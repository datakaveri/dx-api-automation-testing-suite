import { describe, expect, it } from "vitest";
import {
  actionButtonClass,
  applyStatuses,
  describeSkipped,
  markInvalidSkipped,
  markQueuedRunning,
  rerunTitle,
  statusDotClass,
} from "../src/collections";
import { makeCollection } from "./fixtures";

const a = makeCollection({ id: "a" });
const b = makeCollection({ id: "b" });

describe("collections helpers", () => {
  it("applies polled statuses only to matching collections", () => {
    const next = applyStatuses([a, b], [{ collectionId: "a", status: "failed" }]);
    expect(next[0].status).toBe("failed");
    expect(next[1]).toBe(b);
  });

  it("marks only invalid skipped collections as error", () => {
    const next = markInvalidSkipped([a, b], [
      { collectionId: "a", reason: "invalid_collection" },
      { collectionId: "b", reason: "already_running" },
    ]);
    expect(next[0].status).toBe("error");
    expect(next[1]).toBe(b);
  });

  it("marks queued collections as running with their run id", () => {
    const next = markQueuedRunning([a, b], [{ collectionId: "b", runId: "r9", status: "running", statusUrl: "/x" }]);
    expect(next[0]).toBe(a);
    expect(next[1]).toMatchObject({ status: "running", runId: "r9" });
  });

  it("describes every skipped item with underscores replaced", () => {
    expect(describeSkipped([
      { collectionId: "a", reason: "collection_not_found" },
      { collectionId: "b", reason: "already_running" },
    ])).toBe('Collection "a" skipped: collection not found. Collection "b" skipped: already running.');
  });

  it("picks the status dot colour", () => {
    expect(statusDotClass("passed")).toContain("emerald");
    expect(statusDotClass("running")).toContain("animate-pulse");
    expect(statusDotClass("failed")).toContain("rose");
    expect(statusDotClass("idle")).toContain("rose");
  });

  it("picks the action button style", () => {
    expect(actionButtonClass(true, true)).toContain("cursor-not-allowed");
    expect(actionButtonClass(false, true)).toContain("bg-slate-100");
    expect(actionButtonClass(false, false)).toContain("hover:bg-sky-50");
  });

  it("explains why rerun is unavailable", () => {
    expect(rerunTitle(makeCollection({ status: "running" }), false)).toBe("A run is currently in progress");
    expect(rerunTitle(makeCollection({ actions: { canRerun: false, canViewHistory: true } }), false)).toBe("Rerun is not available");
    expect(rerunTitle(makeCollection(), true)).toBe("Actions are disabled for selected collections");
    expect(rerunTitle(makeCollection(), false)).toBeUndefined();
  });
});
