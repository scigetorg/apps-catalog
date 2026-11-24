import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  consolidateDomains, eessiOutputPaths, needsConsolidation, needsEessiConsolidation,
  outputPaths, readDomains, sourcePath,
} from "../scripts/workflow.mjs";
import { catalogAssets } from "../scripts/cloudflare.mjs";
import { readReleases, readSourceDomains } from "../scripts/catalog.mjs";

const repo = "Example/containers";
const domains = {
  neuroimaging: { source_repositories: [repo] },
  microscopy: { source_repositories: [repo] },
};
const sha = "a".repeat(40);
const resolveLicenses = async (titles) => ({
  resolved: Object.fromEntries(Object.keys(titles).map((title) => [title, {
    license: ["MIT"], license_details: [],
  }])), errors: {},
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "catalog-workflow-"));
  await writeFile(join(root, "domains.json"), JSON.stringify({ domains }));
  const source = sourcePath(root, repo);
  await mkdir(join(source, "releases", "demo"), { recursive: true });
  await mkdir(join(source, "recipes", "demo"), { recursive: true });
  await writeFile(join(source, "releases", "demo", "1.0.json"), JSON.stringify({
    apps: { "demo 1.0": { version: "20260921", doi: "https://doi.org/10.123/demo" } },
    categories: ["visualization"],
  }));
  await writeFile(join(source, "recipes", "demo", "build.yaml"), "domains: [neuroimaging]\n");
  await mkdir(join(root, "neuroimaging"));
  await writeFile(join(root, "neuroimaging", "apps.json"), JSON.stringify({
    demo: { apps: { "demo 1.0": { image: "demo_1.0", version: "20260921",
      doi: "https://doi.org/10.123/old", license: ["MIT"] } } },
  }));
  return { root, source };
}

test("validates source lists and generated paths", async () => {
  const { root } = await fixture();
  assert.deepEqual(await readDomains(root), domains);
  assert.deepEqual(outputPaths(domains), [
    "neuroimaging/apps.json", "neuroimaging/manifest.json",
    "microscopy/apps.json", "microscopy/manifest.json",
  ]);
  await writeFile(join(root, "domains.json"), JSON.stringify({ domains: {
    neuroimaging: { source_repositories: [repo, repo] },
  } }));
  await assert.rejects(readDomains(root), /Invalid source_repositories/);
});

test("a new domain gets its catalog and manifest before its launch settings are published", async () => {
  const { root } = await fixture();
  const existing = { neuroimaging: domains.neuroimaging };
  const options = { sourceCommits: { [repo]: sha }, resolveLicenses, publishedDois: {} };
  await consolidateDomains(root, existing, options);
  assert.equal(await needsConsolidation(root, existing), false);

  await writeFile(join(root, "domains.json"), JSON.stringify({ schemaVersion: 1, domains }));
  const configured = await readDomains(root);
  assert.equal(await needsConsolidation(root, configured), true);
  await consolidateDomains(root, configured, options);
  const assets = await catalogAssets(root);
  assert.deepEqual(JSON.parse(assets.get("/domains.json").bytes).domains, domains);
  assert.deepEqual(JSON.parse(assets.get("/microscopy/apps.json").bytes), {});
  assert.ok(JSON.parse(assets.get("/neuroimaging/apps.json").bytes).demo);
  configured.microscopy.title = "Microscopy tools";
  assert.equal(await needsConsolidation(root, configured), false);
});

test("missing outputs and changed source membership require regeneration", async () => {
  const { root } = await fixture();
  const manifest = join(root, "neuroimaging", "manifest.json");
  const sources = [repo, "Example/other"];
  const configured = { neuroimaging: { source_repositories: sources } };
  assert.equal(await needsConsolidation(root, configured), true); // Only apps.json exists.
  await writeFile(manifest, JSON.stringify({ source_commits: { [sources[1]]: sha, [repo]: sha } }));
  assert.equal(await needsConsolidation(root, configured), false);
  for (const changed of [[repo], [repo, "Example/replacement"], [...sources, "Example/new"]]) {
    assert.equal(await needsConsolidation(root, { neuroimaging: { source_repositories: changed } }), true);
  }
  await unlink(join(root, "neuroimaging", "apps.json"));
  assert.equal(await needsConsolidation(root, configured), true);
});

test("domain IDs follow the published schema, including its 64-character limit", async () => {
  const { root } = await fixture();
  const write = (id) => writeFile(join(root, "domains.json"), JSON.stringify({
    domains: { [id]: { source_repositories: [repo] } },
  }));
  for (const id of ["a", "neuro-imaging", "a".repeat(64)]) {
    await write(id);
    assert.deepEqual(Object.keys(await readDomains(root)), [id]);
  }
  for (const id of ["a".repeat(65), "Neuro", "1neuro", "neuro--imaging", "neuro-", "eessi"]) {
    await write(id);
    await assert.rejects(readDomains(root), /Invalid domain ID/, id);
  }
});

test("accepts launch fields but does not validate their values", async () => {
  const { root } = await fixture();
  // Malformed launch data must not stop catalog generation; the deploy check
  // (scripts/domains.mjs) rejects it instead.
  const withContainer = {
    neuroimaging: { source_repositories: [repo], registry: "a;b" },
  };
  await writeFile(join(root, "domains.json"), JSON.stringify({ schemaVersion: 1, domains: withContainer }));
  assert.deepEqual(await readDomains(root), withContainer);
  await writeFile(join(root, "domains.json"), JSON.stringify({ domains: {
    neuroimaging: { source_repositories: [repo], container: {} },
  } }));
  await assert.rejects(readDomains(root), /Unknown configuration field/);
  await writeFile(join(root, "domains.json"), JSON.stringify({ domains: {
    neuroimaging: { source_repositories: [repo], containers: {} },
  } }));
  await assert.rejects(readDomains(root), /Unknown configuration field/);
});

test("domain move routes every version and carries established license", async () => {
  const { root, source } = await fixture();
  await consolidateDomains(root, domains, {
    sourceCommits: { [repo]: sha }, resolveLicenses,
  });
  let neuro = JSON.parse(await readFile(join(root, "neuroimaging", "apps.json"), "utf8"));
  assert.deepEqual(neuro.demo.apps["demo 1.0"].license, ["MIT"]);
  assert.equal(neuro.demo.apps["demo 1.0"].doi, "https://doi.org/10.123/demo");
  assert.equal(Object.hasOwn(neuro.demo.apps["demo 1.0"], "show_in_menu"), false);
  await writeFile(join(source, "recipes", "demo", "build.yaml"), "domains: [microscopy]\n");
  await consolidateDomains(root, domains, {
    sourceCommits: { [repo]: sha }, resolveLicenses,
  });
  neuro = JSON.parse(await readFile(join(root, "neuroimaging", "apps.json"), "utf8"));
  const micro = JSON.parse(await readFile(join(root, "microscopy", "apps.json"), "utf8"));
  assert.deepEqual(neuro, {});
  assert.deepEqual(micro.demo.apps["demo 1.0"].license, ["MIT"]);
  assert.equal(JSON.parse(await readFile(join(root, "neuroimaging", "manifest.json"), "utf8"))
    .entries, 0);
  assert.equal(JSON.parse(await readFile(join(root, "microscopy", "manifest.json"), "utf8"))
    .entries, 1);
  assert.deepEqual(JSON.parse(await readFile(join(root, "microscopy", "manifest.json"), "utf8"))
    .source_commits, { [repo]: sha });
  assert.equal(Object.hasOwn(JSON.parse(await readFile(join(root, "microscopy", "manifest.json"), "utf8")),
    "license_provenance"), false);
});

test("every run reads an already licensed image from its recipe history", async () => {
  const { root } = await fixture();
  const looked = [];
  const resolve = async (titles) => {
    looked.push(...Object.keys(titles));
    return { resolved: Object.fromEntries(Object.keys(titles).map((title) => [title, {
      license: ["Apache-2.0", "MIT"], license_details: [],
    }])), errors: {} };
  };
  await consolidateDomains(root, domains, { sourceCommits: { [repo]: sha }, resolveLicenses: resolve });
  assert.deepEqual(looked, ["demo_1.0_20260921"]);
  const neuro = JSON.parse(await readFile(join(root, "neuroimaging", "apps.json"), "utf8"));
  assert.deepEqual(neuro.demo.apps["demo 1.0"].license, ["Apache-2.0", "MIT"]);
});

test("deleting a release JSON removes that image and keeps another version", async () => {
  const { root, source } = await fixture();
  await writeFile(join(source, "releases", "demo", "2.0.json"), JSON.stringify({
    apps: { "demo 2.0": { version: "20261010" } }, categories: ["visualization"],
  }));
  await consolidateDomains(root, domains, {
    sourceCommits: { [repo]: sha }, resolveLicenses, publishedDois: {},
  });
  await unlink(join(source, "releases", "demo", "1.0.json"));
  await consolidateDomains(root, domains, {
    sourceCommits: { [repo]: sha }, resolveLicenses, publishedDois: {},
  });
  const catalog = JSON.parse(await readFile(join(root, "neuroimaging", "apps.json"), "utf8"));
  assert.deepEqual(Object.keys(catalog.demo.apps), ["demo 2.0"]);
  assert.equal(catalog.demo.apps["demo 2.0"].image, "demo_2.0");
  const manifest = JSON.parse(await readFile(join(root, "neuroimaging", "manifest.json"), "utf8"));
  assert.equal(manifest.entries, 1);
  assert.equal(Object.hasOwn(manifest, "license_provenance"), false);
});

test("deleting the last release JSON publishes an empty catalog", async () => {
  const { root, source } = await fixture();
  await consolidateDomains(root, domains, {
    sourceCommits: { [repo]: sha }, resolveLicenses, publishedDois: {},
  });
  await unlink(join(source, "releases", "demo", "1.0.json"));
  await consolidateDomains(root, domains, {
    sourceCommits: { [repo]: sha }, resolveLicenses, publishedDois: {},
  });
  assert.deepEqual(JSON.parse(await readFile(join(root, "neuroimaging", "apps.json"), "utf8")), {});
  const manifest = JSON.parse(await readFile(join(root, "neuroimaging", "manifest.json"), "utf8"));
  assert.equal(manifest.entries, 0);
});

test("a corrected release license can replace the previous build's value", async () => {
  const { root, source } = await fixture();
  await writeFile(join(source, "releases", "demo", "1.0.json"), JSON.stringify({
    apps: { "demo 1.0": { version: "20260921", license: ["Apache-2.0"] } },
    categories: ["visualization"],
  }));
  await consolidateDomains(root, domains, {
    sourceCommits: { [repo]: sha }, publishedDois: {},
    resolveLicenses: async (titles) => ({ resolved: Object.fromEntries(Object.keys(titles).map(
      (title) => [title, { license: ["Apache-2.0"], license_details: [] }])), errors: {} }),
  });
  const catalog = JSON.parse(await readFile(join(root, "neuroimaging", "apps.json"), "utf8"));
  assert.deepEqual(catalog.demo.apps["demo 1.0"].license, ["Apache-2.0"]);
});

test("catalog generation can run before DOI publication", async () => {
  const { root, source } = await fixture();
  await writeFile(join(source, "releases", "demo", "1.0.json"), JSON.stringify({
    apps: { "demo 1.0": { version: "20260921" } }, categories: ["visualization"],
  }));
  await writeFile(join(root, "neuroimaging", "apps.json"), "{}\n");

  await consolidateDomains(root, domains, {
    sourceCommits: { [repo]: sha }, resolveLicenses,
  });

  const catalog = JSON.parse(await readFile(join(root, "neuroimaging", "apps.json"), "utf8"));
  assert.equal(Object.hasOwn(catalog.demo.apps["demo 1.0"], "doi"), false);
});

test("one account lookup attaches a published DOI across domains", async () => {
  const { root, source } = await fixture();
  await writeFile(join(source, "releases", "demo", "1.0.json"), JSON.stringify({
    apps: { "demo 1.0": { version: "20260921" } }, categories: ["visualization"],
  }));
  await writeFile(join(root, "neuroimaging", "apps.json"), "{}\n");
  let lookups = 0;
  await consolidateDomains(root, domains, {
    sourceCommits: { [repo]: sha }, resolveLicenses,
    lookupDois: async () => { lookups++; return { "demo_1.0_20260921": "10.123/new" }; },
  });
  const catalog = JSON.parse(await readFile(join(root, "neuroimaging", "apps.json"), "utf8"));
  assert.equal(catalog.demo.apps["demo 1.0"].doi, "https://doi.org/10.123/new");
  assert.equal(lookups, 1);
});

test("Zenodo lookup failure does not block catalog generation", async () => {
  const { root, source } = await fixture();
  await writeFile(join(source, "releases", "demo", "1.0.json"), JSON.stringify({
    apps: { "demo 1.0": { version: "20260921" } }, categories: ["visualization"],
  }));
  await writeFile(join(root, "neuroimaging", "apps.json"), "{}\n");
  await consolidateDomains(root, domains, {
    sourceCommits: { [repo]: sha }, resolveLicenses,
    lookupDois: async () => { throw new Error("Zenodo unavailable"); },
  });
  const catalog = JSON.parse(await readFile(join(root, "neuroimaging", "apps.json"), "utf8"));
  assert.equal(Object.hasOwn(catalog.demo.apps["demo 1.0"], "doi"), false);
});

test("a source missing from its declared domain fails", async () => {
  const { root, source } = await fixture();
  await writeFile(join(source, "recipes", "demo", "build.yaml"), "domains: [microscopy]\n");
  await assert.rejects(readSourceDomains(source, await readReleases(source), {
    neuroimaging: { source_repositories: [repo] },
    microscopy: { source_repositories: ["Other/repo"] },
  }, repo), /does not list/);
});

test("two repositories publishing the same app fail with both source names", async () => {
  const { root } = await fixture();
  const second = "Other/containers";
  const source = sourcePath(root, second);
  await mkdir(join(source, "releases", "demo"), { recursive: true });
  await mkdir(join(source, "recipes", "demo"), { recursive: true });
  await writeFile(join(source, "releases", "demo", "1.0.json"), JSON.stringify({
    apps: { "demo 1.0": { version: "20260921" } }, categories: ["visualization"],
  }));
  await writeFile(join(source, "recipes", "demo", "build.yaml"), "domains: [neuroimaging]\n");
  const configured = { neuroimaging: { source_repositories: [repo, second] } };
  await assert.rejects(consolidateDomains(root, configured, {
    sourceCommits: { [repo]: sha, [second]: "b".repeat(40) }, doiDelayMs: 0,
  }), /Duplicate app.*Example\/containers.*Other\/containers/);
});

test("duplicate app identity across separate domains fails", async () => {
  const { root } = await fixture();
  const second = "Other/containers";
  const source = sourcePath(root, second);
  await mkdir(join(source, "releases", "demo"), { recursive: true });
  await mkdir(join(source, "recipes", "demo"), { recursive: true });
  await writeFile(join(source, "releases", "demo", "2.0.json"), JSON.stringify({
    apps: { "demo 1.0": { version: "20261010" } }, categories: ["visualization"],
  }));
  await writeFile(join(source, "recipes", "demo", "build.yaml"), "domains: [microscopy]\n");
  const configured = {
    neuroimaging: { source_repositories: [repo] },
    microscopy: { source_repositories: [second] },
  };
  await assert.rejects(consolidateDomains(root, configured, {
    sourceCommits: { [repo]: sha, [second]: "b".repeat(40) }, doiDelayMs: 0,
  }), /Duplicate app.*Example\/containers.*Other\/containers/);
});

async function writeGenerator(source, generated) {
  await mkdir(join(source, "tools"), { recursive: true });
  await writeFile(join(source, "tools", "generate_apps_json.py"), [
    "import json, os, sys",
    "args = dict(zip(sys.argv[1::2], sys.argv[2::2]))",
    "if 'ZENODO_TOKEN' in os.environ: sys.exit('ZENODO_TOKEN reached the generator')",
    "if not os.path.isfile(os.path.join(args['--releases-dir'], 'demo', '1.0.json')): sys.exit('no releases')",
    generated === null ? "sys.exit('recipe compile exploded')" :
      `json.dump(json.loads(${JSON.stringify(JSON.stringify(generated))}), open(args['--output'], 'w'))`,
  ].join("\n"));
}

async function publishedText(root, text) {
  await writeFile(join(root, "neuroimaging", "apps.json"), JSON.stringify({
    demo: { apps: {}, categories: [], ...text },
  }));
}

async function runWithToken(root) {
  process.env.ZENODO_TOKEN = "secret";
  try {
    await consolidateDomains(root, domains, {
      sourceCommits: { [repo]: sha }, resolveLicenses, publishedDois: {},
    });
  } finally {
    delete process.env.ZENODO_TOKEN;
  }
  return JSON.parse(await readFile(join(root, "neuroimaging", "apps.json"), "utf8"));
}

test("the source generator's citation and description reach the catalog by tool", async () => {
  const { root, source } = await fixture();
  await writeGenerator(source, {
    demo: { apps: {}, categories: [], citation: "Demo et al. 2024", description: "Demo tool." },
    unreleased: { citation: "Not in this catalog" },
  });
  const catalog = await runWithToken(root);
  assert.deepEqual(Object.keys(catalog.demo), ["apps", "categories", "citation", "description"]);
  assert.equal(catalog.demo.citation, "Demo et al. 2024");
  assert.equal(catalog.demo.description, "Demo tool.");
  assert.equal(Object.hasOwn(catalog, "unreleased"), false);
});

test("fields the generator omits or leaves blank are absent, replacing published text", async () => {
  const { root, source } = await fixture();
  await publishedText(root, { citation: "Old citation", description: "Old description" });
  await writeGenerator(source, { demo: { apps: {}, categories: [], citation: "  " } });
  const catalog = await runWithToken(root);
  assert.equal(Object.hasOwn(catalog.demo, "citation"), false);
  assert.equal(Object.hasOwn(catalog.demo, "description"), false);
});

test("a source without a generator yields no tool text", async () => {
  const { root } = await fixture();
  await publishedText(root, { citation: "Old citation" });
  const catalog = await runWithToken(root);
  assert.deepEqual(Object.keys(catalog.demo), ["apps", "categories"]);
  assert.deepEqual(Object.keys(catalog.demo.apps), ["demo 1.0"]);
});

test("a failing generator warns and keeps the published text", async () => {
  const { root, source } = await fixture();
  await publishedText(root, { citation: "Old citation", description: "Old description" });
  await writeGenerator(source, null);
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  let catalog;
  try {
    catalog = await runWithToken(root);
  } finally {
    console.warn = warn;
  }
  assert.equal(catalog.demo.citation, "Old citation");
  assert.equal(catalog.demo.description, "Old description");
  assert.deepEqual(Object.keys(catalog.demo.apps), ["demo 1.0"]);
  assert.match(warnings.join("\n"), /Example\/containers.*generate_apps_json\.py failed: recipe compile exploded/);
});

test("the generator's description wins and the recipe readme fills a gap", async () => {
  const { root, source } = await fixture();
  await writeFile(join(source, "recipes", "demo", "build.yaml"),
    "domains: [neuroimaging]\nreadme: |\n  ## demo/1.0 ##\n  From the recipe readme.\n");
  await writeGenerator(source, { demo: { citation: "Demo et al. 2024" } });
  let catalog = await runWithToken(root);
  assert.equal(catalog.demo.citation, "Demo et al. 2024");
  assert.equal(catalog.demo.description, "From the recipe readme.");
  await writeGenerator(source, { demo: { description: "From the generator." } });
  catalog = await runWithToken(root);
  assert.equal(catalog.demo.description, "From the generator.");
  assert.equal(Object.hasOwn(catalog.demo, "citation"), false);
});

test("supports hybrid and EESSI-only domains in readDomains, outputPaths, and consolidation checks", async () => {
  const { root } = await fixture();
  const configured = {
    neuroimaging: {
      source_repositories: [repo],
      eessi_stacks: ["2025.06"],
      eessiCatalogUrl: "https://apps-catalog.example.workers.dev/neuroimaging/eessi.json",
    },
    hpc: {
      source_repositories: [],
      eessi_stacks: ["2025.06"],
      eessiCatalogUrl: "https://apps-catalog.example.workers.dev/hpc/eessi.json",
    },
  };
  await writeFile(join(root, "domains.json"), JSON.stringify({ schemaVersion: 1, domains: configured }));
  const parsed = await readDomains(root);
  assert.deepEqual(Object.keys(parsed), ["hpc", "neuroimaging"]);
  assert.deepEqual(eessiOutputPaths(parsed), [
    "hpc/eessi.json",
    "neuroimaging/eessi.json",
    "eessi/catalog.json",
  ]);
  assert.deepEqual(outputPaths(parsed), [
    "hpc/apps.json",
    "hpc/manifest.json",
    "neuroimaging/apps.json",
    "neuroimaging/manifest.json",
    "hpc/eessi.json",
    "neuroimaging/eessi.json",
    "eessi/catalog.json",
  ]);

  // First consolidate neuroimaging so its container outputs are up to date,
  // then verify adding a brand-new EESSI-only domain does NOT trigger
  // container consolidation (or Zenodo DOI publication), only EESSI consolidation.
  await consolidateDomains(root, { neuroimaging: configured.neuroimaging }, {
    sourceCommits: { [repo]: sha }, resolveLicenses, publishedDois: {},
  });
  assert.equal(await needsConsolidation(root, parsed), false);
  assert.equal(await needsEessiConsolidation(root, parsed), true);

  const validDomainEessi = JSON.stringify({
    schemaVersion: 1,
    backend: "eessi",
    explicitSelectionRequired: true,
    cvmfsRepo: "software.eessi.io",
    stacks: ["2025.06"],
    tools: {},
  });
  const validGlobalEessi = JSON.stringify({
    schemaVersion: 1,
    backend: "eessi",
    explicitSelectionRequired: true,
    cvmfsRepo: "software.eessi.io",
    stacks: ["2025.06"],
    domain_stacks: { hpc: ["2025.06"], neuroimaging: ["2025.06"] },
    tools: {},
  });
  await mkdir(join(root, "hpc"), { recursive: true });
  await writeFile(join(root, "hpc", "apps.json"), "{}\n");
  await writeFile(join(root, "hpc", "manifest.json"), JSON.stringify({ entries: 0, source_commits: {}, app_sources: {} }));
  await mkdir(join(root, "eessi"), { recursive: true });
  await writeFile(join(root, "hpc", "eessi.json"), validDomainEessi);
  await writeFile(join(root, "neuroimaging", "eessi.json"), validDomainEessi);
  await writeFile(join(root, "eessi", "catalog.json"), validGlobalEessi);
  assert.equal(await needsEessiConsolidation(root, parsed), false);

  // Malformed JSON or structurally corrupt EESSI-only compatibility files trigger repair
  // instead of throwing, and scheduled container consolidation repairs them cleanly.
  for (const corrupt of ["{broken", '{"stale":null}', '{"stale":{"apps":{"x":null}}}']) {
    await writeFile(join(root, "hpc", "apps.json"), corrupt);
    assert.equal(await needsEessiConsolidation(root, parsed), true, corrupt);
    await consolidateDomains(root, parsed, {
      sourceCommits: { [repo]: sha }, resolveLicenses, publishedDois: {},
    });
    assert.deepEqual(JSON.parse(await readFile(join(root, "hpc", "apps.json"), "utf8")), {}, corrupt);
    assert.equal(await needsEessiConsolidation(root, parsed), false, corrupt);
  }

  // Disabling EESSI on one of two enabled domains triggers EESSI regeneration
  // so stale tools/stacks are removed from the global eessi/catalog.json.
  const onlyHpc = {
    hpc: parsed.hpc,
    neuroimaging: { source_repositories: [repo] },
  };
  assert.equal(await needsConsolidation(root, onlyHpc), false);
  assert.equal(await needsEessiConsolidation(root, onlyHpc), true);

  // Changing eessi_stacks triggers EESSI regeneration without container regeneration.
  parsed.hpc.eessi_stacks = ["2025.06", "2023.06"];
  assert.equal(await needsConsolidation(root, parsed), false);
  assert.equal(await needsEessiConsolidation(root, parsed), true);

  // Rejects empty source_repositories without eessi_stacks and bad eessi_stacks.
  await writeFile(join(root, "domains.json"), JSON.stringify({
    domains: { empty: { source_repositories: [] } },
  }));
  await assert.rejects(readDomains(root), /Invalid source_repositories/);
  await writeFile(join(root, "domains.json"), JSON.stringify({
    domains: { bad: { source_repositories: [repo], eessi_stacks: ["2025"] } },
  }));
  await assert.rejects(readDomains(root), /Invalid eessi_stacks/);
});

test("converting a domain to EESSI-only preserves stored licenses and DOIs across corrupt manifests and destination retries", async () => {
  const { root, source } = await fixture();
  // Use a release with no embedded DOI so stored DOI carry-over is isolated.
  await writeFile(join(source, "releases", "demo", "1.0.json"), JSON.stringify({
    apps: { "demo 1.0": { version: "20260921" } },
    categories: ["visualization"],
  }));
  // Converted domain ("a-legacy") sorts BEFORE destination ("z-target").
  await mkdir(join(root, "a-legacy"), { recursive: true });
  await mkdir(join(root, "z-target"), { recursive: true });
  await writeFile(join(root, "a-legacy", "apps.json"), JSON.stringify({
    demo: {
      apps: {
        "demo 1.0": {
          image: "demo_1.0",
          version: "20260921",
          doi: "https://doi.org/10.123/stored",
          license: ["MIT"],
        },
      },
      categories: ["visualization"],
    },
  }));
  // Corrupt manifest on the converted domain must not hide its valid apps.json or drop its stored DOI.
  await writeFile(join(root, "a-legacy", "manifest.json"), "{corrupt");
  await writeFile(join(root, "z-target", "apps.json"), "{}\n");
  await writeFile(join(root, "z-target", "manifest.json"), JSON.stringify({
    entries: 0,
    source_commits: { [repo]: sha },
    app_sources: {},
  }));
  await writeFile(join(source, "recipes", "demo", "build.yaml"), "domains: [z-target]\n");

  const converted = {
    "a-legacy": { source_repositories: [], eessi_stacks: ["2025.06"] },
    "z-target": { source_repositories: [repo] },
  };
  assert.equal(await needsConsolidation(root, converted), true);

  // Simulate a destination failure during conversion: a-legacy/apps.json must remain intact for retry.
  await assert.rejects(
    consolidateDomains(root, converted, {
      sourceCommits: { [repo]: sha },
      resolveLicenses: async () => { throw new Error("destination resolver exploded"); },
      publishedDois: {},
    }),
    /destination resolver exploded/,
  );
  assert.ok(JSON.parse(await readFile(join(root, "a-legacy", "apps.json"), "utf8")).demo);

  // Retry succeeds with no recipe history and no Zenodo lookup, preserving BOTH stored MIT license and DOI.
  const noHistoryLicenses = async () => ({ resolved: {}, errors: {} });
  await consolidateDomains(root, converted, {
    sourceCommits: { [repo]: sha },
    resolveLicenses: noHistoryLicenses,
    publishedDois: {},
  });
  assert.deepEqual(JSON.parse(await readFile(join(root, "a-legacy", "apps.json"), "utf8")), {});
  assert.equal(await needsConsolidation(root, converted), false);
  const target = JSON.parse(await readFile(join(root, "z-target", "apps.json"), "utf8"));
  assert.deepEqual(target.demo.apps["demo 1.0"].license, ["MIT"]);
  assert.equal(target.demo.apps["demo 1.0"].doi, "https://doi.org/10.123/stored");

  // Retry after a partial destination write (z-target/apps.json already updated to Apache-2.0
  // while a-legacy/apps.json still holds old MIT) must not fail with Conflicting catalog licenses,
  // and an earlier domain lacking a DOI must not hide a later converted domain's stored DOI.
  await writeFile(join(root, "z-target", "apps.json"), JSON.stringify({
    demo: {
      apps: {
        "demo 1.0": { image: "demo_1.0", version: "20260921", license: ["Apache-2.0"] },
      },
      categories: ["visualization"],
    },
  }));
  await writeFile(join(root, "a-legacy", "apps.json"), JSON.stringify({
    demo: {
      apps: {
        "demo 1.0": {
          image: "demo_1.0",
          version: "20260921",
          doi: "https://doi.org/10.123/from-converted",
          license: ["MIT"],
        },
      },
      categories: ["visualization"],
    },
  }));
  await consolidateDomains(root, converted, {
    sourceCommits: { [repo]: sha },
    resolveLicenses: noHistoryLicenses,
    publishedDois: {},
  });
  const afterPartial = JSON.parse(await readFile(join(root, "z-target", "apps.json"), "utf8"));
  assert.deepEqual(afterPartial.demo.apps["demo 1.0"].license, ["Apache-2.0"]);
  assert.equal(afterPartial.demo.apps["demo 1.0"].doi, "https://doi.org/10.123/from-converted");
  assert.deepEqual(JSON.parse(await readFile(join(root, "a-legacy", "apps.json"), "utf8")), {});

  // Also test when the domain WITHOUT a DOI ("a-dest") sorts BEFORE the converted domain WITH the DOI ("z-old").
  await mkdir(join(root, "a-dest"), { recursive: true });
  await mkdir(join(root, "z-old"), { recursive: true });
  await writeFile(join(root, "a-dest", "apps.json"), JSON.stringify({
    demo: { apps: { "demo 1.0": { image: "demo_1.0", version: "20260921", license: ["MIT"] } } },
  }));
  await writeFile(join(root, "z-old", "apps.json"), JSON.stringify({
    demo: {
      apps: {
        "demo 1.0": {
          image: "demo_1.0",
          version: "20260921",
          doi: "https://doi.org/10.123/from-z-old",
          license: ["MIT"],
        },
      },
    },
  }));
  await writeFile(join(source, "recipes", "demo", "build.yaml"), "domains: [a-dest]\n");
  await consolidateDomains(root, {
    "a-dest": { source_repositories: [repo] },
    "z-old": { source_repositories: [], eessi_stacks: ["2025.06"] },
  }, {
    sourceCommits: { [repo]: sha },
    resolveLicenses: noHistoryLicenses,
    publishedDois: {},
  });
  const destAfter = JSON.parse(await readFile(join(root, "a-dest", "apps.json"), "utf8"));
  assert.equal(destAfter.demo.apps["demo 1.0"].doi, "https://doi.org/10.123/from-z-old");
  assert.deepEqual(JSON.parse(await readFile(join(root, "z-old", "apps.json"), "utf8")), {});

  // An older build under the same launcher name in an earlier converted domain must not hide
  // the current build's stored DOI in the destination domain.
  await writeFile(join(root, "a-legacy", "apps.json"), JSON.stringify({
    demo: { apps: { "demo 1.0": { image: "demo_1.0", version: "20200101", license: ["MIT"] } } },
  }));
  await writeFile(join(root, "z-target", "apps.json"), JSON.stringify({
    demo: {
      apps: {
        "demo 1.0": {
          image: "demo_1.0",
          version: "20260921",
          doi: "https://doi.org/10.123/current-build",
          license: ["MIT"],
        },
      },
    },
  }));
  await writeFile(join(source, "recipes", "demo", "build.yaml"), "domains: [z-target]\n");
  await consolidateDomains(root, converted, {
    sourceCommits: { [repo]: sha },
    resolveLicenses: noHistoryLicenses,
    publishedDois: {},
  });
  const currentTarget = JSON.parse(await readFile(join(root, "z-target", "apps.json"), "utf8"));
  assert.equal(currentTarget.demo.apps["demo 1.0"].doi, "https://doi.org/10.123/current-build");
});
