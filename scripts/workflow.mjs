import { execFile } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  consolidate, imageBuild, readReleases, readSourceDomains, readPreviousCatalog, readToolText,
} from "./catalog.mjs";
import {
  consolidateEessi, expectedGlobalEessiConfig, GLOBAL_EESSI_CATALOG_PATH,
  hasContainerCatalogData, readPreviousCatalogLoose, RESERVED_DOMAIN_IDS,
  STACK_ID, validateEessiCatalog,
} from "./eessi.mjs";

const exec = promisify(execFile);
// Same rule as the app's domains schema: starts with a letter, single hyphens,
// at most 64 characters. A longer ID would generate a catalog that can never
// be published.
const DOMAIN_ID = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GENERATED = ["apps.json", "manifest.json"];
const DOMAIN_FIELDS = new Set([
  "source_repositories", "title", "description", "registry", "defaultVersion",
  "releaseHistoryUrl", "containerName", "volumeMount", "defaultStorageMount",
  "remoteUrl", "appJsonUrl", "downloadUrls", "tags", "minAppVersion",
  "eessi_stacks", "eessiCatalogUrl",
]);
export const sourcePath = (root, repository) =>
  join(root, ".catalog-sources", encodeURIComponent(repository));

export async function readDomains(root) {
  const document = JSON.parse(await readFile(join(root, "domains.json"), "utf8"));
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      !document.domains || typeof document.domains !== "object" ||
      Array.isArray(document.domains) || !Object.keys(document.domains).length) {
    throw new Error("domains.json must contain a nonempty domains object");
  }
  const domains = {};
  for (const [id, config] of Object.entries(document.domains).sort(([a], [b]) => a.localeCompare(b))) {
    if (!DOMAIN_ID.test(id) || RESERVED_DOMAIN_IDS.has(id)) throw new Error(`Invalid domain ID: ${id}`);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`Invalid domain configuration for ${id}`);
    }
    if (config.eessi_stacks !== undefined) {
      if (!Array.isArray(config.eessi_stacks) || !config.eessi_stacks.length ||
          config.eessi_stacks.some((stack) => typeof stack !== "string" || !STACK_ID.test(stack)) ||
          new Set(config.eessi_stacks).size !== config.eessi_stacks.length) {
        throw new Error(`Invalid eessi_stacks for ${id}`);
      }
    }
    const hasEessi = Array.isArray(config.eessi_stacks) && config.eessi_stacks.length > 0;
    if (!Array.isArray(config.source_repositories) ||
        (!config.source_repositories.length && !hasEessi) ||
        config.source_repositories.some((repository) => !REPOSITORY.test(repository)) ||
        new Set(config.source_repositories).size !== config.source_repositories.length) {
      throw new Error(`Invalid source_repositories for ${id}`);
    }
    // Launch fields are validated against the app's schema before deployment.
    // The catalog pipeline only checks their names, so malformed launch data
    // does not interrupt catalog generation.
    if (Object.keys(config).some((key) => !DOMAIN_FIELDS.has(key))) {
      throw new Error(`Unknown configuration field for ${id}`);
    }
    domains[id] = config;
  }
  return domains;
}

export function eessiOutputPaths(domains) {
  const paths = Object.entries(domains)
    .filter(([, config]) => Array.isArray(config.eessi_stacks) && config.eessi_stacks.length > 0)
    .map(([id]) => `${id}/eessi.json`);
  if (paths.length) paths.push(GLOBAL_EESSI_CATALOG_PATH);
  return paths;
}

export function outputPaths(domains) {
  return [
    ...Object.keys(domains).flatMap((id) => GENERATED.map((name) => `${id}/${name}`)),
    ...eessiOutputPaths(domains),
  ];
}

export async function needsConsolidation(root, domains) {
  for (const [id, config] of Object.entries(domains)) {
    if (!config.source_repositories.length) {
      // Brand-new or already-empty EESSI-only domains need no container
      // checkout or DOI run; however, converting a previously container-backed
      // domain (valid container apps or source_commits, even if the sibling
      // manifest is corrupt) must run container consolidation first so stored
      // licenses/DOIs carry over to any destination domain.
      const { catalog, manifest } = await readPreviousCatalogLoose(join(root, id));
      if (hasContainerCatalogData(catalog, manifest)) return true;
      continue;
    }
    // readPreviousCatalog returns no manifest when either generated file is missing.
    const { manifest } = await readPreviousCatalog(join(root, id));
    if (!manifest) return true;
    const sources = Object.keys(manifest.source_commits ?? {});
    if (sources.length !== config.source_repositories.length ||
        sources.some((source) => !config.source_repositories.includes(source))) return true;
  }
  return false;
}

export async function needsEessiConsolidation(root, domains) {
  const { domainStacks, stacks: globalStacks } = expectedGlobalEessiConfig(domains);
  const enabled = Object.entries(domainStacks);
  if (!enabled.length) return false;
  for (const [id, config] of Object.entries(domains)) {
    if (config.source_repositories.length > 0) continue;
    try {
      const { catalog, manifest } = await readPreviousCatalog(join(root, id));
      if (!manifest || Object.keys(catalog).length > 0 || manifest.entries !== 0 ||
          Object.keys(manifest.source_commits ?? {}).length > 0) {
        return true;
      }
    } catch {
      return true;
    }
  }
  for (const [id, stacks] of enabled) {
    try {
      const parsed = JSON.parse(await readFile(join(root, id, "eessi.json"), "utf8"));
      validateEessiCatalog(parsed, `${id}/eessi.json`, { expectedStacks: stacks });
    } catch {
      return true;
    }
  }
  try {
    const globalCatalog = JSON.parse(await readFile(join(root, GLOBAL_EESSI_CATALOG_PATH), "utf8"));
    validateEessiCatalog(globalCatalog, GLOBAL_EESSI_CATALOG_PATH, {
      expectedStacks: globalStacks,
      expectedDomainStacks: domainStacks,
    });
  } catch {
    return true;
  }
  return false;
}

export async function checkoutSources(root, domains) {
  const sourceBase = join(root, ".catalog-sources");
  await mkdir(sourceBase, { recursive: true });
  const repositories = new Set(Object.values(domains).flatMap((config) => config.source_repositories));
  await Promise.all([...repositories].map(async (repository) => {
    const destination = sourcePath(root, repository);
    // Full history: licenses are read from recipe commits (scripts/recipe_history.py).
    await exec("git", ["clone", `https://github.com/${repository}.git`, destination]);
    console.log(`Checked out ${repository}`);
  }));
}

export function assertUniqueSources(sources) {
  const apps = new Map();
  const images = new Map();
  for (const [repository, source] of sources) {
    for (const { path, data } of source.releases) {
      const [, tool, release] = /^releases\/([^/]+)\/([^/]+)\.json$/.exec(path);
      for (const [name, app] of Object.entries(data.apps)) {
        const appKey = `${tool}\0${name}`;
        const image = imageBuild(tool, release, app);
        for (const [key, owners, kind] of [[appKey, apps, "app"], [image, images, "image"]]) {
          const owner = owners.get(key);
          if (owner && owner !== repository)
            throw new Error(`Duplicate ${kind} ${kind === "app" ? `${tool}/${name}` : image} from ${owner} and ${repository}`);
          owners.set(key, repository);
        }
      }
    }
  }
}

function rememberBuildLicenses(previousByImage, catalog, {
  activeTitles, replace = false, fillMissingOnly = false,
} = {}) {
  for (const entry of Object.values(catalog)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const apps = entry.apps;
    if (!apps || typeof apps !== "object" || Array.isArray(apps)) continue;
    for (const app of Object.values(apps)) {
      if (!app || typeof app !== "object" || Array.isArray(app) ||
          !app.image || !app.version || !Array.isArray(app.license) || !app.license.length)
        continue;
      const title = `${app.image}_${app.version}`;
      if (activeTitles && !activeTitles.has(title)) continue;
      const metadata = {
        license: app.license,
        license_details: app.license_details ?? [],
      };
      const prior = previousByImage.get(title);
      if (prior) {
        if (fillMissingOnly) continue;
        if (!replace && JSON.stringify(prior) !== JSON.stringify(metadata))
          throw new Error(`Conflicting catalog licenses for ${title}`);
      }
      previousByImage.set(title, metadata);
    }
  }
}

export async function lookupPublishedDois() {
  if (!process.env.ZENODO_TOKEN) return {};
  const { stdout } = await exec("python3", ["-m", "scripts.zenodo_catalog", "lookup"],
    { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export async function consolidateDomains(root, domains, {
  sourceCommits = {}, resolveLicenses, publishedDois, lookupDois = lookupPublishedDois,
} = {}) {
  const repositories = [...new Set(Object.values(domains).flatMap((config) => config.source_repositories))];
  const sources = new Map();
  for (const repository of repositories) {
    const sourceRoot = sourcePath(root, repository);
    const sourceCommit = sourceCommits[repository] ??
      (await exec("git", ["-C", sourceRoot, "rev-parse", "HEAD"])).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error(`Invalid source commit for ${repository}`);
    const releases = await readReleases(sourceRoot);
    const metadata = await readSourceDomains(sourceRoot, releases, domains, repository);
    let toolText;
    try {
      toolText = await readToolText(sourceRoot);
    } catch (error) {
      console.warn(`Keeping published citations and descriptions for ${repository}: ${error.message}`);
      toolText = null;
    }
    sources.set(repository, { sourceRoot, sourceCommit, releases, metadata, toolText });
  }
  assertUniqueSources(sources);
  const activeTitles = new Set();
  const currentOwnerByApp = new Map();
  const currentBuildByApp = new Map();
  for (const [repository, source] of sources) {
    for (const { path, data } of source.releases) {
      const [, tool, release] = /^releases\/([^/]+)\/([^/]+)\.json$/.exec(path);
      for (const [name, app] of Object.entries(data.apps)) {
        const build = imageBuild(tool, release, app);
        activeTitles.add(build);
        currentOwnerByApp.set(`${tool}\0${name}`, repository);
        currentBuildByApp.set(`${tool}\0${name}`, build);
      }
    }
  }
  const previousByDomain = {};
  for (const [id, config] of Object.entries(domains)) {
    if (config.source_repositories.length > 0) {
      previousByDomain[id] = await readPreviousCatalog(join(root, id));
      continue;
    }
    // Read apps.json and manifest.json independently so a valid apps.json still
    // carries over stored licenses/DOIs even if manifest.json is corrupt, while
    // tolerating corrupt stubs so scheduled runs can repair them.
    const { catalog, manifest } = await readPreviousCatalogLoose(join(root, id));
    previousByDomain[id] = { catalog: catalog ?? {}, manifest };
  }
  // Load stored licenses from active container-backed domains first (strict
  // conflict check), then fill missing titles from converting EESSI-only domains
  // so a retry after a partial destination write does not conflict with the
  // unconverted copy still waiting to be cleared.
  const previousByImage = new Map();
  for (const [id, previous] of Object.entries(previousByDomain)) {
    if (domains[id].source_repositories.length > 0)
      rememberBuildLicenses(previousByImage, previous.catalog, { activeTitles });
  }
  for (const [id, previous] of Object.entries(previousByDomain)) {
    if (domains[id].source_repositories.length === 0)
      rememberBuildLicenses(previousByImage, previous.catalog, { activeTitles, fillMissingOnly: true });
  }
  const previousByIdentity = new Map();
  for (const [id, previous] of Object.entries(previousByDomain)) {
    const priorSources = Object.keys(previous.manifest?.source_commits ?? {});
    const singleSource = priorSources.length === 1 ? priorSources[0] :
      domains[id].source_repositories.length === 1 ? domains[id].source_repositories[0] : null;
    for (const [tool, entry] of Object.entries(previous.catalog)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const apps = entry.apps;
      if (!apps || typeof apps !== "object" || Array.isArray(apps)) continue;
      for (const [name, app] of Object.entries(apps)) {
        if (!app || typeof app !== "object" || Array.isArray(app)) continue;
        const currentBuild = currentBuildByApp.get(`${tool}\0${name}`);
        if (currentBuild && `${app.image}_${app.version}` !== currentBuild) continue;
        const repository = previous.manifest?.app_sources?.[tool]?.[name] ??
          previous.manifest?.tool_sources?.[tool] ?? singleSource ??
          currentOwnerByApp.get(`${tool}\0${name}`);
        if (!repository) continue;
        const key = JSON.stringify([repository, tool, name]);
        const existing = previousByIdentity.get(key);
        if (!existing || (!existing.doi && app.doi &&
            existing.image === app.image && existing.version === app.version)) {
          previousByIdentity.set(key, app);
        }
      }
    }
  }
  let dois = publishedDois;
  if (dois === undefined) {
    try {
      dois = await lookupDois();
    } catch (error) {
      console.warn(`Could not look up published Zenodo DOIs: ${error.message}`);
      dois = {};
    }
  }
  // Consolidate container-backed domains first so EESSI-only domains (including
  // domains newly converted from container-backed) are only cleared after every
  // destination domain has persisted carried-over licenses and DOIs.
  const orderedDomains = [
    ...Object.entries(domains).filter(([, config]) => config.source_repositories.length > 0),
    ...Object.entries(domains).filter(([, config]) => config.source_repositories.length === 0),
  ];
  for (const [id, config] of orderedDomains) {
    const selected = config.source_repositories.map((repository) => ({ repository, ...sources.get(repository) }));
    const files = await consolidate({
      root: join(root, id), domain: id, sources: selected,
      previous: previousByDomain[id], previousByIdentity, publishedDois: dois,
      previousByImage, resolveLicenses,
    });
    rememberBuildLicenses(previousByImage, JSON.parse(files["apps.json"]), { replace: true });
    console.log(`Generated ${id}: ${Object.keys(files).join(", ")} from ${config.source_repositories.join(", ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const domains = await readDomains(root);
  const command = process.argv[2];
  if (command === "checkout") {
    await checkoutSources(root, domains);
  } else if (command === "run") {
    await consolidateDomains(root, domains);
  } else if (command === "eessi") {
    await consolidateEessi(root, domains, { failSoft: process.argv.includes("--fail-soft") });
  } else if (command === "output-paths") {
    process.stdout.write(`${outputPaths(domains).join("\n")}\n`);
  } else if (command === "eessi-output-paths") {
    const paths = eessiOutputPaths(domains);
    if (paths.length) process.stdout.write(`${paths.join("\n")}\n`);
  } else if (command === "needs-consolidation") {
    console.log(await needsConsolidation(root, domains));
  } else if (command === "needs-eessi") {
    console.log(await needsEessiConsolidation(root, domains));
  } else if (command === "source-repository") {
    throw new Error("source-repository is retired; use source_repositories in domains.json");
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}
