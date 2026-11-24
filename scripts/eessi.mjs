import YAML from "yaml";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CURATION_PATH = "eessi/curation.yaml";
export const GLOBAL_EESSI_CATALOG_PATH = "eessi/catalog.json";
export const DEFAULT_EESSI_FEED_URL =
  "https://www.eessi.io/api_data/data/eessi_api_metadata_software.json";
export const STACK_ID = /^[0-9]{4}\.[0-9]{2}$/;
export const RESERVED_DOMAIN_IDS = new Set(["eessi"]);

const DOMAIN_ID = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;
const TOOL_ID = /^[a-z0-9][a-z0-9._+-]{0,63}$/;
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const MODULE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SAFE_VERSION = /^[A-Za-z0-9._+-]{1,64}$/;
const SAFE_TOOLCHAIN = /^[A-Za-z0-9._+-]{1,64}(?:\/[A-Za-z0-9._+-]{1,64})?$/;
const EXEC_ARG = /^[A-Za-z0-9._/@:+=-]{1,128}$/;
const CVMFS_REPO = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;
const ARCH_NAME = /^[a-z0-9_+-]{2,32}$/;
const GPU_TARGET = /^[a-z0-9._+-]+\/[a-z0-9._+-]+$/;
const SAFE_LABEL = /^[^<>&\r\n]{1,128}$/;
const SAFE_LICENSE = /^[^\r\n\x00-\x1f]{1,128}$/;
const SAFE_URL = /^https?:\/\/[^\s"'<>`\\]+$/;
const MAX_DESCRIPTION_LENGTH = 4000;
const GPU_POLICIES = new Set(["exclude", "optional", "only"]);
const TOP_LEVEL_KEYS = new Set(["schemaVersion", "sourceUrl", "cvmfsRepo", "packages"]);
const PACKAGE_KEYS = new Set(["id", "domains", "categories", "gpu", "version_pattern", "pin", "launchers"]);
const LAUNCHER_KEYS = new Set(["name", "exec", "gui", "terminal", "show_in_menu", "show_in_applist"]);
const FEED_FETCH_TIMEOUT_MS = 30000;
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DATE_VERSION = /^(\d{1,2})([A-Za-z]{3})(\d{4})(.*)$/;

export class EessiFeedError extends Error {
  constructor(message) {
    super(message);
    this.name = "EessiFeedError";
  }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 4)}\n`;
}

function cleanText(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function assertAllowedKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown key "${key}" in ${label}`);
    }
  }
}

function assertNonEmptyStringArray(value, label, pattern = null) {
  if (!Array.isArray(value) || !value.length ||
      value.some((item) => typeof item !== "string" || !item || (pattern && !pattern.test(item))) ||
      new Set(value).size !== value.length) {
    throw new Error(`Invalid ${label}`);
  }
}

export function validateCuration(document, domains) {
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw new Error(`${CURATION_PATH} must contain an object`);
  assertAllowedKeys(document, TOP_LEVEL_KEYS, CURATION_PATH);
  if (document.schemaVersion !== 1)
    throw new Error(`${CURATION_PATH} schemaVersion must be 1`);
  const sourceUrl = document.sourceUrl ?? DEFAULT_EESSI_FEED_URL;
  if (typeof sourceUrl !== "string" || !sourceUrl.startsWith("https://") || !SAFE_URL.test(sourceUrl))
    throw new Error(`${CURATION_PATH} sourceUrl must be a valid https URL`);
  const cvmfsRepo = document.cvmfsRepo ?? "software.eessi.io";
  if (typeof cvmfsRepo !== "string" || !CVMFS_REPO.test(cvmfsRepo))
    throw new Error(`${CURATION_PATH} cvmfsRepo is invalid: ${cvmfsRepo}`);
  if (!document.packages || typeof document.packages !== "object" ||
      Array.isArray(document.packages) || !Object.keys(document.packages).length) {
    throw new Error(`${CURATION_PATH} must define a nonempty packages map`);
  }

  const seenIds = new Map();
  const packages = Object.create(null);
  for (const [pkgName, raw] of Object.entries(document.packages)) {
    if (!PACKAGE_NAME.test(pkgName))
      throw new Error(`Invalid EESSI package name: ${pkgName}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(`Invalid package entry for ${pkgName}`);
    assertAllowedKeys(raw, PACKAGE_KEYS, `package ${pkgName}`);
    if (typeof raw.id !== "string" || !TOOL_ID.test(raw.id))
      throw new Error(`Invalid tool id for ${pkgName}: ${raw.id}`);
    if (seenIds.has(raw.id))
      throw new Error(`Duplicate EESSI tool id ${raw.id} on ${seenIds.get(raw.id)} and ${pkgName}`);
    seenIds.set(raw.id, pkgName);

    assertNonEmptyStringArray(raw.domains, `domains for ${pkgName}`);
    for (const domain of raw.domains) {
      if (!Object.hasOwn(domains, domain))
        throw new Error(`Unknown domain ${domain} for EESSI package ${pkgName}`);
    }
    assertNonEmptyStringArray(raw.categories, `categories for ${pkgName}`);

    const gpu = raw.gpu ?? "exclude";
    if (!GPU_POLICIES.has(gpu))
      throw new Error(`Invalid gpu policy for ${pkgName}: ${gpu}`);

    let versionPattern = null;
    if (raw.version_pattern !== undefined) {
      if (typeof raw.version_pattern !== "string" || !raw.version_pattern)
        throw new Error(`Invalid version_pattern for ${pkgName}`);
      try {
        new RegExp(raw.version_pattern);
      } catch (error) {
        throw new Error(`Invalid version_pattern regex for ${pkgName}: ${error.message}`);
      }
      versionPattern = raw.version_pattern;
    }

    let pin = null;
    if (raw.pin !== undefined) {
      if (typeof raw.pin === "string") {
        if (!MODULE_NAME.test(raw.pin) || !raw.pin.startsWith(`${pkgName}/`))
          throw new Error(`Invalid pin module for ${pkgName}: ${raw.pin}`);
        pin = raw.pin;
      } else if (raw.pin && typeof raw.pin === "object" && !Array.isArray(raw.pin) &&
          Object.keys(raw.pin).length) {
        pin = {};
        for (const [stack, mod] of Object.entries(raw.pin)) {
          if (!STACK_ID.test(stack))
            throw new Error(`Invalid pin stack ${stack} for ${pkgName}`);
          if (typeof mod !== "string" || !MODULE_NAME.test(mod) || !mod.startsWith(`${pkgName}/`))
            throw new Error(`Invalid pin module ${mod} for ${pkgName} (${stack})`);
          pin[stack] = mod;
        }
      } else {
        throw new Error(`Invalid pin for ${pkgName}`);
      }
    }

    if (!Array.isArray(raw.launchers) || !raw.launchers.length)
      throw new Error(`Launchers must be a nonempty array for ${pkgName}`);
    const launcherNames = new Set();
    const launchers = raw.launchers.map((launcher, index) => {
      if (!launcher || typeof launcher !== "object" || Array.isArray(launcher))
        throw new Error(`Invalid launcher #${index} for ${pkgName}`);
      assertAllowedKeys(launcher, LAUNCHER_KEYS, `launcher #${index} for ${pkgName}`);
      if (typeof launcher.name !== "string" || !SAFE_LABEL.test(launcher.name))
        throw new Error(`Invalid launcher name for ${pkgName}: ${launcher.name}`);
      if (launcherNames.has(launcher.name))
        throw new Error(`Duplicate launcher name ${launcher.name} for ${pkgName}`);
      launcherNames.add(launcher.name);
      if (!Array.isArray(launcher.exec) ||
          launcher.exec.some((arg) => typeof arg !== "string" || !EXEC_ARG.test(arg))) {
        throw new Error(`Invalid exec argv for ${pkgName}/${launcher.name}`);
      }
      if (typeof launcher.gui !== "boolean")
        throw new Error(`gui must be boolean for ${pkgName}/${launcher.name}`);
      for (const flag of ["terminal", "show_in_menu", "show_in_applist"]) {
        if (launcher[flag] !== undefined && typeof launcher[flag] !== "boolean")
          throw new Error(`${flag} must be boolean for ${pkgName}/${launcher.name}`);
      }
      return {
        name: launcher.name,
        exec: [...launcher.exec],
        gui: launcher.gui,
        ...(launcher.terminal !== undefined ? { terminal: launcher.terminal } : {}),
        ...(launcher.show_in_menu !== undefined ? { show_in_menu: launcher.show_in_menu } : {}),
        ...(launcher.show_in_applist !== undefined ? { show_in_applist: launcher.show_in_applist } : {}),
      };
    });

    packages[pkgName] = {
      id: raw.id,
      domains: [...raw.domains],
      categories: [...raw.categories],
      gpu,
      ...(versionPattern ? { version_pattern: versionPattern } : {}),
      ...(pin ? { pin } : {}),
      launchers,
    };
  }

  return {
    schemaVersion: 1,
    sourceUrl,
    cvmfsRepo,
    packages,
  };
}

export async function readCuration(root, domains) {
  const raw = await readFile(join(root, CURATION_PATH), "utf8");
  return validateCuration(YAML.parse(raw), domains);
}

export async function fetchEessiFeed(
  url = DEFAULT_EESSI_FEED_URL,
  { fetchImpl = fetch, timeoutMs = FEED_FETCH_TIMEOUT_MS } = {},
) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new EessiFeedError(`Could not fetch EESSI metadata from ${url}: ${error.message}`);
  }
  if (!response.ok) {
    throw new EessiFeedError(`Could not fetch EESSI metadata from ${url}: HTTP ${response.status}`);
  }
  let feed;
  try {
    feed = JSON.parse(await response.text());
  } catch (error) {
    throw new EessiFeedError(`EESSI metadata at ${url} is not valid JSON: ${error.message}`);
  }
  if (!feed || typeof feed !== "object" || Array.isArray(feed) ||
      !feed.software || typeof feed.software !== "object" || Array.isArray(feed.software) ||
      !Object.keys(feed.software).length) {
    throw new EessiFeedError(`EESSI metadata at ${url} is missing a nonempty software map`);
  }
  return feed;
}

function parseVersionTokens(version) {
  const text = String(version ?? "").trim();
  const dateMatch = DATE_VERSION.exec(text);
  if (dateMatch) {
    const [, day, mon, year, rest] = dateMatch;
    const month = MONTHS[mon.toLowerCase()];
    if (month) {
      return [
        Number(year),
        month,
        Number(day),
        ...parseVersionTokens(rest.replace(/^[_.-]+/, "")),
      ];
    }
  }
  if (!text) return [];
  const tokens = [];
  for (const part of text.split(/[._+-]+/).filter(Boolean)) {
    for (const chunk of part.match(/\d+|[A-Za-z]+/g) ?? []) {
      tokens.push(/^\d+$/.test(chunk) ? Number(chunk) : chunk.toLowerCase());
    }
  }
  return tokens;
}

function formatUntrusted(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return Array.isArray(value) ? "array" : typeof value;
}

function splitReleaseAndSuffix(tokens) {
  let splitAt = 0;
  while (splitAt < tokens.length && typeof tokens[splitAt] === "number") splitAt++;
  return { release: tokens.slice(0, splitAt), rest: tokens.slice(splitAt) };
}

function normalizeSuffixToken(token) {
  if (token === "alpha") return "a";
  if (token === "beta") return "b";
  if (token === "update" || token === "p") return "post";
  return token;
}

function tokenRank(token) {
  if (token === undefined) return 0;
  if (typeof token === "number") return 2;
  if (token === "dev") return -5;
  if (token === "pre") return -4;
  if (token === "a") return -3;
  if (token === "b") return -2;
  if (token === "rc") return -1;
  if (token === "post") return 1;
  return 1;
}

export function compareVersionStrings(a, b) {
  const { release: relA, rest: restA } = splitReleaseAndSuffix(parseVersionTokens(a));
  const { release: relB, rest: restB } = splitReleaseAndSuffix(parseVersionTokens(b));
  const relLen = Math.max(relA.length, relB.length);
  for (let i = 0; i < relLen; i++) {
    const diff = (relA[i] ?? 0) - (relB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  const restLen = Math.max(restA.length, restB.length);
  for (let i = 0; i < restLen; i++) {
    const va = typeof restA[i] === "string" ? normalizeSuffixToken(restA[i]) : restA[i];
    const vb = typeof restB[i] === "string" ? normalizeSuffixToken(restB[i]) : restB[i];
    if (va === vb) continue;
    if (va === undefined || vb === undefined) {
      const ra = tokenRank(va);
      const rb = tokenRank(vb);
      if (ra !== rb) return ra - rb;
      return va === undefined ? -1 : 1;
    }
    if (typeof va === "number" && typeof vb === "number") return va - vb;
    if (typeof va === "number" !== (typeof vb === "number")) {
      return typeof va === "number" ? 1 : -1;
    }
    const ra = tokenRank(va);
    const rb = tokenRank(vb);
    if (ra !== rb) return ra - rb;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

export function gpuTargets(entry, { strict = false, context = "entry" } = {}) {
  if (entry?.gpu_arch === undefined) return [];
  if (!entry.gpu_arch || typeof entry.gpu_arch !== "object" || Array.isArray(entry.gpu_arch)) {
    if (strict) throw new EessiFeedError(`Malformed gpu_arch in EESSI feed for ${context}`);
    return [];
  }
  const targets = new Set();
  for (const list of Object.values(entry.gpu_arch)) {
    if (!Array.isArray(list)) {
      if (strict) throw new EessiFeedError(`Malformed gpu_arch list in EESSI feed for ${context}`);
      continue;
    }
    for (const item of list) {
      const cleaned = typeof item === "string" ? item.trim() : "";
      if (!cleaned || !GPU_TARGET.test(cleaned)) {
        if (strict) {
          throw new EessiFeedError(
            `Invalid GPU target ${formatUntrusted(item)} in EESSI feed for ${context}`,
          );
        }
        continue;
      }
      targets.add(cleaned);
    }
  }
  return [...targets].sort();
}

export function normalizeArches(cpuArch) {
  if (!Array.isArray(cpuArch)) return [];
  const families = new Set();
  for (const target of cpuArch) {
    if (typeof target !== "string" || !target.includes("/")) continue;
    const family = target.split("/")[0];
    if (ARCH_NAME.test(family)) families.add(family);
  }
  return [...families].sort();
}

function toolchainLabel(toolchain) {
  if (!toolchain || typeof toolchain !== "object") return undefined;
  const name = cleanText(toolchain.name);
  const version = cleanText(toolchain.version);
  if (!name) return undefined;
  if (!version || version === name) return name;
  return `${name}/${version}`;
}

function hasPlainSuffix(entry) {
  const suffix = typeof entry.versionsuffix === "string" ? entry.versionsuffix.trim() : "";
  if (!suffix) return true;
  // Standard GPU builds only append -CUDA-<ver> / -ROCm-<ver>; treat plain
  // CUDA/ROCm builds as simpler than specialized plugin suffixes (e.g. -PLUMED-).
  return /^-(?:CUDA|ROCm)-[0-9.]+$/i.test(suffix);
}

// Positive means `a` is newer/preferred over `b`.
export function compareVersionEntries(a, b) {
  const byVersion = compareVersionStrings(a.version, b.version);
  if (byVersion !== 0) return byVersion;
  const byToolchain = compareVersionStrings(a.toolchain?.version ?? "", b.toolchain?.version ?? "");
  if (byToolchain !== 0) return byToolchain;
  const plainA = hasPlainSuffix(a) ? 1 : 0;
  const plainB = hasPlainSuffix(b) ? 1 : 0;
  if (plainA !== plainB) return plainA - plainB;
  const modA = a.module?.full_module_name ?? "";
  const modB = b.module?.full_module_name ?? "";
  return modA === modB ? 0 : (modA < modB ? -1 : 1);
}

function entryMatchesStack(entry, stack) {
  if (!Array.isArray(entry?.required_modules)) return false;
  return entry.required_modules.some((mod) => mod?.full_module_name === `EESSI/${stack}`);
}

function pinnedModuleForStack(pkgConfig, stack) {
  if (typeof pkgConfig.pin === "string") return pkgConfig.pin;
  return pkgConfig.pin?.[stack] ?? null;
}

export function selectVersionsForStack(packageEntry, stack, pkgConfig, pkgName = "") {
  const label = pkgName || "package";
  if (!packageEntry || typeof packageEntry !== "object" || Array.isArray(packageEntry) ||
      !Array.isArray(packageEntry.versions) || !packageEntry.versions.length) {
    throw new EessiFeedError(`Malformed EESSI feed record for ${label}: missing nonempty versions array`);
  }
  const versions = packageEntry.versions;
  for (const entry of versions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new EessiFeedError(`Malformed version entry in EESSI feed for ${label}`);
    }
    const modName = entry.module?.full_module_name;
    if (typeof modName !== "string" || !MODULE_NAME.test(modName) ||
        (pkgName && !modName.startsWith(`${pkgName}/`))) {
      throw new EessiFeedError(
        `Invalid EESSI module name from feed for ${label}: ${formatUntrusted(modName)}`,
      );
    }
    if (!Array.isArray(entry.required_modules) || !entry.required_modules.length) {
      throw new EessiFeedError(`Malformed required_modules in EESSI feed for ${modName}`);
    }
    let hasStack = false;
    for (const mod of entry.required_modules) {
      if (!mod || typeof mod !== "object" || Array.isArray(mod) ||
          typeof mod.full_module_name !== "string" || !mod.full_module_name.trim()) {
        throw new EessiFeedError(`Malformed required_modules in EESSI feed for ${modName}`);
      }
      if (mod.full_module_name.startsWith("EESSI/")) {
        if (!MODULE_NAME.test(mod.full_module_name)) {
          throw new EessiFeedError(
            `Malformed EESSI stack in required_modules for ${modName}: ${formatUntrusted(mod.full_module_name)}`,
          );
        }
        const stackVer = mod.full_module_name.slice("EESSI/".length);
        if (!STACK_ID.test(stackVer)) {
          throw new EessiFeedError(
            `Malformed EESSI stack in required_modules for ${modName}: ${formatUntrusted(mod.full_module_name)}`,
          );
        }
        hasStack = true;
      }
    }
    if (!hasStack) {
      throw new EessiFeedError(`Missing EESSI stack in required_modules for ${modName}`);
    }
    if (entry.version !== undefined && typeof entry.version !== "string") {
      throw new EessiFeedError(
        `Malformed version in EESSI feed for ${modName}: ${formatUntrusted(entry.version)}`,
      );
    }
    if (entry.versionsuffix !== undefined && typeof entry.versionsuffix !== "string") {
      throw new EessiFeedError(
        `Malformed versionsuffix in EESSI feed for ${modName}: ${formatUntrusted(entry.versionsuffix)}`,
      );
    }
    if (entry.toolchain !== undefined) {
      if (!entry.toolchain || typeof entry.toolchain !== "object" || Array.isArray(entry.toolchain) ||
          (entry.toolchain.name !== undefined && typeof entry.toolchain.name !== "string") ||
          (entry.toolchain.version !== undefined && typeof entry.toolchain.version !== "string")) {
        throw new EessiFeedError(`Malformed toolchain in EESSI feed for ${modName}`);
      }
    }
    if (entry.cpu_arch !== undefined && !Array.isArray(entry.cpu_arch)) {
      throw new EessiFeedError(`Malformed cpu_arch in EESSI feed for ${modName}`);
    }
    gpuTargets(entry, { strict: true, context: modName });
  }
  let candidates = versions.filter((entry) => entryMatchesStack(entry, stack));

  const pinned = pinnedModuleForStack(pkgConfig, stack);
  if (pinned) {
    const match = candidates.find((entry) => entry.module?.full_module_name === pinned);
    if (!match) {
      throw new EessiFeedError(
        `Pinned EESSI module ${pinned} not found in EESSI/${stack}`,
      );
    }
    return [match];
  }

  if (pkgConfig.version_pattern) {
    const regex = new RegExp(pkgConfig.version_pattern);
    candidates = candidates.filter((entry) => regex.test(String(entry.version ?? "")));
  }

  const cpuOnly = candidates.filter((entry) => gpuTargets(entry).length === 0)
    .sort((a, b) => compareVersionEntries(b, a));
  const gpuOnly = candidates.filter((entry) => gpuTargets(entry).length > 0)
    .sort((a, b) => compareVersionEntries(b, a));

  if (pkgConfig.gpu === "only") return gpuOnly.length ? [gpuOnly[0]] : [];
  if (pkgConfig.gpu === "optional") {
    return [...(cpuOnly.length ? [cpuOnly[0]] : []), ...(gpuOnly.length ? [gpuOnly[0]] : [])];
  }
  return cpuOnly.length ? [cpuOnly[0]] : [];
}

function normalizedLicenses(entry) {
  if (!Array.isArray(entry?.license)) return [];
  return [...new Set(
    entry.license.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()),
  )].sort();
}

export function expectedGlobalEessiConfig(domains) {
  const domainStacks = {};
  const stacks = [];
  const seenStacks = new Set();
  for (const [id, config] of Object.entries(domains).sort(([a], [b]) => a.localeCompare(b))) {
    if (!Array.isArray(config.eessi_stacks) || !config.eessi_stacks.length) continue;
    domainStacks[id] = [...config.eessi_stacks];
    for (const stack of config.eessi_stacks) {
      if (!seenStacks.has(stack)) {
        seenStacks.add(stack);
        stacks.push(stack);
      }
    }
  }
  return { domainStacks, stacks };
}

export function buildEessiCatalog({
  curation,
  feed,
  stacks,
  domain = null,
  domainStacks = null,
}) {
  if (!feed || typeof feed !== "object" || Array.isArray(feed) ||
      !feed.software || typeof feed.software !== "object" || Array.isArray(feed.software) ||
      !Object.keys(feed.software).length) {
    throw new EessiFeedError("EESSI feed is missing a nonempty software map");
  }

  const tools = {};
  const rawStacksInFeed = new Set();
  const orderedPackages = Object.entries(curation.packages)
    .filter(([, cfg]) => domain === null || cfg.domains.includes(domain))
    .sort(([, a], [, b]) => a.id.localeCompare(b.id));

  for (const [pkgName, pkgConfig] of orderedPackages) {
    if (!Object.hasOwn(feed.software, pkgName)) {
      for (const stack of stacks) {
        const pinned = pinnedModuleForStack(pkgConfig, stack);
        if (pinned) {
          throw new EessiFeedError(
            `Pinned EESSI package ${pkgName} (${pinned}) not found in feed for EESSI/${stack}`,
          );
        }
      }
      throw new EessiFeedError(
        `Curated EESSI package ${pkgName} is missing from feed (possible truncated feed)`,
      );
    }
    const packageEntry = feed.software[pkgName];
    if (!packageEntry || typeof packageEntry !== "object" || Array.isArray(packageEntry)) {
      throw new EessiFeedError(`Malformed EESSI feed record for ${pkgName}`);
    }

    const apps = {};
    let description;
    let homepage;

    for (const stack of stacks) {
      const selected = selectVersionsForStack(packageEntry, stack, pkgConfig, pkgName);
      if (packageEntry.versions.some((entry) => entryMatchesStack(entry, stack))) {
        rawStacksInFeed.add(stack);
      }
      for (const entry of selected) {
        const fullModule = entry.module?.full_module_name;
        if (typeof fullModule !== "string" || !MODULE_NAME.test(fullModule) ||
            !fullModule.startsWith(`${pkgName}/`)) {
          throw new EessiFeedError(
            `Invalid EESSI module name from feed for ${pkgName}: ${formatUntrusted(fullModule)}`,
          );
        }
        const softwareVersion = cleanText(entry.version) ?? fullModule.split("/")[1];
        if (!SAFE_VERSION.test(softwareVersion)) {
          throw new EessiFeedError(
            `Invalid software_version from feed for ${fullModule}: ${formatUntrusted(softwareVersion)}`,
          );
        }
        const gpus = gpuTargets(entry, { strict: true, context: fullModule });
        const isGpu = gpus.length > 0;
        const arch = normalizeArches(entry.cpu_arch);
        const toolchain = toolchainLabel(entry.toolchain);
        if (toolchain !== undefined && !SAFE_TOOLCHAIN.test(toolchain)) {
          throw new EessiFeedError(
            `Invalid toolchain from feed for ${fullModule}: ${formatUntrusted(toolchain)}`,
          );
        }
        const license = normalizedLicenses(entry);

        const rawDesc = cleanText(entry.description);
        description ??= rawDesc && rawDesc.length > MAX_DESCRIPTION_LENGTH
          ? `${rawDesc.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`
          : rawDesc;
        if (!homepage && typeof entry.homepage === "string" && SAFE_URL.test(entry.homepage.trim())) {
          homepage = entry.homepage.trim();
        }

        const qualifier = isGpu ? `EESSI/${stack}, GPU` : `EESSI/${stack}`;
        for (const launcher of pkgConfig.launchers) {
          const appKey = `${launcher.name} ${softwareVersion} (${qualifier})`;
          if (Object.hasOwn(apps, appKey)) {
            throw new EessiFeedError(`Duplicate EESSI app key ${appKey} for ${pkgConfig.id}`);
          }
          const app = {
            backend: "eessi",
            stack,
            module: fullModule,
            required_modules: [`EESSI/${stack}`],
            software_version: softwareVersion,
            ...(toolchain ? { toolchain } : {}),
            arch,
            gpu: isGpu,
            ...(isGpu ? { gpu_targets: gpus } : {}),
            exec: [...launcher.exec],
            gui: launcher.gui,
            ...(launcher.terminal !== undefined ? { terminal: launcher.terminal } : {}),
            ...(launcher.show_in_menu !== undefined ? { show_in_menu: launcher.show_in_menu } : {}),
            ...(launcher.show_in_applist !== undefined
              ? { show_in_applist: launcher.show_in_applist }
              : {}),
            ...(license.length ? { license } : {}),
          };
          apps[appKey] = app;
        }
      }
    }

    if (!Object.keys(apps).length) continue;

    const sortedApps = Object.fromEntries(
      Object.keys(apps).sort().map((key) => [key, apps[key]]),
    );
    tools[pkgConfig.id] = {
      package: pkgName,
      categories: [...pkgConfig.categories],
      ...(description ? { description } : {}),
      ...(homepage ? { homepage } : {}),
      apps: sortedApps,
    };
  }

  if (orderedPackages.length > 0) {
    const scope = domain ?? "global";
    const missingStacks = stacks.filter((stack) => !rawStacksInFeed.has(stack));
    if (missingStacks.length) {
      throw new EessiFeedError(
        `EESSI feed matched zero curated tools for ${scope} on stack(s): ${missingStacks.join(", ")}`,
      );
    }
  }

  return {
    schemaVersion: 1,
    backend: "eessi",
    explicitSelectionRequired: true,
    cvmfsRepo: curation.cvmfsRepo,
    stacks: [...stacks],
    ...(domainStacks ? { domain_stacks: domainStacks } : {}),
    tools,
  };
}

export function validateEessiCatalog(
  catalog,
  path = "eessi.json",
  { expectedStacks = null, expectedDomainStacks = null } = {},
) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog))
    throw new Error(`${path} must contain a JSON object`);
  if (catalog.schemaVersion !== 1 || catalog.backend !== "eessi")
    throw new Error(`${path} must declare schemaVersion 1 and backend "eessi"`);
  if (catalog.explicitSelectionRequired !== true)
    throw new Error(`${path} must set explicitSelectionRequired to true`);
  if (typeof catalog.cvmfsRepo !== "string" || !CVMFS_REPO.test(catalog.cvmfsRepo))
    throw new Error(`${path} must declare a valid cvmfsRepo`);
  if (!Array.isArray(catalog.stacks) || !catalog.stacks.length ||
      catalog.stacks.some((s) => typeof s !== "string" || !STACK_ID.test(s)) ||
      new Set(catalog.stacks).size !== catalog.stacks.length) {
    throw new Error(`${path} must list unique valid EESSI stacks`);
  }
  if (expectedStacks && JSON.stringify(catalog.stacks) !== JSON.stringify(expectedStacks)) {
    throw new Error(
      `${path} stacks ${JSON.stringify(catalog.stacks)} do not match configured ${JSON.stringify(expectedStacks)}`,
    );
  }
  if (expectedDomainStacks !== null) {
    if (!catalog.domain_stacks || typeof catalog.domain_stacks !== "object" ||
        Array.isArray(catalog.domain_stacks)) {
      throw new Error(`${path} must declare domain_stacks`);
    }
    const normalizedExpected = Object.fromEntries(
      Object.entries(expectedDomainStacks).sort(([a], [b]) => a.localeCompare(b)),
    );
    const normalizedActual = Object.fromEntries(
      Object.entries(catalog.domain_stacks).sort(([a], [b]) => a.localeCompare(b)),
    );
    if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
      throw new Error(
        `${path} domain_stacks do not match configured EESSI domains`,
      );
    }
  } else if (catalog.domain_stacks !== undefined) {
    if (!catalog.domain_stacks || typeof catalog.domain_stacks !== "object" ||
        Array.isArray(catalog.domain_stacks)) {
      throw new Error(`${path} domain_stacks must be an object`);
    }
    for (const [id, stacks] of Object.entries(catalog.domain_stacks)) {
      if (!DOMAIN_ID.test(id)) throw new Error(`${path} has invalid domain_stacks key: ${id}`);
      assertNonEmptyStringArray(stacks, `${path} domain_stacks.${id}`, STACK_ID);
    }
  }

  if (!catalog.tools || typeof catalog.tools !== "object" || Array.isArray(catalog.tools))
    throw new Error(`${path} must contain a tools object`);

  const declaredStacks = new Set(catalog.stacks);
  for (const [toolId, tool] of Object.entries(catalog.tools)) {
    if (!TOOL_ID.test(toolId))
      throw new Error(`${path} has invalid tool id: ${toolId}`);
    if (!tool || typeof tool !== "object" || Array.isArray(tool))
      throw new Error(`${path} has invalid tool entry for ${toolId}`);
    if (typeof tool.package !== "string" || !tool.package || /[\s/]/.test(tool.package))
      throw new Error(`${path} has invalid package name for ${toolId}`);
    assertNonEmptyStringArray(tool.categories, `${path} categories for ${toolId}`);
    if (tool.description !== undefined &&
        (typeof tool.description !== "string" || !tool.description.trim() ||
          tool.description.length > MAX_DESCRIPTION_LENGTH)) {
      throw new Error(`${path} has invalid description for ${toolId}`);
    }
    if (tool.homepage !== undefined && (typeof tool.homepage !== "string" || !SAFE_URL.test(tool.homepage)))
      throw new Error(`${path} has invalid homepage for ${toolId}`);
    if (!tool.apps || typeof tool.apps !== "object" || Array.isArray(tool.apps) ||
        !Object.keys(tool.apps).length) {
      throw new Error(`${path} must declare nonempty apps for ${toolId}`);
    }
    for (const [appKey, app] of Object.entries(tool.apps)) {
      if (!app || typeof app !== "object" || Array.isArray(app))
        throw new Error(`${path} has invalid app entry ${toolId}/${appKey}`);
      if (app.backend !== "eessi")
        throw new Error(`${path} app ${toolId}/${appKey} must declare backend "eessi"`);
      if (typeof app.stack !== "string" || !declaredStacks.has(app.stack))
        throw new Error(`${path} app ${toolId}/${appKey} uses undeclared stack ${app.stack}`);
      if (typeof app.module !== "string" || !MODULE_NAME.test(app.module) ||
          !app.module.startsWith(`${tool.package}/`)) {
        throw new Error(`${path} app ${toolId}/${appKey} has invalid module ${app.module}`);
      }
      if (!Array.isArray(app.required_modules) || app.required_modules.length !== 1 ||
          app.required_modules[0] !== `EESSI/${app.stack}`) {
        throw new Error(`${path} app ${toolId}/${appKey} has invalid required_modules`);
      }
      if (typeof app.software_version !== "string" || !SAFE_VERSION.test(app.software_version))
        throw new Error(`${path} app ${toolId}/${appKey} has invalid software_version`);
      if (app.toolchain !== undefined &&
          (typeof app.toolchain !== "string" || !SAFE_TOOLCHAIN.test(app.toolchain))) {
        throw new Error(`${path} app ${toolId}/${appKey} has invalid toolchain`);
      }
      if (!Array.isArray(app.arch) ||
          app.arch.some((a) => typeof a !== "string" || !ARCH_NAME.test(a))) {
        throw new Error(`${path} app ${toolId}/${appKey} has invalid arch list`);
      }
      if (typeof app.gpu !== "boolean")
        throw new Error(`${path} app ${toolId}/${appKey} gpu must be boolean`);
      if (app.gpu) {
        assertNonEmptyStringArray(app.gpu_targets, `${path} gpu_targets for ${toolId}/${appKey}`, GPU_TARGET);
      } else if (app.gpu_targets !== undefined) {
        throw new Error(`${path} non-GPU app ${toolId}/${appKey} must not set gpu_targets`);
      }
      if (!Array.isArray(app.exec) ||
          app.exec.some((arg) => typeof arg !== "string" || !EXEC_ARG.test(arg))) {
        throw new Error(`${path} app ${toolId}/${appKey} has invalid exec argv`);
      }
      if (typeof app.gui !== "boolean")
        throw new Error(`${path} app ${toolId}/${appKey} gui must be boolean`);
      for (const flag of ["terminal", "show_in_menu", "show_in_applist"]) {
        if (app[flag] !== undefined && typeof app[flag] !== "boolean")
          throw new Error(`${path} app ${toolId}/${appKey} ${flag} must be boolean`);
      }
      if (app.license !== undefined) {
        assertNonEmptyStringArray(app.license, `${path} license for ${toolId}/${appKey}`, SAFE_LICENSE);
      }
    }
  }
}

async function writeAtomic(destination, content) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, destination);
}

export async function readPreviousCatalogLoose(dir) {
  let catalog = null;
  let catalogMissing = false;
  let rawCatalog;
  try {
    rawCatalog = await readFile(join(dir, "apps.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") catalogMissing = true;
    else throw error;
  }
  if (rawCatalog !== undefined) {
    try {
      const parsed = JSON.parse(rawCatalog);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) catalog = parsed;
    } catch {
      // Malformed JSON: treated as corrupt stub (catalog remains null).
    }
  }
  let manifest = null;
  let manifestMissing = false;
  let rawManifest;
  try {
    rawManifest = await readFile(join(dir, "manifest.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") manifestMissing = true;
    else throw error;
  }
  if (rawManifest !== undefined) {
    try {
      const parsed = JSON.parse(rawManifest);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed;
    } catch {
      // Malformed JSON: treated as corrupt manifest (manifest remains null).
    }
  }
  return { catalog, catalogMissing, manifest, manifestMissing };
}

export function hasContainerCatalogData(catalog, manifest) {
  if (catalog && Object.values(catalog).some((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry) &&
    entry.apps && typeof entry.apps === "object" && !Array.isArray(entry.apps) &&
    Object.values(entry.apps).some((app) => app && typeof app === "object" && !Array.isArray(app)),
  )) {
    return true;
  }
  if (manifest?.source_commits && typeof manifest.source_commits === "object" &&
      !Array.isArray(manifest.source_commits) && Object.keys(manifest.source_commits).length > 0) {
    return true;
  }
  return false;
}

// EESSI-only domains (source_repositories: []) still need an empty apps.json
// and zero-entry manifest.json so NeuroDesk/neurocontainers' merge_domain_catalogs.py
// never hits a missing file. Never silently erase a converted domain that still
// holds container entries or source_commits: container consolidation must run
// first so stored licenses and DOIs carry over to any destination domain.
export async function ensureEmptyDomainCatalogs(root, domains) {
  const written = [];
  for (const [id, config] of Object.entries(domains)) {
    if (config.source_repositories.length > 0) continue;
    const dir = join(root, id);
    const { catalog, manifest } = await readPreviousCatalogLoose(dir);
    if (hasContainerCatalogData(catalog, manifest)) {
      throw new Error(
        `Domain ${id} still has container entries or source_commits; run container consolidation (npm run consolidate) first so stored licenses and DOIs carry over`,
      );
    }
    const alreadyClean = catalog !== null && Object.keys(catalog).length === 0 &&
      manifest !== null && manifest.entries === 0 &&
      manifest.source_commits && typeof manifest.source_commits === "object" &&
      !Array.isArray(manifest.source_commits) && Object.keys(manifest.source_commits).length === 0;
    if (alreadyClean) continue;
    await writeAtomic(join(dir, "apps.json"), jsonText({}));
    await writeAtomic(join(dir, "manifest.json"), jsonText({
      entries: 0,
      source_commits: {},
      app_sources: {},
    }));
    written.push(`${id}/apps.json`, `${id}/manifest.json`);
    console.log(`Generated empty compatibility catalog for EESSI-only domain ${id}`);
  }
  return written;
}

export function mergeDomainEessiCatalogs({
  cvmfsRepo,
  domainCatalogs,
  domainStacks,
  globalStacks,
}) {
  const merged = new Map();
  for (const [domain, catalog] of Object.entries(domainCatalogs).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [toolId, tool] of Object.entries(catalog.tools)) {
      const existing = merged.get(toolId);
      if (!existing) {
        merged.set(toolId, {
          package: tool.package,
          categories: [...tool.categories],
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.homepage ? { homepage: tool.homepage } : {}),
          apps: structuredClone(tool.apps),
        });
        continue;
      }
      if (existing.package !== tool.package) {
        throw new EessiFeedError(
          `Conflicting EESSI package for ${toolId} across domains (${existing.package} vs ${tool.package})`,
        );
      }
      for (const cat of tool.categories) {
        if (!existing.categories.includes(cat)) existing.categories.push(cat);
      }
      existing.description ??= tool.description;
      existing.homepage ??= tool.homepage;
      for (const [appKey, app] of Object.entries(tool.apps)) {
        if (Object.hasOwn(existing.apps, appKey) &&
            JSON.stringify(existing.apps[appKey]) !== JSON.stringify(app)) {
          throw new EessiFeedError(`Conflicting EESSI app ${toolId}/${appKey} in domain ${domain}`);
        }
        existing.apps[appKey] = structuredClone(app);
      }
    }
  }
  const sortedTools = Object.fromEntries(
    [...merged.keys()].sort().map((toolId) => {
      const tool = merged.get(toolId);
      return [toolId, {
        ...tool,
        apps: Object.fromEntries(
          Object.keys(tool.apps).sort().map((appKey) => [appKey, tool.apps[appKey]]),
        ),
      }];
    }),
  );
  return {
    schemaVersion: 1,
    backend: "eessi",
    explicitSelectionRequired: true,
    cvmfsRepo,
    stacks: [...globalStacks],
    domain_stacks: Object.fromEntries(
      Object.entries(domainStacks).sort(([a], [b]) => a.localeCompare(b)),
    ),
    tools: sortedTools,
  };
}

async function readPreviousEessiCatalog(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// EESSI stacks are append-only CVMFS releases: if a curated package previously
// had builds on a still-configured stack in this domain's committed eessi.json,
// a feed that suddenly contains zero raw versions for that (package, stack)
// pair is treated as a partial/truncated feed rather than silently dropping it.
function assertNoLostPublishedStacks({ domain, stacks, curation, feed, previousCatalog }) {
  if (!previousCatalog?.tools || typeof previousCatalog.tools !== "object") return;
  const activeStacks = new Set(stacks);
  const pkgById = new Map(
    Object.entries(curation.packages)
      .filter(([, cfg]) => cfg.domains.includes(domain))
      .map(([pkgName, cfg]) => [cfg.id, pkgName]),
  );
  for (const [toolId, prevTool] of Object.entries(previousCatalog.tools)) {
    const pkgName = pkgById.get(toolId);
    if (!pkgName || prevTool?.package !== pkgName ||
        !prevTool?.apps || typeof prevTool.apps !== "object") continue;
    const prevStacks = new Set(
      Object.values(prevTool.apps)
        .map((app) => app?.stack)
        .filter((stack) => typeof stack === "string" && activeStacks.has(stack)),
    );
    const versions = Array.isArray(feed.software?.[pkgName]?.versions)
      ? feed.software[pkgName].versions
      : [];
    for (const stack of prevStacks) {
      if (!versions.some((entry) => entryMatchesStack(entry, stack))) {
        throw new EessiFeedError(
          `EESSI feed dropped previously published builds for ${pkgName} on EESSI/${stack} in ${domain}`,
        );
      }
    }
  }
}

export async function consolidateEessi(
  root,
  domains,
  { fetchImpl = fetch, feed = null, failSoft = false } = {},
) {
  // Always validate the hand-edited curation manifest strictly; only upstream
  // feed fetch/shape failures may fail softly.
  const curation = await readCuration(root, domains);
  // Repair EESSI-only compatibility files independently of the upstream feed so
  // corrupt non-container stubs heal even during an outage, while refusing to
  // wipe converted domains that still hold container metadata.
  const compatWritten = await ensureEmptyDomainCatalogs(root, domains);
  const { domainStacks, stacks: globalStacks } = expectedGlobalEessiConfig(domains);
  const enabledDomains = Object.entries(domainStacks);
  if (!enabledDomains.length) {
    console.log("EESSI: no domains configure eessi_stacks; curation validated");
    return { updated: compatWritten.length > 0, written: compatWritten };
  }

  let planned;
  try {
    const resolvedFeed = feed ?? await fetchEessiFeed(curation.sourceUrl, { fetchImpl });
    const files = [];
    const domainCatalogs = {};

    for (const [id, stacks] of enabledDomains) {
      const previousCatalog = await readPreviousEessiCatalog(join(root, id, "eessi.json"));
      const catalog = buildEessiCatalog({
        curation,
        feed: resolvedFeed,
        stacks,
        domain: id,
      });
      assertNoLostPublishedStacks({
        domain: id,
        stacks,
        curation,
        feed: resolvedFeed,
        previousCatalog,
      });
      try {
        validateEessiCatalog(catalog, `${id}/eessi.json`, { expectedStacks: stacks });
      } catch (error) {
        throw new EessiFeedError(error.message);
      }
      domainCatalogs[id] = catalog;
      files.push({
        rel: `${id}/eessi.json`,
        content: jsonText(catalog),
        count: Object.keys(catalog.tools).length,
      });
    }

    const globalCatalog = mergeDomainEessiCatalogs({
      cvmfsRepo: curation.cvmfsRepo,
      domainCatalogs,
      domainStacks,
      globalStacks,
    });
    try {
      validateEessiCatalog(globalCatalog, GLOBAL_EESSI_CATALOG_PATH, {
        expectedStacks: globalStacks,
        expectedDomainStacks: domainStacks,
      });
    } catch (error) {
      throw new EessiFeedError(error.message);
    }
    files.push({
      rel: GLOBAL_EESSI_CATALOG_PATH,
      content: jsonText(globalCatalog),
      count: Object.keys(globalCatalog.tools).length,
    });
    planned = files;
  } catch (error) {
    if (failSoft && error instanceof EessiFeedError) {
      const msg = error.message.replace(/[\r\n]+/g, " ");
      console.warn(`EESSI catalogs not updated (keeping committed files): ${msg}`);
      if (process.env.GITHUB_ACTIONS === "true") {
        console.log(`::warning title=EESSI catalogs not updated::${msg}`);
      }
      if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          `> [!WARNING]\n> **EESSI catalogs not updated** (kept committed files): ${msg}\n\n`,
        ).catch(() => {});
      }
      return { updated: compatWritten.length > 0, written: compatWritten, error: error.message };
    }
    throw error;
  }

  // Write EESSI catalogs only after every catalog has been built and validated in memory.
  const written = [...compatWritten];
  for (const { rel, content, count } of planned) {
    await writeAtomic(join(root, rel), content);
    written.push(rel);
    console.log(`Generated ${rel} (${count} EESSI tool(s))`);
  }
  return { updated: true, written };
}
