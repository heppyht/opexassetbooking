/*───────────────────── Cryptographic Utilities ─────────────────────*/
/* Lightweight hash utilities for idempotency payload fingerprints.
   Uses Web Crypto SHA-256 in Cloudflare Workers.
   If SHA-256 is unavailable or fails, throws an error — fail closed.
   These are NOT cryptographically secure for secret handling — only for
   detecting payload changes in idempotency keys.

   Fingerprint format: "v1:" + hex(SHA-256(canonicalize(value)))
   - "v1:" is a serialization-version prefix. Old fingerprints stored without
     this prefix will not match newly computed fingerprints, so previously
     stored idempotency records are treated as new keys (no false conflict,
     but also no deduplication against them). This is intentional: changing
     the canonicalization algorithm must not silently reinterpret old
     fingerprints.
   - canonicalize() produces deterministic output regardless of object key
     insertion order, so semantically identical payloads always yield the
     same fingerprint. */

const FINGERPRINT_VERSION = "v1";

/* Recursively serialize a JSON-compatible value into a deterministic string.
   Object keys are sorted lexicographically; array element order is preserved.
   Supports: null, boolean, number, string, arrays, plain objects.
   Throws for unsupported values (functions, symbols, BigInt, undefined,
   Date, Map, Set, etc.) rather than producing ambiguous output. */
function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value === Infinity ? "Infinity" : "-Infinity";
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    /* Reject non-plain objects (Date, Map, Set, class instances, etc.). */
    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype) {
      throw new Error(`CANONICALIZE_UNSUPPORTED_OBJECT: ${Object.prototype.toString.call(value)}`);
    }
    const keys = Object.keys(obj).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  /* undefined, function, symbol, bigint, etc. — explicitly rejected. */
  throw new Error(`CANONICALIZE_UNKNOWN_TYPE: ${typeof value}`);
}

/* Compute a deterministic SHA-256 hex fingerprint of a value.
   Uses Web Crypto API (crypto.subtle.digest) when available.
   Throws if SHA-256 is not available or fails — protected operations
   cannot proceed without a fingerprint.

   The fingerprint is versioned ("v1:") so that changes to the canonicalization
   algorithm never silently reinterpret previously stored fingerprints. */
export async function computePayloadFingerprint(value: unknown): Promise<string> {
  let input: string;
  try {
    input = canonicalize(value);
  } catch (e) {
    throw new Error(`CANONICALIZE_FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (typeof crypto === "undefined" || typeof crypto.subtle !== "object" || typeof crypto.subtle.digest !== "function") {
    throw new Error("SHA256_UNAVAILABLE");
  }

  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    const bytes = Array.from(new Uint8Array(buf));
    return `${FINGERPRINT_VERSION}:${bytes.map(b => b.toString(16).padStart(2, "0")).join("")}`;
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

/* Expose canonicalize for testing. */
export { canonicalize };
