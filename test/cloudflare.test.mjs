import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  catalogAssets,
  publishCatalogs,
  verifyPublishedCatalogs,
} from "../scripts/cloudflare.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "neurodesk-cloudflare-"));
  await writeFile(
    join(root, "domains.json"),
    JSON.stringify({
      schemaVersion: 1,
      domains: {
        neuroimaging: { source_repositories: ["NeuroDesk/neurocontainers"] },
        microscopy: { source_repositories: ["Example/microcontainers"] },
      },
    }),
  );
  for (const id of ["neuroimaging", "microscopy"]) {
    await mkdir(join(root, id));
    await writeFile(
      join(root, id, "apps.json"),
      JSON.stringify({ [id]: { apps: {} } }),
    );
  }
  return root;
}

function ok(result) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, result }),
  };
}

test("publishes configured domain paths and requested asset batches", async () => {
  const root = await fixture();
  const assets = await catalogAssets(root);
  const hashes = [...assets.values()].map(({ hash }) => hash);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "GET") return ok({ id: "catalog" });
    if (url.endsWith("assets-upload-session"))
      return ok({ jwt: "upload-token", buckets: [hashes] });
    if (url.includes("assets/upload?")) return ok({ jwt: "completion-token" });
    return ok({});
  };
  const paths = await publishCatalogs(root, {
    accountId: "account",
    apiToken: "api-token",
    workerName: "catalog",
    fetchImpl,
  });
  assert.deepEqual(paths, [
    "/microscopy/apps.json",
    "/neuroimaging/apps.json",
    "/domains.json",
  ]);
  assert.equal(calls.length, 5);
  const manifest = JSON.parse(calls[1].options.body).manifest;
  for (const [path, asset] of assets) {
    assert.deepEqual(manifest[path], {
      hash: createHash("sha256")
        .update(asset.bytes.toString("base64") + "json")
        .digest("hex")
        .slice(0, 32),
      size: asset.bytes.length,
    });
  }
  assert.equal(calls[2].options.headers.Authorization, "Bearer upload-token");
  for (const hash of hashes) {
    const part = calls[2].options.body.get(hash);
    assert.equal(part.type, "application/json");
    assert.equal(
      await part.text(),
      [...assets.values()]
        .find((asset) => asset.hash === hash)
        .bytes.toString("base64"),
    );
  }
  assert.equal(calls[3].options.method, "PUT");
  assert.equal(calls[3].options.headers.Authorization, "Bearer api-token");
  const metadata = JSON.parse(
    await calls[3].options.body.get("metadata").text(),
  );
  assert.equal(calls[3].options.body.get("metadata").type, "application/json");
  assert.equal(metadata.assets.jwt, "completion-token");
  assert.match(
    metadata.assets.config._headers,
    /Access-Control-Allow-Origin: \*/,
  );
  assert.equal(calls[4].url.endsWith("/subdomain"), true);
  assert.deepEqual(JSON.parse(calls[4].options.body), {
    enabled: true,
    previews_enabled: false,
  });
});

test("reuses completion token when assets are unchanged", async () => {
  const root = await fixture();
  const calls = [];
  await publishCatalogs(root, {
    accountId: "account",
    apiToken: "api-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "GET") return ok({ id: "apps-json" });
      return ok(
        url.endsWith("assets-upload-session")
          ? { jwt: "existing-assets", buckets: [] }
          : {},
      );
    },
  });
  assert.equal(calls.length, 4);
  assert.equal(
    JSON.parse(await calls[2].options.body.get("metadata").text()).assets.jwt,
    "existing-assets",
  );
});

test("creates the Worker before the first asset upload", async () => {
  const root = await fixture();
  const calls = [];
  await publishCatalogs(root, {
    accountId: "account",
    apiToken: "api-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "GET") {
        return {
          ok: false,
          status: 404,
          json: async () => ({ success: false, errors: [] }),
        };
      }
      return ok(
        url.endsWith("assets-upload-session")
          ? { jwt: "existing-assets", buckets: [] }
          : {},
      );
    },
  });
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].url.endsWith("/workers/workers"), true);
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: "apps-json" });
  assert.equal(calls[2].url.endsWith("assets-upload-session"), true);
});

test("stops before deployment on failed upload or invalid catalog", async () => {
  const root = await fixture();
  const assets = await catalogAssets(root);
  const hash = [...assets.values()][0].hash;
  let calls = 0;
  await assert.rejects(
    publishCatalogs(root, {
      accountId: "account",
      apiToken: "api-token",
      fetchImpl: async (url) => {
        calls++;
        if (url.endsWith("/workers/apps-json")) return ok({ id: "apps-json" });
        if (url.endsWith("assets-upload-session"))
          return ok({ jwt: "upload-token", buckets: [[hash]] });
        return {
          ok: false,
          status: 403,
          json: async () => ({
            success: false,
            errors: [{ code: 10000, message: "Unauthorized" }],
          }),
        };
      },
    }),
    /Cloudflare POST .*assets\/upload.*403.*Unauthorized/,
  );
  assert.equal(calls, 3);
  await writeFile(join(root, "microscopy", "apps.json"), "[]");
  await assert.rejects(catalogAssets(root), /must contain a JSON object/);
});

test("verifies public bytes, content type, and CORS after deployment", async () => {
  const root = await fixture();
  const assets = await catalogAssets(root);
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.includes("api.cloudflare.com"))
      return ok({
        subdomain: { url: "https://apps-json.example.workers.dev" },
      });
    const path = new URL(url).pathname;
    return new Response(assets.get(path).bytes, {
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      },
    });
  };
  assert.equal(
    await verifyPublishedCatalogs(root, {
      accountId: "account",
      apiToken: "api-token",
      fetchImpl,
      delayMs: 0,
    }),
    "https://apps-json.example.workers.dev",
  );
  // One API lookup, then each asset: two catalogs and domains.json.
  assert.equal(requests.length, 4);
  assert.ok(
    requests.includes("https://apps-json.example.workers.dev/domains.json"),
  );
  assert.equal(
    requests[0],
    "https://api.cloudflare.com/client/v4/accounts/account/workers/workers/apps-json",
  );
  await assert.rejects(
    verifyPublishedCatalogs(root, {
      accountId: "account",
      apiToken: "api-token",
      attempts: 1,
      fetchImpl: async (url) =>
        url.includes("api.cloudflare.com")
          ? ok({ subdomain: { url: "https://apps-json.example.workers.dev" } })
          : new Response("{}", {
              headers: { "content-type": "application/json" },
            }),
    }),
    /Could not verify .*content mismatch/,
  );
  await assert.rejects(
    verifyPublishedCatalogs(root, {
      accountId: "account",
      apiToken: "api-token",
      attempts: 1,
      fetchImpl: async (url) =>
        url.includes("api.cloudflare.com")
          ? ok({ subdomain: { url: "https://apps-json.example.workers.dev" } })
          : new Response(assets.get(new URL(url).pathname).bytes, {
              headers: { "content-type": "application/json" },
            }),
    }),
    /Could not verify .*access-control-allow-origin mismatch \(missing\)/,
  );
});

test("ships the Zenodo license list with the catalogs when present", async () => {
  const root = await fixture();
  assert.equal((await catalogAssets(root)).has("/licenses/zenodo.json"), false);
  await mkdir(join(root, "licenses"));
  const list = JSON.stringify({ licenses: [{ id: "MIT" }] });
  await writeFile(join(root, "licenses", "zenodo.json"), list);
  const assets = await catalogAssets(root);
  assert.equal(assets.get("/licenses/zenodo.json").bytes.toString(), list);
  await writeFile(join(root, "licenses", "zenodo.json"), '{"licenses": []}');
  await assert.rejects(catalogAssets(root), /must list licenses/);
});

test("ships per-domain eessi.json and global /eessi/catalog.json when eessi_stacks are configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "neurodesk-cloudflare-eessi-"));
  const schema = {
    type: "object",
    required: ["schemaVersion", "domains"],
    properties: {
      schemaVersion: { const: 1 },
      domains: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            source_repositories: { type: "array", items: { type: "string" } },
            eessi_stacks: { type: "array", items: { type: "string" } },
            eessiCatalogUrl: { type: "string" },
          },
        },
      },
    },
  };
  await writeFile(join(root, "domains.json"), JSON.stringify({
    schemaVersion: 1,
    domains: {
      neuroimaging: {
        source_repositories: ["NeuroDesk/neurocontainers"],
        eessi_stacks: ["2025.06"],
        eessiCatalogUrl: "https://apps-catalog.example.workers.dev/neuroimaging/eessi.json",
      },
      microscopy: {
        source_repositories: ["Example/microcontainers"],
      },
    },
  }));
  await mkdir(join(root, "neuroimaging"));
  await mkdir(join(root, "microscopy"));
  await mkdir(join(root, "eessi"));
  await writeFile(join(root, "neuroimaging", "apps.json"), "{}");
  await writeFile(join(root, "microscopy", "apps.json"), "{}");
  const eessiDoc = JSON.stringify({
    schemaVersion: 1,
    backend: "eessi",
    explicitSelectionRequired: true,
    cvmfsRepo: "software.eessi.io",
    stacks: ["2025.06"],
    tools: {},
  });
  const globalEessiDoc = JSON.stringify({
    schemaVersion: 1,
    backend: "eessi",
    explicitSelectionRequired: true,
    cvmfsRepo: "software.eessi.io",
    stacks: ["2025.06"],
    domain_stacks: { neuroimaging: ["2025.06"] },
    tools: {},
  });
  await writeFile(join(root, "neuroimaging", "eessi.json"), eessiDoc);
  await writeFile(join(root, "eessi", "catalog.json"), globalEessiDoc);

  const assets = await catalogAssets(root, { schema });
  assert.deepEqual([...assets.keys()], [
    "/microscopy/apps.json",
    "/neuroimaging/apps.json",
    "/neuroimaging/eessi.json",
    "/eessi/catalog.json",
    "/domains.json",
  ]);

  // Stack mismatch between domains.json and committed eessi.json fails closed.
  await writeFile(join(root, "neuroimaging", "eessi.json"), JSON.stringify({
    schemaVersion: 1,
    backend: "eessi",
    explicitSelectionRequired: true,
    cvmfsRepo: "software.eessi.io",
    stacks: ["2023.06"],
    tools: {},
  }));
  await assert.rejects(catalogAssets(root, { schema }), /do not match configured/);

  // Stale domain_stacks in global eessi/catalog.json fails closed.
  await writeFile(join(root, "neuroimaging", "eessi.json"), eessiDoc);
  await writeFile(join(root, "eessi", "catalog.json"), JSON.stringify({
    schemaVersion: 1,
    backend: "eessi",
    explicitSelectionRequired: true,
    cvmfsRepo: "software.eessi.io",
    stacks: ["2025.06"],
    domain_stacks: { microscopy: ["2025.06"], neuroimaging: ["2025.06"] },
    tools: {},
  }));
  await assert.rejects(catalogAssets(root, { schema }), /domain_stacks do not match/);

  await writeFile(join(root, "eessi", "catalog.json"), globalEessiDoc);
  await writeFile(join(root, "neuroimaging", "eessi.json"), '{"schemaVersion":1,"backend":"wrong"}');
  await assert.rejects(catalogAssets(root, { schema }), /must declare schemaVersion 1 and backend "eessi"/);

  // EESSI-only domain with stale non-empty apps.json fails closed at deployment.
  await writeFile(join(root, "neuroimaging", "eessi.json"), eessiDoc);
  await writeFile(join(root, "domains.json"), JSON.stringify({
    schemaVersion: 1,
    domains: {
      neuroimaging: {
        source_repositories: [],
        eessi_stacks: ["2025.06"],
        eessiCatalogUrl: "https://apps-catalog.example.workers.dev/neuroimaging/eessi.json",
      },
    },
  }));
  await writeFile(join(root, "neuroimaging", "apps.json"), JSON.stringify({
    stale: { apps: { "stale 1.0": { image: "stale_1.0", version: "20260101" } } },
  }));
  await assert.rejects(
    catalogAssets(root, { schema }),
    /EESSI-only domain neuroimaging must have an empty apps\.json/,
  );
  await writeFile(join(root, "neuroimaging", "apps.json"), "{}");
  const eessiOnlyAssets = await catalogAssets(root, { schema });
  assert.deepEqual([...eessiOnlyAssets.keys()], [
    "/neuroimaging/apps.json",
    "/neuroimaging/eessi.json",
    "/eessi/catalog.json",
    "/domains.json",
  ]);
});
