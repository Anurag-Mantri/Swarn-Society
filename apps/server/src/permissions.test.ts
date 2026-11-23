import { describe, expect, it } from "vitest";
import { allPermissions, defaultMemberPermissions, includesPermission, permissions } from "./permissions.js";

describe("server permissions", () => {
  it("grants a permission only when every requested bit is present", () => {
    expect(includesPermission(defaultMemberPermissions, permissions.readMessages)).toBe(true);
    expect(includesPermission(defaultMemberPermissions, permissions.manageRoles)).toBe(false);
    expect(includesPermission(defaultMemberPermissions, permissions.readMessages | permissions.sendMessages)).toBe(true);
  });

  it("includes every defined permission in the owner grant", () => {
    expect(Object.values(permissions).every((permission) => includesPermission(allPermissions, permission))).toBe(true);
  });
});
