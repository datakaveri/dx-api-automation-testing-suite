import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistoryModal } from "../src/HistoryModal";
import { makeCollection, makeHistoryRun } from "./fixtures";

const openAuthenticatedReport = vi.hoisted(() => vi.fn());
vi.mock("../src/api", () => ({ openAuthenticatedReport }));

afterEach(() => {
  vi.restoreAllMocks();
  openAuthenticatedReport.mockReset();
});

function renderModal(props: Partial<Parameters<typeof HistoryModal>[0]> = {}) {
  const onClose = vi.fn();
  render(<HistoryModal collection={makeCollection()} history={[]} loading={false} onClose={onClose} {...props} />);
  return onClose;
}

describe("HistoryModal", () => {
  it("shows loading and empty states", () => {
    const { unmount } = render(<HistoryModal collection={makeCollection()} history={[]} loading onClose={vi.fn()} />);
    expect(screen.getByText("Loading test execution history…")).toBeInTheDocument();
    unmount();
    renderModal();
    expect(screen.getByText("No history records found yet")).toBeInTheDocument();
  });

  it("lists runs with the newest marked latest", () => {
    renderModal({ history: [makeHistoryRun({ runId: "r2", runNumber: 2 }), makeHistoryRun({ runId: "r1", runNumber: 1, status: "failed" })] });
    expect(screen.getByRole("dialog", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByText(/Run #2/)).toHaveTextContent("(Latest)");
    expect(screen.getByText(/Run #1/)).not.toHaveTextContent("(Latest)");
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("closes via Close, backdrop and Escape", async () => {
    const onClose = renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("opens the report in a new tab", async () => {
    const tab = { opener: {}, close: vi.fn() };
    vi.spyOn(globalThis, "open").mockReturnValue(tab as unknown as Window);
    openAuthenticatedReport.mockResolvedValue(undefined);
    renderModal({ history: [makeHistoryRun()] });
    await userEvent.click(screen.getByRole("button", { name: "Newman Report" }));
    expect(tab.opener).toBeNull();
    expect(openAuthenticatedReport).toHaveBeenCalledWith("/api/runs/r1/report", tab);
  });

  it("closes the tab and alerts when the report fails", async () => {
    const tab = { opener: {}, close: vi.fn() };
    vi.spyOn(globalThis, "open").mockReturnValue(tab as unknown as Window);
    const alert = vi.spyOn(globalThis, "alert").mockImplementation(() => {});
    openAuthenticatedReport.mockRejectedValueOnce(new Error("Denied")).mockRejectedValueOnce("weird");
    renderModal({ history: [makeHistoryRun()] });
    const button = screen.getByRole("button", { name: "Newman Report" });
    await userEvent.click(button);
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith("Denied"));
    await userEvent.click(button);
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith("Could not open this report."));
    expect(tab.close).toHaveBeenCalledTimes(2);
  });
});
