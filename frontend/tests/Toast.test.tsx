import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast, ToastContainer } from "../src/Toast";

afterEach(() => {
  act(() => toast.clear());
  vi.useRealTimers();
});

describe("Toast", () => {
  it("renders nothing without toasts", () => {
    render(<ToastContainer />);
    expect(document.getElementById("toast-container")).toBeNull();
  });

  it("renders each toast type with the right role", () => {
    render(<ToastContainer />);
    act(() => {
      toast.success("Saved");
      toast.error("Failed");
      toast.info("FYI");
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
    const statuses = screen.getAllByRole("status");
    expect(statuses.map((s) => s.textContent)).toEqual(["Saved", "FYI"]);
    expect(statuses[0].className).toContain("emerald");
    expect(statuses[1].className).toContain("sky");
  });

  it("dismisses on click", async () => {
    render(<ToastContainer />);
    act(() => {
      toast.info("Bye", 0);
    });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Bye")).not.toBeInTheDocument();
  });

  it("auto-dismisses after the duration", () => {
    vi.useFakeTimers();
    render(<ToastContainer />);
    act(() => {
      toast.success("Soon gone", 1000);
    });
    expect(screen.getByText("Soon gone")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText("Soon gone")).not.toBeInTheDocument();
  });

  it("clear removes every toast and dismissing an unknown id is safe", () => {
    render(<ToastContainer />);
    act(() => {
      toast.error("One");
      toast.error("Two");
    });
    act(() => toast.dismiss("unknown"));
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    act(() => toast.clear());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
