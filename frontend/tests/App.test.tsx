import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App";
import { makeCollection } from "./fixtures";
import type { Collection } from "../src/types";

const kc = vi.hoisted(() => ({
  authenticated: true,
  tokenParsed: { email: "qa@example.com", name: "Qa Person" } as Record<string, string> | undefined,
  login: vi.fn(),
  logout: vi.fn(),
}));

const mockApi = vi.hoisted(() => ({
  me: vi.fn(),
  dashboard: vi.fn(),
  skipped: vi.fn(),
  result: vi.fn(),
  history: vi.fn(),
  run: vi.fn(),
  runStatus: vi.fn(),
  runSelected: vi.fn(),
  runAll: vi.fn(),
  getAutoRerunSettings: vi.fn(),
  saveAutoRerunSettings: vi.fn(),
}));

vi.mock("../src/keycloak", () => ({ keycloak: kc, keycloakConfigured: true }));
vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  api: mockApi,
}));

const alpha = makeCollection({ id: "c1", folderName: "Alpha", environmentFile: "dev.json" });
const beta = makeCollection({ id: "c2", folderName: "Beta", status: "failed", lastRunAt: "2026-10-01T10:00:00Z", durationMs: 1500 });

function dashboard(collections: Collection[] = [alpha, beta]) {
  return {
    data: {
      collections,
      kpis: { totalCollections: collections.length, passedCollections: 1, failedCollections: 1, totalApis: 6, failedAssertions: 2 },
    },
    meta: { generatedAt: "" },
  };
}

function me(realm: string[] = ["qa_admin"]) {
  return { user: { id: "u1", username: "qa", email: "qa@example.com", name: "Qa Person", roles: { realm, clients: {}, groups: [] } } };
}

beforeEach(() => {
  kc.authenticated = true;
  kc.tokenParsed = { email: "qa@example.com", name: "Qa Person" };
  kc.login.mockResolvedValue(undefined);
  kc.logout.mockResolvedValue(undefined);
  mockApi.me.mockResolvedValue(me());
  mockApi.dashboard.mockResolvedValue(dashboard());
  mockApi.skipped.mockResolvedValue([]);
  mockApi.result.mockResolvedValue({ result: null });
  mockApi.history.mockResolvedValue({ data: { runs: [] } });
  mockApi.getAutoRerunSettings.mockResolvedValue({ data: { interval: "off", recipients: [] } });
  globalThis.scrollTo = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
  globalThis.history.replaceState(null, "", "/");
});

async function renderApp() {
  render(<App />);
  await screen.findByRole("button", { name: "Alpha" });
}

const rowOf = (name: string) => screen.getByRole("button", { name }).closest("tr")!;

async function openActions(name: string) {
  await userEvent.click(within(rowOf(name)).getByRole("button", { name: "Actions menu" }));
}

describe("App login", () => {
  it("shows the login page and starts sign-in", async () => {
    kc.authenticated = false;
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in with Keycloak" }));
    expect(kc.login).toHaveBeenCalled();
    expect(mockApi.me).not.toHaveBeenCalled();
  });

  it("shows an error when sign-in cannot start", async () => {
    kc.authenticated = false;
    kc.login.mockRejectedValue(new Error("bad"));
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in with Keycloak" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not start Keycloak sign-in");
  });
});

describe("App dashboard", () => {
  it("renders KPIs, collections and skipped files", async () => {
    mockApi.skipped.mockResolvedValue([{ fileName: "broken.json", reason: "Invalid JSON" }]);
    await renderApp();
    expect(screen.getByText("Total collections")).toBeInTheDocument();
    expect(screen.getByText("Across 2 collections")).toBeInTheDocument();
    expect(screen.getByText("dev.json")).toBeInTheDocument();
    expect(screen.getByText("Default Environment")).toBeInTheDocument();
    expect(screen.getByText("broken.json")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Auto re-run/ })).toBeInTheDocument();
  });

  it("shows loading until the dashboard arrives", async () => {
    mockApi.dashboard.mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(await screen.findByText("Loading collection inventory…")).toBeInTheDocument();
  });

  it("hides admin controls for non-admins", async () => {
    mockApi.me.mockResolvedValue(me([]));
    await renderApp();
    expect(screen.queryByRole("button", { name: /Auto re-run/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Select all collections")).not.toBeInTheDocument();
  });

  it("shows API errors", async () => {
    mockApi.me.mockRejectedValue(new Error("Roles unavailable"));
    mockApi.dashboard.mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Roles unavailable");
  });

  it("shows a default error when refresh fails with a non-Error", async () => {
    mockApi.dashboard.mockRejectedValue("nope");
    mockApi.me.mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not refresh dashboard data.");
  });

  it("filters by search and status", async () => {
    await renderApp();
    await userEvent.type(screen.getByPlaceholderText("Search collection or file"), "bet");
    expect(screen.queryByRole("button", { name: "Alpha" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beta" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /^Passed/ }));
    expect(screen.getByText("No collections match the current filters.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search collection or file")).toHaveValue("");
  });

  it("refreshes on demand", async () => {
    await renderApp();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mockApi.dashboard).toHaveBeenCalledTimes(2);
    expect(mockApi.skipped).toHaveBeenCalledTimes(2);
  });
});

describe("App drawers and modals", () => {
  it("opens run details as a separate page from a row and goes back", async () => {
    await renderApp();
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(mockApi.result).toHaveBeenCalledWith("c1");
    expect(await screen.findByText("No execution data available yet")).toBeInTheDocument();
    expect(globalThis.location.pathname).toBe("/collections/c1");
    expect(screen.queryByText("API Test Execution Dashboard")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(globalThis.location.pathname).toBe("/");
    expect(screen.queryByText("No execution data available yet")).not.toBeInTheDocument();
    expect(screen.getByText("API Test Execution Dashboard")).toBeInTheDocument();
  });

  it("opens run details directly from the URL", async () => {
    globalThis.history.replaceState(null, "", "/collections/c1");
    render(<App />);
    expect(await screen.findByText("No execution data available yet")).toBeInTheDocument();
    expect(mockApi.result).toHaveBeenCalledWith("c1");
  });

  it("follows the browser back button", async () => {
    await renderApp();
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await screen.findByText("No execution data available yet");
    globalThis.history.replaceState(null, "", "/");
    fireEvent(globalThis.window, new PopStateEvent("popstate"));
    expect(await screen.findByText("API Test Execution Dashboard")).toBeInTheDocument();
  });

  it("returns to the dashboard for an unknown collection in the URL", async () => {
    globalThis.history.replaceState(null, "", "/collections/missing");
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Collection not found.");
    expect(globalThis.location.pathname).toBe("/");
  });

  it("reports result load failures", async () => {
    mockApi.result.mockRejectedValue("nope");
    await renderApp();
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load run details.");
  });

  it("opens history from the action menu", async () => {
    await renderApp();
    await openActions("Alpha");
    await userEvent.click(screen.getByRole("button", { name: "View History" }));
    expect(mockApi.history).toHaveBeenCalledWith("c1");
    expect(await screen.findByText("No history records found yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("No history records found yet")).not.toBeInTheDocument();
  });

  it("reports history load failures", async () => {
    mockApi.history.mockRejectedValue(new Error("History down"));
    await renderApp();
    await openActions("Alpha");
    await userEvent.click(screen.getByRole("button", { name: "View History" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("History down");
  });

  it("closes the action menu on Escape and outside click", async () => {
    await renderApp();
    await openActions("Alpha");
    expect(screen.getByRole("button", { name: "View History" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "View History" })).not.toBeInTheDocument();
    await openActions("Alpha");
    await openActions("Alpha");
    expect(screen.queryByRole("button", { name: "View History" })).not.toBeInTheDocument();
    await openActions("Alpha");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("button", { name: "View History" })).not.toBeInTheDocument();
  });

  it("opens and closes the auto re-run settings", async () => {
    await renderApp();
    await userEvent.click(screen.getByRole("button", { name: /Auto re-run/ }));
    expect(await screen.findByRole("dialog", { name: "Auto Re-run Settings" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the profile menu, closes it and logs out", async () => {
    await renderApp();
    const profile = screen.getByRole("button", { name: "Open user profile menu" });
    await userEvent.click(profile);
    expect(screen.getByRole("menu")).toHaveTextContent("Qa Person");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(profile);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(profile);
    await userEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    expect(kc.logout).toHaveBeenCalledWith({ redirectUri: globalThis.location.origin });
  });
});

describe("App runs", () => {
  it("runs a single collection and polls until it finishes", async () => {
    mockApi.run.mockResolvedValue({ data: { runId: "r1" } });
    mockApi.runStatus.mockResolvedValue({ data: { status: "passed" } });
    await renderApp();
    await openActions("Alpha");
    await userEvent.click(screen.getByRole("button", { name: "Run Collection" }));
    expect(mockApi.run).toHaveBeenCalledWith("c1");
    await vi.waitFor(() => expect(mockApi.runStatus).toHaveBeenCalledWith("r1"));
    await vi.waitFor(() => expect(mockApi.dashboard).toHaveBeenCalledTimes(2));
  });

  it("disables rerun for running collections and labels re-runs", async () => {
    mockApi.dashboard.mockResolvedValue(dashboard([alpha, makeCollection({ id: "c3", folderName: "Gamma", status: "running", runId: "r3" })]));
    mockApi.runStatus.mockReturnValue(new Promise(() => {}));
    await renderApp();
    await vi.waitFor(() => expect(mockApi.runStatus).toHaveBeenCalledWith("r3"));
    await openActions("Gamma");
    expect(screen.getByRole("button", { name: "Run Collection" })).toBeDisabled();
  });

  it("reports run start failures", async () => {
    mockApi.run.mockRejectedValue(new Error("Busy"));
    await renderApp();
    await openActions("Beta");
    await userEvent.click(screen.getByRole("button", { name: "Re-run Collection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Busy");
    expect(mockApi.dashboard).toHaveBeenCalledTimes(2);
  });

  it("reports polling failures", async () => {
    // Only the first load is running; otherwise each reload restarts polling and the count races past 2.
    mockApi.dashboard.mockResolvedValueOnce(dashboard([makeCollection({ status: "running", runId: "r1" })]));
    mockApi.runStatus.mockRejectedValue("nope");
    await renderApp();
    // The failed run counts as finished, so the dashboard is reloaded.
    await vi.waitFor(() => expect(mockApi.dashboard).toHaveBeenCalledTimes(2));
  });

  it("selects rows and runs them in bulk", async () => {
    mockApi.runSelected.mockResolvedValue({
      data: {
        queued: [{ collectionId: "c1", runId: "r1", status: "running", statusUrl: "" }],
        skipped: [{ collectionId: "c2", reason: "invalid_collection" }],
      },
    });
    let finishRun!: (value: unknown) => void;
    mockApi.runStatus.mockReturnValue(new Promise((resolve) => (finishRun = resolve)));
    await renderApp();

    const selectAll = screen.getByLabelText("Select all collections");
    await userEvent.click(selectAll);
    expect(screen.getByLabelText("Select collection Alpha")).toBeChecked();
    expect(within(rowOf("Alpha")).getByRole("button", { name: "Actions menu" })).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Select collection Beta"));
    expect(selectAll).not.toBeChecked();
    expect(selectAll).toHaveProperty("indeterminate", true);
    await userEvent.click(selectAll);
    await userEvent.click(selectAll);
    expect(screen.queryByRole("button", { name: /Run selected/ })).not.toBeInTheDocument();
    await userEvent.click(selectAll);

    await userEvent.click(screen.getByRole("button", { name: "Run selected" }));
    expect(mockApi.runSelected).toHaveBeenCalledWith(["c1", "c2"]);
    expect(await screen.findByRole("alert")).toHaveTextContent('Collection "c2" skipped: invalid collection.');
    expect(screen.getByRole("button", { name: "Running selected…" })).toBeDisabled();
    await vi.waitFor(() => expect(mockApi.runStatus).toHaveBeenCalledWith("r1"));
    finishRun({ data: { status: "passed" } });
    await vi.waitFor(() => expect(mockApi.dashboard).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: /Run selected/ })).not.toBeInTheDocument());
  });

  it("refreshes when nothing was queued in bulk", async () => {
    mockApi.runSelected.mockResolvedValue({ data: {} });
    await renderApp();
    await userEvent.click(screen.getByLabelText("Select collection Alpha"));
    await userEvent.click(screen.getByRole("button", { name: "Run selected" }));
    await vi.waitFor(() => expect(mockApi.dashboard).toHaveBeenCalledTimes(2));
  });

  it("reports bulk run failures", async () => {
    mockApi.runSelected.mockRejectedValue("nope");
    await renderApp();
    await userEvent.click(screen.getByLabelText("Select collection Alpha"));
    await userEvent.click(screen.getByRole("button", { name: "Run selected" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to run selected collections.");
  });
});
