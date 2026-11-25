#!/usr/bin/env python3
"""Publish missing container records and attach their DOIs to domain catalogs."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

import requests
from requests.adapters import HTTPAdapter
from urllib3.exceptions import MaxRetryError, ReadTimeoutError
from urllib3.response import BaseHTTPResponse
from urllib3.util.retry import Retry

from .doi_license import fetch_catalogue, rights_from_catalog, same_rights
from .doi_metadata import build_metadata
from .recipe_history import SourceRecipes, source_roots


ZENODO_API = os.environ.get("ZENODO_API_ROOT", "https://zenodo.org/api").rstrip("/")
SIF_BASE = os.environ.get(
    "ZENODO_SIF_BASE_URL", "https://neurocontainers.s3.us-east-2.amazonaws.com"
).rstrip("/")
IMAGE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
BUILDDATE = re.compile(r"^[0-9]{8}$")
STACK_ID = re.compile(r"^[0-9]{4}\.[0-9]{2}$")
MAX_FILE_BYTES = 50_000_000_000
# Without this Accept header Zenodo answers /api/user/records in its legacy
# format, which shows only the first license and no `pids`.
RDM_JSON = "application/vnd.inveniordm.v1+json"
TITLES_PER_QUERY = 50
TRANSIENT_STATUSES = frozenset({429, 500, 502, 503, 504})
PRE_CREATE_RETRY_STATUSES = frozenset({429, 503})
WRITE_RETRY_ATTEMPTS = 4
WRITE_RETRY_BASE_SECONDS = 2.0
WRITE_RETRY_MAX_SECONDS = 60.0
WRITE_RETRY_MAX_RETRY_AFTER_SECONDS = 60.0
CLEANUP_BUDGET_SECONDS = 120.0
_NOT_RECOVERED = object()


class _CappedRetry(Retry):
    """urllib3 Retry that caps Retry-After sleeps and never retries non-allowed methods."""

    def get_retry_after(self, response: Any) -> float | None:
        retry_after = super().get_retry_after(response)
        if retry_after is None:
            return None
        return min(retry_after, WRITE_RETRY_MAX_SECONDS)

    def increment(
        self,
        method: str | None = None,
        url: str | None = None,
        response: Any = None,
        error: Exception | None = None,
        _pool: Any = None,
        _stacktrace: Any = None,
    ) -> _CappedRetry:
        if error is not None and method is not None and not self._is_method_retryable(method):
            if self._is_connection_error(error):
                raise MaxRetryError(_pool, url, error) from error
            raise error.with_traceback(_stacktrace)
        return super().increment(
            method=method,
            url=url,
            response=response,
            error=error,
            _pool=_pool,
            _stacktrace=_stacktrace,
        )


def build_session(token: str) -> requests.Session:
    retry = _CappedRetry(
        total=3,
        backoff_factor=1,
        status_forcelist=sorted(TRANSIENT_STATUSES),
        allowed_methods=["GET", "HEAD"],
        respect_retry_after_header=True,
    )
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {token}"})
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def domain_paths(root: Path) -> list[Path]:
    registry = json.loads((root / "domains.json").read_text(encoding="utf-8"))
    domains = registry.get("domains")
    if not isinstance(domains, dict) or not domains:
        raise ValueError("domains.json must list configured domains")
    return [root / domain / "apps.json" for domain in sorted(domains)]


def artifact_name(app: dict[str, Any]) -> str:
    # consolidate writes the exact SIF image on every launcher; it cannot be
    # derived from launcher names (GUI and arm64 releases differ).
    image = app.get("image")
    date = app.get("version")
    if not isinstance(image, str) or not IMAGE.fullmatch(image):
        raise ValueError(f"Invalid catalog image: {image!r}")
    if not isinstance(date, str) or not BUILDDATE.fullmatch(date):
        raise ValueError(f"Invalid catalog build date: {date!r}")
    return f"{image}_{date}"


def catalog_artifacts(root: Path) -> dict[str, dict[str, Any]]:
    artifacts: dict[str, dict[str, Any]] = {}
    domains = json.loads((root / "domains.json").read_text(encoding="utf-8"))["domains"]
    for path in domain_paths(root):
        domain_config = domains[path.parent.name]
        sources = domain_config.get("source_repositories")
        eessi_stacks = domain_config.get("eessi_stacks")
        has_eessi = (
            isinstance(eessi_stacks, list)
            and bool(eessi_stacks)
            and all(isinstance(stack, str) and STACK_ID.fullmatch(stack) for stack in eessi_stacks)
            and len(set(eessi_stacks)) == len(eessi_stacks)
        )
        if not isinstance(sources, list) or (not sources and not has_eessi) or any(
            not isinstance(source, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source)
            for source in sources
        ) or len(set(sources)) != len(sources):
            raise ValueError(f"Invalid source_repositories for {path.parent.name}")
        catalog = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(catalog, dict):
            raise ValueError(f"Invalid apps catalog: {path}")
        if not sources:
            if catalog:
                raise ValueError(
                    f"EESSI-only domain {path.parent.name} must have an empty apps.json"
                )
            continue
        for tool, entry in catalog.items():
            if not isinstance(entry, dict) or not isinstance(entry.get("apps"), dict):
                raise ValueError(f"Invalid app group in {path}: {tool}")
            for name, app in entry["apps"].items():
                if not isinstance(app, dict):
                    raise ValueError(f"Invalid app in {path}: {tool}/{name}")
                title = artifact_name(app)
                current = artifacts.setdefault(title, {"doi": "", "license": [],
                                                       "license_details": [], "source_repositories": []})
                current["source_repositories"] = sorted(set(
                    current["source_repositories"] + sources
                ))
                doi = app.get("doi") or ""
                if doi and current["doi"] and doi != current["doi"]:
                    raise ValueError(f"Conflicting DOI for {title}")
                if doi:
                    current["doi"] = doi
                licenses = app.get("license") or []
                if isinstance(licenses, str):
                    licenses = [licenses]
                if not isinstance(licenses, list):
                    raise ValueError(f"Invalid license for {tool}/{name}")
                if licenses:
                    normalized = sorted(set(licenses))
                    if current["license"] and current["license"] != normalized:
                        raise ValueError(f"Conflicting licenses for {title}")
                    current["license"] = normalized
                details = app.get("license_details") or []
                if not isinstance(details, list) or any(not isinstance(item, dict) for item in details):
                    raise ValueError(f"Invalid license details for {tool}/{name}")
                if details:
                    if current["license_details"] and current["license_details"] != details:
                        raise ValueError(f"Conflicting license details for {title}")
                    current["license_details"] = details
    return artifacts


def has_production_doi(doi: Any) -> bool:
    return isinstance(doi, str) and bool(doi) and "10.5072/" not in doi


def user_records(
    session: requests.Session, titles: set[str] | None = None
) -> dict[str, dict[str, Any]]:
    """Published records of this account by exact title, newest wins.

    Zenodo's search stops at about 10,000 results, far above this catalog.
    """
    if titles is not None and not titles:
        return {}
    queries = ["is_published:true"] if titles is None else [
        "is_published:true AND (" + " OR ".join(
            f'metadata.title:"{title}"' for title in chunk) + ")"
        for chunk in (sorted(titles)[i:i + TITLES_PER_QUERY]
                      for i in range(0, len(titles), TITLES_PER_QUERY))
    ]
    result: dict[str, dict[str, Any]] = {}
    for query in queries:
        page = 1
        while True:
            response = session.get(
                f"{ZENODO_API}/user/records",
                params={"q": query, "allversions": "true", "sort": "newest",
                        "page": page, "size": 100},
                headers={"Accept": RDM_JSON},
                timeout=(10, 60),
            )
            response.raise_for_status()
            hits = (response.json().get("hits") or {}).get("hits")
            if not isinstance(hits, list):
                raise ValueError("Zenodo records response has no hits list")
            for row in hits:
                title = (row.get("metadata") or {}).get("title")
                if (row.get("is_published") is not True or not isinstance(title, str)
                        or (titles is not None and title not in titles)):
                    continue
                if title not in result or str(row.get("updated", "")) > str(result[title].get("updated", "")):
                    result[title] = row
            if len(hits) < 100:
                break
            page += 1
    return result


def record_doi(row: dict[str, Any]) -> str | None:
    return ((row.get("pids") or {}).get("doi") or {}).get("identifier")


# Keep in step with `max-parallel` in .github/workflows/publish-dois.yml.
PUBLISH_JOBS = 6


def unpublishable_reason(metadata: dict[str, Any]) -> str | None:
    """Why apps.json cannot back a publication for this image, or None.

    An image whose licenses are all NOASSERTION/NONE/unknown is publishable:
    its rights are empty and the record is published without a license.
    """
    if not metadata.get("license"):
        return "apps.json has no license"
    try:
        rights_from_catalog(metadata)
    except ValueError as exc:
        return str(exc)
    return None


def sif_url(title: str) -> str:
    return f"{SIF_BASE}/{quote(title, safe='')}.simg"


def sif_reason(title: str) -> str | None:
    """Why the image's SIF cannot be uploaded (absent from the bucket), or None.

    The public bucket answers 403 (not 404) for a missing key. Release JSON that
    names an image never uploaded (e.g. left over from a recipe rename) would
    otherwise fail publication every night. Other errors are not a skip: the
    publish step retries and reports them.
    """
    try:
        # Public request: the Zenodo bearer token must never reach S3.
        response = requests.head(sif_url(title), allow_redirects=True, timeout=(15, 60))
    except requests.RequestException:
        return None
    if response.status_code in (403, 404):
        return f"no SIF at {sif_url(title)} (HTTP {response.status_code})"
    return None


def recipe_reason(recipes: SourceRecipes, title: str, metadata: dict[str, Any]) -> str | None:
    """Why the recipe history cannot back a publication for this image, or None."""
    try:
        info = recipes.license(title, metadata["source_repositories"])
    except (OSError, RuntimeError, ValueError) as exc:
        return str(exc)
    return None if info["declared"] else f"recipe for version {info['version']} declares no license"


def missing_batches(
    artifacts: dict[str, dict[str, Any]],
    published: dict[str, dict[str, Any]],
    jobs: int = PUBLISH_JOBS,
    limit: int = 0,
    recipe_reason: Callable[[str], str | None] | None = None,
) -> tuple[list[list[str]], dict[str, str]]:
    """Split unpublished images across at most `jobs` parallel batches.

    Images apps.json cannot license are returned as skipped (title -> reason)
    instead of failing every run; consolidate fills their licenses when it can.
    `limit` keeps only the newest N images (0 = all).
    """
    if jobs < 1 or limit < 0:
        raise ValueError("jobs must be positive and limit 0 or more")
    missing, skipped = [], {}
    for title, metadata in artifacts.items():
        if has_production_doi(metadata["doi"]) or title in published:
            continue
        reason = unpublishable_reason(metadata) or (recipe_reason and recipe_reason(title))
        if reason:
            skipped[title] = reason
        else:
            missing.append(title)
    missing.sort(key=lambda title: (-int(title.rsplit("_", 1)[1]), title))
    if limit:
        missing = missing[:limit]
    if not missing:
        return [[]], skipped
    # Round-robin keeps batches within one image of each other and starts the
    # newest builds first in every job.
    return [missing[i::jobs] for i in range(min(jobs, len(missing)))], skipped


class RemoteStream:
    def __init__(
        self,
        response: requests.Response,
        length: int,
        deadline: float | None = None,
    ):
        self.response = response
        self.length = length
        self.deadline = deadline

    def __len__(self) -> int:
        return self.length

    def _bound_read_timeout(self, remaining: float) -> None:
        conn = getattr(self.response.raw, "_connection", None)
        sock = getattr(conn, "sock", None)
        if sock is None:
            fp = getattr(getattr(self.response.raw, "_fp", None), "fp", None)
            sock = getattr(getattr(fp, "raw", None), "_sock", None)
        settimeout = getattr(sock, "settimeout", None)
        if not callable(settimeout):
            return
        gettimeout = getattr(sock, "gettimeout", None)
        try:
            current = gettimeout() if callable(gettimeout) else None
            limit = min(current, remaining) if isinstance(current, (int, float)) else remaining
            settimeout(limit)
        except OSError:
            pass

    def read(self, size: int = -1) -> bytes:
        raw = self.response.raw
        if self.deadline is None:
            return raw.read(size)
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise requests.ReadTimeout("upload deadline exceeded")
        self._bound_read_timeout(remaining)
        try:
            # Use read1 so a single read() makes at most one bounded recv() instead
            # of looping across many slow trickle receives past the deadline.
            if isinstance(raw, BaseHTTPResponse):
                chunk = raw.read1(size, decode_content=False)
            elif callable(getattr(type(raw), "read1", None)):
                chunk = raw.read1(size)
            else:
                chunk = raw.read(size)
        except (ReadTimeoutError, TimeoutError) as exc:
            raise requests.ReadTimeout("upload deadline exceeded") from exc
        if time.monotonic() >= self.deadline:
            raise requests.ReadTimeout("upload deadline exceeded")
        return chunk


def raise_draft_errors(body: dict[str, Any], ignore: tuple[str, ...] = ()) -> None:
    # Draft writes answer HTTP 200/201 even when fields fail validation.
    errors = [
        error for error in body.get("errors") or []
        if not (isinstance(error, dict) and error.get("field") in ignore)
    ]
    if errors:
        raise ValueError(f"Zenodo rejected draft fields: {errors}")


def _parse_retry_after(response: requests.Response | None) -> float | None:
    if response is None:
        return None
    headers = getattr(response, "headers", None)
    if not isinstance(headers, Mapping):
        return None
    raw = headers.get("Retry-After")
    if not isinstance(raw, str) or not raw.strip():
        return None
    raw = raw.strip()
    try:
        seconds = float(raw)
        if not math.isfinite(seconds):
            return None
        return max(0.0, min(seconds, WRITE_RETRY_MAX_RETRY_AFTER_SECONDS))
    except ValueError:
        pass
    try:
        target = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if target.tzinfo is None:
        target = target.replace(tzinfo=timezone.utc)
    delay = (target - datetime.now(timezone.utc)).total_seconds()
    return max(0.0, min(delay, WRITE_RETRY_MAX_RETRY_AFTER_SECONDS))


def _retry_delay(attempt: int, response: requests.Response | None = None) -> float:
    backoff = min(WRITE_RETRY_BASE_SECONDS * (2 ** (attempt - 1)), WRITE_RETRY_MAX_SECONDS)
    retry_after = _parse_retry_after(response)
    return max(backoff, retry_after) if retry_after is not None else backoff


def _is_transient_exception(exc: Exception) -> tuple[bool, requests.Response | None]:
    if isinstance(exc, (requests.Timeout, requests.ConnectionError,
                        requests.exceptions.ChunkedEncodingError)):
        return True, None
    if isinstance(exc, requests.HTTPError):
        resp = exc.response
        if resp is not None and getattr(resp, "status_code", None) in TRANSIENT_STATUSES:
            return True, resp
    return False, None


def _bounded_timeout(
    timeout: tuple[float, float], deadline: float | None, *, minimum: float = 1.0
) -> tuple[float, float] | None:
    if deadline is None:
        return timeout
    remaining = deadline - time.monotonic()
    if remaining <= minimum:
        return None
    return (min(timeout[0], remaining), min(timeout[1], remaining))


def _probe_get(
    session: requests.Session,
    url: str,
    *,
    headers: dict[str, str],
    timeout: tuple[float, float],
    params: dict[str, Any] | None = None,
) -> requests.Response:
    """Single-attempt GET for recovery probes without nested adapter retries."""
    kwargs: dict[str, Any] = {"headers": headers, "timeout": timeout}
    if params is not None:
        kwargs["params"] = params
    if (isinstance(session, requests.Session)
            and getattr(session.get, "__func__", None) is requests.Session.get):
        with requests.Session() as probe_session:
            probe_session.headers.update(session.headers)
            probe_session.mount("https://", HTTPAdapter(max_retries=0))
            probe_session.mount("http://", HTTPAdapter(max_retries=0))
            return probe_session.get(url, **kwargs)
    return session.get(url, **kwargs)


def _with_retries(
    label: str,
    action: Callable[[int, tuple[float, float]], requests.Response],
    *,
    timeout: tuple[float, float],
    attempts: int = WRITE_RETRY_ATTEMPTS,
    retry_statuses: frozenset[int] = TRANSIENT_STATUSES,
    retry_exception: Callable[[requests.RequestException], bool] | None = None,
    recover: Callable[[], Any] | None = None,
    recover_on_status: frozenset[int] = frozenset(),
    ok_statuses: frozenset[int] = frozenset(),
    on_retry: Callable[[int], None] | None = None,
    close_on_retry: bool = False,
    deadline: float | None = None,
) -> tuple[requests.Response | None, Any]:
    for attempt in range(1, attempts + 1):
        attempt_timeout = _bounded_timeout(timeout, deadline)
        if attempt_timeout is None:
            raise requests.ReadTimeout(f"{label}: deadline exceeded")
        response: requests.Response | None = None
        exc: requests.RequestException | None = None
        try:
            response = action(attempt, attempt_timeout)
        except requests.RequestException as err:
            exc = err

        if exc is None:
            assert response is not None
            status = getattr(response, "status_code", None)
            if status in ok_statuses:
                return response, _NOT_RECOVERED
            if status not in TRANSIENT_STATUSES:
                if attempt > 1 and status in recover_on_status and recover is not None:
                    recovered = recover()
                    if recovered is not _NOT_RECOVERED:
                        if close_on_retry:
                            response.close()
                        return None, recovered
                try:
                    response.raise_for_status()
                except Exception:
                    if close_on_retry:
                        response.close()
                    raise
                return response, _NOT_RECOVERED
            transient_resp = response
            error_desc = f"HTTP {status}"
            can_retry = status in retry_statuses
        else:
            transient, transient_resp = _is_transient_exception(exc)
            err_status = getattr(transient_resp, "status_code", None)
            if not transient:
                if attempt > 1 and err_status in recover_on_status and recover is not None:
                    recovered = recover()
                    if recovered is not _NOT_RECOVERED:
                        return None, recovered
                raise exc
            error_desc = type(exc).__name__
            if err_status is not None:
                can_retry = err_status in retry_statuses
            elif retry_exception is not None:
                can_retry = retry_exception(exc)
            else:
                can_retry = True

        # Recovery, backoff sleep, and retry preparation run outside the request
        # try/except so errors in on_retry are never mistaken for action failures.
        delay = _retry_delay(attempt, transient_resp)
        exhausted = attempt == attempts or not can_retry
        budget_allows_sleep = deadline is None or time.monotonic() + delay < deadline
        if exhausted or not budget_allows_sleep:
            if not can_retry and recover is not None and budget_allows_sleep:
                time.sleep(delay)
            if recover is not None:
                recovered = recover()
                if recovered is not _NOT_RECOVERED:
                    if close_on_retry and response is not None:
                        response.close()
                    return None, recovered
            if exc is not None:
                raise exc
            assert response is not None
            try:
                response.raise_for_status()
                raise requests.HTTPError(error_desc, response=response)
            finally:
                if close_on_retry:
                    response.close()

        if close_on_retry and response is not None:
            response.close()
        print(
            f"{label}: {error_desc} (attempt {attempt}/{attempts}); "
            f"retrying in {delay:.1f}s ...",
            file=sys.stderr, flush=True,
        )
        time.sleep(delay)
        if recover is not None:
            recovered = recover()
            if recovered is not _NOT_RECOVERED:
                return None, recovered
        if deadline is not None and time.monotonic() >= deadline:
            if exc is not None:
                raise exc
            assert response is not None
            response.raise_for_status()
            raise requests.HTTPError(error_desc, response=response)
        if on_retry is not None:
            on_retry(attempt)
    raise AssertionError("unreachable")


def discard_draft(
    session: requests.Session,
    draft_url: str,
    headers: dict[str, str],
    draft_id: Any,
    *,
    label: str = "failed draft",
) -> None:
    """Discard a draft, treating 404 as already gone and logging any other failure."""
    cleanup_deadline = time.monotonic() + CLEANUP_BUDGET_SECONDS
    try:
        _with_retries(
            f"discard {label} {draft_id}",
            lambda _, req_timeout: session.delete(
                draft_url, headers=headers, timeout=req_timeout
            ),
            timeout=(15.0, 60.0),
            attempts=2,
            ok_statuses=frozenset({404}),
            deadline=cleanup_deadline,
        )
    except requests.RequestException as error:
        print(f"Could not discard {label} {draft_id}: {error}", file=sys.stderr, flush=True)


def _open_sif(
    source_url: str, title: str, *, deadline: float | None = None
) -> tuple[requests.Response, int]:
    # The public S3 request must never receive the Zenodo bearer token.
    response, _ = _with_retries(
        f"{title} download SIF",
        lambda _, req_timeout: requests.get(source_url, stream=True, timeout=req_timeout),
        timeout=(15, 300),
        close_on_retry=True,
        deadline=deadline,
    )
    assert response is not None
    try:
        length = int(response.headers.get("Content-Length", "0"))
        if length < 1 or length > MAX_FILE_BYTES:
            raise ValueError(f"Unsupported SIF size for {title}: {length}")
    except Exception:
        response.close()
        raise
    return response, length


def publish_deposition(
    title: str,
    license_info: dict[str, Any],
    session: requests.Session,
    *,
    deadline: float | None = None,
) -> str:
    """Create a draft, stream the SIF from S3 into it, and publish; return the DOI."""
    source_url = sif_url(title)
    download: requests.Response | None = None
    try:
        download, length = _open_sif(source_url, title, deadline=deadline)
        headers = {"Accept": RDM_JSON}
        payload = build_metadata(title, license_info)

        def find_created_draft() -> Any:
            timeout = _bounded_timeout((15.0, 60.0), deadline)
            if timeout is None:
                return _NOT_RECOVERED
            try:
                probe = _probe_get(
                    session,
                    f"{ZENODO_API}/user/records",
                    headers=headers,
                    params={
                        "q": f'is_published:false AND metadata.title:"{title}"',
                        "allversions": "true",
                        "sort": "newest",
                        "size": 10,
                    },
                    timeout=timeout,
                )
                if getattr(probe, "status_code", None) != 200:
                    return _NOT_RECOVERED
                hits = (probe.json().get("hits") or {}).get("hits")
                if not isinstance(hits, list):
                    return _NOT_RECOVERED
            except (requests.RequestException, ValueError):
                return _NOT_RECOVERED
            expected_meta = payload["metadata"]
            expected_rights = expected_meta.get("rights") or []
            expected_revision = str(license_info.get("revision") or "")
            for row in hits:
                if not isinstance(row, dict) or row.get("is_published") is not False:
                    continue
                meta = row.get("metadata") or {}
                description = meta.get("description") or ""
                if (meta.get("title") != title
                        or (expected_revision and expected_revision not in description)
                        or not same_rights(meta.get("rights") or [], expected_rights)):
                    continue
                files = row.get("files") or {}
                if files.get("count", 0) or files.get("entries"):
                    continue
                if row.get("id") is not None:
                    return row
            return _NOT_RECOVERED

        # Retry draft creation only on pre-submission failures (ConnectTimeout, 429, 503).
        # Ambiguous failures (500/502/504/ReadTimeout/ConnectionError) reconcile via
        # /api/user/records instead of blindly POSTing a second draft.
        created, recovered_draft = _with_retries(
            f"{title} create draft",
            lambda _, req_timeout: session.post(
                f"{ZENODO_API}/records", json=payload, headers=headers, timeout=req_timeout
            ),
            timeout=(15, 60),
            retry_statuses=PRE_CREATE_RETRY_STATUSES,
            retry_exception=lambda exc: isinstance(exc, requests.ConnectTimeout),
            recover=find_created_draft,
            deadline=deadline,
        )
        draft = created.json() if created is not None else recovered_draft
        draft_id = draft["id"]
        draft_url = f"{ZENODO_API}/records/{draft_id}/draft"
        try:
            # The file is attached next, so "missing uploaded files" is expected here.
            raise_draft_errors(draft, ignore=("files.enabled",))
            key = f"{title}.simg"
            file_url = f"{draft_url}/files/{quote(key, safe='')}"

            def check_file_initialized() -> Any:
                timeout = _bounded_timeout((15.0, 60.0), deadline)
                if timeout is None:
                    return _NOT_RECOVERED
                try:
                    probe = _probe_get(session, file_url, headers=headers, timeout=timeout)
                    if getattr(probe, "status_code", None) == 200:
                        body = probe.json()
                        if isinstance(body, dict):
                            return body
                except (requests.RequestException, ValueError):
                    return _NOT_RECOVERED
                return _NOT_RECOVERED

            def init_file() -> None:
                _with_retries(
                    f"{title} init file",
                    lambda _, req_timeout: session.post(
                        f"{draft_url}/files", json=[{"key": key}],
                        headers=headers, timeout=req_timeout,
                    ),
                    timeout=(15, 60),
                    recover=check_file_initialized,
                    recover_on_status=frozenset({400}),
                    deadline=deadline,
                )

            init_file()

            def reset_for_upload_retry(_: int) -> None:
                nonlocal download
                if download is not None:
                    download.close()
                    download = None
                _with_retries(
                    f"{title} reset file entry",
                    lambda _, req_timeout: session.delete(
                        file_url, headers=headers, timeout=req_timeout
                    ),
                    timeout=(15, 60),
                    ok_statuses=frozenset({404}),
                    deadline=deadline,
                )
                init_file()
                download, retry_length = _open_sif(source_url, title, deadline=deadline)
                if retry_length != length:
                    raise ValueError(
                        f"SIF size changed during upload retry for {title}: "
                        f"{retry_length} != {length}"
                    )

            def upload_attempt(_: int, req_timeout: tuple[float, float]) -> requests.Response:
                nonlocal download
                assert download is not None
                stream_response = download
                download = None
                try:
                    return session.put(
                        f"{file_url}/content",
                        data=RemoteStream(stream_response, length, deadline=deadline),
                        headers={**headers, "Content-Type": "application/octet-stream",
                                 "Content-Length": str(length)},
                        timeout=req_timeout,
                    )
                finally:
                    stream_response.close()

            upload_resp, _ = _with_retries(
                f"{title} upload SIF",
                upload_attempt,
                timeout=(30, 300),
                on_retry=reset_for_upload_retry,
                deadline=deadline,
            )
            assert upload_resp is not None
            try:
                upload_body = upload_resp.json()
            except ValueError:
                upload_body = None
            if isinstance(upload_body, dict):
                raise_draft_errors(upload_body)

            def check_file_committed() -> Any:
                timeout = _bounded_timeout((15.0, 60.0), deadline)
                if timeout is None:
                    return _NOT_RECOVERED
                try:
                    probe = _probe_get(session, file_url, headers=headers, timeout=timeout)
                    if getattr(probe, "status_code", None) == 200:
                        body = probe.json()
                        if isinstance(body, dict) and body.get("status") == "completed":
                            return body
                except (requests.RequestException, ValueError):
                    return _NOT_RECOVERED
                return _NOT_RECOVERED

            committed_resp, committed_body = _with_retries(
                f"{title} commit file",
                lambda _, req_timeout: session.post(
                    f"{file_url}/commit", headers=headers, timeout=req_timeout
                ),
                timeout=(30, 600),
                recover=check_file_committed,
                recover_on_status=frozenset({400}),
                deadline=deadline,
            )
            commit_json = committed_resp.json() if committed_resp is not None else committed_body
            if commit_json.get("size") != length:
                raise ValueError(f"Zenodo stored {commit_json.get('size')} bytes, expected {length}")

            def check_record_published() -> Any:
                # Even past the retry deadline, allow one short bounded check so an
                # already-published DOI is recovered instead of discarded.
                timeout = _bounded_timeout((15.0, 60.0), deadline) or (10.0, 30.0)
                try:
                    probe = _probe_get(
                        session,
                        f"{ZENODO_API}/records/{draft_id}",
                        headers=headers,
                        timeout=timeout,
                    )
                    if getattr(probe, "status_code", None) == 200:
                        body = probe.json()
                        if isinstance(body, dict) and body.get("is_published") is True:
                            return body
                except (requests.RequestException, ValueError):
                    return _NOT_RECOVERED
                return _NOT_RECOVERED

            published_resp, published_body = _with_retries(
                f"{title} publish draft",
                lambda _, req_timeout: session.post(
                    f"{draft_url}/actions/publish", headers=headers, timeout=req_timeout
                ),
                timeout=(15, 120),
                recover=check_record_published,
                recover_on_status=frozenset({404}),
                deadline=deadline,
            )
            record = published_resp.json() if published_resp is not None else published_body
            raise_draft_errors(record)
            doi = record_doi(record)
            if not isinstance(doi, str) or not doi:
                raise ValueError(f"Published Zenodo record has no DOI: {title}")
            return doi
        except Exception:
            discard_draft(session, draft_url, headers, draft_id, label="failed draft")
            raise
    finally:
        if download is not None:
            download.close()


def publish_batch(
    artifacts: dict[str, dict[str, Any]], selected: list[str], session: requests.Session,
    catalogue: dict[str, dict[str, Any]], recipes: SourceRecipes, deadline: float | None = None,
) -> int:
    """Publish `selected`; start no new upload after `deadline` (time.monotonic())."""
    existing = user_records(session, set(selected))
    count = 0
    failures = {}
    total = len(selected)
    for i, title in enumerate(selected, 1):
        if deadline is not None and time.monotonic() > deadline:
            # A job killed mid-upload cannot discard its draft; stop cleanly and
            # leave the rest to the next scheduled run.
            print(f"Time budget reached; leaving {total - i + 1} image(s) for the next run",
                  flush=True)
            break
        prefix = f"[{i}/{total}] {title}"
        try:
            if title not in artifacts:
                raise ValueError("absent from domain catalogs")
            if has_production_doi(artifacts[title]["doi"]) or title in existing:
                print(f"{prefix}: already published, skipping", flush=True)
                continue
            print(f"{prefix}: resolving license ...", flush=True)
            license_info = recipes.license(
                title, artifacts[title]["source_repositories"], catalogue)
            expected = rights_from_catalog(artifacts[title])
            # Empty rights on both sides (NOASSERTION/unknown) agree; an image with
            # no license at all in apps.json never publishes.
            if not artifacts[title].get("license"):
                raise ValueError("apps.json has no license (not even NOASSERTION)")
            if not same_rights(license_info["rights"], expected):
                raise ValueError(
                    f"Catalog licenses {expected!r} differ from the recipe for version "
                    f"{license_info['version']} ({license_info['revision'][:12]}): "
                    f"{license_info['rights']!r}"
                )
            print(f"{prefix}: uploading to Zenodo ...", flush=True)
            doi = publish_deposition(title, license_info, session, deadline=deadline)
            existing[title] = {"pids": {"doi": {"identifier": doi}}}
            count += 1
            print(f"{prefix}: published {doi}", flush=True)
        except Exception as exc:
            print(f"{prefix}: FAILED - {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            failures[title] = f"{type(exc).__name__}: {exc}"
    if failures:
        summary = "\n".join(f"  {title}: {error}" for title, error in failures.items())
        raise RuntimeError(
            f"Published {count}; failed to publish {len(failures)} artifact(s):\n{summary}"
        )
    return count



def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["plan", "publish", "lookup"])
    parser.add_argument("--catalog-root", type=Path, default=Path("."))
    parser.add_argument("--artifacts-json")
    parser.add_argument("--sources-root", type=Path,
                        help="source clones with full history (default: <catalog-root>/.catalog-sources)")
    parser.add_argument("--limit", type=int, default=0,
                        help="plan: only the newest N publishable images (0 = all)")
    parser.add_argument("--time-budget-minutes", type=int, default=0,
                        help="publish: start no new upload after this many minutes (0 = none)")
    args = parser.parse_args()
    token = os.environ.get("ZENODO_TOKEN")
    if not token:
        parser.error("ZENODO_TOKEN is required")
    session = build_session(token)
    if args.command == "lookup":
        print(json.dumps({title: record_doi(row) for title, row in user_records(session).items()
                          if record_doi(row)}))
        return 0
    artifacts = catalog_artifacts(args.catalog_root)
    repositories = sorted({repository for metadata in artifacts.values()
                           for repository in metadata["source_repositories"]})
    recipes = SourceRecipes(source_roots(
        args.sources_root or args.catalog_root / ".catalog-sources", repositories))
    if args.command == "plan":
        if args.limit < 0:
            parser.error("--limit must be 0 or more")
        batches, skipped = missing_batches(
            artifacts, user_records(session), limit=args.limit,
            # The SIF check runs last: one HEAD request per otherwise publishable image.
            recipe_reason=lambda title: (recipe_reason(recipes, title, artifacts[title])
                                         or sif_reason(title)))
        if skipped:
            print(f"Skipping {len(skipped)} image(s) that cannot be published:", file=sys.stderr)
            for title, reason in sorted(skipped.items()):
                print(f"  {title}: {reason}", file=sys.stderr)
        print(f"Planned {sum(map(len, batches))} image(s) in {len(batches)} batch(es)",
              file=sys.stderr)
        print(json.dumps(batches))
    elif args.command == "publish":
        if args.artifacts_json is None:
            parser.error("--artifacts-json is required for publish")
        selected = json.loads(args.artifacts_json)
        if not isinstance(selected, list) or any(not isinstance(x, str) for x in selected):
            parser.error("--artifacts-json must be a JSON list of names")
        catalogue = fetch_catalogue()["entries"]
        deadline = (time.monotonic() + args.time_budget_minutes * 60
                    if args.time_budget_minutes > 0 else None)
        count = publish_batch(artifacts, selected, session, catalogue, recipes, deadline)
        print(f"Published {count} Zenodo records")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
