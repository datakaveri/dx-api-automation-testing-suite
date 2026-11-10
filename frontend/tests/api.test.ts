import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kc = vi.hoisted(() => ({
  authenticated: true,
  token: "tok",
  updateToken: vi.fn(),
}));

vi.mock("../src/keycloak", () => ({
  keycloak: kc,
  keycloakReady: () => Promise.resolve(true),
}));

import { api, ApiError, apiUrl, extractFieldErrors, openAuthenticatedReport } from "../src/api";

const BASE = "http://api.test";

function respond(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
    blob: () => Promise.resolve(new Blob(["<html></html>"])),
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  kc.authenticated = true;
  kc.updateToken.mockResolvedValue(true);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiUrl", () => {
  it("prefixes the configured API base URL", () => {
    expect(apiUrl("/api/x")).toBe(`${BASE}/api/x`);
  });
});

describe("request via api", () => {
  it("sends the bearer token and returns JSON", async () => {
    fetchMock.mockResolvedValue(respond(200, { data: { collections: [] } }));
    await expect(api.dashboard()).resolves.toEqual({ data: { collections: [] } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/dashboard`);
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer tok");
    expect(kc.updateToken).toHaveBeenCalledWith(30);
  });

  it("refuses when the session has ended", async () => {
    kc.authenticated = false;
    await expect(api.me()).rejects.toThrow("Your Keycloak session has ended");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forces a token refresh and retries once on 401", async () => {
    fetchMock.mockResolvedValueOnce(respond(401, {})).mockResolvedValueOnce(respond(200, []));
    await expect(api.skipped()).resolves.toEqual([]);
    expect(kc.updateToken).toHaveBeenCalledWith(-1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws ApiError with nested error payload", async () => {
    const details = { fieldErrors: { interval: ["bad"] } };
    fetchMock.mockResolvedValue(respond(400, { error: { message: "Invalid", details } }));
    const error = await api.getAutoRerunSettings().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: "Invalid", status: 400, details });
  });

  it("throws ApiError with top-level message, or a default when there is no body", async () => {
    fetchMock.mockResolvedValueOnce(respond(500, { message: "Boom" }));
    await expect(api.runAll()).rejects.toThrow("Boom");
    fetchMock.mockResolvedValueOnce(respond(500, undefined));
    await expect(api.runAll()).rejects.toThrow("Request failed with status 500.");
  });

  it("does not retry 401 twice", async () => {
    fetchMock.mockResolvedValue(respond(401, { message: "Unauthorized" }));
    await expect(api.dashboard()).rejects.toThrow("Unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("builds every endpoint", async () => {
    fetchMock.mockResolvedValue(respond(200, {}));
    await api.result("a b");
    await api.history("a/b");
    await api.run("c1");
    await api.runStatus("r1");
    await api.runSelected(["c1", "c2"]);
    await api.saveAutoRerunSettings({ interval: "1h", recipients: ["qa@example.com"] });
    const calls = fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body]);
    expect(calls).toEqual([
      [`${BASE}/api/collections/a%20b/result`, undefined, undefined],
      [`${BASE}/api/collections/a%2Fb/history`, undefined, undefined],
      [`${BASE}/api/collections/c1/run`, "POST", undefined],
      [`${BASE}/api/runs/r1`, undefined, undefined],
      [`${BASE}/api/run-selected`, "POST", JSON.stringify({ collectionIds: ["c1", "c2"] })],
      [`${BASE}/api/settings/auto-rerun`, "PUT", JSON.stringify({ interval: "1h", recipients: ["qa@example.com"] })],
    ]);
  });
});

describe("extractFieldErrors", () => {
  it("returns empty for non-objects and missing field errors", () => {
    expect(extractFieldErrors(null)).toEqual({});
    expect(extractFieldErrors("oops")).toEqual({});
    expect(extractFieldErrors({})).toEqual({});
  });

  it("reads record-shaped field errors from ApiError", () => {
    const error = new ApiError("x", 400, { fieldErrors: { interval: "bad", recipients: ["a", "b"] } });
    expect(extractFieldErrors(error)).toEqual({ interval: ["bad"], recipients: ["a", "b"] });
  });

  it("reads list-shaped field errors from a raw payload and skips junk", () => {
    const payload = {
      error: {
        details: {
          fieldErrors: [
            { field: "recipients", message: "first" },
            { field: "recipients", message: "second" },
            { nope: true },
            null,
          ],
        },
      },
    };
    expect(extractFieldErrors(payload)).toEqual({ recipients: ["first", "second"] });
  });

  it("ignores non-string, non-array record values", () => {
    expect(extractFieldErrors({ details: { fieldErrors: { a: 1 } } })).toEqual({});
  });
});

describe("openAuthenticatedReport", () => {
  function fakeTab() {
    return { location: { href: "" } } as unknown as Window;
  }

  it("loads the report with auth and points the tab at a blob URL", async () => {
    const createObjectURL = vi.fn(() => "blob:report");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL }));
    fetchMock.mockResolvedValue(respond(200, {}));
    const tab = fakeTab();
    await openAuthenticatedReport("/api/runs/r1/report", tab);
    expect(fetchMock.mock.calls[0][0].toString()).toBe(`${BASE}/api/runs/r1/report`);
    expect(tab.location.href).toBe("blob:report");
  });

  it("rejects when signed out or pop-ups are blocked", async () => {
    kc.authenticated = false;
    await expect(openAuthenticatedReport("/r", fakeTab())).rejects.toThrow("Please sign in");
    kc.authenticated = true;
    await expect(openAuthenticatedReport("/r", null)).rejects.toThrow("Allow pop-ups");
  });

  it("rejects report URLs outside the API origin", async () => {
    await expect(openAuthenticatedReport("https://evil.example.com/r", fakeTab())).rejects.toThrow("outside the configured API origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains failed report loads", async () => {
    fetchMock.mockResolvedValueOnce(respond(401, {}));
    await expect(openAuthenticatedReport("/r", fakeTab())).rejects.toThrow("no longer valid");
    fetchMock.mockResolvedValueOnce(respond(500, {}));
    await expect(openAuthenticatedReport("/r", fakeTab())).rejects.toThrow("Could not load this report.");
  });
});
