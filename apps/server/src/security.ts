import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function secretsEqual(left: string, right: string): boolean {
  const leftHash = Buffer.from(hashSecret(left));
  const rightHash = Buffer.from(hashSecret(right));
  return leftHash.length === rightHash.length && timingSafeEqual(leftHash, rightHash);
}
