import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { flattenRequests, scanCatalog, slugify } from "../src/catalog";
import { loadConfig, type AppConfig } from "../src/config/env";
import { createDatabase } from "../src/database/client";
import { formatIST, formatISTDate, formatISTTime } from "../src/formatTime";
import { createLogger } from "../src/logger";
import { buildRunReportHtml, buildRunReportText, formatDuration, Mailer, type DashboardData } from "../src/mailer";
import { SettingsStore } from "../src/repositories/settingsStore";
import { AutoRerunScheduler } from "../src/scheduler";
import type { RunResult } from "../src/types";
import { collectionsDir, memoryLogger, memorySettingsModel, memoryStore, postmanCollection, postmanEnvironment, waitFor } from "./helpers";

const DATABASE_URL = "postgres://qa:secret@127.0.0.1:5432/qa";

describe("loadConfig", () => {
  it("applies defaults to a minimal environment", () => {
    const config = loadConfig({ DATABASE_URL });
    assert.equal(config.PORT, 4000);
    assert.equal(config.DB_SYNC, "alter");
    assert.equal(config.AUTO_RERUN_ON_STARTUP, false);
    assert.equal(config.COLLECTIONS_DIR, "collections");
  });

  it("parses explicit values", () => {
    const config = loadConfig({ DATABASE_URL, PORT: "8080", AUTO_RERUN_ON_STARTUP: "true", NODE_ENV: "production", DB_SYNC: "none" });
    assert.equal(config.PORT, 8080);
    assert.equal(config.AUTO_RERUN_ON_STARTUP, true);
  });

  it("rejects a missing or non-Postgres database URL", () => {
    assert.throws(() => loadConfig({}), /Invalid environment configuration: DATABASE_URL/);
    assert.throws(() => loadConfig({ DATABASE_URL: "mysql://x@y/z" }), /postgres:\/\/ or postgresql:\/\//);
  });

  it("rejects DB_SYNC=alter in production", () => {
    assert.throws(() => loadConfig({ DATABASE_URL, NODE_ENV: "production" }), /DB_SYNC: DB_SYNC=alter is not allowed in production/);
  });
});

describe("formatTime", () => {
  const date = new Date("2024-01-15T06:30:45Z"); // 12:00:45 IST

  it("formats dates and times in IST", () => {
    assert.match(formatIST(date), /15 Jan 2024.*12:00:45.*pm IST$/i);
    assert.equal(formatISTDate(date), "15 Jan 2024");
    assert.match(formatISTTime(date), /^12:00:45 pm$/i);
  });
});

const dashboard = (): DashboardData => ({
  kpis: { totalCollections: 3, passedCollections: 1, failedCollections: 2, totalApis: 9, failedAssertions: 4 },
  collections: [
    { id: "a", folderName: "A <&>", collectionFile: "a.json", environmentFile: "e.json", status: "passed", runId: "run-1", apiCount: 3, assertions: { passed: 3, failed: 0, total: 3 }, tests: { passed: 3, failed: 0, total: 3 }, lastRunAt: null, durationMs: null, actions: { canRerun: true, canViewHistory: true } },
    { id: "b c", folderName: "B", collectionFile: "b.json", environmentFile: "e.json", status: "failed", runId: "run-2", apiCount: 4, assertions: { passed: 1, failed: 3, total: 4 }, tests: { passed: 1, failed: 3, total: 4 }, lastRunAt: null, durationMs: null, actions: { canRerun: true, canViewHistory: true } },
    { id: "c", folderName: "C", collectionFile: "c.json", environmentFile: "e.json", status: "error", runId: null, apiCount: 2, assertions: { passed: 0, failed: 1, total: 1 }, tests: { passed: 0, failed: 0, total: 0 }, lastRunAt: null, durationMs: null, actions: { canRerun: true, canViewHistory: true } },
  ],
});
const report = () => ({ startedAt: new Date("2024-01-15T06:30:00Z"), completedAt: new Date("2024-01-15T07:35:05Z"), data: dashboard() });

describe("mailer", () => {
  it("formats durations", () => {
    assert.equal(formatDuration(4_400), "4s");
    assert.equal(formatDuration(125_000), "2m 5s");
    assert.equal(formatDuration(3_725_000), "1h 2m 5s");
  });

  it("builds the HTML run report with escaped names and report links only for passed/failed runs", () => {
    const html = buildRunReportHtml(report(), "https://api.example/", "https://dash.example");
    assert.match(html, /A &lt;&amp;&gt;/);
    assert.match(html, /https:\/\/api\.example\/api\/collections\/a\/history\/run-1\/report/);
    assert.match(html, /\/api\/collections\/b%20c\/history\/run-2\/report/);
    assert.equal((html.match(/View report/g) ?? []).length, 2);
    assert.match(html, /Total Duration:<\/strong> 1h 5m 5s/);
    assert.match(html, /Collections Failed:<\/strong> 2/);
  });

  it("falls back to counting collections when KPIs are missing", () => {
    const withoutKpis = { ...report(), data: { ...dashboard(), kpis: undefined as never } };
    assert.match(buildRunReportHtml(withoutKpis, "https://api", "https://dash"), /Collections Failed:<\/strong> 2/);
    const text = buildRunReportText(withoutKpis, "https://dash");
    assert.match(text, /Total Collections: 3/);
    assert.match(text, /Collections Passed: 1/);
    assert.match(text, /Open QA Dashboard: https:\/\/dash/);
  });

  const config = (overrides: Partial<AppConfig> = {}) => ({ ...loadConfig({ DATABASE_URL }), ...overrides });

  it("refuses to send when SMTP is not configured", async () => {
    const mailer = new Mailer(config());
    assert.equal(mailer.isConfigured(), false);
    assert.deepEqual(await mailer.verifyConnection(), { success: false, message: "SMTP is not configured (SMTP_HOST is missing)." });
    await assert.rejects(mailer.sendFailureAlert(["qa@example.com"], "boom", new Date()), /SMTP is not configured/);
  });

  it("sends the test email, run report and failure alert through the transport", async () => {
    const mailer = new Mailer(config({ SMTP_HOST: "127.0.0.1", SMTP_USER: "smtp-user", SMTP_PASS: "pw", SMTP_PORT: 465 }));
    assert.equal(mailer.isConfigured(), true);
    const sent: Array<Record<string, unknown>> = [];
    let verifyError: Error | null = null;
    Object.assign(mailer, {
      transporter: {
        verify: async () => {
          if (verifyError) throw verifyError;
          return true;
        },
        sendMail: async (message: Record<string, unknown>) => {
          sent.push(message);
          return { messageId: "id" };
        },
      },
    });

    assert.equal((await mailer.verifyConnection()).success, true);
    verifyError = new Error("bad credentials");
    assert.deepEqual(await mailer.verifyConnection(), { success: false, message: "bad credentials" });

    await mailer.sendTestEmail(["a@example.com", "b@example.com"]);
    await mailer.sendRunReport(["a@example.com"], report());
    await mailer.sendFailureAlert(["a@example.com"], "<db down>", new Date());
    assert.deepEqual(sent.map((message) => message.subject), [
      "[IUDX QA] Email Functionality Verification Test",
      "[IUDX QA] Daily API Automation Test Report",
      "[IUDX QA] Auto re-run could not be executed",
    ]);
    assert.equal(sent[0].from, "smtp-user");
    assert.equal(sent[0].to, "a@example.com, b@example.com");
    assert.match(String(sent[2].html), /&lt;db down&gt;/);
  });
});

describe("createLogger", () => {
  it("logs in development and production formats", () => {
    for (const environment of ["development", "production"]) {
      const logger = createLogger(environment);
      logger.transports.forEach((transport) => { transport.silent = true; });
      logger.info("hello", { extra: 1 });
      logger.info("plain");
    }
  });
});

describe("createDatabase", () => {
  it("defines both models without connecting", async () => {
    const database = createDatabase(DATABASE_URL);
    assert.equal(database.collectionStateModel.getTableName(), "collection_states");
    assert.equal(database.appSettingModel.getTableName(), "app_settings");
    await database.sequelize.close();
  });
});

describe("SettingsStore", () => {
  it("starts from defaults, loads saved settings and saves updates", async () => {
    const empty = new SettingsStore(memorySettingsModel().model, ["qa@example.com"]);
    await empty.load();
    assert.deepEqual(empty.get(), { interval: "off", recipients: ["qa@example.com"], collectionIds: null });

    const { model, rows } = memorySettingsModel({ interval: "1h", collectionIds: ["a"] });
    const settings = new SettingsStore(model, []);
    await settings.load();
    assert.deepEqual(settings.get(), { interval: "1h", recipients: [], collectionIds: ["a"] });
    const updated = await settings.update({ recipients: ["x@example.com"] });
    assert.deepEqual(updated.recipients, ["x@example.com"]);
    assert.deepEqual(rows.get("auto-rerun"), { interval: "1h", recipients: ["x@example.com"], collectionIds: ["a"] });
  });
});

const runResult = (failed = 0): RunResult => ({
  startedAt: "2024-01-01T00:00:00.000Z",
  completedAt: "2024-01-01T00:00:01.000Z",
  durationMs: 1000,
  stats: { requests: { total: 2, failed }, assertions: { total: 2, failed }, tests: { total: 2, failed }, averageResponseTimeMs: 5 },
  executions: [],
});

describe("SequelizeResultsStore", () => {
  it("reports idle collections and treats an old idle result without failures as passed", async () => {
    const { store } = memoryStore({ old: { status: "idle", lastRunAt: null, durationMs: null, stats: runResult().stats, result: runResult() } });
    await store.load();
    assert.equal(store.get("missing").status, "idle");
    assert.equal(store.get("old").status, "passed");
  });

  it("records runs, keeps the last five in history and finds runs by id", async () => {
    const { store, rows } = memoryStore();
    for (let index = 0; index < 6; index += 1) {
      await store.markRunning("c");
      assert.equal(store.get("c").status, "running");
      await store.complete("c", index % 2 ? "failed" : "passed", runResult(index % 2));
    }
    const state = store.get("c");
    assert.equal(state.history?.length, 5);
    assert.equal(rows.get("c")?.history?.length, 5);
    const latest = state.history![0];
    assert.equal(store.findRun(latest.runId)?.collectionId, "c");
    assert.equal(store.findRun("run-missing"), null);

    await store.complete("c", "error", null);
    assert.equal(store.get("c").status, "error");
    assert.equal(store.get("c").history?.length, 5);
    await store.complete("c", "passed", runResult(), []);
    assert.deepEqual(store.get("c").history, []);
    await store.reload();
    assert.equal(store.get("c").status, "passed");
  });

  it("fills stat groups missing from rows saved by older versions", async () => {
    const legacyStats = { requests: { total: 2, failed: 1 }, assertions: { total: 3, failed: 0 }, averageResponseTimeMs: 5 };
    const legacyRun = { ...runResult(), stats: legacyStats, runId: "run-old", status: "passed" };
    const { store } = memoryStore({ old: { status: "failed", lastRunAt: null, durationMs: null, stats: legacyStats, result: legacyRun, history: [legacyRun] } as never });
    await store.load();
    const state = store.get("old");
    assert.deepEqual(state.stats?.tests, { total: 0, failed: 0 });
    assert.deepEqual(state.result?.stats.tests, { total: 0, failed: 0 });
    assert.deepEqual(state.history?.[0].stats.tests, { total: 0, failed: 0 });
    assert.equal(state.stats?.requests.failed, 1);
  });
});

describe("AutoRerunScheduler", () => {
  function scheduler(options: { interval?: string; recipients?: string[]; configured?: boolean; runError?: Error; sendError?: Error } = {}) {
    const logger = memoryLogger();
    const settings = { get: () => ({ interval: options.interval ?? "15m", recipients: options.recipients ?? ["qa@example.com"], collectionIds: null }) };
    const sent: string[] = [];
    let release = () => {};
    const runner = {
      runAllAndWait: async () => {
        if (options.runError) throw options.runError;
        await new Promise<void>((resolve) => { release = resolve; });
        return { queued: [], skipped: [], waitedFor: [] };
      },
    };
    const controller = { getDashboardData: async () => dashboard() };
    const mailer = {
      isConfigured: () => options.configured ?? true,
      sendRunReport: async () => {
        if (options.sendError) throw options.sendError;
        sent.push("report");
        return { messageId: "m1", response: "250 OK" };
      },
      sendFailureAlert: async () => {
        sent.push("alert");
        return { messageId: "m2" };
      },
    };
    const instance = new AutoRerunScheduler(settings as never, runner as never, controller as never, mailer as never, logger as never);
    return { instance, logger, sent, release: () => release() };
  }
  const messages = (logger: ReturnType<typeof memoryLogger>) => logger.entries.map((entry) => entry.message);

  it("does nothing when auto re-run is off", () => {
    const { instance, logger } = scheduler({ interval: "off" });
    instance.start(true);
    assert.deepEqual(messages(logger), ["Auto re-run is off"]);
  });

  it("schedules, runs immediately, skips an overlapping tick and emails the report", async () => {
    const { instance, logger, sent, release } = scheduler({ interval: "1h" });
    instance.start(true);
    await (instance as unknown as { tick(): Promise<void> }).tick();
    assert.ok(messages(logger).includes("Skipping auto re-run because the previous one is still in progress"));
    release();
    await waitFor(() => sent.length === 1);
    instance.stop();
    assert.deepEqual(sent, ["report"]);
    assert.ok(messages(logger).includes("Auto re-run email sent"));
  });

  it("sends a failure alert when the run cannot be executed", async () => {
    const { instance, logger, sent } = scheduler({ runError: new Error("catalog unreadable") });
    await (instance as unknown as { tick(): Promise<void> }).tick();
    assert.deepEqual(sent, ["alert"]);
    assert.equal(logger.entries.find((entry) => entry.level === "error")?.metadata?.error, "catalog unreadable");
  });

  it("skips email without SMTP or recipients and logs send failures", async () => {
    const unconfigured = scheduler({ configured: false, runError: new Error("x") });
    await (unconfigured.instance as unknown as { tick(): Promise<void> }).tick();
    assert.ok(messages(unconfigured.logger).includes("Auto re-run email not sent because SMTP or recipients are not configured"));

    const failing = scheduler({ sendError: new Error("smtp down") });
    const tick = (failing.instance as unknown as { tick(): Promise<void> }).tick();
    failing.release();
    await tick;
    assert.ok(messages(failing.logger).includes("Auto re-run email failed to send"));
  });
});

describe("scanCatalog", () => {
  const request = (name: string) => ({ name, request: { method: "GET", url: "https://example.com" } });
  let cleanup = async () => {};
  after(() => cleanup());

  it("accepts valid folders and explains every skipped file or folder", async () => {
    const fixture = await collectionsDir({
      "readme.txt": "not a folder",
      "Good One/collection.json": postmanCollection("Good", [request("a"), { name: "folder", item: [request("b"), "junk"] }]),
      "Good One/env.json": postmanEnvironment(),
      "Good One/ignored.json": "{ not json",
      "Good One/post-run.json": { ignoreFiles: ["ignored.json", "../bad.json"], export: { id: "environment.id" }, steps: [{ name: "s", command: "node", args: ["{{id}}", "{{env.x}}"] }] },
      "Unnamed/collection.json": { info: {}, item: [] },
      "Unnamed/env.json": postmanEnvironment(),
      "Broken/collection.json": "{",
      "Broken/other.json": { hello: "world" },
      "Bad Manifest/post-run.json": { steps: [{ name: "s", command: "../escape", args: [] }] },
      "Undeclared/post-run.json": { steps: [{ name: "s", command: "node", args: ["{{missing}}"] }] },
      "Invalid Schema/post-run.json": { steps: "nope" },
    });
    cleanup = fixture.cleanup;
    const catalog = await scanCatalog(fixture.dir);

    assert.deepEqual(catalog.collections.map((c) => [c.id, c.name, c.requestCount, c.postRunFile]), [
      ["good-one", "Good", 2, "post-run.json"],
      ["unnamed", "Unnamed", 0, null],
    ]);
    const reasons = catalog.skipped.map((s) => `${s.folderName}/${s.fileName}: ${s.reason}`);
    assert.deepEqual(reasons, [
      "Bad Manifest/post-run.json: Invalid post-run manifest: Cleanup command must be a relative path inside its collection folder: ../escape",
      "Broken/Broken: Expected exactly one collection and one environment JSON file; found 0 collection(s) and 0 environment(s).",
      "Broken/collection.json: Invalid JSON.",
      "Broken/other.json: Not a Postman collection or environment.",
      "Good One/post-run.json: Invalid ignored JSON file name: ../bad.json",
      "Invalid Schema/post-run.json: Invalid post-run manifest: Invalid input: expected array, received string",
      'Undeclared/post-run.json: Invalid post-run manifest: Post-run value "missing" must be declared in export or use the env. prefix.',
    ]);
  });
});

describe("catalog helpers", () => {
  it("slugifies folder names", () => {
    assert.equal(slugify("  Control Plane / v2  "), "control-plane-v2");
  });

  it("flattens nested requests with their folder path and URL", () => {
    assert.deepEqual(
      flattenRequests({
        item: [
          { name: "Root", request: { url: "https://a" } },
          { name: "F", item: [{ request: { method: "POST", url: { raw: "https://b" } } }, { name: "G", item: [{ name: "Deep", request: { url: {} } }] }] },
          null,
        ],
      }),
      [
        { folder: null, name: "Root", method: "GET", url: "https://a" },
        { folder: "F", name: "Unnamed request", method: "POST", url: "https://b" },
        { folder: "F / G", name: "Deep", method: "GET", url: "" },
      ],
    );
  });
});
