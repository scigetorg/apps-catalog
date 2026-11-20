import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  dockerHubTagUrl,
  latestRelease,
  planBumps,
  pullRequestFor,
  tagExists,
  updateDefaultVersions,
} from "../scripts/default_version.mjs";

const HISTORY = "https://raw.githubusercontent.com/a/b/main/history.mdx";
const page = (latest, older = ["2026-07-11", "2026-06-04"]) => `
import { Badge } from '@astrojs/starlight/components';

## 2026

### ${latest} <Badge text="Latest" variant="success" />

#### New Features

${older.map((version) => `### ${version}\n\n- fixes\n`).join("\n")}`;

const container = (overrides = {}) => ({
  title: "neurodesk",
  description: "Neuroimaging tools.",
  registry: "docker.io/vnmd/neurodesktop",
  defaultVersion: "2026-09-23",
  releaseHistoryUrl: HISTORY,
  containerName: "neurodeskapp",
  volumeMount: "neurodesk-home",
  defaultStorageMount: "neurodesktop-storage",
  ...overrides,
});

const documentWith = (block) => ({
  schemaVersion: 1,
  domains: {
    neuroimaging: {
      source_repositories: ["NeuroDesk/neurocontainers"],
      ...(block ?? {}),
    },
  },
});

// fetch stub: the release page answers `history`, Docker Hub knows `tags`.
function stub({ history = page("2026-11-01"), status = 200, tags = ["2026-11-01"] } = {}) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url === HISTORY) return new Response(history, { status });
    const tag = decodeURIComponent(url.split("/tags/")[1]);
    return new Response("{}", { status: tags.includes(tag) ? 200 : 404 });
  };
  return { fetchImpl, urls };
}

test("latestRelease reads the one heading marked Latest", () => {
  assert.equal(latestRelease(page("2026-09-23")), "2026-09-23");
  assert.equal(
    latestRelease("## 2027-01-02 <Badge variant='success' text='Latest' />"),
    "2027-01-02",
  );
});

test("latestRelease refuses a page with no or several Latest headings", () => {
  assert.throws(() => latestRelease("### 2026-09-23\n"), /found 0/);
  assert.throws(
    () => latestRelease(`${page("2026-09-23")}\n${page("2026-10-01")}`),
    /found 2 \(2026-09-23, 2026-10-01\)/,
  );
  // A Latest badge on an undated heading is not a release.
  assert.throws(() => latestRelease('### Next <Badge text="Latest" />'), /found 0/);
});

test("dockerHubTagUrl maps Docker Hub names and rejects other registries", () => {
  assert.equal(
    dockerHubTagUrl("docker.io/vnmd/neurodesktop", "2026-09-23"),
    "https://hub.docker.com/v2/repositories/vnmd/neurodesktop/tags/2026-09-23",
  );
  assert.equal(
    dockerHubTagUrl("docker.io/ubuntu", "24.04"),
    "https://hub.docker.com/v2/repositories/library/ubuntu/tags/24.04",
  );
  assert.equal(dockerHubTagUrl("ghcr.io/neurodesk/x", "1"), null);
});

test("tagExists: 200 yes, 404 no, other statuses and registries throw", async () => {
  const answer = (status) => async () => new Response("{}", { status });
  assert.equal(await tagExists("docker.io/vnmd/x", "1", answer(200)), true);
  assert.equal(await tagExists("docker.io/vnmd/x", "1", answer(404)), false);
  await assert.rejects(tagExists("docker.io/vnmd/x", "1", answer(429)), /HTTP 429/);
  await assert.rejects(tagExists("ghcr.io/a/b", "1", answer(200)), /only docker\.io/);
});

test("planBumps bumps to a newer Latest that is on the registry", async () => {
  const { fetchImpl } = stub();
  const plan = await planBumps(documentWith(container()), { fetchImpl });
  assert.deepEqual(plan.bumps, [{ id: "neuroimaging", from: "2026-09-23", to: "2026-11-01" }]);
  assert.deepEqual(plan.errors, []);
});

for (const [label, options, block, note] of [
  ["already current", { history: page("2026-09-23") }, container(), /already at 2026-09-23/],
  ["Latest is older than the current default", { history: page("2026-07-11", []) }, container(), /newer than Latest/],
  ["the tag is not pushed yet", { tags: [] }, container(), /not on the registry yet/],
  ["the current default is not a date", {}, container({ defaultVersion: "latest" }), /not a dated release/],
]) {
  test(`planBumps leaves the version alone when ${label}`, async () => {
    const plan = await planBumps(documentWith(block), stub(options));
    assert.deepEqual(plan.bumps, []);
    assert.match(plan.notes.join("\n"), note);
  });
}

test("planBumps skips domains without launch fields or a release history", async () => {
  const { fetchImpl, urls } = stub();
  const noHistory = container();
  delete noHistory.releaseHistoryUrl;
  for (const document of [documentWith(null), documentWith(noHistory)]) {
    assert.deepEqual(await planBumps(document, { fetchImpl }), { bumps: [], notes: [], errors: [] });
  }
  assert.deepEqual(urls, []);
});

test("planBumps reports a failing page per domain and still bumps the others", async () => {
  const document = documentWith(container());
  document.domains.microscopy = {
    source_repositories: ["Example/micro"],
    ...container({
      containerName: "microapp",
      releaseHistoryUrl: "https://example.org/missing.mdx",
    }),
  };
  const { fetchImpl: base } = stub();
  const fetchImpl = async (url) =>
    url.startsWith("https://example.org/") ? new Response("", { status: 404 }) : base(url);
  const plan = await planBumps(document, { fetchImpl });
  assert.deepEqual(plan.bumps.map(({ id }) => id), ["neuroimaging"]);
  assert.match(plan.errors.join("\n"), /microscopy: .*HTTP 404/);
});

test("updateDefaultVersions rewrites only defaultVersion in domains.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "neurodesk-default-version-"));
  const before = `${JSON.stringify(documentWith(container()), null, 2)}\n`;
  await writeFile(join(root, "domains.json"), before);
  await updateDefaultVersions(root, stub());
  const after = await readFile(join(root, "domains.json"), "utf8");
  assert.equal(after, before.replace('"defaultVersion": "2026-09-23"', '"defaultVersion": "2026-11-01"'));
});

test("updateDefaultVersions leaves the file untouched when nothing changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "neurodesk-default-version-"));
  const before = JSON.stringify(documentWith(container())); // not pretty-printed
  await writeFile(join(root, "domains.json"), before);
  await updateDefaultVersions(root, stub({ history: page("2026-09-23") }));
  assert.equal(await readFile(join(root, "domains.json"), "utf8"), before);
});

test("the repository's domains.json is pretty-printed, so a bump is a one-line diff", async () => {
  const text = await readFile(new URL("../domains.json", import.meta.url), "utf8");
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
});

test("pullRequestFor names a branch and title from the bumps", () => {
  assert.deepEqual(
    pullRequestFor([
      { id: "neuroimaging", from: "2026-09-23", to: "2026-11-01" },
      { id: "microscopy", from: "2026-01-01", to: "2026-02-02" },
    ]),
    {
      branch: "default-version/neuroimaging-2026-11-01+microscopy-2026-02-02",
      title:
        "Bump default container version: neuroimaging 2026-09-23 → 2026-11-01, microscopy 2026-01-01 → 2026-02-02",
    },
  );
});
