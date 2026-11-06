import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Drawer } from "../src/Drawer";
import { makeCollection, makeExecution, makeResult } from "./fixtures";

const executions = [
  makeExecution({ name: "List users", folder: "Users", method: "GET" }),
  makeExecution({
    name: "Create user",
    folder: "Users",
    method: "POST",
    statusCode: 500,
    failed: true,
    assertions: [{ name: "Status is 201", passed: false, errorMessage: "expected 201 got 500" }],
  }),
  makeExecution({ name: "Health", folder: null, method: "GET", statusCode: null, requestError: "ECONNREFUSED", assertions: [] }),
  makeExecution({ name: "Delete order", folder: "Orders", method: "DELETE" }),
];

function renderDrawer(props: Partial<Parameters<typeof Drawer>[0]> = {}) {
  const onClose = vi.fn();
  render(<Drawer collection={makeCollection()} result={makeResult(executions)} loading={false} onClose={onClose} {...props} />);
  return onClose;
}

function visibleNames() {
  return ["List users", "Create user", "Health", "Delete order"].filter((name) => screen.queryAllByText(name).length > 0);
}

afterEach(() => vi.restoreAllMocks());

describe("Drawer", () => {
  it("shows loading and empty states", () => {
    const { unmount } = render(<Drawer collection={makeCollection()} result={null} loading onClose={vi.fn()} />);
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    unmount();
    renderDrawer({ result: null });
    expect(screen.getByText("No execution data available yet")).toBeInTheDocument();
  });

  it("groups executions by folder with root requests last", () => {
    renderDrawer();
    expect(visibleNames()).toEqual(["List users", "Create user", "Health", "Delete order"]);
    const names = screen.getAllByText(/^(List users|Create user|Health|Delete order)$/).map((el) => el.textContent);
    expect(names).toEqual(["List users", "Create user", "Delete order", "Health"]);
    expect(screen.getAllByText("No response").length).toBeGreaterThan(0);
    expect(screen.getByText(/expected 201 got 500/)).toBeInTheDocument();
  });

  it("filters by folder, status, method and search", async () => {
    renderDrawer();
    await userEvent.click(screen.getByRole("button", { name: /^Orders/ }));
    expect(visibleNames()).toEqual(["Delete order"]);
    await userEvent.click(screen.getByRole("button", { name: /^All folders/ }));

    const [statusSelect, methodSelect] = screen.getAllByRole("combobox");
    await userEvent.selectOptions(statusSelect, "failed");
    expect(visibleNames()).toEqual(["Create user"]);
    await userEvent.selectOptions(statusSelect, "passed");
    expect(visibleNames()).not.toContain("Create user");
    await userEvent.selectOptions(statusSelect, "all");

    await userEvent.selectOptions(methodSelect, "DELETE");
    expect(visibleNames()).toEqual(["Delete order"]);
    await userEvent.selectOptions(methodSelect, "all");

    await userEvent.type(screen.getByPlaceholderText("Search endpoint name or URL"), "health");
    expect(visibleNames()).toEqual(["Health"]);
    await userEvent.clear(screen.getByPlaceholderText("Search endpoint name or URL"));
    await userEvent.type(screen.getByPlaceholderText("Search endpoint name or URL"), "nothing-matches");
    expect(visibleNames()).toEqual([]);
  });

  it("switches to the table view", async () => {
    renderDrawer();
    await userEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(visibleNames()).toHaveLength(4);
    await userEvent.click(screen.getByRole("button", { name: "Cards" }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("opens the Newman report and closes via Back or Escape", async () => {
    const open = vi.spyOn(globalThis, "open").mockReturnValue(null);
    const onClose = renderDrawer();
    await userEvent.click(screen.getByRole("button", { name: /View Newman report/ }));
    expect(open).toHaveBeenCalledWith("http://api.test/api/collections/c1/report", "_blank", "noopener,noreferrer");
    await userEvent.click(screen.getByRole("button", { name: /Back/ }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("scrolls to the top of the page from the bottom button", async () => {
    globalThis.scrollTo = vi.fn();
    renderDrawer();
    await userEvent.click(screen.getByRole("button", { name: "Go to top" }));
    expect(globalThis.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    expect(screen.getByRole("button", { name: /Back/ })).toHaveFocus();
  });

  it("hides the go to top button when there are no endpoints to show", () => {
    renderDrawer({ result: null });
    expect(screen.queryByRole("button", { name: "Go to top" })).not.toBeInTheDocument();
  });

  it("falls back to collection API count without results", () => {
    renderDrawer({ result: null, collection: makeCollection({ apiCount: 0 }) });
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
