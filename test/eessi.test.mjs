import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import {
  buildEessiCatalog,
  compareVersionEntries,
  compareVersionStrings,
  consolidateEessi,
  CURATION_PATH,
  fetchEessiFeed,
  GLOBAL_EESSI_CATALOG_PATH,
  readCuration,
  selectVersionsForStack,
  validateCuration,
  validateEessiCatalog,
} from "../scripts/eessi.mjs";
import { readDomains } from "../scripts/workflow.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;

function makeVersion({
  pkg = "ParaView",
  version = "6.0.1",
  tcName = "foss",
  tcVersion = "2025b",
  suffix = "",
  stack = "2025.06",
  cpuArch = ["aarch64/generic", "x86_64/amd/zen4", "x86_64/intel/icelake"],
  gpuArch = {},
  description = "A scientific tool.",
  homepage = "https://example.org/tool",
  license = [],
} = {}) {
  const modVer = tcName === "system"
    ? `${version}${suffix}`
    : `${version}-${tcName}-${tcVersion}${suffix}`;
  return {
    version,
    versionsuffix: suffix,
    homepage,
    description,
    license,
    toolchain: { name: tcName, version: tcVersion },
    module: {
      full_module_name: `${pkg}/${modVer}`,
      module_name: pkg,
      module_version: modVer,
    },
    required_modules: [{ full_module_name: `EESSI/${stack}`, module_name: "EESSI", module_version: stack }],
    cpu_arch: cpuArch,
    gpu_arch: gpuArch,
  };
}

function sampleCuration(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceUrl: "https://www.eessi.io/api_data/data/eessi_api_metadata_software.json",
    cvmfsRepo: "software.eessi.io",
    packages: {
      ParaView: {
        id: "paraview",
        domains: ["neuroimaging", "microscopy"],
        categories: ["visualization"],
        launchers: [
          { name: "ParaView", exec: ["paraview"], gui: true, show_in_menu: true, show_in_applist: true },
        ],
      },
      GROMACS: {
        id: "gromacs",
        domains: ["molecular-imaging"],
        categories: ["molecular biology"],
        gpu: "optional",
        launchers: [
          { name: "GROMACS", exec: ["gmx"], gui: false, show_in_menu: false, show_in_applist: true },
        ],
      },
    },
    ...overrides,
  };
}

const sampleDomains = {
  neuroimaging: { source_repositories: ["NeuroDesk/neurocontainers"], eessi_stacks: ["2025.06"] },
  microscopy: { source_repositories: ["NeuroDesk/neurocontainers"] },
  "molecular-imaging": { source_repositories: [], eessi_stacks: ["2025.06"] },
};

test("the repository's eessi/curation.yaml is valid and covers every EESSI-enabled domain", async () => {
  const domains = await readDomains(repoRoot);
  const curation = await readCuration(repoRoot, domains);
  assert.equal(curation.schemaVersion, 1);
  assert.ok(Object.keys(curation.packages).length >= 20);
  const covered = new Set(Object.values(curation.packages).flatMap((pkg) => pkg.domains));
  for (const [domain, config] of Object.entries(domains)) {
    if (Array.isArray(config.eessi_stacks) && config.eessi_stacks.length > 0) {
      assert.ok(covered.has(domain), `expected curated EESSI tools for EESSI-enabled domain ${domain}`);
    }
  }
});

test("validateCuration rejects malformed manifests and unsafe exec arguments", () => {
  assert.doesNotThrow(() => validateCuration(sampleCuration(), sampleDomains));
  for (const [label, mutator, pattern] of [
    ["wrong schemaVersion", (c) => { c.schemaVersion = 2; }, /schemaVersion/],
    ["http sourceUrl", (c) => { c.sourceUrl = "http://example.org/feed.json"; }, /sourceUrl/],
    ["bad cvmfsRepo", (c) => { c.cvmfsRepo = "../etc"; }, /cvmfsRepo/],
    ["bad package name", (c) => { c.packages["../bad"] = c.packages.ParaView; }, /Invalid EESSI package name/],
    ["unknown domain", (c) => { c.packages.ParaView.domains = ["unknown"]; }, /Unknown domain/],
    ["duplicate tool id", (c) => { c.packages.GROMACS.id = "paraview"; }, /Duplicate EESSI tool id/],
    ["bad gpu policy", (c) => { c.packages.ParaView.gpu = "maybe"; }, /Invalid gpu policy/],
    ["bad regex", (c) => { c.packages.ParaView.version_pattern = "[unclosed"; }, /version_pattern/],
    ["unsafe exec semicolon", (c) => { c.packages.ParaView.launchers[0].exec = ["paraview;id"]; }, /Invalid exec argv/],
    ["unsafe exec spaces", (c) => { c.packages.ParaView.launchers[0].exec = ["octave --gui"]; }, /Invalid exec argv/],
    ["markup in launcher name", (c) => { c.packages.ParaView.launchers[0].name = "<img src=x>"; }, /Invalid launcher name/],
    ["non-boolean gui", (c) => { c.packages.ParaView.launchers[0].gui = "yes"; }, /gui must be boolean/],
    ["bad pin module", (c) => { c.packages.ParaView.pin = "ParaView;sh"; }, /Invalid pin module/],
    ["cross-package pin module", (c) => { c.packages.ParaView.pin = "GROMACS/2026.2"; }, /Invalid pin module/],
    ["unknown top-level key", (c) => { c.extraField = true; }, /Unknown key "extraField"/],
    ["unknown package key typo", (c) => { c.packages.ParaView.versionPattern = "^6\\."; }, /Unknown key "versionPattern"/],
    ["unknown launcher key typo", (c) => { c.packages.ParaView.launchers[0].execArgs = []; }, /Unknown key "execArgs"/],
  ]) {
    const doc = structuredClone(sampleCuration());
    mutator(doc);
    assert.throws(() => validateCuration(doc, sampleDomains), pattern, label);
  }
});

test("version comparison handles numeric versions, toolchains, suffixes, prereleases, and date versions", () => {
  assert.ok(compareVersionStrings("11.1.0", "10.3.0") > 0);
  assert.ok(compareVersionStrings("0.10.0.post5", "0.10.0") > 0);
  assert.ok(compareVersionStrings("1.0.0", "1.0.0rc1") > 0);
  assert.ok(compareVersionStrings("1.0", "1.0.0rc1") > 0);
  assert.ok(compareVersionStrings("1.0", "1.0a1") > 0);
  assert.ok(compareVersionStrings("1.0", "1.0b1") > 0);
  assert.ok(compareVersionStrings("1.0b1", "1.0a1") > 0);
  assert.ok(compareVersionStrings("1.0a10", "1.0alpha2") > 0);
  assert.ok(compareVersionStrings("1.0b10", "1.0beta2") > 0);
  assert.ok(compareVersionStrings("1.0b1", "1.0dev1") > 0);
  assert.ok(compareVersionStrings("1.0a1", "1.0dev1") > 0);
  assert.ok(compareVersionStrings("1.0rc1", "1.0b1") > 0);
  assert.ok(compareVersionStrings("1.0.post1", "1.0b1") > 0);
  assert.ok(compareVersionStrings("2025b", "2025a") > 0);
  assert.ok(compareVersionStrings("22Jul2025_update4", "22Jul2025") > 0);
  assert.ok(compareVersionStrings("22Jul2025", "15Aug2024") > 0);

  const olderTc = makeVersion({ version: "6.0.1", tcVersion: "2025a" });
  const newerTc = makeVersion({ version: "6.0.1", tcVersion: "2025b" });
  assert.ok(compareVersionEntries(newerTc, olderTc) > 0);

  const plain = makeVersion({ pkg: "GROMACS", version: "2025.2", tcVersion: "2025a", suffix: "" });
  const plumed = makeVersion({ pkg: "GROMACS", version: "2025.2", tcVersion: "2025a", suffix: "-PLUMED-2.9.4" });
  assert.ok(compareVersionEntries(plain, plumed) > 0);
});

test("selectVersionsForStack picks latest CPU, optional GPU, version_pattern, and explicit pins", () => {
  const gromacsFeed = {
    versions: [
      makeVersion({ pkg: "GROMACS", version: "2025.2", tcVersion: "2025a" }),
      makeVersion({ pkg: "GROMACS", version: "2026.2", tcVersion: "2025b" }),
      makeVersion({ pkg: "GROMACS", version: "2026.2", tcVersion: "2025b", suffix: "-PLUMED-2.9.4" }),
      makeVersion({
        pkg: "GROMACS", version: "2026.2", tcVersion: "2025b", suffix: "-CUDA-12.9.1",
        gpuArch: { "x86_64/amd/zen4": ["nvidia/cc80", "nvidia/cc90"] },
      }),
      makeVersion({ pkg: "GROMACS", version: "2024.1", tcVersion: "2023b", stack: "2023.06" }),
    ],
  };

  const cpuOnly = selectVersionsForStack(gromacsFeed, "2025.06", { gpu: "exclude" });
  assert.deepEqual(cpuOnly.map((v) => v.module.full_module_name), ["GROMACS/2026.2-foss-2025b"]);

  const optional = selectVersionsForStack(gromacsFeed, "2025.06", { gpu: "optional" });
  assert.deepEqual(optional.map((v) => v.module.full_module_name), [
    "GROMACS/2026.2-foss-2025b",
    "GROMACS/2026.2-foss-2025b-CUDA-12.9.1",
  ]);

  const gpuOnly = selectVersionsForStack(gromacsFeed, "2025.06", { gpu: "only" });
  assert.deepEqual(gpuOnly.map((v) => v.module.full_module_name), [
    "GROMACS/2026.2-foss-2025b-CUDA-12.9.1",
  ]);

  const patterned = selectVersionsForStack(gromacsFeed, "2025.06", {
    gpu: "exclude", version_pattern: "^2025\\.",
  });
  assert.deepEqual(patterned.map((v) => v.module.full_module_name), ["GROMACS/2025.2-foss-2025a"]);

  const pinned = selectVersionsForStack(gromacsFeed, "2025.06", {
    gpu: "exclude", pin: { "2025.06": "GROMACS/2025.2-foss-2025a" },
  });
  assert.deepEqual(pinned.map((v) => v.module.full_module_name), ["GROMACS/2025.2-foss-2025a"]);

  assert.throws(
    () => selectVersionsForStack(gromacsFeed, "2025.06", { gpu: "exclude", pin: "GROMACS/missing" }),
    /Pinned EESSI module GROMACS\/missing not found/,
  );
});

test("buildEessiCatalog emits deterministic catalogs with explicitSelectionRequired and rejects bad feed modules", () => {
  const curation = validateCuration(sampleCuration(), sampleDomains);
  const feed = {
    software: {
      ParaView: {
        versions: [
          makeVersion({
            pkg: "ParaView", version: "5.13.2", tcVersion: "2024a",
            description: "Old desc", license: ["BSD-3-Clause"],
          }),
          makeVersion({
            pkg: "ParaView", version: "6.0.1", tcVersion: "2025b",
            description: "ParaView is a\n  scientific visualizer.",
            homepage: "https://www.paraview.org",
            license: ["BSD-3-Clause"],
          }),
        ],
      },
      GROMACS: {
        versions: [
          makeVersion({ pkg: "GROMACS", version: "2026.2", tcVersion: "2025b" }),
          makeVersion({
            pkg: "GROMACS", version: "2026.2", tcVersion: "2025b", suffix: "-CUDA-12.9.1",
            gpuArch: { "x86_64/amd/zen4": ["nvidia/cc90", "nvidia/cc80"] },
          }),
        ],
      },
    },
  };

  const neuro = buildEessiCatalog({ curation, feed, stacks: ["2025.06"], domain: "neuroimaging" });
  validateEessiCatalog(neuro);
  assert.equal(neuro.explicitSelectionRequired, true);
  assert.deepEqual(Object.keys(neuro.tools), ["paraview"]);
  assert.equal(neuro.tools.paraview.description, "ParaView is a scientific visualizer.");
  assert.deepEqual(neuro.tools.paraview.apps["ParaView 6.0.1 (EESSI/2025.06)"], {
    backend: "eessi",
    stack: "2025.06",
    module: "ParaView/6.0.1-foss-2025b",
    required_modules: ["EESSI/2025.06"],
    software_version: "6.0.1",
    toolchain: "foss/2025b",
    arch: ["aarch64", "x86_64"],
    gpu: false,
    exec: ["paraview"],
    gui: true,
    show_in_menu: true,
    show_in_applist: true,
    license: ["BSD-3-Clause"],
  });

  const mol = buildEessiCatalog({ curation, feed, stacks: ["2025.06"], domain: "molecular-imaging" });
  assert.deepEqual(Object.keys(mol.tools.gromacs.apps), [
    "GROMACS 2026.2 (EESSI/2025.06)",
    "GROMACS 2026.2 (EESSI/2025.06, GPU)",
  ]);
  assert.deepEqual(mol.tools.gromacs.apps["GROMACS 2026.2 (EESSI/2025.06, GPU)"].gpu_targets, [
    "nvidia/cc80",
    "nvidia/cc90",
  ]);

  const maliciousFeed = {
    software: {
      ParaView: {
        versions: [
          { ...makeVersion({ pkg: "ParaView" }), module: { full_module_name: "ParaView/6.0;rm -rf /" } },
        ],
      },
    },
  };
  assert.throws(
    () => buildEessiCatalog({ curation, feed: maliciousFeed, stacks: ["2025.06"], domain: "neuroimaging" }),
    /Invalid EESSI module name/,
  );

  // A syntactically valid module belonging to another package is rejected.
  const crossPackageFeed = {
    software: {
      ParaView: {
        versions: [
          { ...makeVersion({ pkg: "ParaView" }), module: { full_module_name: "OtherPkg/6.0.1-foss-2025b" } },
        ],
      },
    },
  };
  assert.throws(
    () => buildEessiCatalog({ curation, feed: crossPackageFeed, stacks: ["2025.06"], domain: "neuroimaging" }),
    /Invalid EESSI module name/,
  );

  // A pinned package omitted from the feed fails loudly instead of silently skipping.
  const pinnedCuration = validateCuration(
    sampleCuration({
      packages: {
        ParaView: {
          ...sampleCuration().packages.ParaView,
          pin: { "2025.06": "ParaView/6.0.1-foss-2025b" },
        },
      },
    }),
    sampleDomains,
  );
  assert.throws(
    () => buildEessiCatalog({
      curation: pinnedCuration,
      feed: { software: { GROMACS: { versions: [makeVersion({ pkg: "GROMACS" })] } } },
      stacks: ["2025.06"],
      domain: "neuroimaging",
    }),
    /Pinned EESSI package ParaView \(ParaView\/6\.0\.1-foss-2025b\) not found in feed for EESSI\/2025\.06/,
  );
});

test("validateEessiCatalog validates nested launchers, modules, stacks, and domain_stacks", () => {
  const base = {
    schemaVersion: 1,
    backend: "eessi",
    explicitSelectionRequired: true,
    cvmfsRepo: "software.eessi.io",
    stacks: ["2025.06"],
    tools: {
      paraview: {
        package: "ParaView",
        categories: ["visualization"],
        apps: {
          "ParaView 6.0.1 (EESSI/2025.06)": {
            backend: "eessi",
            stack: "2025.06",
            module: "ParaView/6.0.1-foss-2025b",
            required_modules: ["EESSI/2025.06"],
            software_version: "6.0.1",
            arch: ["x86_64"],
            gpu: false,
            exec: ["paraview"],
            gui: true,
          },
        },
      },
    },
  };
  assert.doesNotThrow(() => validateEessiCatalog(base, "x.json", { expectedStacks: ["2025.06"] }));
  assert.throws(
    () => validateEessiCatalog(base, "x.json", { expectedStacks: ["2025.06", "2023.06"] }),
    /do not match configured/,
  );

  for (const [label, mutate, pattern] of [
    ["undeclared stack", (c) => { c.tools.paraview.apps["ParaView 6.0.1 (EESSI/2025.06)"].stack = "2023.06"; }, /undeclared stack/],
    ["unsafe exec", (c) => { c.tools.paraview.apps["ParaView 6.0.1 (EESSI/2025.06)"].exec = ["paraview;sh"]; }, /invalid exec argv/],
    ["cross-package module", (c) => { c.tools.paraview.apps["ParaView 6.0.1 (EESSI/2025.06)"].module = "Other/1.0"; }, /invalid module/],
    ["bad required_modules", (c) => { c.tools.paraview.apps["ParaView 6.0.1 (EESSI/2025.06)"].required_modules = ["EESSI/2023.06"]; }, /invalid required_modules/],
    ["unsafe software_version", (c) => { c.tools.paraview.apps["ParaView 6.0.1 (EESSI/2025.06)"].software_version = "6.0.1<script>"; }, /invalid software_version/],
    ["unsafe toolchain", (c) => { c.tools.paraview.apps["ParaView 6.0.1 (EESSI/2025.06)"].toolchain = "foss;sh"; }, /invalid toolchain/],
  ]) {
    const copy = structuredClone(base);
    mutate(copy);
    assert.throws(() => validateEessiCatalog(copy, "x.json"), pattern, label);
  }
});

test("consolidateEessi writes domain, global, and EESSI-only compat catalogs; failSoft preserves files on empty/malformed feeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "eessi-consolidate-"));
  await mkdir(join(root, "eessi"));
  await writeFile(join(root, CURATION_PATH), YAML.stringify(sampleCuration()));

  const feed = {
    software: {
      ParaView: { versions: [makeVersion({ pkg: "ParaView", version: "6.0.1", tcVersion: "2025b" })] },
      GROMACS: { versions: [makeVersion({ pkg: "GROMACS", version: "2026.2", tcVersion: "2025b" })] },
    },
  };
  const fetchOk = async () => new Response(JSON.stringify(feed), { status: 200 });

  const result = await consolidateEessi(root, sampleDomains, { fetchImpl: fetchOk });
  assert.equal(result.updated, true);
  assert.deepEqual(result.written, [
    "molecular-imaging/apps.json",
    "molecular-imaging/manifest.json",
    "molecular-imaging/eessi.json",
    "neuroimaging/eessi.json",
    GLOBAL_EESSI_CATALOG_PATH,
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(root, "molecular-imaging", "apps.json"), "utf8")), {});
  const neuroText = await readFile(join(root, "neuroimaging", "eessi.json"), "utf8");
  const molText = await readFile(join(root, "molecular-imaging", "eessi.json"), "utf8");
  const globalText = await readFile(join(root, GLOBAL_EESSI_CATALOG_PATH), "utf8");
  const globalCatalog = JSON.parse(globalText);
  assert.deepEqual(Object.keys(globalCatalog.tools), ["gromacs", "paraview"]);
  assert.deepEqual(globalCatalog.domain_stacks, {
    "molecular-imaging": ["2025.06"],
    neuroimaging: ["2025.06"],
  });

  // Fail-soft on HTTP outage preserves previously written files.
  const fetchDown = async () => new Response("unavailable", { status: 503 });
  const soft = await consolidateEessi(root, sampleDomains, { fetchImpl: fetchDown, failSoft: true });
  assert.equal(soft.updated, false);
  assert.match(soft.error, /HTTP 503/);
  assert.equal(await readFile(join(root, "neuroimaging", "eessi.json"), "utf8"), neuroText);

  // Fail-soft on HTTP 200 empty feed preserves existing files instead of wiping them.
  const fetchEmpty = async () => new Response(JSON.stringify({ software: {} }), { status: 200 });
  const softEmpty = await consolidateEessi(root, sampleDomains, { fetchImpl: fetchEmpty, failSoft: true });
  assert.equal(softEmpty.updated, false);
  assert.match(softEmpty.error, /nonempty software map/);
  assert.equal(await readFile(join(root, "neuroimaging", "eessi.json"), "utf8"), neuroText);
  assert.equal(await readFile(join(root, GLOBAL_EESSI_CATALOG_PATH), "utf8"), globalText);

  // Fail-soft on partially broken feed (valid first domain, broken second domain) writes NOTHING.
  const partialBrokenFeed = {
    software: {
      ParaView: { versions: [makeVersion({ pkg: "ParaView", version: "6.1.0", tcVersion: "2025b" })] },
      GROMACS: { versions: "not-an-array" },
    },
  };
  const softBroken = await consolidateEessi(root, sampleDomains, {
    fetchImpl: async () => new Response(JSON.stringify(partialBrokenFeed), { status: 200 }),
    failSoft: true,
  });
  assert.equal(softBroken.updated, false);
  assert.match(softBroken.error, /Malformed EESSI feed record for GROMACS/);
  assert.equal(await readFile(join(root, "neuroimaging", "eessi.json"), "utf8"), neuroText);
  assert.equal(await readFile(join(root, "molecular-imaging", "eessi.json"), "utf8"), molText);
  assert.equal(await readFile(join(root, GLOBAL_EESSI_CATALOG_PATH), "utf8"), globalText);

  // Fail-soft on malformed records (null package, empty version entry, bad required_modules,
  // or bad GPU target) fails the feed instead of silently dropping tools, and preserves files.
  for (const [label, brokenFeed, pattern] of [
    ["null package record", {
      software: {
        ParaView: null,
        GROMACS: { versions: [makeVersion({ pkg: "GROMACS", version: "2026.2", tcVersion: "2025b" })] },
      },
    }, /Malformed EESSI feed record for ParaView/],
    ["empty version entry", {
      software: {
        ParaView: { versions: [{}] },
        GROMACS: { versions: [makeVersion({ pkg: "GROMACS", version: "2026.2", tcVersion: "2025b" })] },
      },
    }, /Invalid EESSI module name from feed for ParaView/],
    ["empty versions array", {
      software: {
        ParaView: { versions: [] },
        GROMACS: { versions: [makeVersion({ pkg: "GROMACS", version: "2026.2", tcVersion: "2025b" })] },
      },
    }, /missing nonempty versions array/],
    ["empty required_modules array", {
      software: {
        ParaView: { versions: [{ ...makeVersion({ pkg: "ParaView" }), required_modules: [] }] },
        GROMACS: { versions: [makeVersion({ pkg: "GROMACS", version: "2026.2", tcVersion: "2025b" })] },
      },
    }, /Malformed required_modules/],
    ["stack name with trailing whitespace", {
      software: {
        ParaView: {
          versions: [{
            ...makeVersion({ pkg: "ParaView" }),
            required_modules: [{ full_module_name: "EESSI/2025.06 " }],
          }],
        },
        GROMACS: { versions: [makeVersion({ pkg: "GROMACS", version: "2026.2", tcVersion: "2025b" })] },
      },
    }, /Malformed EESSI stack in required_modules/],
    ["malformed required_modules", {
      software: {
        ParaView: { versions: [{ ...makeVersion({ pkg: "ParaView" }), required_modules: "bad" }] },
        GROMACS: { versions: [makeVersion({ pkg: "GROMACS", version: "2026.2", tcVersion: "2025b" })] },
      },
    }, /Malformed required_modules/],
    ["invalid GPU target string", {
      software: {
        ParaView: { versions: [makeVersion({ pkg: "ParaView", version: "6.0.1", tcVersion: "2025b" })] },
        GROMACS: {
          versions: [makeVersion({
            pkg: "GROMACS", version: "2026.2", tcVersion: "2025b", suffix: "-CUDA-12.9.1",
            gpuArch: { "x86_64/amd/zen4": ["not a valid target!"] },
          })],
        },
      },
    }, /Invalid GPU target/],
    ["exotic GPU target object with non-callable toString", {
      software: {
        ParaView: { versions: [makeVersion({ pkg: "ParaView", version: "6.0.1", tcVersion: "2025b" })] },
        GROMACS: {
          versions: [makeVersion({
            pkg: "GROMACS", version: "2026.2", tcVersion: "2025b", suffix: "-CUDA-12.9.1",
            gpuArch: { "x86_64/amd/zen4": [{ toString: null }] },
          })],
        },
      },
    }, /Invalid GPU target object/],
    ["malformed version object with non-callable toString", {
      software: {
        ParaView: {
          versions: [
            makeVersion({ pkg: "ParaView", version: "6.0.1", tcVersion: "2025a" }),
            { ...makeVersion({ pkg: "ParaView", version: "6.0.1", tcVersion: "2025b" }), version: { toString: null } },
          ],
        },
        GROMACS: { versions: [makeVersion({ pkg: "GROMACS", version: "2026.2", tcVersion: "2025b" })] },
      },
    }, /Malformed version in EESSI feed/],
    ["malformed toolchain.version object with non-callable toString", {
      software: {
        ParaView: {
          versions: [
            makeVersion({ pkg: "ParaView", version: "6.0.1", tcVersion: "2025a" }),
            {
              ...makeVersion({ pkg: "ParaView", version: "6.0.1", tcVersion: "2025b" }),
              toolchain: { name: "foss", version: { toString: null } },
            },
          ],
        },
        GROMACS: { versions: [makeVersion({ pkg: "GROMACS", version: "2026.2", tcVersion: "2025b" })] },
      },
    }, /Malformed toolchain in EESSI feed/],
  ]) {
    const softBad = await consolidateEessi(root, sampleDomains, {
      fetchImpl: async () => new Response(JSON.stringify(brokenFeed), { status: 200 }),
      failSoft: true,
    });
    assert.equal(softBad.updated, false, label);
    assert.match(softBad.error, pattern, label);
    assert.equal(await readFile(join(root, "neuroimaging", "eessi.json"), "utf8"), neuroText, label);
    assert.equal(await readFile(join(root, GLOBAL_EESSI_CATALOG_PATH), "utf8"), globalText, label);
  }

  // Standalone consolidateEessi refuses to wipe a converted domain that still holds
  // container entries in apps.json (even on outage with failSoft), requiring container
  // consolidation first so stored licenses and DOIs carry over.
  const staleContainerApps = JSON.stringify({
    stale: { apps: { "stale 1.0": { image: "stale_1.0", version: "20260101", license: ["MIT"] } } },
  });
  await writeFile(join(root, "molecular-imaging", "apps.json"), staleContainerApps);
  await assert.rejects(
    consolidateEessi(root, sampleDomains, { fetchImpl: fetchDown, failSoft: true }),
    /still has container entries or source_commits; run container consolidation/,
  );
  assert.equal(await readFile(join(root, "molecular-imaging", "apps.json"), "utf8"), staleContainerApps);

  // Unreadable apps.json (non-ENOENT fs error such as EACCES) propagates instead of overwriting.
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    const appsFile = join(root, "molecular-imaging", "apps.json");
    await chmod(appsFile, 0o000);
    try {
      await assert.rejects(
        consolidateEessi(root, sampleDomains, { fetchImpl: fetchDown, failSoft: true }),
        (error) => error.code === "EACCES",
      );
    } finally {
      await chmod(appsFile, 0o644);
    }
    assert.equal(await readFile(appsFile, "utf8"), staleContainerApps);
  }

  // Corrupt (non-container) compatibility stubs are repaired independently of the feed.
  await writeFile(join(root, "molecular-imaging", "apps.json"), "{broken");
  const softRepair = await consolidateEessi(root, sampleDomains, { fetchImpl: fetchDown, failSoft: true });
  assert.equal(softRepair.updated, true);
  assert.deepEqual(softRepair.written, ["molecular-imaging/apps.json", "molecular-imaging/manifest.json"]);
  assert.match(softRepair.error, /HTTP 503/);
  assert.deepEqual(JSON.parse(await readFile(join(root, "molecular-imaging", "apps.json"), "utf8")), {});
  assert.equal(await readFile(join(root, "molecular-imaging", "eessi.json"), "utf8"), molText);

  // A partial HTTP 200 feed omitting a curated package preserves committed two-tool catalogs.
  const twoToolDomains = {
    neuroimaging: { source_repositories: ["NeuroDesk/neurocontainers"], eessi_stacks: ["2025.06"] },
  };
  const twoToolCuration = sampleCuration({
    packages: {
      ParaView: {
        ...sampleCuration().packages.ParaView,
        domains: ["neuroimaging"],
      },
      GROMACS: {
        ...sampleCuration().packages.GROMACS,
        domains: ["neuroimaging"],
      },
    },
  });
  await writeFile(join(root, CURATION_PATH), YAML.stringify(twoToolCuration));
  await consolidateEessi(root, twoToolDomains, { fetchImpl: fetchOk });
  const twoToolBefore = await readFile(join(root, "neuroimaging", "eessi.json"), "utf8");
  const oneToolFeed = {
    software: {
      ParaView: { versions: [makeVersion({ pkg: "ParaView", version: "6.0.1", tcVersion: "2025b" })] },
    },
  };
  const softTruncated = await consolidateEessi(root, twoToolDomains, {
    fetchImpl: async () => new Response(JSON.stringify(oneToolFeed), { status: 200 }),
    failSoft: true,
  });
  assert.equal(softTruncated.updated, false);
  assert.match(softTruncated.error, /Curated EESSI package GROMACS is missing from feed/);
  assert.equal(await readFile(join(root, "neuroimaging", "eessi.json"), "utf8"), twoToolBefore);

  // Without failSoft, fetch failures throw.
  await assert.rejects(
    fetchEessiFeed("https://example.org/eessi.json", { fetchImpl: fetchDown }),
    /HTTP 503/,
  );

  // Even with failSoft, invalid curation fails strictly.
  await writeFile(join(root, CURATION_PATH), "schemaVersion: 99\n");
  await assert.rejects(
    consolidateEessi(root, sampleDomains, { fetchImpl: fetchOk, failSoft: true }),
    /schemaVersion must be 1/,
  );
});

test("consolidateEessi is a no-op (after validating curation) when no domain configures eessi_stacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "eessi-noop-"));
  await mkdir(join(root, "eessi"));
  await writeFile(join(root, CURATION_PATH), YAML.stringify(sampleCuration()));
  const containerOnlyDomains = {
    neuroimaging: { source_repositories: ["NeuroDesk/neurocontainers"] },
    microscopy: { source_repositories: ["NeuroDesk/neurocontainers"] },
    "molecular-imaging": { source_repositories: ["NeuroDesk/neurocontainers"] },
  };
  const res = await consolidateEessi(root, containerOnlyDomains, {
    fetchImpl: async () => assert.fail("must not fetch when no domain enables eessi_stacks"),
  });
  assert.equal(res.updated, false);
  assert.deepEqual(res.written, []);
});

test("global eessi/catalog.json merges per-domain stacks without leaking stacks across domains or breaking pins", async () => {
  const root = await mkdtemp(join(tmpdir(), "eessi-multistack-"));
  await mkdir(join(root, "eessi"));
  const domains = {
    neuroimaging: { source_repositories: ["NeuroDesk/neurocontainers"], eessi_stacks: ["2025.06"] },
    "molecular-imaging": { source_repositories: [], eessi_stacks: ["2023.06"] },
  };
  const curation = sampleCuration({
    packages: {
      ParaView: {
        id: "paraview",
        domains: ["neuroimaging"],
        categories: ["visualization"],
        pin: "ParaView/6.0.1-foss-2025b",
        launchers: [{ name: "ParaView", exec: ["paraview"], gui: true }],
      },
      GROMACS: {
        id: "gromacs",
        domains: ["molecular-imaging"],
        categories: ["molecular biology"],
        launchers: [{ name: "GROMACS", exec: ["gmx"], gui: false }],
      },
    },
  });
  await writeFile(join(root, CURATION_PATH), YAML.stringify(curation));

  const feed = {
    software: {
      ParaView: {
        versions: [
          makeVersion({ pkg: "ParaView", version: "5.11.1", tcVersion: "2022b", stack: "2023.06" }),
          makeVersion({ pkg: "ParaView", version: "6.0.1", tcVersion: "2025b", stack: "2025.06" }),
        ],
      },
      GROMACS: {
        versions: [
          makeVersion({ pkg: "GROMACS", version: "2024.1", tcVersion: "2023b", stack: "2023.06" }),
          makeVersion({ pkg: "GROMACS", version: "2026.2", tcVersion: "2025b", stack: "2025.06" }),
        ],
      },
    },
  };

  const res = await consolidateEessi(root, domains, { feed });
  assert.equal(res.updated, true);
  const globalCatalog = JSON.parse(await readFile(join(root, GLOBAL_EESSI_CATALOG_PATH), "utf8"));
  assert.deepEqual(globalCatalog.domain_stacks, {
    "molecular-imaging": ["2023.06"],
    neuroimaging: ["2025.06"],
  });
  assert.deepEqual(Object.keys(globalCatalog.tools.paraview.apps), [
    "ParaView 6.0.1 (EESSI/2025.06)",
  ]);
  assert.deepEqual(Object.keys(globalCatalog.tools.gromacs.apps), [
    "GROMACS 2024.1 (EESSI/2023.06)",
  ]);

  // A partial HTTP 200 feed missing an entire configured stack preserves committed catalogs under failSoft.
  const dualDomains = {
    neuroimaging: { source_repositories: ["NeuroDesk/neurocontainers"], eessi_stacks: ["2025.06", "2023.06"] },
  };
  await writeFile(join(root, CURATION_PATH), YAML.stringify(sampleCuration({
    packages: {
      ParaView: {
        id: "paraview",
        domains: ["neuroimaging"],
        categories: ["visualization"],
        launchers: [{ name: "ParaView", exec: ["paraview"], gui: true }],
      },
    },
  })));
  await consolidateEessi(root, dualDomains, { feed });
  const beforeNeuro = await readFile(join(root, "neuroimaging", "eessi.json"), "utf8");
  const beforeGlobal = await readFile(join(root, GLOBAL_EESSI_CATALOG_PATH), "utf8");
  const partialFeed = {
    software: {
      ParaView: {
        versions: [makeVersion({ pkg: "ParaView", version: "6.0.1", tcVersion: "2025b", stack: "2025.06" })],
      },
    },
  };
  const softPartial = await consolidateEessi(root, dualDomains, {
    fetchImpl: async () => new Response(JSON.stringify(partialFeed), { status: 200 }),
    failSoft: true,
  });
  assert.equal(softPartial.updated, false);
  assert.match(softPartial.error, /matched zero curated tools for neuroimaging on stack\(s\): 2023\.06/);
  assert.equal(await readFile(join(root, "neuroimaging", "eessi.json"), "utf8"), beforeNeuro);
  assert.equal(await readFile(join(root, GLOBAL_EESSI_CATALOG_PATH), "utf8"), beforeGlobal);

  // A partial HTTP 200 feed that keeps all package keys and stack coverage via another
  // tool, but drops one package's previously published stack builds, also fails softly.
  await writeFile(join(root, CURATION_PATH), YAML.stringify(sampleCuration({
    packages: {
      ParaView: {
        id: "paraview",
        domains: ["neuroimaging"],
        categories: ["visualization"],
        launchers: [{ name: "ParaView", exec: ["paraview"], gui: true }],
      },
      GROMACS: {
        id: "gromacs",
        domains: ["neuroimaging"],
        categories: ["molecular biology"],
        launchers: [{ name: "GROMACS", exec: ["gmx"], gui: false }],
      },
    },
  })));
  await consolidateEessi(root, dualDomains, { feed });
  const dualTwoBefore = await readFile(join(root, "neuroimaging", "eessi.json"), "utf8");
  const droppedOneStackFeed = {
    software: {
      ParaView: {
        versions: [makeVersion({ pkg: "ParaView", version: "6.0.1", tcVersion: "2025b", stack: "2025.06" })],
      },
      GROMACS: feed.software.GROMACS,
    },
  };
  const softDropped = await consolidateEessi(root, dualDomains, {
    fetchImpl: async () => new Response(JSON.stringify(droppedOneStackFeed), { status: 200 }),
    failSoft: true,
  });
  assert.equal(softDropped.updated, false);
  assert.match(softDropped.error, /dropped previously published builds for ParaView on EESSI\/2023\.06/);
  assert.equal(await readFile(join(root, "neuroimaging", "eessi.json"), "utf8"), dualTwoBefore);

  // An intentional version_pattern change that excludes all builds on one stack succeeds
  // when the upstream feed still contains raw builds for that stack.
  await writeFile(join(root, CURATION_PATH), YAML.stringify(sampleCuration({
    packages: {
      ParaView: {
        id: "paraview",
        domains: ["neuroimaging"],
        categories: ["visualization"],
        version_pattern: "^6\\.",
        launchers: [{ name: "ParaView", exec: ["paraview"], gui: true }],
      },
    },
  })));
  const filteredRes = await consolidateEessi(root, dualDomains, { feed, failSoft: true });
  assert.equal(filteredRes.updated, true);
  const filteredNeuro = JSON.parse(await readFile(join(root, "neuroimaging", "eessi.json"), "utf8"));
  assert.deepEqual(Object.keys(filteredNeuro.tools.paraview.apps), [
    "ParaView 6.0.1 (EESSI/2025.06)",
  ]);

  // Replacing a curated package under a stable tool id must not inherit the old package's stack coverage.
  await writeFile(join(root, CURATION_PATH), YAML.stringify(sampleCuration({
    packages: {
      ParaView: {
        id: "viewer",
        domains: ["neuroimaging"],
        categories: ["visualization"],
        launchers: [{ name: "ParaView", exec: ["paraview"], gui: true }],
      },
      GROMACS: {
        id: "gromacs",
        domains: ["neuroimaging"],
        categories: ["molecular biology"],
        launchers: [{ name: "GROMACS", exec: ["gmx"], gui: false }],
      },
    },
  })));
  await consolidateEessi(root, dualDomains, { feed });
  const replacementFeed = {
    software: {
      ParaViewAlt: {
        versions: [makeVersion({ pkg: "ParaViewAlt", version: "1.0.0", tcVersion: "2025b", stack: "2025.06" })],
      },
      GROMACS: feed.software.GROMACS,
    },
  };
  await writeFile(join(root, CURATION_PATH), YAML.stringify(sampleCuration({
    packages: {
      ParaViewAlt: {
        id: "viewer",
        domains: ["neuroimaging"],
        categories: ["visualization"],
        launchers: [{ name: "ParaViewAlt", exec: ["paraview"], gui: true }],
      },
      GROMACS: {
        id: "gromacs",
        domains: ["neuroimaging"],
        categories: ["molecular biology"],
        launchers: [{ name: "GROMACS", exec: ["gmx"], gui: false }],
      },
    },
  })));
  const replacedRes = await consolidateEessi(root, dualDomains, { feed: replacementFeed, failSoft: true });
  assert.equal(replacedRes.updated, true);
  const replacedNeuro = JSON.parse(await readFile(join(root, "neuroimaging", "eessi.json"), "utf8"));
  assert.equal(replacedNeuro.tools.viewer.package, "ParaViewAlt");

  // Prototype-named tool IDs (e.g. "constructor") merge cleanly without prototype collisions.
  await writeFile(join(root, CURATION_PATH), YAML.stringify(sampleCuration({
    packages: {
      ParaViewAlt: {
        id: "constructor",
        domains: ["neuroimaging"],
        categories: ["visualization"],
        launchers: [{ name: "ParaViewAlt", exec: ["paraview"], gui: true }],
      },
      GROMACS: {
        id: "gromacs",
        domains: ["neuroimaging"],
        categories: ["molecular biology"],
        launchers: [{ name: "GROMACS", exec: ["gmx"], gui: false }],
      },
    },
  })));
  const protoRes = await consolidateEessi(root, dualDomains, { feed: replacementFeed });
  assert.equal(protoRes.updated, true);
  const protoGlobal = JSON.parse(await readFile(join(root, GLOBAL_EESSI_CATALOG_PATH), "utf8"));
  assert.equal(protoGlobal.tools.constructor.package, "ParaViewAlt");
});
