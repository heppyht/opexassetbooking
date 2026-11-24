/*───────────────────── Cryptographic Utilities ─────────────────────*/
/* Lightweight hash utilities for idempotency payload fingerprints.
   Uses Web Crypto SHA-256 in Cloudflare Workers.
   If SHA-256 is unavailable or fails, throws an error — fail closed.
   These are NOT cryptographically secure for secret handling — only for
   detecting payload changes in idempotency keys. */

/* Compute a deterministic SHA-256 hex fingerprint of a value.
   Uses Web Crypto API (crypto.subtle.digest) when available.
   Throws if SHA-256 is not available or fails — protected operations
   cannot proceed without a fingerprint. */
export async function computePayloadFingerprint(value: unknown): Promise<string> {
  const input = JSON.stringify(value);

  if (typeof crypto === "undefined" || typeof crypto.subtle !== "object" || typeof crypto.subtle.digest !== "function") {
    throw new Error("SHA256_UNAVAILABLE");
  }

  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    const bytes = Array.from(new Uint8Array(buf));
    return bytes.map(b => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    throw new Error(`SHA256_FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* Compute fingerprint synchronously (for testing contexts without async crypto).
   Uses Web Crypto SHA-256. Fails closed if unavailable. */
export function computePayloadFingerprintSync(): never {
  if (typeof crypto === "undefined" || typeof crypto.subtle !== "object" || typeof crypto.subtle.digest !== "function") {
    throw new Error("SHA256_UNAVAILABLE_SYNC");
  }

  /* Web Crypto SHA-256 is async-only; sync wrapper throws.
     Callers should use computePayloadFingerprint instead. */
  throw new Error("SHA256_UNAVAILABLE_SYNC");
}
