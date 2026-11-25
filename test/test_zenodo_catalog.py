"""DOI publication uses the domain catalog's exact image identities."""

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import requests
from urllib3.exceptions import ConnectTimeoutError, MaxRetryError, ReadTimeoutError

from scripts.doi_metadata import build_metadata
from scripts.zenodo_catalog import (
    RDM_JSON,
    WRITE_RETRY_MAX_RETRY_AFTER_SECONDS,
    WRITE_RETRY_MAX_SECONDS,
    _probe_get,
    build_session,
    catalog_artifacts,
    discard_draft,
    missing_batches,
    publish_deposition,
    record_doi,
    sif_reason,
    user_records,
)

LICENSE_INFO = {
    "rights": [{"id": "mit"}, {"title": {"en": "Research terms"}, "link": "https://example.org/terms"}],
    "revision": "a" * 40, "recipe": "demo", "version": "1.0",
    "source_repository": "Example/microcontainers",
}


def reply(payload, status=200, headers=None):
    response = MagicMock()
    response.status_code = status
    response.headers = headers or {}
    response.json.return_value = payload
    response.raise_for_status.side_effect = (
        requests.HTTPError(str(status), response=response) if status >= 400 else None)
    return response


def records_session(created_errors=None, **overrides):
    """Stub session answering the records API publish sequence.

    Override one step's reply by name: create, init, commit, publish or upload.
    """
    steps = {
        "create": reply({"id": "12", "errors": created_errors or []}),
        "init": reply({"entries": []}),
        "commit": reply({"size": 3}),
        "publish": reply({"id": "12", "is_published": True,
                          "pids": {"doi": {"identifier": "10.5281/zenodo.12"}}}),
        "upload": reply({"size": 3}),
        **overrides,
    }
    session = MagicMock()
    session.post.side_effect = [steps[name] for name in ("create", "init", "commit", "publish")]
    session.put.return_value = steps["upload"]
    return session


class ZenodoCatalogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "domains.json").write_text(json.dumps({"domains": {
            "neuroimaging": {"source_repositories": ["NeuroDesk/neurocontainers"]},
            "microscopy": {"source_repositories": ["Example/microcontainers"]},
        }}))
        for domain in ("neuroimaging", "microscopy"):
            (self.root / domain).mkdir()
        (self.root / "neuroimaging/apps.json").write_text(json.dumps({
            "demo": {"apps": {
                "demo 1.0": {"image": "demo_1.0", "version": "20260101",
                             "license": ["MIT"]},
                "viewerGUI-demo 1.0": {"image": "demo_1.0", "version": "20260101"},
            }, "categories": ["visualization"]},
        }))
        (self.root / "microscopy/apps.json").write_text(json.dumps({
            "viewer": {"apps": {
                "viewerGUI-viewer 2.0": {"image": "viewer_2.0",
                                                "version": "20261010"},
            }, "categories": ["visualization"]},
        }))

    def test_plans_unique_images_including_gui_only_release(self) -> None:
        artifacts = catalog_artifacts(self.root)
        self.assertEqual(set(artifacts), {
            "demo_1.0_20260101", "viewer_2.0_20261010"
        })
        self.assertEqual(artifacts["demo_1.0_20260101"]["license"], ["MIT"])
        self.assertEqual(artifacts["demo_1.0_20260101"]["source_repositories"],
                         ["NeuroDesk/neurocontainers"])
        self.assertEqual(artifacts["viewer_2.0_20261010"]["source_repositories"],
                         ["Example/microcontainers"])
        # viewer has no catalog license, so it cannot be published yet.
        self.assertEqual(missing_batches(artifacts, {}), (
            [["demo_1.0_20260101"]], {"viewer_2.0_20261010": "apps.json has no license"}))

    def test_every_missing_image_is_split_across_at_most_six_jobs(self) -> None:
        artifacts = {f"tool_1.0_202601{day:02d}": {"doi": "", "license": ["MIT"]}
                     for day in range(1, 15)}
        artifacts["done_1.0_20260120"] = {"doi": "10.5281/zenodo.9", "license": ["MIT"]}
        batches, skipped = missing_batches(artifacts, {"tool_1.0_20260114": {}})
        self.assertEqual(skipped, {})
        self.assertEqual(len(batches), 6)
        self.assertEqual(sorted(sum(batches, [])),
                         sorted(f"tool_1.0_202601{day:02d}" for day in range(1, 14)))
        self.assertEqual([len(batch) for batch in batches], [3, 2, 2, 2, 2, 2])
        self.assertEqual([batch[0] for batch in batches],
                         [f"tool_1.0_202601{day:02d}" for day in range(13, 7, -1)])
        self.assertEqual(missing_batches(artifacts, {}, jobs=20)[0][0], ["tool_1.0_20260114"])
        with self.assertRaises(ValueError):
            missing_batches(artifacts, {}, jobs=0)

    def test_limit_keeps_newest_and_unlicensable_images_are_skipped(self) -> None:
        artifacts = {f"tool_1.0_202601{day:02d}": {"doi": "", "license": ["MIT"]}
                     for day in range(1, 5)}
        artifacts["fsl_1.0_20260109"] = {"doi": "", "license": ["LicenseRef-FSL"]}
        artifacts["old_1.0_20200101"] = {"doi": "", "license": []}
        batches, skipped = missing_batches(artifacts, {}, limit=1)
        self.assertEqual(batches, [["tool_1.0_20260104"]])
        self.assertEqual(sorted(skipped), ["fsl_1.0_20260109", "old_1.0_20200101"])
        self.assertIn("no license_details", skipped["fsl_1.0_20260109"])
        self.assertEqual(missing_batches({"old_1.0_20200101": artifacts["old_1.0_20200101"]}, {})[0],
                         [[]])

    def test_image_without_a_sif_is_skipped_by_the_plan(self) -> None:
        # neurodesktop-lite_20260428_arm64: release JSON left by a rename, no SIF uploaded.
        title = "neurodesktop-lite_20260428_arm64_20260519"
        url = f"https://neurocontainers.s3.us-east-2.amazonaws.com/{title}.simg"
        for status in (403, 404):
            with patch("scripts.zenodo_catalog.requests.head",
                       return_value=reply({}, status=status)) as head:
                self.assertEqual(sif_reason(title), f"no SIF at {url} (HTTP {status})")
            self.assertEqual(head.call_args.args[0], url)
            self.assertNotIn("headers", head.call_args.kwargs)  # never the Zenodo token
        # Present, or an error the publish step should retry and report: not skipped.
        for outcome in (reply({}), reply({}, status=503), requests.ConnectionError("down")):
            with patch("scripts.zenodo_catalog.requests.head",
                       **({"side_effect": outcome} if isinstance(outcome, Exception)
                          else {"return_value": outcome})):
                self.assertIsNone(sif_reason(title))
        artifacts = {title: {"doi": "", "license": ["MIT"]},
                     "tool_1.0_20260101": {"doi": "", "license": ["MIT"]}}
        batches, skipped = missing_batches(
            artifacts, {}, recipe_reason=lambda name: f"no SIF" if name == title else None)
        self.assertEqual((batches, list(skipped)), ([["tool_1.0_20260101"]], [title]))

    def test_removed_releases_are_absent_from_doi_plan(self) -> None:
        for domain in ("neuroimaging", "microscopy"):
            (self.root / domain / "apps.json").write_text("{}\n")
        artifacts = catalog_artifacts(self.root)
        self.assertEqual(artifacts, {})
        self.assertEqual(missing_batches(artifacts, {}), ([[]], {}))

    def test_launcher_alias_uses_its_image_for_doi_identity(self) -> None:
        path = self.root / "neuroimaging/apps.json"
        catalog = json.loads(path.read_text())
        catalog["demo"]["apps"]["VoxTell-demo 1.0"] = {
            "image": "demo_1.0", "version": "20260101", "license": ["MIT"],
        }
        path.write_text(json.dumps(catalog))
        artifacts = catalog_artifacts(self.root)
        self.assertEqual(set(artifacts), {"demo_1.0_20260101", "viewer_2.0_20261010"})

    def test_app_without_image_is_rejected(self) -> None:
        path = self.root / "neuroimaging/apps.json"
        catalog = json.loads(path.read_text())
        catalog["demo"]["apps"]["VoxTell-demo 1.0"] = {
            "version": "20260101", "license": ["MIT"],
        }
        path.write_text(json.dumps(catalog))
        with self.assertRaisesRegex(ValueError, "Invalid catalog image: None"):
            catalog_artifacts(self.root)

    def test_sandbox_doi_does_not_prevent_production_publication(self) -> None:
        artifacts = catalog_artifacts(self.root)
        artifacts["demo_1.0_20260101"]["doi"] = "https://doi.org/10.5072/zenodo.1"
        artifacts["viewer_2.0_20261010"]["doi"] = "https://doi.org/10.5281/zenodo.2"

        self.assertEqual(missing_batches(artifacts, {})[0], [["demo_1.0_20260101"]])

    def publish(self, session, download_length="3"):
        download = MagicMock()
        download.headers = {"Content-Length": download_length}
        download.raw.read.return_value = b"sif"
        with patch("scripts.zenodo_catalog.requests.get", return_value=download) as get:
            try:
                return publish_deposition("demo_1.0_20260101", LICENSE_INFO, session)
            finally:
                self.assertEqual(get.call_args.kwargs, {"stream": True, "timeout": (15, 300)})
                self.assertNotIn("headers", get.call_args.kwargs)
                download.close.assert_called_once()

    def test_publish_creates_draft_uploads_and_publishes_through_records_api(self) -> None:
        session = records_session()
        self.assertEqual(self.publish(session), "10.5281/zenodo.12")
        draft = "https://zenodo.org/api/records/12/draft"
        key = "demo_1.0_20260101.simg"
        self.assertEqual([(c.args[0]) for c in session.post.call_args_list], [
            "https://zenodo.org/api/records", f"{draft}/files",
            f"{draft}/files/{key}/commit", f"{draft}/actions/publish",
        ])
        self.assertEqual(session.put.call_args.args[0], f"{draft}/files/{key}/content")
        self.assertEqual(session.put.call_args.kwargs["headers"]["Content-Length"], "3")
        self.assertTrue(all(c.kwargs["headers"]["Accept"] == RDM_JSON
                            for c in session.post.call_args_list))
        body = session.post.call_args_list[0].kwargs["json"]
        metadata = body["metadata"]
        self.assertEqual(metadata["rights"], LICENSE_INFO["rights"])
        self.assertEqual(metadata["resource_type"], {"id": "software"})
        self.assertEqual(metadata["publisher"], "Zenodo")
        self.assertEqual(metadata["creators"][0]["person_or_org"]["name"], "Neurodesk")
        self.assertIn("github.com/Example/microcontainers/tree/" + "a" * 40, metadata["description"])
        self.assertIn("Recipe for version 1.0", metadata["description"])
        self.assertEqual(body["files"], {"enabled": True})
        session.delete.assert_not_called()

    def test_failed_publication_discards_the_draft(self) -> None:
        cases = {
            "upload": {"upload": reply({}, status=400)},
            "size": {"commit": reply({"size": 2})},
            "publish": {"publish": reply({}, status=400)},
            "field errors": {"create": reply({"id": "12", "errors": [
                {"field": "metadata.publisher", "messages": ["Missing"]}]})},
        }
        with patch("scripts.zenodo_catalog.time.sleep") as sleep:
            for label, overrides in cases.items():
                session = records_session(**overrides)
                with self.assertRaises((requests.HTTPError, ValueError), msg=label):
                    self.publish(session)
                session.delete.assert_called_once()
                self.assertEqual(session.delete.call_args.args[0],
                                 "https://zenodo.org/api/records/12/draft", label)
            sleep.assert_not_called()

    def test_missing_files_error_on_new_draft_is_expected(self) -> None:
        session = records_session(created_errors=[{"field": "files.enabled",
                                                   "messages": ["Missing uploaded files."]}])
        self.assertEqual(self.publish(session), "10.5281/zenodo.12")

    def test_build_session_retries_safe_methods_caps_retry_after_and_blocks_write_retries(self) -> None:
        session = build_session("secret-token")
        retry = session.adapters["https://"].max_retries
        self.assertEqual(set(retry.allowed_methods), {"GET", "HEAD"})
        self.assertNotIn("POST", retry.allowed_methods)
        self.assertNotIn("PUT", retry.allowed_methods)
        self.assertNotIn("DELETE", retry.allowed_methods)
        self.assertEqual(set(retry.status_forcelist), {429, 500, 502, 503, 504})
        self.assertTrue(retry.respect_retry_after_header)

        # Retry-After: 7200 must be capped so one sleep cannot blow the cleanup window.
        huge = MagicMock()
        huge.headers = {"Retry-After": "7200"}
        self.assertEqual(retry.get_retry_after(huge), WRITE_RETRY_MAX_SECONDS)

        # Connect errors on POST/PUT/DELETE must raise requests.ConnectTimeout (not raw
        # urllib3 ConnectTimeoutError) with strictly 1 attempt through build_session().
        err = ConnectTimeoutError(None, "https://zenodo.org/api/records", "timed out")
        for method in ("POST", "PUT", "DELETE"):
            with self.assertRaises(MaxRetryError, msg=method):
                retry.increment(method=method, url="/api/records", error=err)
        next_retry = retry.increment(method="GET", url="/api/user/records", error=err)
        self.assertEqual(next_retry.total, retry.total - 1)

        calls = [0]

        def raise_connect_timeout(*_args, **_kwargs):
            calls[0] += 1
            raise err

        with patch("urllib3.connectionpool.HTTPSConnectionPool._make_request",
                   side_effect=raise_connect_timeout):
            for verb in ("post", "put", "delete"):
                calls[0] = 0
                with self.assertRaises(requests.ConnectTimeout, msg=verb):
                    getattr(session, verb)("https://zenodo.org/api/records", timeout=(1, 1))
                self.assertEqual(calls[0], 1, verb)

            # discard_draft must catch and log ConnectTimeout instead of masking the caller error.
            with patch("scripts.zenodo_catalog.time.sleep"), patch("sys.stderr") as stderr:
                discard_draft(session, "https://zenodo.org/api/records/12/draft",
                              {"Accept": RDM_JSON}, "12")
            err_text = "".join(str(c.args[0]) for c in stderr.write.call_args_list)
            self.assertIn("Could not discard failed draft 12", err_text)

        # Read timeout on POST must map to requests.ReadTimeout with strictly 1 attempt.
        read_err = ReadTimeoutError(None, "https://zenodo.org/api/records", "read timed out")
        calls[0] = 0

        def raise_read_timeout(*_args, **_kwargs):
            calls[0] += 1
            raise read_err

        with patch("urllib3.connectionpool.HTTPSConnectionPool._make_request",
                   side_effect=raise_read_timeout):
            with self.assertRaises(requests.ReadTimeout):
                session.post("https://zenodo.org/api/records", timeout=(1, 1))
        self.assertEqual(calls[0], 1)

    def test_publish_retries_pre_create_errors_and_file_init(self) -> None:
        session = MagicMock()
        session.post.side_effect = [
            requests.ConnectTimeout("connect timed out"),
            reply({}, status=503),
            reply({"id": "12", "errors": []}),
            requests.ReadTimeout("init timed out"),
            reply({"entries": []}),
            reply({"size": 3}),
            reply({"id": "12", "is_published": True,
                   "pids": {"doi": {"identifier": "10.5281/zenodo.12"}}}),
        ]
        session.get.return_value = reply({}, status=404)
        session.put.return_value = reply({"size": 3})
        with patch("scripts.zenodo_catalog.time.sleep") as sleep:
            self.assertEqual(self.publish(session), "10.5281/zenodo.12")
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [2.0, 4.0, 2.0])
        session.delete.assert_not_called()

    def test_publish_reconciles_ambiguous_create_without_duplicate_drafts(self) -> None:
        expected_meta = build_metadata("demo_1.0_20260101", LICENSE_INFO)["metadata"]
        matching_draft = {
            "id": "12",
            "is_published": False,
            "metadata": {
                "title": expected_meta["title"],
                "description": expected_meta["description"],
                "rights": [
                    {"id": "mit", "title": {"en": "MIT License"}},
                    {"title": {"en": "Research terms"}, "link": "https://example.org/terms"},
                ],
            },
            "files": {"enabled": True, "count": 0},
        }
        # Subcase A: 504 on create after Zenodo actually created draft 12 -> adopts it.
        session = MagicMock()
        session.post.side_effect = [
            reply({}, status=504),
            reply({"entries": []}),
            reply({"size": 3}),
            reply({"id": "12", "is_published": True,
                   "pids": {"doi": {"identifier": "10.5281/zenodo.12"}}}),
        ]
        session.get.return_value = reply({"hits": {"hits": [matching_draft]}})
        session.put.return_value = reply({"size": 3})
        with patch("scripts.zenodo_catalog.time.sleep") as sleep:
            self.assertEqual(self.publish(session), "10.5281/zenodo.12")
        self.assertEqual(session.post.call_args_list[0].args[0], "https://zenodo.org/api/records")
        self.assertEqual(session.post.call_args_list[1].args[0],
                         "https://zenodo.org/api/records/12/draft/files")
        self.assertEqual(session.get.call_args.args[0], "https://zenodo.org/api/user/records")
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [2.0])
        session.delete.assert_not_called()

        # Subcase B: 500/504/ReadTimeout on create when draft is NOT found -> NEVER sends a 2nd POST.
        for outcome in (reply({}, status=500), reply({}, status=504),
                        requests.ReadTimeout("create timed out")):
            session = MagicMock()
            session.post.side_effect = [outcome]
            session.get.return_value = reply({"hits": {"hits": []}})
            with patch("scripts.zenodo_catalog.time.sleep"):
                with self.assertRaises((requests.HTTPError, requests.ReadTimeout)):
                    self.publish(session)
            self.assertEqual(session.post.call_count, 1)
            session.delete.assert_not_called()

        # Subcase C: stale draft with different rights is ignored (never adopted or re-POSTed).
        stale_draft = {
            **matching_draft,
            "metadata": {**matching_draft["metadata"], "rights": [{"id": "apache-2.0"}]},
        }
        session = MagicMock()
        session.post.side_effect = [reply({}, status=504)]
        session.get.return_value = reply({"hits": {"hits": [stale_draft]}})
        with patch("scripts.zenodo_catalog.time.sleep"):
            with self.assertRaises(requests.HTTPError):
                self.publish(session)
        self.assertEqual(session.post.call_count, 1)

    def test_upload_retry_preparation_failure_runs_reset_only_once(self) -> None:
        draft = "https://zenodo.org/api/records/12/draft"
        key = "demo_1.0_20260101.simg"
        file_url = f"{draft}/files/{key}"
        session = MagicMock()
        session.post.side_effect = [
            reply({"id": "12", "errors": []}),
            reply({"entries": []}),
        ]
        session.put.return_value = reply({}, status=503)
        # Reset DELETE exhausts its own 4 attempts with 503; final discard DELETE succeeds.
        session.delete.side_effect = [
            reply({}, status=503),
            reply({}, status=503),
            reply({}, status=503),
            reply({}, status=503),
            reply({}, status=204),
        ]
        with patch("scripts.zenodo_catalog.time.sleep"):
            with self.assertRaises(requests.HTTPError):
                self.publish(session)
        self.assertEqual(session.put.call_count, 1)
        # Exactly one reset (4 DELETE attempts on file_url) + 1 draft discard on draft_url.
        self.assertEqual([c.args[0] for c in session.delete.call_args_list],
                         [file_url, file_url, file_url, file_url, draft])

    def test_upload_http_200_with_errors_aborts_before_commit_and_discards_draft(self) -> None:
        draft = "https://zenodo.org/api/records/12/draft"
        session = records_session(
            upload=reply({"key": "demo_1.0_20260101.simg",
                          "errors": [{"field": "files", "messages": ["Transfer failed"]}]}),
        )
        with patch("scripts.zenodo_catalog.time.sleep") as sleep:
            with self.assertRaisesRegex(ValueError, "Transfer failed"):
                self.publish(session)
        # Only create and init POSTs ran; commit and publish were never called.
        self.assertEqual([c.args[0] for c in session.post.call_args_list], [
            "https://zenodo.org/api/records", f"{draft}/files",
        ])
        session.delete.assert_called_once()
        self.assertEqual(session.delete.call_args.args[0], draft)
        sleep.assert_not_called()

    def test_failed_discard_is_reported_while_404_is_silent(self) -> None:
        # 403 on DELETE logs the discard failure while preserving the original ValueError.
        session = records_session(commit=reply({"size": 2}))
        session.delete.return_value = reply({}, status=403)
        with patch("sys.stderr") as stderr:
            with self.assertRaisesRegex(ValueError, "expected 3"):
                self.publish(session)
        session.delete.assert_called_once()
        err_text = "".join(str(c.args[0]) for c in stderr.write.call_args_list)
        self.assertIn("Could not discard failed draft 12", err_text)

        # 404 on DELETE is treated as already discarded and stays silent.
        session = records_session(commit=reply({"size": 2}))
        session.delete.return_value = reply({}, status=404)
        with patch("sys.stderr") as stderr:
            with self.assertRaisesRegex(ValueError, "expected 3"):
                self.publish(session)
        session.delete.assert_called_once()
        self.assertEqual("".join(str(c.args[0]) for c in stderr.write.call_args_list), "")

    def test_publish_respects_deadline_across_writes_streams_and_retries(self) -> None:
        draft = "https://zenodo.org/api/records/12/draft"
        # Subcase A: S3 response arrives after deadline -> no draft creation or file init.
        clock = [90.0]

        def slow_s3(*_args, **_kwargs):
            clock[0] = 105.0  # past deadline=100.0
            dl = MagicMock()
            dl.status_code = 200
            dl.headers = {"Content-Length": "3"}
            dl.raw.read.return_value = b"sif"
            return dl

        session = MagicMock()
        with (patch("scripts.zenodo_catalog.requests.get", side_effect=slow_s3),
              patch("scripts.zenodo_catalog.time.monotonic", side_effect=lambda: clock[0]),
              patch("scripts.zenodo_catalog.time.sleep") as sleep):
            with self.assertRaisesRegex(requests.ReadTimeout, "deadline exceeded"):
                publish_deposition("demo_1.0_20260101", LICENSE_INFO, session, deadline=100.0)
        session.post.assert_not_called()
        session.put.assert_not_called()
        session.delete.assert_not_called()
        sleep.assert_not_called()

        # Subcase B: upload and commit timeouts are clamped to remaining deadline, and
        # retry stops cleanly when backoff would cross the deadline.
        clock[0] = 80.0  # 20s remaining before deadline=100.0
        dl = MagicMock()
        dl.status_code = 200
        dl.headers = {"Content-Length": "3"}
        dl.raw.read.return_value = b"sif"
        session = MagicMock()

        post_replies = iter([
            reply({"id": "12", "errors": []}),
            reply({"entries": []}),
        ])

        def post_dispatch(*_args, **_kwargs):
            try:
                return next(post_replies)
            except StopIteration:
                clock[0] = 99.0  # only 1.0s left (< 2.0s backoff and <= 1.0s probe min)
                return reply({}, status=500)

        session.post.side_effect = post_dispatch
        session.put.return_value = reply({"size": 3})
        session.delete.return_value = reply({}, status=204)
        with (patch("scripts.zenodo_catalog.requests.get", return_value=dl),
              patch("scripts.zenodo_catalog.time.monotonic", side_effect=lambda: clock[0]),
              patch("scripts.zenodo_catalog.time.sleep") as sleep):
            with self.assertRaises(requests.HTTPError):
                publish_deposition("demo_1.0_20260101", LICENSE_INFO, session, deadline=100.0)
        self.assertEqual(session.put.call_args.kwargs["timeout"], (20.0, 20.0))
        self.assertEqual(session.post.call_args_list[2].kwargs["timeout"], (20.0, 20.0))
        sleep.assert_not_called()
        session.get.assert_not_called()
        session.delete.assert_called_once()
        self.assertEqual(session.delete.call_args.args[0], draft)

        # Subcase C: wall-clock deadline enforced inside RemoteStream.read() during upload.
        clock[0] = 90.0
        dl_stream = MagicMock()
        dl_stream.status_code = 200
        dl_stream.headers = {"Content-Length": "3"}
        session = MagicMock()
        session.post.side_effect = [
            reply({"id": "12", "errors": []}),
            reply({"entries": []}),
        ]

        def consume_stream(_url, data, **_kwargs):
            clock[0] = 100.5  # deadline expires mid-upload
            data.read(1)
            return reply({"size": 3})

        session.put.side_effect = consume_stream
        session.delete.return_value = reply({}, status=204)
        with (patch("scripts.zenodo_catalog.requests.get", return_value=dl_stream),
              patch("scripts.zenodo_catalog.time.monotonic", side_effect=lambda: clock[0]),
              patch("scripts.zenodo_catalog.time.sleep") as sleep):
            with self.assertRaisesRegex(requests.ReadTimeout, "upload deadline exceeded"):
                publish_deposition("demo_1.0_20260101", LICENSE_INFO, session, deadline=100.0)
        dl_stream.close.assert_called_once()
        sleep.assert_not_called()
        self.assertEqual(session.post.call_count, 2)  # never reached /commit
        session.delete.assert_called_once()
        self.assertEqual(session.delete.call_args.args[0], draft)

    def test_probe_get_uses_non_retrying_adapter_for_real_session(self) -> None:
        real_session = build_session("secret-token")
        captured = {}

        def fake_send(adapter_self, request, **kwargs):
            captured["max_retries"] = adapter_self.max_retries.total
            captured["auth"] = request.headers.get("Authorization")
            res = requests.Response()
            res.status_code = 200
            res._content = b'{"status": "completed"}'
            return res

        with patch.object(requests.adapters.HTTPAdapter, "send", autospec=True,
                          side_effect=fake_send):
            resp = _probe_get(real_session, "https://zenodo.org/api/records/12",
                              headers={"Accept": RDM_JSON}, timeout=(10.0, 30.0))
        self.assertEqual(resp.json(), {"status": "completed"})
        self.assertEqual(captured["max_retries"], 0)
        self.assertEqual(captured["auth"], "Bearer secret-token")

    def test_publish_recovers_when_file_init_succeeded_before_timeout(self) -> None:
        draft = "https://zenodo.org/api/records/12/draft"
        key = "demo_1.0_20260101.simg"
        session = MagicMock()
        session.post.side_effect = [
            reply({"id": "12", "errors": []}),
            requests.ReadTimeout("init timed out"),
            reply({"size": 3}),
            reply({"id": "12", "is_published": True,
                   "pids": {"doi": {"identifier": "10.5281/zenodo.12"}}}),
        ]
        session.get.return_value = reply({"key": key, "status": "pending"})
        session.put.return_value = reply({"size": 3})
        with patch("scripts.zenodo_catalog.time.sleep") as sleep:
            self.assertEqual(self.publish(session), "10.5281/zenodo.12")
        self.assertEqual([c.args[0] for c in session.post.call_args_list], [
            "https://zenodo.org/api/records", f"{draft}/files",
            f"{draft}/files/{key}/commit", f"{draft}/actions/publish",
        ])
        self.assertEqual(session.get.call_args.args[0], f"{draft}/files/{key}")
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [2.0])
        session.delete.assert_not_called()

    def test_publish_retries_upload_with_fresh_s3_stream_and_file_reset(self) -> None:
        draft = "https://zenodo.org/api/records/12/draft"
        key = "demo_1.0_20260101.simg"
        file_url = f"{draft}/files/{key}"
        downloads = []
        for _ in range(3):
            dl = MagicMock()
            dl.status_code = 200
            dl.headers = {"Content-Length": "3"}
            dl.raw.read.return_value = b"sif"
            downloads.append(dl)
        session = MagicMock()
        session.post.side_effect = [
            reply({"id": "12", "errors": []}),
            reply({"entries": []}),
            reply({"entries": []}),  # re-init after attempt 1
            reply({"entries": []}),  # re-init after attempt 2
            reply({"size": 3}),
            reply({"id": "12", "is_published": True,
                   "pids": {"doi": {"identifier": "10.5281/zenodo.12"}}}),
        ]
        session.put.side_effect = [
            requests.ConnectionError("write timed out"),
            reply({}, status=504),
            reply({"size": 3}),
        ]
        session.delete.side_effect = [reply({}, status=204), reply({}, status=404)]
        with (patch("scripts.zenodo_catalog.requests.get", side_effect=downloads) as get,
              patch("scripts.zenodo_catalog.time.sleep") as sleep):
            doi = publish_deposition("demo_1.0_20260101", LICENSE_INFO, session)
        self.assertEqual(doi, "10.5281/zenodo.12")
        self.assertEqual(get.call_count, 3)
        self.assertTrue(all("headers" not in c.kwargs for c in get.call_args_list))
        for dl in downloads:
            dl.close.assert_called_once()
        self.assertEqual([c.args[0] for c in session.delete.call_args_list],
                         [file_url, file_url])
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [2.0, 4.0])

    def test_publish_exhausted_upload_retries_discards_draft(self) -> None:
        draft = "https://zenodo.org/api/records/12/draft"
        key = "demo_1.0_20260101.simg"
        file_url = f"{draft}/files/{key}"
        downloads = []
        for _ in range(4):
            dl = MagicMock()
            dl.status_code = 200
            dl.headers = {"Content-Length": "3"}
            dl.raw.read.return_value = b"sif"
            downloads.append(dl)
        session = MagicMock()
        session.post.side_effect = [
            reply({"id": "12", "errors": []}),
            reply({"entries": []}),
            reply({"entries": []}),
            reply({"entries": []}),
            reply({"entries": []}),
        ]
        session.put.return_value = reply({}, status=503)
        session.delete.return_value = reply({}, status=204)
        with (patch("scripts.zenodo_catalog.requests.get", side_effect=downloads),
              patch("scripts.zenodo_catalog.time.sleep") as sleep):
            with self.assertRaises(requests.HTTPError):
                publish_deposition("demo_1.0_20260101", LICENSE_INFO, session)
        for dl in downloads:
            dl.close.assert_called_once()
        self.assertEqual(session.put.call_count, 4)
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [2.0, 4.0, 8.0])
        self.assertEqual([c.args[0] for c in session.delete.call_args_list],
                         [file_url, file_url, file_url, draft])

    def test_publish_retries_commit_and_recovers_already_committed_file(self) -> None:
        draft = "https://zenodo.org/api/records/12/draft"
        key = "demo_1.0_20260101.simg"
        # Subcase A: commit gets 500 while still pending, then succeeds on retry.
        session = MagicMock()
        session.post.side_effect = [
            reply({"id": "12", "errors": []}),
            reply({"entries": []}),
            reply({}, status=500),
            reply({"size": 3}),
            reply({"id": "12", "is_published": True,
                   "pids": {"doi": {"identifier": "10.5281/zenodo.12"}}}),
        ]
        session.put.return_value = reply({"size": 3})
        session.get.return_value = reply({"status": "pending", "size": 0})
        with patch("scripts.zenodo_catalog.time.sleep") as sleep:
            self.assertEqual(self.publish(session), "10.5281/zenodo.12")
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [2.0])
        session.delete.assert_not_called()

        # Subcase B: commit gets 504 after Zenodo already completed it.
        session = MagicMock()
        session.post.side_effect = [
            reply({"id": "12", "errors": []}),
            reply({"entries": []}),
            reply({}, status=504),
            reply({"id": "12", "is_published": True,
                   "pids": {"doi": {"identifier": "10.5281/zenodo.12"}}}),
        ]
        session.put.return_value = reply({"size": 3})
        session.get.return_value = reply({"status": "completed", "size": 3})
        with patch("scripts.zenodo_catalog.time.sleep") as sleep:
            self.assertEqual(self.publish(session), "10.5281/zenodo.12")
        self.assertEqual([c.args[0] for c in session.post.call_args_list], [
            "https://zenodo.org/api/records", f"{draft}/files",
            f"{draft}/files/{key}/commit", f"{draft}/actions/publish",
        ])
        self.assertEqual(session.get.call_args.args[0], f"{draft}/files/{key}")
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [2.0])
        session.delete.assert_not_called()

        # Subcase C: recovered committed file with wrong size fails and discards draft.
        session = MagicMock()
        session.post.side_effect = [
            reply({"id": "12", "errors": []}),
            reply({"entries": []}),
            reply({}, status=504),
        ]
        session.put.return_value = reply({"size": 3})
        session.get.return_value = reply({"status": "completed", "size": 2})
        with patch("scripts.zenodo_catalog.time.sleep"):
            with self.assertRaisesRegex(ValueError, "expected 3"):
                self.publish(session)
        session.delete.assert_called_once()
        self.assertEqual(session.delete.call_args.args[0], draft)

    def test_publish_retries_publish_and_recovers_already_published_record(self) -> None:
        published_record = {
            "id": "12", "is_published": True,
            "pids": {"doi": {"identifier": "10.5281/zenodo.12"}},
        }
        # Subcase A: publish gets 500, record not yet published (404), retry succeeds.
        session = MagicMock()
        session.post.side_effect = [
            reply({"id": "12", "errors": []}),
            reply({"entries": []}),
            reply({"size": 3}),
            reply({}, status=500),
            reply(published_record),
        ]
        session.put.return_value = reply({"size": 3})
        session.get.return_value = reply({}, status=404)
        with patch("scripts.zenodo_catalog.time.sleep") as sleep:
            self.assertEqual(self.publish(session), "10.5281/zenodo.12")
        self.assertEqual(session.get.call_args.args[0], "https://zenodo.org/api/records/12")
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [2.0])
        session.delete.assert_not_called()

        # Subcase B: publish gets 504 on final attempt after Zenodo already published it.
        session = MagicMock()
        session.post.side_effect = [
            reply({"id": "12", "errors": []}),
            reply({"entries": []}),
            reply({"size": 3}),
            reply({}, status=504),
            reply({}, status=504),
            reply({}, status=504),
            reply({}, status=504),
        ]
        session.put.return_value = reply({"size": 3})
        session.get.side_effect = [
            reply({}, status=404),
            reply({}, status=404),
            reply({}, status=404),
            reply(published_record),
        ]
        with patch("scripts.zenodo_catalog.time.sleep") as sleep:
            self.assertEqual(self.publish(session), "10.5281/zenodo.12")
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [2.0, 4.0, 8.0])
        session.delete.assert_not_called()

        # Subcase C: race where record publishes right between GET 404 and retry POST 404.
        session = MagicMock()
        session.post.side_effect = [
            reply({"id": "12", "errors": []}),
            reply({"entries": []}),
            reply({"size": 3}),
            reply({}, status=504),
            reply({}, status=404),
        ]
        session.put.return_value = reply({"size": 3})
        session.get.side_effect = [reply({}, status=404), reply(published_record)]
        with patch("scripts.zenodo_catalog.time.sleep"):
            self.assertEqual(self.publish(session), "10.5281/zenodo.12")
        session.delete.assert_not_called()

    def test_retry_respects_retry_after_header_seconds_and_http_date(self) -> None:
        # Numeric Retry-After larger than backoff, then clamped huge Retry-After.
        session = MagicMock()
        session.post.side_effect = [
            reply({}, status=429, headers={"Retry-After": "15"}),
            reply({}, status=429, headers={"Retry-After": "9999"}),
            reply({"id": "12", "errors": []}),
            reply({"entries": []}),
            reply({"size": 3}),
            reply({"id": "12", "is_published": True,
                   "pids": {"doi": {"identifier": "10.5281/zenodo.12"}}}),
        ]
        session.put.return_value = reply({"size": 3})
        with patch("scripts.zenodo_catalog.time.sleep") as sleep:
            self.assertEqual(self.publish(session), "10.5281/zenodo.12")
        self.assertEqual([c.args[0] for c in sleep.call_args_list],
                         [15.0, WRITE_RETRY_MAX_RETRY_AFTER_SECONDS])

        # HTTP-date Retry-After ~30s in the future.
        future = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=30), usegmt=True)
        session = MagicMock()
        session.post.side_effect = [
            reply({}, status=429, headers={"Retry-After": future}),
            reply({"id": "12", "errors": []}),
            reply({"entries": []}),
            reply({"size": 3}),
            reply({"id": "12", "is_published": True,
                   "pids": {"doi": {"identifier": "10.5281/zenodo.12"}}}),
        ]
        session.put.return_value = reply({"size": 3})
        with patch("scripts.zenodo_catalog.time.sleep") as sleep:
            self.assertEqual(self.publish(session), "10.5281/zenodo.12")
        self.assertEqual(sleep.call_count, 1)
        self.assertGreater(sleep.call_args.args[0], 20.0)
        self.assertLessEqual(sleep.call_args.args[0], 35.0)

    def test_open_sif_retries_transient_s3_errors_and_closes_failed_responses(self) -> None:
        bad = reply({}, status=503)
        good = MagicMock()
        good.status_code = 200
        good.headers = {"Content-Length": "3"}
        good.raw.read.return_value = b"sif"
        session = records_session()
        with (patch("scripts.zenodo_catalog.requests.get",
                    side_effect=[bad, requests.ConnectionError("s3 reset"), good]) as get,
              patch("scripts.zenodo_catalog.time.sleep") as sleep):
            doi = publish_deposition("demo_1.0_20260101", LICENSE_INFO, session)
        self.assertEqual(doi, "10.5281/zenodo.12")
        self.assertEqual(get.call_count, 3)
        bad.close.assert_called_once()
        good.close.assert_called_once()
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [2.0, 4.0])

    def test_user_records_keeps_published_exact_titles_newest_first(self) -> None:
        session = MagicMock()
        session.get.return_value = reply({"hits": {"hits": [
            {"is_published": True, "updated": "2026-01-01", "metadata": {"title": "demo_1.0_20260101"},
             "pids": {"doi": {"identifier": "10.123/old"}}},
            {"is_published": True, "updated": "2026-02-01", "metadata": {"title": "demo_1.0_20260101"},
             "pids": {"doi": {"identifier": "10.123/new"}}},
            {"is_published": False, "metadata": {"title": "demo_1.0_20260101"}},
            {"is_published": True, "metadata": {"title": "demo_1.0_20260101-extra"}},
        ]}})
        rows = user_records(session, {"demo_1.0_20260101"})
        self.assertEqual(set(rows), {"demo_1.0_20260101"})
        self.assertEqual(record_doi(rows["demo_1.0_20260101"]), "10.123/new")
        call = session.get.call_args
        self.assertEqual(call.args[0], "https://zenodo.org/api/user/records")
        self.assertEqual(call.kwargs["headers"], {"Accept": RDM_JSON})
        self.assertEqual(call.kwargs["params"]["q"],
                         'is_published:true AND (metadata.title:"demo_1.0_20260101")')
        self.assertEqual(user_records(session, set()), {})

    def test_user_records_pages_and_chunks_title_queries(self) -> None:
        session = MagicMock()
        full = {"hits": {"hits": [{"is_published": True, "metadata": {"title": f"t_1_{i:08d}"}}
                                  for i in range(100)]}}
        session.get.side_effect = [reply(full), reply({"hits": {"hits": []}})]
        self.assertEqual(len(user_records(session)), 100)
        self.assertEqual([c.kwargs["params"]["page"] for c in session.get.call_args_list], [1, 2])
        session = MagicMock()
        session.get.return_value = reply({"hits": {"hits": []}})
        user_records(session, {f"t_1_{i:08d}" for i in range(120)})
        self.assertEqual(session.get.call_count, 3)

    def test_eessi_only_domain_with_empty_apps_json_is_skipped(self) -> None:
        (self.root / "hpc").mkdir()
        (self.root / "hpc/apps.json").write_text("{}")
        (self.root / "domains.json").write_text(json.dumps({"domains": {
            "neuroimaging": {
                "source_repositories": ["NeuroDesk/neurocontainers"],
                "eessi_stacks": ["2025.06"],
            },
            "hpc": {
                "source_repositories": [],
                "eessi_stacks": ["2025.06"],
            },
        }}))
        artifacts = catalog_artifacts(self.root)
        self.assertEqual(set(artifacts), {"demo_1.0_20260101"})

        # Non-empty apps.json on an EESSI-only domain must fail loudly.
        (self.root / "hpc/apps.json").write_text(json.dumps({
            "rogue": {"apps": {"rogue 1.0": {"image": "rogue_1.0", "version": "20260101"}}},
        }))
        with self.assertRaisesRegex(ValueError, "EESSI-only domain hpc must have an empty apps.json"):
            catalog_artifacts(self.root)

        # Empty source_repositories without eessi_stacks still fails.
        (self.root / "hpc/apps.json").write_text("{}")
        (self.root / "domains.json").write_text(json.dumps({"domains": {
            "hpc": {"source_repositories": []},
        }}))
        with self.assertRaisesRegex(ValueError, "Invalid source_repositories for hpc"):
            catalog_artifacts(self.root)

if __name__ == "__main__":
    unittest.main()
