import { statusDotClass } from "./collections";
import type { CollectionStatus } from "./types";

const badgeClass: Record<CollectionStatus, string> = {
  idle: "idle",
  running: "run",
  passed: "pass",
  failed: "fail",
  error: "err",
};

export function StatusBadge({ status }: Readonly<{ status: CollectionStatus }>) {
  return (
    <span className={`badge ${badgeClass[status]}`}>
      <span className={`dot ${status === "idle" ? "bg-slate-400" : statusDotClass(status)}`} />
      {status === "idle" ? "Not run" : status}
    </span>
  );
}
