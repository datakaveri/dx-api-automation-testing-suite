import type { Collection, ExecutionResult, HistoryRunSummary, RunResult } from "../src/types";

export function makeCollection(overrides: Partial<Collection> = {}): Collection {
  return {
    id: "c1",
    folderName: "Alpha",
    collectionFile: "alpha.postman_collection.json",
    environmentFile: null,
    status: "passed",
    runId: null,
    apiCount: 3,
    assertions: { passed: 2, failed: 0, total: 2 },
    tests: { passed: 1, failed: 0, total: 1 },
    lastRunAt: null,
    durationMs: null,
    actions: { canRerun: true, canViewHistory: true },
    ...overrides,
  };
}

export function makeExecution(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    folder: null,
    name: "Get item",
    method: "GET",
    url: "https://example.com/items",
    statusCode: 200,
    responseTimeMs: 120,
    responseSize: 512,
    assertions: [{ name: "Status is 200", passed: true, errorMessage: null }],
    requestError: null,
    failed: false,
    ...overrides,
  };
}

export function makeResult(executions: ExecutionResult[]): RunResult {
  return {
    startedAt: "2026-10-01T10:00:00Z",
    completedAt: "2026-10-01T10:00:05Z",
    durationMs: 5000,
    stats: {
      requests: { total: executions.length, failed: executions.filter((e) => e.failed).length },
      assertions: { total: 0, failed: 0 },
      averageResponseTimeMs: 100,
    },
    executions,
  };
}

export function makeHistoryRun(overrides: Partial<HistoryRunSummary> = {}): HistoryRunSummary {
  return {
    runId: "r1",
    runNumber: 1,
    startedAt: "2026-10-01T10:00:00Z",
    completedAt: "2026-10-01T10:00:05Z",
    durationMs: 5000,
    status: "passed",
    totalApis: 4,
    assertions: { passed: 4, failed: 0, total: 4 },
    avgLatencyMs: 80,
    reportUrl: "/api/runs/r1/report",
    ...overrides,
  };
}
