import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginPage } from "../src/LoginPage";

describe("LoginPage", () => {
  it("calls onLogin and shows no error by default", async () => {
    const onLogin = vi.fn();
    render(<LoginPage onLogin={onLogin} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign in with Keycloak" }));
    expect(onLogin).toHaveBeenCalledOnce();
  });

  it("shows the error", () => {
    render(<LoginPage onLogin={vi.fn()} error="Nope" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Nope");
  });
});
