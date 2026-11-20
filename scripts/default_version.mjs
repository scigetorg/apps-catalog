import { readFile, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DOMAINS_PATH, domainsErrors } from "./domains.mjs";

// Keeps each domain container's `defaultVersion` in domains.json at the
// release its release-history page marks as Latest. domains.json is the one
// place Neurodesk App reads the default image tag from, so this replaces
// hand bumps (and neurodesk-app's old neurodesktop.toml sync).
//
//   releaseHistoryUrl ──fetch──► "### 2026-09-23 <Badge text="Latest" .../>"
//          │                                  │ latestRelease()
//          ▼                                  ▼
//   current defaultVersion  ◄── newer date? ── tag on Docker Hub? ── yes ──► bump
//
// The CLI rewrites domains.json in place and, under GitHub Actions, writes
// `branch` and `title` outputs; sync-default-version.yml opens the PR, and
// merging it runs publish-domains.yml. Nothing here publishes.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LATEST_HEADING =
  /^#{2,4}[ \t]+(\d{4}-\d{2}-\d{2})[ \t]+<Badge\b[^>]*\btext=["']Latest["'][^>]*>/gm;
const FETCH_TIMEOUT_MS = 15000;

/** The one release dated and marked Latest on a release-history page. */
export function latestRelease(text) {
  const versions = [...text.matchAll(LATEST_HEADING)].map((match) => match[1]);
  if (versions.length !== 1)
    throw new Error(
      `expected one release heading marked Latest, found ${versions.length}` +
        (versions.length ? ` (${versions.join(", ")})` : ""),
    );
  return versions[0];
}

/** Docker Hub API URL for a tag, or null for a registry other than Docker Hub. */
export function dockerHubTagUrl(registry, tag) {
  const match = /^(?:docker\.io|registry-1\.docker\.io)\/(.+)$/.exec(registry);
  if (!match) return null;
  const repository = match[1].includes("/") ? match[1] : `library/${match[1]}`;
  return `https://hub.docker.com/v2/repositories/${repository}/tags/${encodeURIComponent(tag)}`;
}

async function get(fetchImpl, url) {
  return fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/** Whether registry:tag can be pulled. Throws on an unsupported registry. */
export async function tagExists(registry, tag, fetchImpl = fetch) {
  const url = dockerHubTagUrl(registry, tag);
  if (!url) throw new Error(`cannot check tags on ${registry}: only docker.io is supported`);
  const response = await get(fetchImpl, url);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return true;
}

/**
 * Bumps to apply to a parsed domains.json. Each domain is decided on its own:
 * a failure for one (page down, no Latest heading, registry error) is
 * reported in `errors` and leaves that domain alone.
 */
export async function planBumps(document, { fetchImpl = fetch } = {}) {
  const bumps = [];
  const notes = [];
  const errors = [];
  for (const [id, domain] of Object.entries(document.domains)) {
    if (!domain.releaseHistoryUrl) continue;
    const current = domain.defaultVersion;
    try {
      const response = await get(fetchImpl, domain.releaseHistoryUrl);
      if (!response.ok)
        throw new Error(`${domain.releaseHistoryUrl} answered HTTP ${response.status}`);
      const latest = latestRelease(await response.text());
      if (latest === current) {
        notes.push(`${id}: already at ${current}`);
      } else if (!DATE.test(current)) {
        notes.push(`${id}: defaultVersion ${current} is not a dated release; left alone (Latest is ${latest})`);
      } else if (latest < current) {
        notes.push(`${id}: defaultVersion ${current} is newer than Latest ${latest}; left alone`);
      } else if (!(await tagExists(domain.registry, latest, fetchImpl))) {
        notes.push(`${id}: ${domain.registry}:${latest} is not on the registry yet`);
      } else {
        bumps.push({ id, from: current, to: latest });
      }
    } catch (error) {
      errors.push(`${id}: ${error.message}`);
    }
  }
  return { bumps, notes, errors };
}

/** Apply planned bumps to <root>/domains.json, validated before writing. */
export async function updateDefaultVersions(root, options = {}) {
  const path = join(root, DOMAINS_PATH);
  const document = JSON.parse(await readFile(path, "utf8"));
  const plan = await planBumps(document, options);
  if (!plan.bumps.length) return plan;
  for (const { id, to } of plan.bumps) document.domains[id].defaultVersion = to;
  const invalid = await domainsErrors(document);
  if (invalid.length)
    throw new Error(`bumped ${DOMAINS_PATH} would be invalid:\n  ${invalid.join("\n  ")}`);
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
  return plan;
}

/** Branch name and PR title for a set of bumps. */
export function pullRequestFor(bumps) {
  const parts = bumps.map(({ id, to }) => `${id}-${to}`);
  return {
    branch: `default-version/${parts.join("+")}`,
    title: `Bump default container version: ${bumps
      .map(({ id, from, to }) => `${id} ${from} → ${to}`)
      .join(", ")}`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { bumps, notes, errors } = await updateDefaultVersions(process.cwd());
    for (const note of notes) console.log(note);
    for (const error of errors) console.error(`error: ${error}`);
    for (const { id, from, to } of bumps) console.log(`${id}: ${from} -> ${to}`);
    if (bumps.length && process.env.GITHUB_OUTPUT) {
      const { branch, title } = pullRequestFor(bumps);
      await appendFile(process.env.GITHUB_OUTPUT, `branch=${branch}\ntitle=${title}\n`);
    }
    // Bumps that succeeded are still written; a failing domain fails the run
    // so it is noticed.
    if (errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
