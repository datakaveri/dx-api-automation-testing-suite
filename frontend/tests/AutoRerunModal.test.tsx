import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutoRerunModal } from "../src/AutoRerunModal";
import { toast } from "../src/Toast";

const mockApi = vi.hoisted(() => ({
  getAutoRerunSettings: vi.fn(),
  saveAutoRerunSettings: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  api: mockApi,
}));

import { ApiError } from "../src/api";

beforeEach(() => {
  mockApi.getAutoRerunSettings.mockResolvedValue({ data: { interval: "24h", recipients: ["lead@example.com"] } });
  mockApi.saveAutoRerunSettings.mockImplementation((settings) => Promise.resolve({ data: settings }));
});

afterEach(() => {
  vi.restoreAllMocks();
  mockApi.getAutoRerunSettings.mockReset();
  mockApi.saveAutoRerunSettings.mockReset();
});

async function renderModal() {
  const onClose = vi.fn();
  render(<AutoRerunModal onClose={onClose} />);
  await screen.findByLabelText("Re-run Interval");
  return onClose;
}

const emailInput = () => screen.getByLabelText("QA Email Recipients");
const submit = () => fireEvent.submit(document.getElementById("auto-rerun-form")!);

describe("AutoRerunModal", () => {
  it("loads saved settings", async () => {
    await renderModal();
    expect(screen.getByLabelText("Re-run Interval")).toHaveValue("24h");
    expect(screen.getByText("lead@example.com")).toBeInTheDocument();
    expect(screen.getByText("1 configured")).toBeInTheDocument();
  });

  it("falls back to defaults for unknown or flat payloads", async () => {
    mockApi.getAutoRerunSettings.mockResolvedValue({ interval: "weekly" });
    await renderModal();
    expect(screen.getByLabelText("Re-run Interval")).toHaveValue("off");
    expect(screen.getByText(/No recipients added yet/)).toBeInTheDocument();
  });

  it("shows a load error and retries", async () => {
    mockApi.getAutoRerunSettings.mockRejectedValueOnce(new Error("Server down")).mockRejectedValueOnce("weird");
    render(<AutoRerunModal onClose={vi.fn()} />);
    expect(await screen.findByText("Server down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save Settings/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Failed to load auto re-run settings.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Re-run Interval")).toBeInTheDocument();
  });

  it("validates new recipients", async () => {
    await renderModal();
    const add = screen.getByRole("button", { name: "Add" });
    await userEvent.click(add);
    expect(screen.getByText("Please enter an email address.")).toBeInTheDocument();
    await userEvent.type(emailInput(), "not-an-email");
    expect(screen.queryByText("Please enter an email address.")).not.toBeInTheDocument();
    await userEvent.click(add);
    expect(screen.getByText(/Please enter a valid email address/)).toBeInTheDocument();
    await userEvent.clear(emailInput());
    await userEvent.type(emailInput(), "LEAD@example.com");
    await userEvent.click(add);
    expect(screen.getByText("This email address is already added.")).toBeInTheDocument();
  });

  it("adds with Enter and removes recipients", async () => {
    await renderModal();
    await userEvent.type(emailInput(), "dev@example.com{Enter}");
    expect(screen.getByText("dev@example.com")).toBeInTheDocument();
    expect(emailInput()).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "Remove recipient lead@example.com" }));
    expect(screen.queryByText("lead@example.com")).not.toBeInTheDocument();
  });

  it("requires a recipient before saving", async () => {
    const error = vi.spyOn(toast, "error");
    await renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Remove recipient lead@example.com" }));
    submit();
    expect(await screen.findByText("At least one valid recipient is required before saving.")).toBeInTheDocument();
    expect(error).toHaveBeenCalled();
    expect(mockApi.saveAutoRerunSettings).not.toHaveBeenCalled();
    await userEvent.type(emailInput(), "a@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByText("At least one valid recipient is required before saving.")).not.toBeInTheDocument();
  });

  it("saves the interval and auto-adds a typed email", async () => {
    const success = vi.spyOn(toast, "success");
    await renderModal();
    await userEvent.selectOptions(screen.getByLabelText("Re-run Interval"), "off");
    await userEvent.type(emailInput(), "typed@example.com");
    submit();
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith("Auto re-run settings saved successfully."));
    expect(mockApi.saveAutoRerunSettings).toHaveBeenCalledWith({
      interval: "off",
      recipients: ["lead@example.com", "typed@example.com"],
    });
    expect(screen.getByText("typed@example.com")).toBeInTheDocument();
  });

  it("does not duplicate a typed email that is already a recipient", async () => {
    await renderModal();
    await userEvent.type(emailInput(), "lead@example.com");
    submit();
    await vi.waitFor(() =>
      expect(mockApi.saveAutoRerunSettings).toHaveBeenCalledWith({ interval: "24h", recipients: ["lead@example.com"] }),
    );
  });

  it("shows server field errors on save failure", async () => {
    const error = vi.spyOn(toast, "error");
    mockApi.saveAutoRerunSettings.mockRejectedValue(
      new ApiError("Validation failed", 400, { fieldErrors: { interval: ["Bad interval"], recipients: ["Bad email"] } }),
    );
    await renderModal();
    submit();
    expect(await screen.findByText("Bad interval")).toBeInTheDocument();
    expect(screen.getByText("Bad email")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Validation failed");
    expect(error).toHaveBeenCalledWith("Validation failed: Bad interval, Bad email");
    await userEvent.selectOptions(screen.getByLabelText("Re-run Interval"), "off");
    expect(screen.queryByText("Bad interval")).not.toBeInTheDocument();
  });

  it("uses a generic message for unknown save errors", async () => {
    const error = vi.spyOn(toast, "error");
    mockApi.saveAutoRerunSettings.mockRejectedValue("weird");
    await renderModal();
    submit();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Failed to save auto re-run settings."));
  });

  it("closes via Close, Cancel, backdrop and Escape", async () => {
    const onClose = await renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(4);
  });
});
