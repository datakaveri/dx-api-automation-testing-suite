import { afterEach, describe, expect, it, vi } from "vitest";

const instances = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("keycloak-js", () => ({
  default: vi.fn(function (this: Record<string, unknown>, config: unknown) {
    Object.assign(this, {
      config,
      init: vi.fn(() => Promise.resolve(true)),
      updateToken: vi.fn(() => Promise.reject(new Error("expired"))),
      logout: vi.fn(() => Promise.resolve()),
    });
    instances.push(this);
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  instances.length = 0;
});

describe("keycloak", () => {
  it("is disabled when env is not configured", async () => {
    vi.stubEnv("VITE_KEYCLOAK_URL", "");
    const mod = await import("../src/keycloak");
    expect(mod.keycloakConfigured).toBe(false);
    expect(mod.keycloak).toBeNull();
    await expect(mod.initializeKeycloak()).resolves.toBe(false);
    await expect(mod.keycloakReady()).resolves.toBe(false);
  });

  it("initialises with PKCE and logs out when token refresh fails", async () => {
    vi.stubEnv("VITE_KEYCLOAK_URL", "https://kc.example.com");
    vi.stubEnv("VITE_KEYCLOAK_REALM", "iudx");
    vi.stubEnv("VITE_KEYCLOAK_CLIENT_ID", "qa");
    const mod = await import("../src/keycloak");
    expect(mod.keycloakConfigured).toBe(true);

    const ready = mod.initializeKeycloak();
    await expect(ready).resolves.toBe(true);
    expect(mod.keycloakReady()).toBe(ready);

    const kc = instances[0] as { config: unknown; init: ReturnType<typeof vi.fn>; onTokenExpired: () => void; logout: ReturnType<typeof vi.fn> };
    expect(kc.config).toEqual({ url: "https://kc.example.com", realm: "iudx", clientId: "qa" });
    expect(kc.init).toHaveBeenCalledWith({ onLoad: "check-sso", pkceMethod: "S256", checkLoginIframe: false });

    kc.onTokenExpired();
    await vi.waitFor(() => expect(kc.logout).toHaveBeenCalledWith({ redirectUri: globalThis.location.origin }));
  });
});
