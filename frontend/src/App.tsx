import { type ComponentProps, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { Drawer } from "./Drawer";
import { HistoryModal } from "./HistoryModal";
import { AutoRerunModal } from "./AutoRerunModal";
import { ToastContainer } from "./Toast";
import { LoginPage } from "./LoginPage";
import { keycloak, keycloakConfigured } from "./keycloak";
import { formatLastRun, formatNumber, initials, percent, shortEnvironment } from "./format";
import { actionButtonClass, applyStatuses, describeSkipped, markInvalidSkipped, markQueuedRunning, rerunTitle } from "./collections";
import { Icon } from "./Icon";
import { StatusBadge } from "./StatusBadge";
import type { Collection, DashboardKpis, HistoryRunSummary, RunResult, SkippedFile } from "./types";

type StatusTab = "all" | "failed" | "passed" | "running";
type SortKey = "collection" | "environment" | "status" | "apis" | "assertions" | "tests" | "lastRun";

const sortValue: Record<SortKey, (collection: Collection) => string | number> = {
  collection: (c) => c.folderName.toLowerCase(),
  environment: (c) => (c.environmentFile ?? "").toLowerCase(),
  status: (c) => c.status,
  apis: (c) => c.apiCount,
  assertions: (c) => (c.assertions.total ? c.assertions.passed / c.assertions.total : 0),
  tests: (c) => (c.tests?.total ? c.tests.passed / c.tests.total : 0),
  lastRun: (c) => (c.lastRunAt ? Date.parse(c.lastRunAt) : 0),
};

const matchesTab = (collection: Collection, tab: StatusTab) =>
  tab === "all" ||
  collection.status === tab ||
  (tab === "failed" && collection.status === "error");

function SplitBar({ passed, total }: Readonly<{ passed: number; total: number }>) {
  const width = total ? (passed / total) * 100 : 0;
  return (
    <div className="stat-bar" aria-hidden="true">
      <i style={{ width: `${width}%` }} />
      {passed < total && <i className="f" style={{ width: `${Math.max(100 - width, 1.5)}%` }} />}
    </div>
  );
}

function Progress({ passed, total }: Readonly<{ passed: number; total: number }>) {
  const value = percent(passed, total);
  const ok = passed === total;
  return (
    <div className="prog">
      <div className="prog-txt">
        <b className={ok ? "ok" : "bad"}>{formatNumber(passed)}</b>
        <span className="muted">/ {formatNumber(total)}</span>
        <span className="pct">{value}%</span>
      </div>
      <div className={`bar ${ok ? "" : "bad"}`}><i style={{ width: `${value}%` }} /></div>
    </div>
  );
}

// Collection ids are URL-safe slugs, so they need no encoding in the path.
const collectionIdFromPath = () => /^\/collections\/([^/]+)\/?$/.exec(globalThis.location.pathname)?.[1] ?? null;

type RunDetailsPageProps = Omit<ComponentProps<typeof Drawer>, "collection"> & { collection?: Collection };

function RunDetailsPage({ collection, ...drawerProps }: Readonly<RunDetailsPageProps>) {
  if (!collection) {
    return (
      <output className="loading">
        <Icon name="loader" size={28} className="spin" />
        Loading run details…
      </output>
    );
  }
  return (
    <>
      <Drawer collection={collection} {...drawerProps} />
      <ToastContainer />
    </>
  );
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<string | null>(() => keycloak?.authenticated ? (keycloak.tokenParsed?.email ?? keycloak.tokenParsed?.preferred_username ?? "Keycloak user") : null);
  const [currentUserName, setCurrentUserName] = useState<string | null>(() => keycloak?.authenticated ? (keycloak.tokenParsed?.name ?? null) : null);
  const [loginError, setLoginError] = useState<string | null>(() => keycloakConfigured ? null : "Keycloak is not configured. Set VITE_KEYCLOAK_URL, VITE_KEYCLOAK_REALM, and VITE_KEYCLOAK_CLIENT_ID.");
  const [isQaAdmin, setIsQaAdmin] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [kpis, setKpis] = useState<DashboardKpis | null>(null);
  const [skipped, setSkipped] = useState<SkippedFile[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusTab>("all");
  const [sort, setSort] = useState<{ key: SortKey | null; dir: 1 | -1 }>({ key: null, dir: 1 });
  const [selectedId, setSelectedId] = useState(collectionIdFromPath);
  const dashboardScrollY = useRef(0);
  const [result, setResult] = useState<RunResult | null>(null);
  const [resultLoading, setResultLoading] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<Collection | null>(null);
  const [historyList, setHistoryList] = useState<HistoryRunSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activeRuns, setActiveRuns] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkRunning, setIsBulkRunning] = useState(false);
  const bulkRunTrackedIdsRef = useRef<Set<string>>(new Set());
  const headerCheckboxRef = useRef<HTMLInputElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const handleLogin = () => {
    if (!keycloak) return;
    setLoginError(null);
    void keycloak.login().catch(() => setLoginError("Could not start Keycloak sign-in. Check the client and redirect URI configuration."));
  };

  const handleLogout = () => {
    setIsProfileMenuOpen(false);
    if (keycloak) void keycloak.logout({ redirectUri: globalThis.location.origin });
  };

  useEffect(() => {
    if (!isProfileMenuOpen) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !profileMenuRef.current?.contains(event.target)) {
        setIsProfileMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsProfileMenuOpen(false);
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isProfileMenuOpen]);

  useEffect(() => {
    if (!keycloak?.authenticated) {
      setCurrentUser(null);
      setCurrentUserName(null);
      setIsQaAdmin(false);
      return;
    }
    const claims = keycloak.tokenParsed;
    setCurrentUser(claims?.email ?? claims?.preferred_username ?? "Keycloak user");
    setCurrentUserName(claims?.name ?? null);
    void api.me().then(({ user }) => {
      setCurrentUser(user.email ?? user.username ?? user.name ?? "Keycloak user");
      setCurrentUserName(user.name ?? null);
      setIsQaAdmin(user.roles.realm.includes("qa_admin"));
    }).catch((requestError: unknown) => {
      setError(requestError instanceof Error ? requestError.message : "Could not load your Keycloak roles.");
    });
  }, []);

  const refresh = useCallback(async (includeSkipped = false) => {
    try {
      const [dashboard, nextSkipped] = await Promise.all([
        api.dashboard(),
        includeSkipped ? api.skipped() : Promise.resolve(undefined)
      ]);
      setCollections(dashboard.data.collections);
      setKpis(dashboard.data.kpis);
      setActiveRuns((current) => {
        const next = { ...current };
        for (const collection of dashboard.data.collections) {
          if (collection.status === "running" && collection.runId) next[collection.id] = collection.runId;
        }
        return next;
      });
      if (nextSkipped) setSkipped(nextSkipped);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not refresh dashboard data.");
    }
  }, []);

  useEffect(() => {
    if (currentUser) {
      void refresh(true);
    }
  }, [currentUser, refresh]);

  useEffect(() => {
    const entries = Object.entries(activeRuns);
    if (entries.length === 0) return;

    let polling = false;
    let cancelled = false;

    const pollStatuses = async () => {
      if (polling || cancelled) return;
      polling = true;
      try {
        const statuses = await Promise.all(entries.map(async ([collectionId, runId]) => {
          try {
            const status = await api.runStatus(runId);
            return { collectionId, status: status.data.status, failed: false };
          } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : "Could not read collection run status.");
            return { collectionId, status: "error" as const, failed: true };
          }
        }));

        if (cancelled) return;

        const completedCollectionIds = statuses
          .filter(({ status, failed }) => failed || ["passed", "failed", "error"].includes(status))
          .map(({ collectionId }) => collectionId);

        setCollections((current) => current && applyStatuses(current, statuses));

        if (completedCollectionIds.length > 0) {
          setActiveRuns((current) => {
            const next = { ...current };
            for (const collectionId of completedCollectionIds) delete next[collectionId];
            return next;
          });

          const tracked = bulkRunTrackedIdsRef.current;
          if (tracked.size === 0) {
            void refresh();
          } else {
            for (const id of completedCollectionIds) tracked.delete(id);
            if (tracked.size === 0) {
              setIsBulkRunning(false);
              setSelectedIds(new Set());
              void refresh();
            }
          }
        }
      } finally {
        polling = false;
      }
    };

    void pollStatuses();
    const timer = globalThis.setInterval(() => void pollStatuses(), 1500);
    return () => {
      cancelled = true;
      globalThis.clearInterval(timer);
    };
  }, [activeRuns, refresh]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && !target.closest(".action-menu-dropdown-container")) {
        setOpenActionMenuId(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenActionMenuId(null);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const syncRoute = () => setSelectedId(collectionIdFromPath());
    globalThis.addEventListener("popstate", syncRoute);
    return () => globalThis.removeEventListener("popstate", syncRoute);
  }, []);

  const isSignedIn = Boolean(currentUser);
  useEffect(() => {
    if (!selectedId || !isSignedIn) return;
    let cancelled = false;
    setResult(null);
    setResultLoading(true);
    api.result(selectedId)
      .then(({ result: nextResult }) => {
        if (!cancelled) setResult(nextResult);
      })
      .catch((requestError: unknown) => {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : "Could not load run details.");
      })
      .finally(() => {
        if (!cancelled) setResultLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, isSignedIn]);

  // A link can name a collection that no longer exists; fall back to the dashboard.
  useEffect(() => {
    if (selectedId && collections && !collections.some((c) => c.id === selectedId)) {
      globalThis.history.replaceState(null, "", "/");
      setSelectedId(null);
      setError("Collection not found.");
    }
  }, [selectedId, collections]);

  useLayoutEffect(() => {
    globalThis.scrollTo(0, selectedId ? 0 : dashboardScrollY.current);
  }, [selectedId]);

  const filteredCollections = useMemo(() => {
    const query = search.trim().toLowerCase();
    const rows = (collections ?? []).filter((collection) => {
      const haystack = `${collection.folderName} ${collection.collectionFile} ${collection.environmentFile ?? ""}`.toLowerCase();
      return (!query || haystack.includes(query)) && matchesTab(collection, status);
    });
    if (!sort.key) return rows;
    const value = sortValue[sort.key];
    return [...rows].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (x === y) return 0;
      return (x > y ? 1 : -1) * sort.dir;
    });
  }, [collections, search, status, sort]);

  const displayedCollectionIds = useMemo(() => {
    return filteredCollections.map((c) => c.id);
  }, [filteredCollections]);

  const selectedDisplayedCount = useMemo(() => {
    return displayedCollectionIds.filter((id) => selectedIds.has(id)).length;
  }, [displayedCollectionIds, selectedIds]);

  const isAllSelected = displayedCollectionIds.length > 0 && selectedDisplayedCount === displayedCollectionIds.length;
  const isIndeterminate = selectedDisplayedCount > 0 && selectedDisplayedCount < displayedCollectionIds.length;

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = isIndeterminate;
    }
  }, [isIndeterminate]);

  const handleToggleAll = () => {
    setOpenActionMenuId(null);
    if (isAllSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of displayedCollectionIds) {
          next.delete(id);
        }
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of displayedCollectionIds) {
          next.add(id);
        }
        return next;
      });
    }
  };

  const handleToggleRow = (id: string) => {
    setOpenActionMenuId(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleRunSelected = async () => {
    if (selectedIds.size === 0 || isBulkRunning) return;
    const selectedCollectionIds = Array.from(selectedIds);
    setSelectedIds(new Set());
    setIsBulkRunning(true);
    setError(null);
    try {
      const response = await api.runSelected(selectedCollectionIds);
      const queued = response.data?.queued ?? [];
      const skipped = response.data?.skipped ?? [];

      if (skipped.length > 0) {
        setError(describeSkipped(skipped));
        setCollections((current) => current && markInvalidSkipped(current, skipped));
      }

      if (queued.length > 0) {
        setCollections((current) => current && markQueuedRunning(current, queued));

        setActiveRuns((current) => {
          const next = { ...current };
          for (const item of queued) {
            next[item.collectionId] = item.runId;
          }
          return next;
        });

        bulkRunTrackedIdsRef.current = new Set(queued.map((q) => q.collectionId));
      } else {
        setIsBulkRunning(false);
        setSelectedIds(new Set());
        await refresh();
      }
    } catch (requestError) {
      setIsBulkRunning(false);
      bulkRunTrackedIdsRef.current = new Set();
      // Refresh first: a successful refresh clears the error banner.
      await refresh();
      setError(requestError instanceof Error ? requestError.message : "Failed to run selected collections.");
    }
  };

  function showResult(collection: Collection) {
    dashboardScrollY.current = globalThis.scrollY;
    globalThis.history.pushState(null, "", `/collections/${collection.id}`);
    setSelectedId(collection.id);
  }

  function closeResult() {
    globalThis.history.pushState(null, "", "/");
    setSelectedId(null);
  }

  async function openHistory(collection: Collection) {
    setHistoryTarget(collection);
    setHistoryList([]);
    setHistoryLoading(true);
    try {
      const historyData = await api.history(collection.id);
      setHistoryList(historyData.data.runs);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load test execution history.");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function run(id: string) {
    setSelectedIds(new Set());
    try {
      setCollections((prev) => prev ? prev.map((c) => c.id === id ? { ...c, status: "running" } : c) : prev);
      const runResponse = await api.run(id);
      setActiveRuns((current) => ({ ...current, [id]: runResponse.data.runId }));
    } catch (requestError) {
      // Refresh first: a successful refresh clears the error banner.
      await refresh();
      setError(requestError instanceof Error ? requestError.message : "Could not start collection.");
    }
  }

  const allCollections = collections ?? [];
  const totalAssertions = allCollections.reduce((sum, c) => sum + c.assertions.total, 0);
  const environmentCount = new Set(allCollections.map((c) => c.environmentFile).filter(Boolean)).size;
  const failedNames = allCollections.filter((c) => matchesTab(c, "failed")).map((c) => c.folderName).join(", ") || "None";
  const tabs: { key: StatusTab; label: string; count: number }[] = [
    { key: "all", label: "All collections", count: allCollections.length },
    { key: "failed", label: "Failed", count: allCollections.filter((c) => matchesTab(c, "failed")).length },
    { key: "passed", label: "Passed", count: allCollections.filter((c) => c.status === "passed").length },
  ];
  const runningCount = allCollections.filter((c) => c.status === "running").length;
  if (runningCount > 0 || status === "running") tabs.push({ key: "running", label: "Running", count: runningCount });
  const userLabel = (currentUserName ?? currentUser ?? "U").trim();

  const toggleSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const sortHeader = (key: SortKey, label: string) => (
    <th>
      <button type="button" className={`th-sort${sort.key === key ? " on" : ""}`} onClick={() => toggleSort(key)} aria-label={`Sort by ${label}`}>
        {label} <Icon name="sort" size={13} />
      </button>
    </th>
  );

  if (!currentUser) {
    return <LoginPage onLogin={handleLogin} error={loginError} />;
  }

  if (selectedId) {
    return (
      <RunDetailsPage
        collection={allCollections.find((c) => c.id === selectedId)}
        result={result}
        loading={resultLoading}
        error={error}
        onClose={closeResult}
      />
    );
  }

  return (
    <main className="min-h-screen">
      <header className="topbar">
        <h1 className="app-title">API Test Execution Dashboard</h1>
        <div className="head-actions">
          {isQaAdmin && (
            <button
              type="button"
              id="auto-rerun-settings-btn"
              className="btn"
              onClick={() => setIsSettingsOpen(true)}
              title="Configure scheduled runs and email alerts"
            >
              <Icon name="clock" />
              <span className="lbl">Auto re-run</span>
            </button>
          )}
          <button type="button" className="btn" onClick={() => void refresh(true)}>
            <Icon name="refresh" />
            <span className="lbl">Refresh</span>
          </button>
          <div className="relative" ref={profileMenuRef}>
            <button
              type="button"
              id="user-profile-menu-button"
              className="me-av"
              aria-label="Open user profile menu"
              aria-haspopup="menu"
              aria-expanded={isProfileMenuOpen}
              aria-controls="user-profile-menu"
              onClick={() => setIsProfileMenuOpen((open) => !open)}
              title="User profile"
            >
              {initials(userLabel)}
            </button>
            {isProfileMenuOpen && (
              <div id="user-profile-menu" role="menu" aria-labelledby="user-profile-menu-button" className="menu right-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)]">
                <div className="menu-user">
                  <span className="me-av" aria-hidden="true">{initials(userLabel)}</span>
                  <div className="min-w-0">
                    {currentUserName && <p className="font-medium">{currentUserName}</p>}
                    <p className="small muted" title={currentUser ?? undefined}>{currentUser}</p>
                  </div>
                </div>
                <hr />
                <button type="button" role="menuitem" onClick={handleLogout}>
                  <Icon name="logout" size={16} />
                  Log out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="page">
        {error && <div role="alert" className="alert">{error}</div>}

        {kpis && (
          <section aria-label="Summary" className="stats" style={{ marginTop: 28 }}>
            <div className="stat">
              <div className="stat-label"><span className="stat-ic acc"><Icon name="layers" size={15} /></span>Total collections</div>
              <div className="stat-val">{formatNumber(kpis.totalCollections)}</div>
              <div className="stat-meta">{environmentCount} {environmentCount === 1 ? "environment" : "environments"}</div>
            </div>
            <div className="stat">
              <div className="stat-label"><span className="stat-ic pass"><Icon name="check" size={15} /></span>Passed collections</div>
              <div className="stat-val pass">{formatNumber(kpis.passedCollections)}</div>
              <div className="stat-meta">{Math.round(percent(kpis.passedCollections, kpis.totalCollections))}% of collections</div>
              <SplitBar passed={kpis.passedCollections} total={kpis.totalCollections} />
            </div>
            <div className="stat">
              <div className="stat-label"><span className="stat-ic fail"><Icon name="x" size={15} /></span>Failed collections</div>
              <div className={`stat-val${kpis.failedCollections > 0 ? " fail" : ""}`}>{formatNumber(kpis.failedCollections)}</div>
              <div className="stat-meta" title={failedNames}>{failedNames}</div>
            </div>
            <div className="stat">
              <div className="stat-label"><span className="stat-ic info"><Icon name="zap" size={15} /></span>Total APIs</div>
              <div className="stat-val">{formatNumber(kpis.totalApis)}</div>
              <div className="stat-meta">Across {kpis.totalCollections} {kpis.totalCollections === 1 ? "collection" : "collections"}</div>
            </div>
            <div className="stat">
              <div className="stat-label"><span className="stat-ic fail"><Icon name="alert" size={15} /></span>Failed assertions</div>
              <div className={`stat-val${kpis.failedAssertions > 0 ? " fail" : ""}`}>
                {formatNumber(kpis.failedAssertions)} <small>/ {formatNumber(totalAssertions)}</small>
              </div>
              <div className="stat-meta">{percent(totalAssertions - kpis.failedAssertions, totalAssertions)}% of assertions passing</div>
              <SplitBar passed={totalAssertions - kpis.failedAssertions} total={totalAssertions} />
            </div>
          </section>
        )}

        <div className="toolbar" style={kpis ? undefined : { marginTop: 28 }}>
          <label className="search">
            <Icon name="search" size={16} />
            <input
              id="collection-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search collection or file"
              aria-label="Search collections"
            />
          </label>
          <div className="seg" role="tablist" aria-label="Filter by status">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={status === tab.key}
                className={status === tab.key ? "on" : ""}
                onClick={() => setStatus(tab.key)}
              >
                {tab.label}<span className="cnt">{tab.count}</span>
              </button>
            ))}
          </div>
          {isQaAdmin && (selectedIds.size > 0 || isBulkRunning) && (
            <div className="bulk">
              {selectedIds.size > 0 && <span className="bulk-count">{selectedIds.size} selected</span>}
              <button
                type="button"
                id="run-selected-btn"
                className="btn btn-sm btn-success"
                disabled={isBulkRunning}
                onClick={() => void handleRunSelected()}
                title="Run selected collections"
              >
                {isBulkRunning ? <Icon name="loader" size={14} className="spin" /> : <Icon name="play" size={14} />}
                {isBulkRunning ? "Running selected…" : "Run selected"}
              </button>
              {!isBulkRunning && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelectedIds(new Set())}>
                  Clear
                </button>
              )}
            </div>
          )}
          <span className="spacer" />
          {collections !== null && (
            <span className="small muted">
              Showing <b className="font-medium text-slate-900">{filteredCollections.length}</b> of {allCollections.length} collections
            </span>
          )}
        </div>

        <section className="card overflow-hidden">
          {collections === null && (
            <output className="loading">
              <Icon name="loader" size={28} className="spin" />
              Loading collection inventory…
            </output>
          )}

          {collections !== null && filteredCollections.length === 0 && (
            <div className="empty">
              <Icon name="search" size={28} />
              <h3>No collections match the current filters.</h3>
              <p>Try a different name or clear the filters.</p>
              <button type="button" className="btn btn-sm" onClick={() => { setSearch(""); setStatus("all"); }}>
                Clear filters
              </button>
            </div>
          )}

          {filteredCollections.length > 0 && (
            <div className="table-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    {isQaAdmin && (
                      <th className="chk">
                        <input
                          type="checkbox"
                          id="select-all-collections"
                          aria-label="Select all collections"
                          ref={headerCheckboxRef}
                          checked={isAllSelected}
                          onChange={handleToggleAll}
                        />
                      </th>
                    )}
                    <th className="idx">#</th>
                    {sortHeader("collection", "Collection & file")}
                    {sortHeader("environment", "Environment")}
                    {sortHeader("status", "Status")}
                    {sortHeader("apis", "APIs / Endpoints")}
                    {sortHeader("assertions", "Assertions passed")}
                    {sortHeader("tests", "Tests passed")}
                    {sortHeader("lastRun", "Last run")}
                    <th className="act">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCollections.map((collection, index) => {
                    const isSelected = selectedIds.has(collection.id);
                    const isRowActionDisabled = isSelected;
                    const isMenuOpen = openActionMenuId === collection.id;
                    const opensUpward = filteredCollections.length > 2 && index >= filteredCollections.length - 2;
                    const position = allCollections.indexOf(collection);
                    const tests = collection.tests ?? { passed: 0, failed: 0, total: 0 };
                    return (
                      <tr key={collection.id} className={`relative cursor-pointer ${isSelected ? "is-sel" : ""}`}>
                        {isQaAdmin && (
                          <td className="chk relative z-10">
                            <input
                              type="checkbox"
                              id={`select-collection-${collection.id}`}
                              aria-label={`Select collection ${collection.folderName}`}
                              checked={isSelected}
                              onChange={() => handleToggleRow(collection.id)}
                            />
                          </td>
                        )}
                        <td className="idx num">{index + 1}</td>
                        <td>
                          <div className="coll">
                            <span className={`tile h${(position % 4) + 1}`} aria-hidden="true">{initials(collection.folderName)}</span>
                            <div className="min-w-0">
                              {/* The after: overlay stretches this button over the whole row, so clicking anywhere on the row opens the result. */}
                              <button
                                type="button"
                                onClick={() => showResult(collection)}
                                className="coll-name block cursor-pointer text-left focus:outline-none after:absolute after:inset-0 after:content-['']"
                              >
                                {collection.folderName}
                              </button>
                              <div className="coll-file mono" title={collection.collectionFile}>
                                <Icon name="file" size={13} />
                                <span>{collection.collectionFile}</span>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          {collection.environmentFile ? (
                            <span className="chip mono trunc" title={collection.environmentFile}>
                              <span className="t">{shortEnvironment(collection.environmentFile)}</span>
                            </span>
                          ) : (
                            <span className="muted">Default Environment</span>
                          )}
                        </td>
                        <td><StatusBadge status={collection.status} /></td>
                        <td>
                          <span className="num nowrap"><b className="font-medium">{formatNumber(collection.apiCount)}</b> <span className="muted">APIs</span></span>
                        </td>
                        <td><Progress passed={collection.assertions.passed} total={collection.assertions.total} /></td>
                        <td><Progress passed={tests.passed} total={tests.total} /></td>
                        <td>
                          <span className="lastrun"><Icon name="clock" size={15} />{formatLastRun(collection.lastRunAt)}</span>
                        </td>
                        <td className={`act ${isMenuOpen ? "z-30" : "z-10"}`}>
                          <div className="relative inline-block text-left action-menu-dropdown-container">
                            <button
                              type="button"
                              disabled={isRowActionDisabled}
                              onClick={() => setOpenActionMenuId(isMenuOpen ? null : collection.id)}
                              className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-all ${actionButtonClass(isRowActionDisabled, isMenuOpen)}`}
                              title={isRowActionDisabled ? "Actions are disabled for selected collections" : "Actions menu"}
                              aria-expanded={isMenuOpen}
                              aria-label="Actions menu"
                            >
                              <Icon name="more" />
                            </button>

                            {isMenuOpen && !isRowActionDisabled && (
                              <div className={`menu right-0 ${opensUpward ? "bottom-full mb-2" : "top-full mt-2"}`}>
                                {isQaAdmin && (
                                  <button
                                    type="button"
                                    disabled={
                                      collection.status === "running" ||
                                      isRowActionDisabled ||
                                      collection.actions?.canRerun === false
                                    }
                                    onClick={() => {
                                      setOpenActionMenuId(null);
                                      void run(collection.id);
                                    }}
                                    title={rerunTitle(collection, isRowActionDisabled)}
                                  >
                                    <Icon name="play" size={16} />
                                    <span>{collection.lastRunAt ? "Re-run Collection" : "Run Collection"}</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={isRowActionDisabled}
                                  onClick={() => {
                                    setOpenActionMenuId(null);
                                    void openHistory(collection);
                                  }}
                                >
                                  <Icon name="history" size={16} />
                                  <span>View History</span>
                                </button>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {skipped.length > 0 && (
          <section className="card skipped">
            <h2>Skipped Files &amp; Unmatched Collections</h2>
            <ul className="m-0 list-none p-0">
              {skipped.map((file) => (
                <li key={file.fileName}>
                  <span className="font-medium">{file.fileName}</span>
                  <span className="muted">{file.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {historyTarget && (
        <HistoryModal
          collection={historyTarget}
          history={historyList}
          loading={historyLoading}
          onClose={() => setHistoryTarget(null)}
        />
      )}

      {isQaAdmin && isSettingsOpen && (
        <AutoRerunModal
          onClose={() => setIsSettingsOpen(false)}
        />
      )}

      <ToastContainer />
    </main>
  );
}
