import { describe, expect, it } from "vitest";
import { createSecret, hashSecret, secretsEqual } from "./security.js";

describe("host and session secrets", () => {
  it("creates unique secrets", () => {
    expect(createSecret()).not.toBe(createSecret());
  });

  it("compares secrets by hash", () => {
    const secret = createSecret();
    expect(secretsEqual(secret, secret)).toBe(true);
    expect(secretsEqual(secret, createSecret())).toBe(false);
  });

  it("does not expose the original in the digest", () => {
    const secret = "host-token-value";
    expect(hashSecret(secret)).not.toContain(secret);
  });
});
