import type { ModelStatic } from "sequelize";
import { randomUUID } from "node:crypto";
import type { CollectionState, CollectionStatus, HistoryRun, RunResult, RunStats } from "../types";
import type { ResultsStorePort } from "../store";
import { CollectionStateModel } from "../database/models/collectionState";

const emptyStats = (): RunStats => ({
  requests: { total: 0, failed: 0 },
  assertions: { total: 0, failed: 0 },
  tests: { total: 0, failed: 0 },
  averageResponseTimeMs: 0
});

// Rows written by older versions can lack stat groups (e.g. `tests`); fill them so readers can trust RunStats.
export const normalizeStats = (stats: Partial<RunStats> | null | undefined): RunStats => {
  const empty = emptyStats();
  return {
    requests: { ...empty.requests, ...stats?.requests },
    assertions: { ...empty.assertions, ...stats?.assertions },
    tests: { ...empty.tests, ...stats?.tests },
    averageResponseTimeMs: stats?.averageResponseTimeMs ?? 0
  };
};

export const normalizeState = (state: CollectionState): CollectionState => ({
  ...state,
  stats: state.stats ? normalizeStats(state.stats) : null,
  result: state.result
    ? { ...state.result, stats: normalizeStats(state.result.stats), executions: state.result.executions ?? [] }
    : null,
  history: state.history?.map((run) => ({ ...run, stats: normalizeStats(run.stats), executions: run.executions ?? [] }))
});

const idleState = (): CollectionState => ({
  status: "idle",
  lastRunAt: null,
  durationMs: null,
  stats: null,
  result: null
});

export class SequelizeResultsStore implements ResultsStorePort {
  private collections: Record<string, CollectionState> = {};
  // updatedAt (ms) of each row as last read or written, so reload() can skip unchanged rows.
  private loadedAt = new Map<string, number>();
  private pendingReload: Promise<void> | null = null;
  private writes = Promise.resolve();

  constructor(private readonly model: ModelStatic<CollectionStateModel>) {}

  async load(): Promise<void> {
    const rows = await this.model.findAll();
    this.collections = Object.fromEntries(rows.map((row) => [row.collectionId, normalizeState(row.state)]));
    this.loadedAt = new Map(rows.map((row) => [row.collectionId, new Date(row.updatedAt).getTime()]));
  }

  get(id: string): CollectionState {
    const state = this.collections[id] ?? idleState();
    if (state.status === "idle" && state.result && (state.stats?.requests.failed ?? 0) === 0) {
      return { ...state, status: "passed" };
    }
    return state;
  }

  // Picks up rows written by other server instances. Every GET calls this and the state JSON is large,
  // so concurrent callers share one query and only rows whose updatedAt moved are downloaded.
  reload(): Promise<void> {
    this.pendingReload ??= this.reloadChanged().finally(() => {
      this.pendingReload = null;
    });
    return this.pendingReload;
  }

  private async reloadChanged(): Promise<void> {
    const stamps = await this.model.findAll({ attributes: ["collectionId", "updatedAt"], raw: true });
    const present = new Set(stamps.map((row) => row.collectionId));
    const changedIds = stamps
      .filter((row) => this.loadedAt.get(row.collectionId) !== new Date(row.updatedAt).getTime())
      .map((row) => row.collectionId);
    const changedRows = changedIds.length > 0 ? await this.model.findAll({ where: { collectionId: changedIds } }) : [];

    // Drop rows deleted elsewhere; keep in-memory states that have not been saved yet.
    const kept = Object.entries(this.collections).filter(([id]) => present.has(id) || !this.loadedAt.has(id));
    this.collections = {
      ...Object.fromEntries(kept),
      ...Object.fromEntries(changedRows.map((row) => [row.collectionId, normalizeState(row.state)]))
    };
    this.loadedAt = new Map([
      ...[...this.loadedAt].filter(([id]) => present.has(id)),
      ...changedRows.map((row): [string, number] => [row.collectionId, new Date(row.updatedAt).getTime()])
    ]);
  }

  async markRunning(id: string): Promise<string> {
    const current = this.get(id);
    const runId = `run-${randomUUID()}`;
    this.collections[id] = { ...current, status: "running", runId, runStartedAt: new Date().toISOString() };
    await this.save(id);
    return runId;
  }

  async complete(id: string, status: Exclude<CollectionStatus, "idle" | "running">, result: RunResult | null, customHistory?: HistoryRun[]): Promise<void> {
    const stats = result?.stats ?? emptyStats();
    const current = this.get(id);
    const existingHistory = customHistory ?? current.history ?? [];

    let updatedHistory = existingHistory;
    if (result && !customHistory) {
      const newEntry: HistoryRun = {
        runId: current.runId ?? `run-${randomUUID()}`,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        durationMs: result.durationMs,
        status,
        stats,
        executions: result.executions,
        skippedRequests: result.skippedRequests
      };
      updatedHistory = [newEntry, ...existingHistory].slice(0, 5);
    }

    this.collections[id] = {
      status,
      runId: current.runId,
      runStartedAt: result?.startedAt ?? current.runStartedAt,
      lastRunAt: result?.completedAt ?? new Date().toISOString(),
      durationMs: result?.durationMs ?? null,
      stats,
      result,
      history: updatedHistory
    };
    await this.save(id);
  }

  findRun(runId: string): { collectionId: string; state: CollectionState; run?: HistoryRun } | null {
    for (const [collectionId, state] of Object.entries(this.collections)) {
      const run = state.history?.find((historyRun) => historyRun.runId === runId);
      if (run || state.runId === runId) return { collectionId, state, run };
    }
    return null;
  }

  private async save(collectionId: string): Promise<void> {
    this.writes = this.writes.then(async () => {
      const [row] = await this.model.upsert({ collectionId, state: this.collections[collectionId] });
      // Record our own write so the next reload() does not download it again.
      if (row?.updatedAt) this.loadedAt.set(collectionId, new Date(row.updatedAt).getTime());
      else this.loadedAt.delete(collectionId);
    });
    await this.writes;
  }
}
