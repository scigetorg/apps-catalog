import Ajv from "ajv";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// domains.json is published for Neurodesk App. Each domain has one container
// image, described by its optional `container` block, which the app fetches
// to know what it can launch. readDomains (workflow.mjs) checks only what the
// catalog pipeline needs; this file checks the whole document against the
// app's JSON Schema before it is published. The app re-validates every
// container with the same rules (neurodesk-desktop
// src/main/config/containerCatalogSchema.ts) and drops what fails, so this
// check exists to stop a bad edit before it is published, not after.
//
// The schema lives only in neurodesk-desktop and is fetched from there, so the
// two repositories cannot drift apart. DOMAINS_SCHEMA_FILE points at a local
// copy instead (offline work, or testing a schema change before it is merged);
// DOMAINS_SCHEMA_URL points at another branch or fork.

export const DOMAINS_PATH = "domains.json";
export const DOMAINS_SCHEMA_URL =
  "https://raw.githubusercontent.com/scigetorg/sciget-app/release-v2.2.0/src/main/config/domains.schema.json";
const SCHEMA_FETCH_TIMEOUT_MS = 15000;

let compiled;

export async function loadSchema(env = process.env, fetchImpl = fetch) {
  if (env.DOMAINS_SCHEMA_FILE) {
    return JSON.parse(await readFile(env.DOMAINS_SCHEMA_FILE, "utf8"));
  }
  const url = env.DOMAINS_SCHEMA_URL || DOMAINS_SCHEMA_URL;
  let response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(SCHEMA_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Could not fetch the domains schema from ${url}: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(
      `Could not fetch the domains schema from ${url}: HTTP ${response.status}`,
    );
  }
  try {
    return JSON.parse(await response.text());
  } catch (error) {
    throw new Error(`The domains schema at ${url} is not valid JSON: ${error.message}`);
  }
}

async function validator() {
  if (!compiled) {
    // Fails closed: without the schema nothing is validated, so nothing is
    // published and the Worker keeps serving the previous files.
    compiled = new Ajv({ strict: true, allErrors: true }).compile(
      await loadSchema(),
    );
  }
  return compiled;
}

/**
 * Validation errors for a parsed domains.json; empty if valid. Besides the
 * schema, no two domains may share a containerName: their containers would
 * collide in the app.
 */
export async function domainsErrors(document) {
  const validate = await validator();
  if (!validate(document))
    return validate.errors.map(
      ({ instancePath, message }) => `${instancePath || "/"} ${message}`,
    );
  const errors = [];
  const owners = new Map();
  for (const [id, { container }] of Object.entries(document.domains)) {
    if (!container) continue;
    const owner = owners.get(container.containerName);
    if (owner)
      errors.push(
        `/domains/${id}/container/containerName ${container.containerName} is already used by ${owner}`,
      );
    else owners.set(container.containerName, id);
  }
  return errors;
}

/**
 * Read <root>/domains.json and validate it for publishing. Returns its bytes;
 * throws when it is not valid JSON or fails validation.
 */
export async function readPublishedDomains(root) {
  const bytes = await readFile(join(root, DOMAINS_PATH));
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${DOMAINS_PATH} is not valid JSON: ${error.message}`);
  }
  const errors = await domainsErrors(document);
  if (errors.length)
    throw new Error(`${DOMAINS_PATH} is invalid:\n  ${errors.join("\n  ")}`);
  return bytes;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await readPublishedDomains(process.cwd());
    console.log(`${DOMAINS_PATH} is valid`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
