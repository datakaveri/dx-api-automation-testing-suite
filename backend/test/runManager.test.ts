import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { scanCatalog, type Catalog } from "../src/catalog";
import { RunError, RunManager } from "../src/runner";
import type { CollectionDescriptor } from "../src/types";
import { collectionsDir, memoryLogger, memoryStore, postmanCollection, postmanEnvironment } from "./helpers";

// Real Newman runs and real post-run child processes over a throwaway collections folder.
const TOKEN = "secret-token-123456";
const REQUIREMENTS = "requests==2.0\n";
let server: Server;
let fixture: Awaited<ReturnType<typeof collectionsDir>>;
let catalog: Catalog;
let dir = ""; // the collections folder; Python venvs and the password file live beside it

const okRequest = (extraTest: string[] = []) => ({
  name: "Ping 200",
  request: { method: "GET", url: "{{base_url}}/ok", header: [{ key: "Authorization", value: "Bearer {{token}}" }] },
  event: [{ listen: "test", script: { type: "text/javascript", exec: ['pm.test("Status code is 200", () => pm.response.to.have.status(200));', ...extraTest] } }],
});
const environment = (baseUrl: string, extra: Array<{ key: string; value: string }> = []) =>
  postmanEnvironment([{ key: "base_url", value: baseUrl }, { key: "token", value: TOKEN, type: "secret" }, ...extra]);
// Writes its arguments to a file and echoes them, so the test can check resolution and redaction.
const STEP_SCRIPT = `
const fs = require("node:fs");
fs.writeFileSync("step-output.json", JSON.stringify({ args: process.argv.slice(2), env: process.env.QA_STEP_VALUE }));
console.log("stdout " + process.argv[2]);
console.error("stderr " + process.argv[2]);
`;
const steps = (name: string, extra: Record<string, unknown> = {}) => [
  { name, command: "node", args: ["step.cjs", "{{exported}}", "{{env.base_url}}"], env: { QA_STEP_VALUE: "{{exported}}" }, shell: false, ...extra },
];

function venvPython(root: string, id: string): string {
  return path.join(root, id, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

before(async () => {
  server = createServer((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const folder = (name: string, postRun?: unknown, extraEnv: Array<{ key: string; value: string }> = [], extraTest: string[] = []) => ({
    [`${name}/collection.json`]: postmanCollection(name, [okRequest(extraTest)]),
    [`${name}/environment.json`]: environment(baseUrl, extraEnv),
    [`${name}/step.cjs`]: STEP_SCRIPT,
    ...(postRun ? { [`${name}/post-run.json`]: postRun } : {}),
  });
  const exportToken = { exported: "environment.token" };

  const files: Record<string, unknown> = {
    ...folder("Plain", { export: exportToken, steps: steps("echo") }),
    ...folder("Shell Failure", { export: exportToken, steps: [{ name: "fail", command: "node", args: ["-e", "console.error('bad {{exported}}'); process.exit(3)", "{{exported}}"], shell: true }] }),
    ...folder("Bad Export", { export: { exported: "nonsense" }, steps: [] }),
    ...folder("Missing Export", { export: { exported: "environment.not_there" }, steps: [] }),
    ...folder("Python Missing", { export: exportToken, python: { requirements: "requirements.txt" }, steps: steps("never") }),
    "Python Missing/requirements.txt": REQUIREMENTS,
    ...folder("Python Stale", { export: exportToken, python: { requirements: "requirements.txt" }, steps: steps("never") }),
    "Python Stale/requirements.txt": REQUIREMENTS,
    ...folder("Python Ready", { export: exportToken, python: { requirements: "requirements.txt" }, steps: steps("ready") }),
    "Python Ready/requirements.txt": REQUIREMENTS,
    ...folder("Python Escape", { export: exportToken, python: { requirements: "../requirements.txt" }, steps: steps("never") }),
    // The request rotates the password the way the real Control Plane collection does.
    ...folder("Control Plane", undefined, [{ key: "consumer_pass", value: "old-password" }, { key: "new_password_value", value: "new-password" }],
      ['pm.environment.set("consumer_pass", pm.environment.get("new_password_value"));']),
  };
  fixture = await collectionsDir(Object.fromEntries(Object.entries(files).map(([name, contents]) => [`collections/${name}`, contents])));
  dir = path.join(fixture.dir, "collections");

  // Prebuilt Python environments, as the Docker image provides them.
  const venvRoot = path.join(fixture.dir, "venvs");
  for (const id of ["python-stale", "python-ready"]) {
    await mkdir(path.dirname(venvPython(venvRoot, id)), { recursive: true });
    await writeFile(venvPython(venvRoot, id), "");
  }
  await writeFile(path.join(venvRoot, "python-ready", ".requirements.sha256"), `${createHash("sha256").update(REQUIREMENTS).digest("hex")}\n`);
  process.env.POST_RUN_VENV_ROOT = venvRoot;
  process.env.CONTROL_PLANE_PASSWORD_FILE = path.join(fixture.dir, "data", "control-plane-password.json");

  catalog = await scanCatalog(dir);
  assert.deepEqual(catalog.skipped, []);
});

after(async () => {
  server.close();
  delete process.env.POST_RUN_VENV_ROOT;
  delete process.env.CONTROL_PLANE_PASSWORD_FILE;
  await fixture.cleanup();
});

const extra = (id: string, overrides: Partial<CollectionDescriptor>): CollectionDescriptor => ({ ...catalog.collections[0], id, ...overrides });

describe("RunManager.runAllAndWait", () => {
  const { store } = memoryStore();
  const logger = memoryLogger();
  const errors = () => Object.fromEntries(logger.entries.filter((e) => e.level === "error").map((e) => [e.metadata?.collectionId, String(e.metadata?.error)]));

  before(async () => {
    const manager = new RunManager(dir, async () => catalog, store, logger);
    const outcome = await manager.runAllAndWait();
    assert.equal(outcome.queued.length, catalog.collections.length);
  });

  it("stores each collection's Newman result", () => {
    for (const collection of catalog.collections) {
      const state = store.get(collection.id);
      assert.equal(state.status, "passed", collection.id);
      assert.equal(state.history?.length, 1);
      assert.equal(state.result?.executions[0].requestHeaders?.find((h) => h.key === "Authorization")?.value, "Bearer [REDACTED]");
    }
  });

  it("runs post-run steps with resolved values and redacts secrets from their output", async () => {
    const output = JSON.parse(await readFile(path.join(dir, "Plain", "step-output.json"), "utf8"));
    assert.equal(output.args[0], TOKEN);
    assert.match(output.args[1], /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(output.env, TOKEN);
    const plainOutput = logger.entries.filter((e) => e.metadata?.step === "echo" && e.metadata?.output).map((e) => e.metadata?.output);
    assert.deepEqual(plainOutput, ["stdout [REDACTED]", "stderr [REDACTED]"]);
    const resolved = logger.entries.find((e) => e.message === "Resolved post-run input" && e.metadata?.variable === "exported");
    assert.deepEqual(resolved?.metadata, { step: "echo", variable: "exported", source: "manifest export", present: true, length: TOKEN.length });
  });

  it("logs post-run failures without failing the collection", () => {
    assert.deepEqual(errors(), {
      "shell-failure": 'Post-run step "fail" exited with code 3. bad [REDACTED]',
      "bad-export": 'Invalid post-run export source "nonsense" for "exported".',
      "missing-export": 'Post-run export "exported" requires environment value "not_there".',
      "python-missing": `Prebuilt Python environment is missing for collection "python-missing" at ${path.join(process.env.POST_RUN_VENV_ROOT!, "python-missing")}. Rebuild the deployment image.`,
      "python-stale": 'Python environment dependencies are out of date for collection "python-stale". Rebuild the deployment image.',
      "python-escape": "Python requirements file must stay inside the collection folder: ../requirements.txt",
    });
  });

  it("uses a prebuilt Python environment whose requirements match", async () => {
    const output = JSON.parse(await readFile(path.join(dir, "Python Ready", "step-output.json"), "utf8"));
    assert.equal(output.args[0], TOKEN);
  });

  it("saves the rotated Control Plane password for the next run", async () => {
    const saved = JSON.parse(await readFile(process.env.CONTROL_PLANE_PASSWORD_FILE!, "utf8"));
    assert.deepEqual(saved, { consumer_pass: "new-password", new_password_value: "new-password" });
    assert.ok(logger.entries.some((e) => e.message === "Persisted successful Control Plane password change"));
  });
});

describe("RunManager.startOne and friends", () => {
  const controlPlane = () => catalog.collections.filter((c) => c.folderName === "Control Plane");

  it("starts one collection and reports unknown, invalid and busy ones", async () => {
    const { store } = memoryStore({ busy: { status: "running", lastRunAt: null, durationMs: null, stats: null, result: null } });
    await store.load();
    const invalid = extra("invalid", { collection: null });
    const busy = extra("busy", {});
    const manager = new RunManager(dir, async () => ({ collections: [catalog.collections[0], invalid, busy], skipped: [] }), store, memoryLogger());

    await assert.rejects(manager.startOne("ghost"), (error: RunError) => error.status === 404 && error.code === "COLLECTION_NOT_FOUND");
    await assert.rejects(manager.startOne("busy"), (error: RunError) => error.status === 409);
    await assert.rejects(manager.startOne("invalid"), (error: RunError) => error.status === 422);
    assert.equal(store.get("invalid").status, "error");

    const selected = await manager.startSelected(["ghost", catalog.collections[0].id]);
    assert.deepEqual(selected.skipped, [{ collectionId: "ghost", reason: "collection_not_found" }]);
    assert.match(selected.queued[0].runId, /^run-/);
    // A scheduled run waits for the manual run already in progress.
    const waited = await manager.runAllAndWait([catalog.collections[0].id]);
    assert.deepEqual(waited.waitedFor, [catalog.collections[0].id]);
    assert.equal(store.get(catalog.collections[0].id).status, "passed");

    await assert.rejects(manager.runAllAndWait(["ghost"]), /Scheduled collections not found: ghost/);
    const all = await manager.startAll();
    assert.deepEqual(all.skipped, ["invalid", "busy"]);
    await manager.runAllAndWait([catalog.collections[0].id]);
  });

  it("loads the saved Control Plane password and rejects an invalid password file", async () => {
    const file = process.env.CONTROL_PLANE_PASSWORD_FILE!;
    await writeFile(file, JSON.stringify({ consumer_pass: "saved-password" }));
    const { store } = memoryStore();
    const manager = new RunManager(dir, async () => ({ collections: controlPlane(), skipped: [] }), store, memoryLogger());
    await manager.runAllAndWait();
    // The saved password was used, and the rotation to new-password was saved again.
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { consumer_pass: "new-password", new_password_value: "new-password" });

    await writeFile(file, JSON.stringify({ consumer_pass: 42 }));
    const logger = memoryLogger();
    const broken = new RunManager(dir, async () => ({ collections: controlPlane(), skipped: [] }), store, logger);
    await broken.runAllAndWait();
    assert.equal(store.get(controlPlane()[0].id).status, "error");
    assert.match(String(logger.entries.find((e) => e.message === "Collection execution failed")?.metadata?.error), /password file is invalid/);
  });

  it("marks a collection as error when it cannot be executed", async () => {
    const { store } = memoryStore();
    const logger = memoryLogger();
    const missingEnv = extra("missing-env", { environmentFile: "nope.json" });
    const manager = new RunManager(dir, async () => ({ collections: [missingEnv], skipped: [] }), store, logger);
    await manager.runAllAndWait();
    assert.equal(store.get("missing-env").status, "error");
    assert.ok(logger.entries.some((e) => e.message === "Collection execution failed"));
  });

  it("releases reservations when the store cannot mark a run as started", async () => {
    const { store } = memoryStore();
    let failNext = true;
    const flaky = Object.assign(Object.create(store), {
      markRunning: async (id: string) => {
        if (failNext) {
          failNext = false;
          throw new Error("database down");
        }
        return store.markRunning(id);
      },
    });
    const manager = new RunManager(dir, async () => catalog, flaky, memoryLogger());
    const id = catalog.collections[0].id;
    await assert.rejects(manager.startOne(id), /database down/);
    // Nothing stays reserved: the same collection can start right away.
    assert.match(await manager.startOne(id), /^run-/);
    await manager.runAllAndWait([id]);
  });
});
