import { describe, expect, it, vi } from "vitest";
import type Keycloak from "keycloak-js";
import type { KeycloakTokenParsed } from "keycloak-js";
import { extractRolesFromAccess, hasQaAdminRole, isMatchingAdminRole, isMatchingQaAdminRole, isUserAdmin } from "../src/auth";

function fakeKeycloak(overrides: Partial<Keycloak>): Keycloak {
  return { authenticated: true, hasRealmRole: vi.fn(() => false), hasResourceRole: vi.fn(() => false), ...overrides } as unknown as Keycloak;
}

describe("isMatchingQaAdminRole", () => {
  it.each(["qa_admin", " QA_ADMIN ", "frontend-client:qa_admin", "/qa_admin", "//qa_admin"])("accepts %s", (role) => {
    expect(isMatchingQaAdminRole(role)).toBe(true);
  });

  it.each([42, null, "admin", "cos_admin", "client:admin", "/admin", "qa_admin_extra"])("rejects %s", (role) => {
    expect(isMatchingQaAdminRole(role)).toBe(false);
  });

  it("is aliased as isMatchingAdminRole", () => {
    expect(isMatchingAdminRole).toBe(isMatchingQaAdminRole);
  });
});

describe("extractRolesFromAccess", () => {
  it("handles arrays, role objects and junk", () => {
    expect(extractRolesFromAccess(["a", 1, "b"])).toEqual(["a", "b"]);
    expect(extractRolesFromAccess({ roles: ["x", null] })).toEqual(["x"]);
    expect(extractRolesFromAccess({ roles: "x" })).toEqual([]);
    expect(extractRolesFromAccess(null)).toEqual([]);
    expect(extractRolesFromAccess("qa_admin")).toEqual([]);
  });
});

describe("hasQaAdminRole", () => {
  it("returns false with no inputs", () => {
    expect(hasQaAdminRole()).toBe(false);
    expect(hasQaAdminRole(null, null, null)).toBe(false);
  });

  it("uses keycloak realm role check", () => {
    expect(hasQaAdminRole(null, null, fakeKeycloak({ hasRealmRole: vi.fn(() => true) }))).toBe(true);
  });

  it("uses keycloak resource role check for default and each client", () => {
    const hasResourceRole = vi.fn((_role: string, client?: string) => client === "frontend");
    const token = { resource_access: { other: { roles: [] }, frontend: { roles: [] } } } as KeycloakTokenParsed;
    expect(hasQaAdminRole(token, null, fakeKeycloak({ hasResourceRole }))).toBe(true);
    expect(hasResourceRole).toHaveBeenCalledWith("qa_admin", undefined);
  });

  it("ignores keycloak instance when unauthenticated or methods are missing", () => {
    expect(hasQaAdminRole(null, null, fakeKeycloak({ authenticated: false, hasRealmRole: vi.fn(() => true) }))).toBe(false);
    expect(hasQaAdminRole(null, null, { authenticated: true } as Keycloak)).toBe(false);
  });

  it("checks realm roles from user roles and token", () => {
    expect(hasQaAdminRole(null, { realm: ["qa_admin"], clients: {}, groups: [] })).toBe(true);
    expect(hasQaAdminRole({ realm_access: { roles: ["qa_admin"] } } as KeycloakTokenParsed)).toBe(true);
    expect(hasQaAdminRole({ roles: ["qa_admin"] } as KeycloakTokenParsed)).toBe(true);
  });

  it("checks client roles from user roles and token", () => {
    expect(hasQaAdminRole(null, { realm: [], clients: { web: { roles: ["qa_admin"] } }, groups: [] })).toBe(true);
    expect(hasQaAdminRole({ resource_access: { web: { roles: ["qa_admin"] } } } as KeycloakTokenParsed)).toBe(true);
    expect(hasQaAdminRole({ resource_access: { web: { roles: ["cos_admin"] } } } as KeycloakTokenParsed)).toBe(false);
  });
});

describe("isUserAdmin", () => {
  it("delegates to role claims only", () => {
    expect(isUserAdmin("qa_admin", null, null, null, "qa_admin")).toBe(false);
    expect(isUserAdmin(null, { realm: ["qa_admin"], clients: {}, groups: [] })).toBe(true);
  });
});
