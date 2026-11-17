import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { catalogAssets } from "../scripts/cloudflare.mjs";
import {
  DOMAINS_SCHEMA_URL,
  domainsErrors,
  loadSchema,
  readPublishedDomains,
} from "../scripts/domains.mjs";
import { readDomains } from "../scripts/workflow.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const SOURCES = ["NeuroDesk/neurocontainers"];

const container = (overrides = {}) => ({
  title: "neurodesk",
  description: "Neuroimaging tools.",
  registry: "docker.io/vnmd/neurodesktop",
  defaultVersion: "2026-09-23",
  releaseHistoryUrl: "https://raw.githubusercontent.com/a/b/main/x.mdx",
  containerName: "neurodeskapp",
  volumeMount: "neurodesk-home",
  defaultStorageMount: "neurodesktop-storage",
  remoteUrl: ["https://play.neurodesk.cloud.edu.au/"],
  ...overrides,
});

// domains.json with the given container block for neuroimaging.
const withContainer = (block) => ({
  schemaVersion: 1,
  domains: {
    neuroimaging: { source_repositories: SOURCES, container: block },
  },
});

async function fixture(domainsText) {
  const root = await mkdtemp(join(tmpdir(), "neurodesk-domains-"));
  await writeFile(join(root, "domains.json"), domainsText);
  await mkdir(join(root, "neuroimaging"));
  await writeFile(join(root, "neuroimaging", "apps.json"), "{}");
  return root;
}

// loadSchema with a stubbed fetch: these cases need no network.
test("loadSchema fetches the configured URL, or DOMAINS_SCHEMA_URL", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return new Response('{"type":"object"}');
  };
  assert.deepEqual(await loadSchema({}, fetchImpl), { type: "object" });
  await loadSchema({ DOMAINS_SCHEMA_URL: "https://example.org/s.json" }, fetchImpl);
  assert.deepEqual(urls, [DOMAINS_SCHEMA_URL, "https://example.org/s.json"]);
});

test("loadSchema reads DOMAINS_SCHEMA_FILE without fetching", async () => {
  const root = await mkdtemp(join(tmpdir(), "neurodesk-schema-"));
  await writeFile(join(root, "s.json"), '{"type":"object"}');
  const fetchImpl = async () => assert.fail("must not fetch");
  assert.deepEqual(
    await loadSchema({ DOMAINS_SCHEMA_FILE: join(root, "s.json") }, fetchImpl),
    { type: "object" },
  );
});

test("loadSchema fails closed on HTTP errors, network errors and bad JSON", async () => {
  await assert.rejects(
    loadSchema({}, async () => new Response("nope", { status: 404 })),
    /Could not fetch the domains schema .*HTTP 404/,
  );
  await assert.rejects(
    loadSchema({}, async () => { throw new Error("offline"); }),
    /Could not fetch the domains schema .*offline/,
  );
  await assert.rejects(
    loadSchema({}, async () => new Response("<html>")),
    /is not valid JSON/,
  );
});

test("the repository's domains.json is valid for the pipeline and for publishing", async () => {
  await readDomains(repoRoot);
  await readPublishedDomains(repoRoot);
});

test("accepts a domain with a container", async () => {
  assert.deepEqual(await domainsErrors(withContainer(container())), []);
});

test("accepts a domain that has no container yet", async () => {
  const errors = await domainsErrors({
    schemaVersion: 1,
    domains: { microscopy: { source_repositories: ["Example/micro"] } },
  });
  assert.deepEqual(errors, []);
});

// The fields below reach a shell command or the app's HTML; each value is one
// the app would also reject.
for (const [label, field, value] of [
  ["shell separator in registry", "registry", "vnmd/x; rm -rf ~"],
  ["command substitution in registry", "registry", "vnmd/$(id)"],
  ["tag in registry", "registry", "vnmd/neurodesktop:latest"],
  ["pipe in tag", "defaultVersion", "latest|sh"],
  ["dated tag as a number", "defaultVersion", 20260923],
  ["space in containerName", "containerName", "neurodesk app"],
  ["host path as volumeMount", "volumeMount", "/etc:/host"],
  ["traversal as storage mount", "defaultStorageMount", ".."],
  ["markup in title", "title", "<img src=x onerror=alert(1)>"],
  ["quote in title", "title", "neuro'desk"],
  ["markup in description", "description", "a <script>b</script>"],
  ["http remote URL", "remoteUrl", ["http://play.neurodesk.org/"]],
  ["quote in remote URL", "remoteUrl", ["https://a.org/');alert(1);//"]],
  ["javascript release history", "releaseHistoryUrl", "javascript:alert(1)"],
  ["non-semver minAppVersion", "minAppVersion", "2.1"],
]) {
  test(`rejects ${label}`, async () => {
    const errors = await domainsErrors(
      withContainer(container({ [field]: value })),
    );
    assert.ok(
      errors.some((error) => error.includes(`/container/${field}`)),
      `expected an error at ${field}, got ${JSON.stringify(errors)}`,
    );
  });
}

test("rejects a container missing a required field", async () => {
  const block = container();
  delete block.registry;
  assert.notDeepEqual(await domainsErrors(withContainer(block)), []);
});

test("rejects an unknown container field, so typos are caught", async () => {
  const errors = await domainsErrors(
    withContainer({ ...container(), defaultVerison: "x" }),
  );
  assert.notDeepEqual(errors, []);
});

for (const [label, value] of [
  ["a missing schemaVersion", { domains: withContainer(container()).domains }],
  [
    "a newer schemaVersion",
    { ...withContainer(container()), schemaVersion: 2 },
  ],
  ["no domains", { schemaVersion: 1, domains: {} }],
  [
    "an uppercase domain ID",
    { schemaVersion: 1, domains: { Neuro: { source_repositories: SOURCES } } },
  ],
  [
    "a domain without source repositories",
    { schemaVersion: 1, domains: { neuroimaging: { container: container() } } },
  ],
  [
    "a malformed source repository",
    {
      schemaVersion: 1,
      domains: { neuroimaging: { source_repositories: ["not a repo"] } },
    },
  ],
  [
    "an unknown domain field",
    {
      schemaVersion: 1,
      domains: { neuroimaging: { source_repositories: SOURCES, extra: 1 } },
    },
  ],
  ["an extra top-level field", { ...withContainer(container()), extra: 1 }],
]) {
  test(`rejects ${label}`, async () => {
    assert.notDeepEqual(await domainsErrors(value), []);
  });
}

test("reports every error, not just the first", async () => {
  const errors = await domainsErrors(
    withContainer(container({ registry: "a;b", title: "<x>" })),
  );
  assert.ok(errors.length >= 2, JSON.stringify(errors));
});

test("accepts two domains with their own containerNames", async () => {
  const errors = await domainsErrors({
    schemaVersion: 1,
    domains: {
      neuroimaging: { source_repositories: SOURCES, container: container() },
      microscopy: {
        source_repositories: ["Example/micro"],
        container: container({
          title: "microscopy",
          containerName: "microapp",
        }),
      },
    },
  });
  assert.deepEqual(errors, []);
});

test("rejects two domains sharing a containerName", async () => {
  const errors = await domainsErrors({
    schemaVersion: 1,
    domains: {
      neuroimaging: { source_repositories: SOURCES, container: container() },
      microscopy: {
        source_repositories: ["Example/micro"],
        container: container({ title: "microscopy" }),
      },
    },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /containerName neurodeskapp is already used/);
});

test("readPublishedDomains rejects malformed JSON with a clear message", async () => {
  await assert.rejects(
    readPublishedDomains(await fixture("{oops")),
    /not valid JSON/,
  );
});

test("catalogAssets publishes domains.json byte for byte", async () => {
  const text = JSON.stringify(withContainer(container()), null, 2);
  const assets = await catalogAssets(await fixture(text));
  assert.equal(assets.get("/domains.json").bytes.toString("utf8"), text);
});

test("a bad container fails the deploy but not catalog generation", async () => {
  const root = await fixture(
    JSON.stringify(withContainer(container({ registry: "a;b" }))),
  );
  await readDomains(root);
  await assert.rejects(catalogAssets(root), /domains\.json is invalid/);
});
