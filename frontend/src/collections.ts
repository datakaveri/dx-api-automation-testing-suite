import type { Collection, CollectionStatus, SelectedRunQueuedItem, SelectedRunSkippedItem } from "./types";

export function applyStatuses(collections: Collection[], statuses: { collectionId: string; status: CollectionStatus }[]): Collection[] {
  return collections.map((collection) => {
    const nextStatus = statuses.find((item) => item.collectionId === collection.id)?.status;
    return nextStatus ? { ...collection, status: nextStatus } : collection;
  });
}

export function markInvalidSkipped(collections: Collection[], skipped: SelectedRunSkippedItem[]): Collection[] {
  const invalidIds = new Set(skipped.filter((s) => s.reason === "invalid_collection").map((s) => s.collectionId));
  return collections.map((c) => (invalidIds.has(c.id) ? { ...c, status: "error" } : c));
}

export function markQueuedRunning(collections: Collection[], queued: SelectedRunQueuedItem[]): Collection[] {
  return collections.map((c) => {
    const queuedItem = queued.find((q) => q.collectionId === c.id);
    return queuedItem ? { ...c, status: "running", runId: queuedItem.runId } : c;
  });
}

export function describeSkipped(skipped: SelectedRunSkippedItem[]): string {
  return skipped.map((item) => `Collection "${item.collectionId}" skipped: ${item.reason.replaceAll("_", " ")}.`).join(" ");
}

export function statusDotClass(status: CollectionStatus): string {
  if (status === "passed") return "bg-emerald-600";
  if (status === "running") return "bg-cyan-600 animate-pulse";
  return "bg-rose-600";
}

export function actionButtonClass(disabled: boolean, open: boolean): string {
  if (disabled) return "border-slate-200 bg-slate-50 text-slate-300 cursor-not-allowed opacity-50";
  if (open) return "border-slate-300 bg-slate-100 text-slate-900 shadow-2xs";
  return "border-slate-200 bg-transparent text-slate-600 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700 active:bg-sky-100";
}

export function rerunTitle(collection: Collection, rowActionDisabled: boolean): string | undefined {
  if (collection.status === "running") return "A run is currently in progress";
  if (collection.actions?.canRerun === false) return "Rerun is not available";
  if (rowActionDisabled) return "Actions are disabled for selected collections";
  return undefined;
}
