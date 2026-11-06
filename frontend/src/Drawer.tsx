import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "./api";
import { formatDuration, formatLastRun, formatNumber, formatSize, percent, shortEnvironment } from "./format";
import { Icon } from "./Icon";
import { StatusBadge } from "./StatusBadge";
import type { Collection, ExecutionResult, RunResult } from "./types";

interface DrawerProps {
  collection: Collection;
  result: RunResult | null;
  loading: boolean;
  error?: string | null;
  onClose: () => void;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const isSuccessCode = (code: number | null) => code !== null && code >= 200 && code < 300;
const passedAssertions = (execution: ExecutionResult) => execution.assertions.filter((a) => a.passed).length;

function MethodTag({ method }: Readonly<{ method: string }>) {
  const upper = method.toUpperCase();
  const className = METHODS.includes(upper) ? `method m-${upper}` : "method";
  return <span className={className}>{method}</span>;
}

function CodeTag({ execution, prefix }: Readonly<{ execution: ExecutionResult; prefix: string }>) {
  return (
    <span className={`code mono${isSuccessCode(execution.statusCode) ? "" : " bad"}`}>
      {execution.statusCode === null ? "No response" : `${prefix}${execution.statusCode}`}
    </span>
  );
}

function ResultBadge({ failed }: Readonly<{ failed: boolean }>) {
  return <StatusBadge status={failed ? "failed" : "passed"} />;
}

function SplitBar({ passed, total }: Readonly<{ passed: number; total: number }>) {
  const width = total ? (passed / total) * 100 : 0;
  return (
    <div className="stat-bar" aria-hidden="true">
      <i style={{ width: `${width}%` }} />
      {passed < total && <i className="f" style={{ width: `${Math.max(100 - width, 1.5)}%` }} />}
    </div>
  );
}

type ExecutionFilter = {
  folder: string;
  method: string;
  status: "all" | "passed" | "failed";
  query: string;
};

function matchesFilter(e: ExecutionResult, f: ExecutionFilter) {
  if (f.folder !== "all" && e.folder !== f.folder) return false;
  if (f.method !== "all" && e.method.toUpperCase() !== f.method) return false;
  if (f.status !== "all" && e.failed !== (f.status === "failed")) return false;
  return !f.query || `${e.name} ${e.url} ${e.method} ${e.folder ?? ""}`.toLowerCase().includes(f.query);
}

function filterExecutions(executions: ExecutionResult[], f: ExecutionFilter) {
  return executions.filter((e) => matchesFilter(e, f));
}

// Keeps folder order; requests without a known folder go last.
function groupByFolder(executions: ExecutionResult[], folders: string[]) {
  const known = new Set(folders);
  const grouped = folders.flatMap((folder) => executions.filter((e) => e.folder === folder));
  return [...grouped, ...executions.filter((e) => !e.folder || !known.has(e.folder))];
}

function NoEndpoints({ configured }: Readonly<{ configured: boolean }>) {
  return (
    <div className="empty">
      <Icon name="search" size={28} />
      <h3>{configured ? "No matching endpoints found" : "No endpoints configured"}</h3>
      <p>{configured ? "Change the search, result or method filter to see more." : "This collection currently has no API endpoints."}</p>
    </div>
  );
}

function collectFolders(executions: ExecutionResult[]) {
  return [...new Set(executions.flatMap((e) => (e.folder ? [e.folder] : [])))];
}

function summarizeRun(collection: Collection, result: RunResult | null) {
  const executions = result?.executions ?? [];
  const totalReqs = result?.stats.requests.total ?? collection.apiCount;
  const failedReqs = result?.stats.requests.failed ?? 0;
  const hasRequests = totalReqs > 0;
  const failedExecutions = executions.filter((e) => e.failed);
  return {
    executions,
    totalReqs,
    failedReqs,
    passedReqs: hasRequests ? totalReqs - failedReqs : 0,
    avgLatency: result?.stats.averageResponseTimeMs ?? (hasRequests ? 42 : 0),
    assertionTotal: executions.reduce((sum, e) => sum + e.assertions.length, 0),
    assertionPassed: executions.reduce((sum, e) => sum + passedAssertions(e), 0),
    latencies: executions.map((e) => e.responseTimeMs).filter((ms): ms is number => ms !== null),
    failedExecutions,
    failedFolderCount: new Set(failedExecutions.map((e) => e.folder ?? "")).size,
    passedCount: executions.length - failedExecutions.length,
  };
}

export function Drawer({ collection, result, loading, error, onClose }: Readonly<DrawerProps>) {
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const foldersRef = useRef<HTMLDivElement>(null);
  const [selectedFolder, setSelectedFolder] = useState<string>("all");
  const [selectedMethod, setSelectedMethod] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"all" | "passed" | "failed">("all");
  const [viewMode, setViewMode] = useState<"cards" | "compact">("cards");
  const [folderEdges, setFolderEdges] = useState({ atStart: true, atEnd: true });

  useEffect(() => {
    backButtonRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const folders = useMemo(() => collectFolders(result?.executions ?? []), [result]);

  const filteredExecutions = useMemo(() => {
    if (!result?.executions) return [];
    const filtered = filterExecutions(result.executions, {
      folder: selectedFolder,
      method: selectedMethod,
      status: statusFilter,
      query: searchQuery.trim().toLowerCase(),
    });
    return selectedFolder === "all" ? groupByFolder(filtered, folders) : filtered;
  }, [result, selectedFolder, selectedMethod, statusFilter, searchQuery, folders]);

  const syncFolderEdges = useCallback(() => {
    const el = foldersRef.current;
    if (!el) return;
    setFolderEdges({
      atStart: el.scrollLeft <= 2,
      atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2,
    });
  }, []);

  useEffect(() => {
    syncFolderEdges();
    globalThis.addEventListener("resize", syncFolderEdges);
    return () => globalThis.removeEventListener("resize", syncFolderEdges);
  }, [folders, syncFolderEdges]);

  const scrollFolders = (direction: 1 | -1) => {
    const el = foldersRef.current;
    if (!el) return;
    el.scrollBy?.({ left: direction * el.clientWidth * 0.7, behavior: "smooth" });
  };

  const goToTop = () => {
    globalThis.scrollTo({ top: 0, behavior: "smooth" });
    backButtonRef.current?.focus({ preventScroll: true });
  };

  const openHtmlReport = () => {
    window.open(apiUrl(`/api/collections/${collection.id}/report`), "_blank", "noopener,noreferrer");
  };

  const {
    executions, totalReqs, failedReqs, passedReqs, avgLatency, assertionTotal,
    assertionPassed, latencies, failedExecutions, failedFolderCount, passedCount,
  } = summarizeRun(collection, result);
  const folderHasFailures = (folder: string) => executions.some((e) => e.folder === folder && e.failed);

  const showFailures = () => {
    setStatusFilter("failed");
    setSelectedFolder("all");
  };

  return (
    <main aria-labelledby="run-title">
      <div className="detail-shell">
        <header className="topbar detail">
          <button
            ref={backButtonRef}
            type="button"
            onClick={onClose}
            className="icon-btn hd-back"
            aria-label="Back to collections"
            title="Back to collections"
          >
            <Icon name="arrowLeft" />
          </button>
          <div className="hd-main">
            <div className="hd-row">
              <h2 id="run-title" className="app-title">{collection.folderName}</h2>
              <StatusBadge status={collection.status} />
            </div>
            <div className="hd-meta">
              <span className="chip mono trunc" title={collection.collectionFile}>
                <Icon name="file" size={13} />
                <span className="t">{collection.collectionFile}</span>
              </span>
              {collection.environmentFile && (
                <span className="chip mono trunc" title={collection.environmentFile}>
                  <Icon name="globe" size={13} />
                  <span className="t">{shortEnvironment(collection.environmentFile)}</span>
                </span>
              )}
              <span className="lastrun">
                <Icon name="clock" size={14} />
                {collection.lastRunAt ? formatLastRun(collection.lastRunAt) : "Never run"}
                {collection.lastRunAt && collection.durationMs !== null && `, took ${formatDuration(collection.durationMs)}`}
              </span>
            </div>
          </div>
          <div className="head-actions">
            <button type="button" className="btn" onClick={openHtmlReport} title="Open full Newman HTML report">
              <Icon name="external" />
              <span className="lbl">View Newman report</span>
            </button>
          </div>
        </header>

        <div className="detail-scroll">
          <div className="page">
            <div style={{ height: 24 }} />

            {error && <div role="alert" className="alert" style={{ marginBottom: 20 }}>{error}</div>}

            {failedReqs > 0 && (
              <div className="banner">
                <Icon name="alert" size={20} />
                <div>
                  <b>{failedReqs} {failedReqs === 1 ? "request" : "requests"} failed</b>
                  {result && ` in ${failedFolderCount} ${failedFolderCount === 1 ? "folder" : "folders"}, with ${formatNumber(assertionTotal - assertionPassed)} assertions not passing.`}
                </div>
                <button type="button" className="btn btn-sm" onClick={showFailures}>Show failures</button>
              </div>
            )}

            <div className="stats">
              <div className="stat">
                <div className="stat-label"><span className="stat-ic acc"><Icon name="zap" size={15} /></span>Total endpoints</div>
                <div className="stat-val">{formatNumber(totalReqs)}</div>
                <div className="stat-meta">{folders.length} {folders.length === 1 ? "folder" : "folders"}</div>
              </div>
              <div className="stat">
                <div className="stat-label"><span className="stat-ic pass"><Icon name="check" size={15} /></span>Passed requests</div>
                <div className="stat-val pass">
                  {formatNumber(passedReqs)} {totalReqs > 0 && <small>/ {formatNumber(totalReqs)}</small>}
                </div>
                <div className="stat-meta">{percent(passedReqs, totalReqs)}% pass rate</div>
                <SplitBar passed={passedReqs} total={totalReqs} />
              </div>
              <div className="stat">
                <div className="stat-label"><span className="stat-ic fail"><Icon name="x" size={15} /></span>Failed requests</div>
                <div className={`stat-val${failedReqs > 0 ? " fail" : ""}`}>{formatNumber(failedReqs)}</div>
                <div className="stat-meta">{failedReqs > 0 ? "Needs attention" : "Nothing to fix"}</div>
              </div>
              <div className="stat">
                <div className="stat-label"><span className="stat-ic info"><Icon name="okCircle" size={15} /></span>Assertions passed</div>
                <div className="stat-val">
                  {formatNumber(assertionPassed)} <small>/ {formatNumber(assertionTotal)}</small>
                </div>
                <div className="stat-meta">{percent(assertionPassed, assertionTotal)}% passing</div>
                <SplitBar passed={assertionPassed} total={assertionTotal} />
              </div>
              <div className="stat">
                <div className="stat-label"><span className="stat-ic"><Icon name="clock" size={15} /></span>Avg response time</div>
                <div className="stat-val">
                  {totalReqs > 0 ? <>{avgLatency} <small>ms</small></> : "—"}
                </div>
                <div className="stat-meta">{latencies.length > 0 ? `Slowest ${Math.max(...latencies)} ms` : "No timings yet"}</div>
              </div>
            </div>

            {folders.length > 0 && (
              <nav className="tab-frame f-frame" aria-label="Folders">
                {!(folderEdges.atStart && folderEdges.atEnd) && (
                  <button type="button" className="fscroll" disabled={folderEdges.atStart} onClick={() => scrollFolders(-1)} aria-label="Scroll folders left">
                    <Icon name="chevLeft" size={16} />
                  </button>
                )}
                <div className="folders" ref={foldersRef} onScroll={syncFolderEdges}>
                  <button
                    type="button"
                    className={`fchip${selectedFolder === "all" ? " on" : ""}`}
                    onClick={() => setSelectedFolder("all")}
                  >
                    All folders <span className="fc">{executions.length}</span>
                  </button>
                  {folders.map((folder) => {
                    const count = executions.filter((e) => e.folder === folder).length;
                    return (
                      <button
                        key={folder}
                        type="button"
                        className={`fchip${selectedFolder === folder ? " on" : ""}`}
                        onClick={() => setSelectedFolder(folder)}
                      >
                        {folder}
                        {folderHasFailures(folder) && <span className="fd" title="Has failures" />}
                        <span className="fc">{count}</span>
                      </button>
                    );
                  })}
                </div>
                {!(folderEdges.atStart && folderEdges.atEnd) && (
                  <button type="button" className="fscroll" disabled={folderEdges.atEnd} onClick={() => scrollFolders(1)} aria-label="Scroll folders right">
                    <Icon name="chevRight" size={16} />
                  </button>
                )}
              </nav>
            )}

            <section className="card overflow-hidden">
              <div className="ep-toolbar">
                <label className="search">
                  <Icon name="search" size={16} />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search endpoint name or URL"
                    aria-label="Search endpoints"
                  />
                </label>
                <div className="sel">
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                    aria-label="Filter by result"
                  >
                    <option value="all">All results ({executions.length})</option>
                    <option value="passed">Passed ({passedCount})</option>
                    <option value="failed">Failed ({failedExecutions.length})</option>
                  </select>
                  <Icon name="chevDown" size={16} />
                </div>
                <div className="sel">
                  <select value={selectedMethod} onChange={(e) => setSelectedMethod(e.target.value)} aria-label="Filter by HTTP method">
                    <option value="all">All HTTP methods</option>
                    {METHODS.map((method) => (
                      <option key={method} value={method}>{method}</option>
                    ))}
                  </select>
                  <Icon name="chevDown" size={16} />
                </div>
                <span className="spacer" />
                <fieldset className="seg" aria-label="View">
                  <button type="button" className={viewMode === "cards" ? "on" : ""} onClick={() => setViewMode("cards")} title="Detailed cards view">
                    <Icon name="grid" size={16} />
                    Cards
                  </button>
                  <button type="button" className={viewMode === "compact" ? "on" : ""} onClick={() => setViewMode("compact")} title="Dense table view">
                    <Icon name="list" size={16} />
                    Table
                  </button>
                </fieldset>
              </div>

              <div className={`ep-body${!loading && result && filteredExecutions.length > 0 && viewMode === "compact" ? " flush" : ""}`}>
                {loading && (
                  <div className="loading">
                    <Icon name="loader" size={28} className="spin" />
                    Loading collection endpoints…
                  </div>
                )}

                {!loading && !result && (
                  <div className="empty">
                    <Icon name="search" size={28} />
                    <h3>No execution data available yet</h3>
                    <p>Run this collection to view endpoint metrics and live assertions.</p>
                  </div>
                )}

                {!loading && result && filteredExecutions.length === 0 && (
                  <NoEndpoints configured={result.executions.length > 0} />
                )}

                {!loading && result && filteredExecutions.length > 0 && viewMode === "cards" && (
                  <div className="ep-grid">
                    {filteredExecutions.map((execution, index) => (
                      <article key={`${execution.name}-${index}`} className={`ep${execution.failed ? " is-fail" : ""}`}>
                        <div className="ep-top">
                          <MethodTag method={execution.method} />
                          <CodeTag execution={execution} prefix="HTTP " />
                          <span className="spacer" />
                          <ResultBadge failed={execution.failed} />
                        </div>
                        <h3 className="ep-name">{execution.name}</h3>
                        {execution.url && <div className="ep-url mono" title={execution.url}>{execution.url}</div>}
                        {execution.folder && (
                          <div className="ep-folder"><Icon name="folder" size={14} /><span>{execution.folder}</span></div>
                        )}
                        <div className="metrics">
                          <div><span>Latency</span><b>{formatDuration(execution.responseTimeMs)}</b></div>
                          <div><span>Payload</span><b>{formatSize(execution.responseSize)}</b></div>
                          <div>
                            <span>Assertions</span>
                            <b className={execution.failed ? "bad" : "ok"}>{passedAssertions(execution)}/{execution.assertions.length}</b>
                          </div>
                        </div>
                        {execution.assertions.length > 0 && (
                          <ul className="asserts">
                            {execution.assertions.map((assertion, assertionIndex) => (
                              <li key={`${assertion.name}-${assertionIndex}`} className={assertion.passed ? "ok" : "no"}>
                                <Icon name={assertion.passed ? "okCircle" : "noCircle"} size={17} />
                                <span>
                                  {assertion.name}
                                  {assertion.errorMessage && <span className="msg">{assertion.errorMessage}</span>}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </article>
                    ))}
                  </div>
                )}

                {!loading && result && filteredExecutions.length > 0 && viewMode === "compact" && (
                  <div className="table-scroll">
                    <table className="tbl ep-tbl">
                      <thead>
                        <tr>
                          <th>Method</th>
                          <th>Endpoint</th>
                          <th>Folder</th>
                          <th>Status</th>
                          <th>Latency</th>
                          <th>Payload</th>
                          <th>Assertions</th>
                          <th>Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredExecutions.map((execution, index) => (
                          <tr key={`${execution.name}-${index}`}>
                            <td><MethodTag method={execution.method} /></td>
                            <td className="ep-cell">
                              <div className="font-medium">{execution.name}</div>
                              {execution.url && <div className="ep-url mono" title={execution.url}>{execution.url}</div>}
                            </td>
                            <td className="nowrap small text-slate-700">{execution.folder ?? "Root"}</td>
                            <td><CodeTag execution={execution} prefix="" /></td>
                            <td className="num nowrap">{formatDuration(execution.responseTimeMs)}</td>
                            <td className="num nowrap">{formatSize(execution.responseSize)}</td>
                            <td className="num">
                              <span className={execution.failed ? "text-rose-600" : "text-emerald-600"}>{passedAssertions(execution)}</span>
                              <span className="muted"> / {execution.assertions.length}</span>
                            </td>
                            <td><ResultBadge failed={execution.failed} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="ep-foot">
                <span>
                  Showing <b className="font-medium text-slate-900">{filteredExecutions.length}</b> of {formatNumber(executions.length)} endpoints
                </span>
              </div>
            </section>

            {filteredExecutions.length > 0 && (
              <div className="to-top">
                <button type="button" className="btn btn-success" onClick={goToTop}>
                  <Icon name="arrowUp" size={16} />
                  Go to top
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
