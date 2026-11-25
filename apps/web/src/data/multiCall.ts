/*───────────────────── MultiCall Helper ─────────────────────*/
/* Batches independent, short MyGeotab read operations into a single
   ExecuteMultiCall round-trip.

   Geotab guidance: ExecuteMultiCall supports up to 100 nested requests, runs
   them independently (non-transactional), and returns results in request
   order. It must NOT be used for Add/Set/Remove or for large/long-running
   responses — this helper only issues "Get" calls.

   Robustness:
   - If ExecuteMultiCall is unavailable or fails, the helper falls back to
     individual Get calls so behavior is preserved on older runtimes/test mocks.
   - If the batched response is malformed (wrong length / not an array), it also
     falls back to individual calls.
   - Requests beyond the 100-nested limit are issued individually. */

export type MultiGetRequest = {
  typeName: string;
  resultsLimit?: number;
  search?: Record<string, unknown>;
};

export type GeotabCall = (
  method: string,
  params: Record<string, unknown>,
  success: (result: unknown) => void,
  error?: (error: unknown) => void,
) => void;

export const MAX_MULTI_CALL = 100;

function buildParams(req: MultiGetRequest): Record<string, unknown> {
  const params: Record<string, unknown> = { typeName: req.typeName };
  if (typeof req.resultsLimit === "number") params.resultsLimit = req.resultsLimit;
  if (req.search) params.search = req.search;
  return params;
}

function callOnce<T>(call: GeotabCall, method: string, params: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      call(method, params, (result) => resolve(result as T), (err) => reject(err ?? new Error("GEOTAB_API_ERROR")));
    } catch (e) {
      reject(e ?? new Error("GEOTAB_API_ERROR"));
    }
  });
}

async function individualGet<T>(call: GeotabCall, req: MultiGetRequest): Promise<T[] | null> {
  try {
    const result = await callOnce<unknown>(call, "Get", buildParams(req));
    return Array.isArray(result) ? (result as T[]) : null;
  } catch {
    return null;
  }
}

/* Execute independent Get requests, batched when safe.
   Returns an array of per-request results (each an array or null) in the
   original request order. */
export async function executeMultiGet<T>(
  call: GeotabCall | null | undefined,
  requests: MultiGetRequest[],
): Promise<Array<T[] | null>> {
  if (!call || requests.length === 0) {
    return requests.map(() => null);
  }

  // Too many to batch safely under the 100-nested limit: issue individually.
  if (requests.length > MAX_MULTI_CALL) {
    return Promise.all(requests.map((req) => individualGet<T>(call, req)));
  }

  try {
    const results = await callOnce<unknown>(call, "ExecuteMultiCall", {
      calls: requests.map((req) => ({ method: "Get", params: buildParams(req) })),
    });
    if (Array.isArray(results) && results.length === requests.length) {
      return results.map((r) => (Array.isArray(r) ? (r as T[]) : null));
    }
  } catch {
    // Fall through to individual calls below.
  }

  return Promise.all(requests.map((req) => individualGet<T>(call, req)));
}