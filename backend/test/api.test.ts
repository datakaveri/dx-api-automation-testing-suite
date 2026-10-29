import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app";
import type { Catalog } from "../src/catalog";
import { CollectionController } from "../src/controllers/collectionController";
import { SettingsController } from "../src/controllers/settingsController";
import { SettingsStore } from "../src/repositories/settingsStore";
import { RunError } from "../src/runner";
import type { CollectionDescriptor, ExecutionResult, HistoryRun } from "../src/types";
import { memoryLogger, memorySettingsModel, memoryStore } from "./helpers";

// The real app, controllers, validation and Keycloak checks, with an in-memory store,
// a fake runner and a local JWKS server instead of Keycloak.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key";
let jwksServer: Server;
let apiServer: Server;
let jwksFails = false;
let api = "";
let issuer = "";

const descriptor = (id: string, folderName: string, collection: Record<string, unknown> | null = { item: [] }): CollectionDescriptor => ({
  id, folderName, folderPath: folderName, collectionFile: "c.json", environmentFile: "e.json", postRunFile: null,
  fileName: "c.json", name: folderName, requestCount: 3, environment: "e.json", collection, parseError: collection ? null : "bad JSON",
});
const catalog: Catalog = {
  collections: [descriptor("alpha", "Alpha"), descriptor("beta", "Beta"), descriptor("broken", "Broken", null)],
  skipped: [{ folderName: "Junk", fileName: "x.json", reason: "Invalid JSON." }],
};

const execution = (name: string, method: string, folder: string | null, failed: boolean): ExecutionResult => ({
  folder, name, method, url: `https://example.com/${name}`, statusCode: failed ? 500 : 200, responseTimeMs: 10, responseSize: 20,
  assertions: [{ name: "status", passed: !failed, errorMessage: failed ? "expected 200" : null }], requestError: null, failed,
});
const historyRun: HistoryRun = {
  runId: "run-alpha-1", startedAt: "2024-01-01T00:00:00.000Z", completedAt: "2024-01-01T00:00:02.000Z", durationMs: 2000, status: "failed",
  stats: { requests: { total: 3, failed: 1 }, assertions: { total: 3, failed: 1 }, tests: { total: 3, failed: 1 }, averageResponseTimeMs: 10 },
  executions: [execution("list", "get", "Items", false), execution("create", "POST", "Items", true), execution("health", "GET", null, false)],
};

const runnerCalls: string[] = [];
const runner = {
  startOne: async (id: string) => {
    runnerCalls.push(`one:${id}`);
    if (id === "beta") throw new RunError(409, "COLLECTION_RUNNING", "Collection is already running.");
    if (id === "broken") throw new Error("unexpected failure");
    return "run-new";
  },
  startAll: async () => ({ queued: ["alpha"], skipped: ["broken"] }),
  startSelected: async (ids: string[]) => ({ queued: ids.map((collectionId) => ({ collectionId, runId: "run-x", status: "running", statusUrl: "/api/runs/run-x" })), skipped: [] }),
};

function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "RS256", kid: KID, ...header })}.${encode({
    iss: issuer, sub: "user-1", exp: Math.floor(Date.now() / 1000) + 300, aud: ["qa-api"], azp: "qa-web",
    preferred_username: "qa", realm_access: { roles: ["qa_admin"] }, ...claims,
  })}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
}
const ADMIN = () => ({ authorization: `Bearer ${token()}` });

async function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${api}${path}`, { ...init, headers, body: init.json === undefined ? init.body : JSON.stringify(init.json) });
  const text = await response.text();
  let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, headers: response.headers, body };
}

before(async () => {
  jwksServer = createServer((_request, response) => {
    if (jwksFails) return void response.writeHead(500).end();
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, use: "sig" };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk, { kid: "enc", use: "enc", kty: "RSA" }, null] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const keycloakUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/`;
  Object.assign(process.env, { KEYCLOAK_URL: keycloakUrl, KEYCLOAK_REALM: "qa", KEYCLOAK_API_AUDIENCE: "qa-api", KEYCLOAK_FRONTEND_CLIENT_ID: "qa-web" });
  issuer = `${keycloakUrl.replace(/\/$/, "")}/realms/qa`;

  const { store } = memoryStore({
    alpha: { status: "failed", runId: "run-alpha-1", lastRunAt: historyRun.completedAt, durationMs: 2000, stats: historyRun.stats, result: { ...historyRun, executions: historyRun.executions }, history: [historyRun] },
    beta: { status: "running", runId: "run-beta-live", runStartedAt: "2024-01-01T00:00:00.000Z", lastRunAt: null, durationMs: null, stats: null, result: null },
  });
  const loadCatalog = async () => catalog;
  const settings = new SettingsStore(memorySettingsModel().model, ["qa@example.com"]);
  const scheduler = { start: () => {} };
  const controller = new CollectionController(loadCatalog, store, runner as never, "https://dash.example");
  const settingsController = new SettingsController(settings, scheduler as never, loadCatalog);
  const app = createApp(controller, memoryLogger() as never, ["http://allowed.example"], settingsController);
  apiServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => apiServer.once("listening", resolve));
  api = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
});

after(() => {
  apiServer.close();
  jwksServer.close();
});

describe("public endpoints and middleware", () => {
  it("answers health checks and CORS preflight", async () => {
    const health = await call("/healthz");
    assert.equal(health.body.status, "healthy");
    assert.equal(health.headers.get("access-control-allow-origin"), "*");
    assert.equal(health.headers.get("x-content-type-options"), null); // health is answered before the security headers

    const allowed = await call("/api/collections", { method: "OPTIONS", headers: { origin: "http://allowed.example" } });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://allowed.example");
    const other = await call("/health", { headers: { origin: "http://other.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), "*");
  });

  it("serves the API docs and echoes the request id", async () => {
    const docs = await call("/api/docs.json", { headers: { "x-request-id": "req-1" } });
    assert.equal(docs.status, 200);
    assert.ok(docs.body.openapi);
    assert.equal(docs.headers.get("x-request-id"), "req-1");
    assert.equal(docs.headers.get("x-frame-options"), "SAMEORIGIN");
  });

  it("serves HTML reports without a token", async () => {
    const latest = await call("/api/collections/alpha/report");
    assert.equal(latest.status, 200);
    assert.match(latest.headers.get("content-type") ?? "", /text\/html/);
    assert.equal((await call("/api/collections/alpha/history/run-alpha-1/report")).status, 200);
    assert.equal((await call("/api/collections/nope/report")).status, 404);
    assert.equal((await call("/api/collections/nope/history/run-alpha-1/report")).status, 404);
    assert.equal((await call("/api/collections/alpha/history/run-missing/report")).body.error.code, "RUN_NOT_FOUND");
    assert.equal((await call("/api/collections/%20/report")).status, 400);
  });
});

describe("authentication", () => {
  const status = async (authorization?: string) => (await call("/api/auth/me", { headers: authorization ? { authorization } : {} })).status;

  it("accepts a valid Keycloak token and returns the user", async () => {
    const me = await call("/api/auth/me", { headers: { authorization: `Bearer ${token({ email: "qa@example.com", aud: "qa-api" })}` } });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.user, {
      id: "user-1", username: "qa", email: "qa@example.com", name: null,
      roles: { realm: ["qa_admin"], clients: {}, groups: [] },
    });
  });

  it("rejects missing, malformed, unsigned, expired or foreign tokens", async () => {
    assert.equal(await status(), 401);
    assert.equal(await status("Basic abc"), 401);
    assert.equal(await status("Bearer only.two"), 401);
    assert.equal(await status(`Bearer ${token({}, { alg: "HS256" })}`), 401);
    assert.equal(await status(`Bearer ${token().slice(0, -4)}AAAA`), 401);
    assert.equal(await status(`Bearer ${token({ exp: 1 })}`), 401);
    assert.equal(await status(`Bearer ${token({ iss: "https://evil.example" })}`), 401);
    assert.equal(await status(`Bearer ${token({ aud: "other-api" })}`), 401);
    assert.equal(await status(`Bearer ${token({ azp: "other-web" })}`), 401);
    assert.equal(await status(`Bearer ${token({ nbf: Math.floor(Date.now() / 1000) + 3600 })}`), 401);
  });

  it("returns 503 when Keycloak is not configured or its keys cannot be fetched", async () => {
    const realm = process.env.KEYCLOAK_REALM;
    delete process.env.KEYCLOAK_REALM;
    const unconfigured = await call("/api/auth/me", { headers: ADMIN() });
    process.env.KEYCLOAK_REALM = realm;
    assert.equal(unconfigured.status, 503);
    assert.match(unconfigured.body.error.message, /not configured/);

    jwksFails = true;
    const originalError = console.error;
    console.error = () => {};
    try {
      // An unknown key id forces a refresh, which now fails.
      const unavailable = await call("/api/auth/me", { headers: { authorization: `Bearer ${token({}, { kid: "rotated" })}` } });
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.body.error.message, "Could not verify the access token.");
    } finally {
      console.error = originalError;
      jwksFails = false;
    }
  });

  it("requires the qa_admin role to start runs", async () => {
    const viewer = { authorization: `Bearer ${token({ realm_access: { roles: [] } })}` };
    assert.equal((await call("/api/run-all", { method: "POST", headers: viewer })).status, 403);
    assert.equal((await call("/api/collections", { headers: viewer })).status, 200);
  });
});

describe("collection endpoints", () => {
  it("lists collections, skipped files, summary and dashboard", async () => {
    const list = await call("/api/collections", { headers: ADMIN() });
    assert.deepEqual(list.body.map((c: { id: string; status: string }) => [c.id, c.status]), [["alpha", "failed"], ["beta", "running"], ["broken", "error"]]);
    assert.deepEqual((await call("/api/skipped", { headers: ADMIN() })).body, catalog.skipped);

    const summary = (await call("/api/summary", { headers: ADMIN() })).body;
    assert.deepEqual(summary, { totalCollections: 3, passed: 0, failed: 1, running: 1, totalApis: 9, totalRequests: 3, failedAssertions: 1, averageResponseTimeMs: 10 });

    const dashboard = (await call("/api/dashboard", { headers: ADMIN() })).body.data;
    assert.equal(dashboard.kpis.failedCollections, 2);
    assert.deepEqual(dashboard.collections[0].tests, { passed: 2, failed: 1, total: 3 });
  });

  it("returns the latest result or 404", async () => {
    assert.equal((await call("/api/collections/alpha/result", { headers: ADMIN() })).body.result.durationMs, 2000);
    assert.equal((await call("/api/collections/nope/result", { headers: ADMIN() })).status, 404);
  });

  it("filters and pages the latest run's endpoints", async () => {
    const all = (await call("/api/collections/alpha/runs/latest", { headers: ADMIN() })).body;
    assert.deepEqual(all.data.folders, [{ name: "Items", endpointCount: 2 }, { name: "Root Requests", endpointCount: 1 }]);
    assert.equal(all.data.kpis.passedRequests, 2);
    assert.equal(all.data.endpoints[0].method, "GET");

    const failed = (await call("/api/collections/alpha/runs/latest?status=failed&method=POST&folder=Items&search=CRE", { headers: ADMIN() })).body;
    assert.deepEqual(failed.data.endpoints.map((e: { name: string }) => e.name), ["create"]);
    assert.deepEqual(failed.data.endpoints[0].assertions, { passed: 0, failed: 1, total: 1 });

    const paged = (await call("/api/collections/alpha/runs/latest?page=2&pageSize=2", { headers: ADMIN() })).body;
    assert.equal(paged.data.endpoints.length, 1);
    assert.equal(paged.meta.totalItems, 3);

    assert.equal((await call("/api/collections/alpha/runs/latest?status=weird", { headers: ADMIN() })).status, 400);
    assert.equal((await call("/api/collections/nope/runs/latest", { headers: ADMIN() })).body.error.code, "COLLECTION_NOT_FOUND");
    assert.equal((await call("/api/collections/beta/runs/latest", { headers: ADMIN() })).body.error.code, "RUN_NOT_FOUND");
  });

  it("returns run history", async () => {
    const history = (await call("/api/collections/alpha/history", { headers: ADMIN() })).body;
    assert.equal(history.meta.count, 1);
    assert.deepEqual(history.data.runs[0].assertions, { passed: 2, failed: 1, total: 3 });
    assert.equal((await call("/api/collections/beta/history", { headers: ADMIN() })).body.meta.count, 0);
    assert.equal((await call("/api/collections/nope/history", { headers: ADMIN() })).status, 404);
  });

  it("reports run status for finished, running and unknown runs", async () => {
    const finished = (await call("/api/runs/run-alpha-1", { headers: ADMIN() })).body.data;
    assert.equal(finished.status, "failed");
    assert.equal(finished.durationMs, 2000);
    const running = (await call("/api/runs/run-beta-live", { headers: ADMIN() })).body.data;
    assert.deepEqual([running.status, running.completedAt, running.stats], ["running", null, null]);
    assert.equal((await call("/api/runs/run-nope", { headers: ADMIN() })).status, 404);
  });

  it("starts runs and maps runner errors to responses", async () => {
    const one = await call("/api/collections/alpha/run", { method: "POST", headers: ADMIN() });
    assert.equal(one.status, 202);
    assert.equal(one.body.data.statusUrl, "/api/runs/run-new");
    const busy = await call("/api/collections/beta/run", { method: "POST", headers: ADMIN() });
    assert.deepEqual([busy.status, busy.body.error.code], [409, "COLLECTION_RUNNING"]);
    const crashed = await call("/api/collections/broken/run", { method: "POST", headers: ADMIN() });
    assert.deepEqual([crashed.status, crashed.body.error.code], [500, "INTERNAL_ERROR"]);

    assert.deepEqual((await call("/api/run-all", { method: "POST", headers: ADMIN() })).body, { queued: ["alpha"], skipped: ["broken"] });
    const selected = await call("/api/run-selected", { method: "POST", headers: ADMIN(), json: { collectionIds: ["alpha", "beta"] } });
    assert.equal(selected.status, 202);
    assert.equal(selected.body.data.queued.length, 2);
  });

  it("validates run-selected bodies and malformed JSON", async () => {
    const duplicate = await call("/api/run-selected", { method: "POST", headers: ADMIN(), json: { collectionIds: ["a", "a"] } });
    assert.equal(duplicate.status, 400);
    assert.ok(duplicate.body.error.details.fieldErrors.collectionIds);
    const malformed = await call("/api/run-selected", { method: "POST", headers: { ...ADMIN(), "content-type": "application/json" }, body: "{" });
    assert.deepEqual([malformed.status, malformed.body.error.message], [400, "Request body must contain valid JSON."]);
  });
});

describe("settings endpoints", () => {
  it("reads and updates auto re-run settings with validation", async () => {
    assert.equal((await call("/api/settings/auto-rerun", { headers: ADMIN() })).body.data.interval, "off");

    const invalid = await call("/api/settings/auto-rerun", { method: "PUT", headers: ADMIN(), json: { interval: "5m" } });
    assert.equal(invalid.status, 400);
    const unknown = await call("/api/settings/auto-rerun", { method: "PUT", headers: ADMIN(), json: { collectionIds: ["alpha", "ghost"] } });
    assert.deepEqual(unknown.body.error.details, { collectionIds: ["ghost"] });

    const updated = await call("/api/settings/auto-rerun", { method: "PUT", headers: ADMIN(), json: { interval: "1h", collectionIds: ["alpha"] } });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.data, { interval: "1h", recipients: ["qa@example.com"], collectionIds: ["alpha"] });
  });
});
