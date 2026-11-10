import { useEffect, useRef } from "react";
import { openAuthenticatedReport } from "./api";
import { formatDate, formatDuration } from "./format";
import { Icon } from "./Icon";
import { StatusBadge } from "./StatusBadge";
import type { Collection, HistoryRunSummary } from "./types";

interface HistoryModalProps {
  collection: Collection;
  history: HistoryRunSummary[];
  loading: boolean;
  onClose: () => void;
}

function openRunReport(reportUrl: string): void {
  const reportTab = window.open("about:blank", "_blank");
  if (reportTab) reportTab.opener = null;
  void openAuthenticatedReport(reportUrl, reportTab).catch((error: unknown) => {
    reportTab?.close();
    globalThis.alert(error instanceof Error ? error.message : "Could not open this report.");
  });
}

export function HistoryModal({ collection, history, loading, onClose }: Readonly<HistoryModalProps>) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <dialog
      open
      className="overlay"
      aria-modal="true"
      aria-labelledby="history-modal-title"
    >
      <button type="button" tabIndex={-1} aria-label="Close dialog" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div className="modal">
        <div className="modal-head">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 id="history-modal-title">{collection.folderName}</h2>
              <span className="pill">Last 5 Test Runs</span>
            </div>
            <p>Running a new test adds the latest result and drops the oldest of the last 5 runs.</p>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} className="icon-btn plain" aria-label="Close">
            <Icon name="x" size={22} />
          </button>
        </div>

        <div className="modal-body bg-canvas">
          <div className="flex flex-col gap-3.5 p-6">
            {loading && (
              <div className="loading">
                <Icon name="loader" size={28} className="spin" />
                Loading test execution history…
              </div>
            )}

            {!loading && history.length === 0 && (
              <div className="empty card">
                <Icon name="history" size={28} />
                <h3>No history records found yet</h3>
                <p>Run this collection to record your first execution in history.</p>
              </div>
            )}

            {!loading && history.map((run, index) => {
              const isLatest = index === 0;
              return (
                <div key={run.runId} className={`run-card${isLatest ? " latest" : ""}`}>
                  <div className="run-head">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="run-no">Run #{run.runNumber} {isLatest && "(Latest)"}</span>
                      <StatusBadge status={run.status} />
                    </div>
                    <div className="run-meta">
                      <span className="lastrun"><Icon name="clock" size={14} />{formatDate(run.completedAt)}</span>
                      <span>Duration <b className="font-medium text-slate-900">{formatDuration(run.durationMs)}</b></span>
                    </div>
                  </div>

                  <div className="run-body">
                    <div className="metrics">
                      <div><span>Total APIs</span><b>{run.totalApis}</b></div>
                      <div>
                        <span>Assertions passed</span>
                        <b className={run.assertions.failed > 0 ? "bad" : "ok"}>{run.assertions.passed} / {run.assertions.total}</b>
                      </div>
                      <div><span>Avg latency</span><b>{run.avgLatencyMs} ms</b></div>
                    </div>
                    <button
                      type="button"
                      onClick={() => openRunReport(run.reportUrl)}
                      className="btn btn-sm"
                      title="Open full Newman HTML execution report for this historical test run"
                    >
                      <Icon name="external" size={15} />
                      Newman Report
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="modal-foot">
          <span className="small muted">
            Stored <b className="font-medium text-slate-900">{history.length}</b> of maximum <b className="font-medium text-slate-900">5</b> test runs in history
          </span>
        </div>
      </div>
    </dialog>
  );
}
