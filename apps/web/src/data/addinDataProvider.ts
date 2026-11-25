/*───────────────────── MyGeotab AddInData Booking Provider ─────────────────────*/
/* Booking transactions stored in MyGeotab AddInData.
   One AddInData record per booking. details = JSON-compatible object (max 10,000 serialized chars).
   Master data (devices/users/groups) loaded live from MyGeotab Get calls.
   No localStorage, no external database, no PostgreSQL/Neon/Cloudflare. */

import type {
  MyGeotabGroup,
  MyGeotabStatusData,
  MyGeotabLogRecord,
  OpexBooking,
  OpexVehicleHold,
  ResolvedAsset,
  ResolvedBooking,
  ResolvedUser,
  BookingDataProvider,
  NotificationDataProvider,
  OpexNotification,
  OpexBookingAudit,
  OpexBookingAuditV2,
  OpexAuditPending,
  OpexAuditDeadLetter,
  NotificationType,
  RecordType,
  CanonicalAuditInput,
  NormalizedAuditEvent,
} from "./types";
import { SCHEMA_VERSION, generateBusinessId } from "./types.ts";
import { isValidAddInId } from "../config/addinId.ts";
import { validateResolvedBooking } from "./bookingValidation.ts";
import { buildBookingAuditEvent, deserializeBookingAudit, generateCanonicalAuditKey, normalizeAuditRecord } from "./auditEvent.ts";
import { RequestCache } from "./requestCache.ts";
import { executeMultiGet, type MultiGetRequest } from "./multiCall.ts";
import type { ServerAuthzClient } from "../auth/serverAuthzClient";
import type { ServerAuthzSessionCreds } from "../auth/serverAuthzClient";

/*───────────────────── Geotab API type (Add-In context) ─────────────────────*/

type GeotabApi = {
  call?: (method: string, params: Record<string, unknown>, success: (result: unknown) => void, error?: (error: unknown) => void) => void;
  getSession?: (callback: (session: { userName?: string; database?: string; server?: string } | null) => void) => void;
};

const MAX_DETAILS_CHARS = 10000;
const DEFAULT_GROUP_ID = "GroupCompanyId";
const MAX_RETRIES = 5;

/*───────────────────── Canonical status → Worker action contract ─────────────────────*/
/* The Cloudflare Worker's ACTION_REQUIRED_ROLE (apps/api/src/authz.ts) is the
   single source of truth for protected action names. The frontend MUST send
   these exact literals to /authz/execute; any other string is rejected by the
   Worker with UNKNOWN_ACTION (403). This map translates a target booking status
   into the canonical action. Unknown statuses fail closed (no write). */
const STATUS_TO_ACTION: Record<string, string> = {
  APPROVED: "approve_booking",
  REJECTED: "reject_booking",
  CANCELLED: "cancel_booking",
  COMPLETED: "complete_booking",
  ASSIGNED: "assign_driver",
};

/*───────────────────── Query bounds & cache TTLs ─────────────────────*/
/* Explicit, bounded result limits prevent unbounded AddInData reads.
   Master data is cached longer (rarely changes); AddInData query results use
   a short TTL and are invalidated after any write.
   AddInData does not support server pagination, so resultsLimit is a safety
   ceiling (not a page size) that bounds worst-case payload/memory. */
const MASTER_DATA_LIMIT = 1000;
const MASTER_DATA_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RECORDS_CACHE_TTL_MS = 10 * 1000; // 10 seconds
const ADDIN_DATA_QUERY_LIMIT = 2000;
const BOOKING_QUERY_LIMIT = 1000;
const NOTIFICATION_QUERY_LIMIT = 1000;
const AUDIT_QUERY_LIMIT = 500;
const DEAD_LETTER_QUERY_LIMIT = 500;

function nextRetryAt(retryCount: number): string {
  return new Date(Date.now() + Math.min(1000 * 2 ** retryCount, 30000)).toISOString();
}

type AddInDataDetails = string | Record<string, unknown>;

/*───────────────────── Diagnostic Logging ─────────────────────*/
/* Safe diagnostic logging for MyGeotab API lifecycle.
   Never logs session tokens, credentials, AddInId values, or personal data. */
function diagLog(message: string, detail?: unknown): void {
  try {
    if (typeof console !== "undefined" && console.log) {
      const detailStr = detail !== undefined ? ` | detail=${String(detail).slice(0, 100)}` : "";
      console.log(`[OPEX-VBM-AddInData] ${message}${detailStr}`);
    }
  } catch {
    // Logging must never throw
  }
}
const NOTIFICATION_GROUP_ID = DEFAULT_GROUP_ID;
const AUDIT_GROUP_ID = DEFAULT_GROUP_ID;
const AUDIT_PENDING_GROUP_ID = DEFAULT_GROUP_ID;
const AUDIT_DEAD_LETTER_GROUP_ID = DEFAULT_GROUP_ID;

function assertDetailsWithinLimit(value: unknown): void {
  const json = JSON.stringify(value);
  if (json.length > MAX_DETAILS_CHARS) {
    throw new Error(`ADDIN_DATA_DETAILS_EXCEEDED: ${json.length} characters (max ${MAX_DETAILS_CHARS})`);
  }
}

function toDetailsObject<T extends object>(details: AddInDataDetails): T {
  return (typeof details === "string" ? JSON.parse(details) : details) as T;
}

function safeParse(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") return JSON.parse(value);
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return undefined;
}

function serializeNotification(n: OpexNotification): OpexNotification {
  assertDetailsWithinLimit(n);
  return n;
}
function deserializeNotification(details: AddInDataDetails): OpexNotification {
  return normalizeNotification(toDetailsObject<OpexNotification>(details));
}
function serializeAudit(a: OpexBookingAudit): OpexBookingAudit {
  assertDetailsWithinLimit(a);
  return a;
}
function deserializeAudit(details: AddInDataDetails): OpexBookingAudit {
  return normalizeAudit(toDetailsObject<OpexBookingAudit>(details));
}
function serializeAuditPending(p: OpexAuditPending): OpexAuditPending {
  assertDetailsWithinLimit(p);
  return p;
}
function deserializeAuditPending(details: AddInDataDetails): OpexAuditPending {
  return toDetailsObject<OpexAuditPending>(details);
}
function serializeAuditDeadLetter(p: OpexAuditDeadLetter): OpexAuditDeadLetter {
  assertDetailsWithinLimit(p);
  return p;
}
function deserializeAuditDeadLetter(details: AddInDataDetails): OpexAuditDeadLetter {
  return toDetailsObject<OpexAuditDeadLetter>(details);
}

/*───────────────────── Raw MyGeotab record shapes ─────────────────────*/

type RawMyGeotabDevice = {
  id: string;
  name?: string;
  serialNumber?: string;
  licensePlate?: string;
  make?: string;
  model?: string;
  vehicleClass?: string;
  groupIds?: string[];
  status?: string;
};

type RawMyGeotabUser = {
  id: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  companyGroups?: string[];
  role?: string;
  siteCode?: string;
};

type RawMyGeotabGroup = {
  id: string;
  name: string;
  parentId?: string;
};

type AddInDataRecord = {
  id: string;
  addInId: string;
  details: AddInDataDetails;
  groups?: Array<{ id: string }>;
  dateTime?: string;
};

/*───────────────────── Mapping helpers ─────────────────────*/

function mapLiveAsset(raw: RawMyGeotabDevice): ResolvedAsset {
  return {
    id: raw.id,
    asset_code: `VEH-${raw.id.slice(-3).toUpperCase()}`,
    asset_name: parseVehicleName(raw.name ?? ""),
    serial_number: raw.serialNumber ?? null,
    make_model: `${raw.make ?? "Unknown"} ${raw.model ?? "Asset"}`,
    asset_class: raw.vehicleClass ?? "OPERATIONAL_4X4",
    registration_no: raw.licensePlate ?? null,
    status: raw.status ?? "AVAILABLE",
    geotab_device_id: raw.id,
  };
}

/*───────────────────── Vehicle name parsing ─────────────────────*/
/* MyGeotab Add-In device names follow the pattern:
   "<license_plate>_<make> <model>[_<variant>]"

   Example: "AD 1283 VO_Honda Brio_Andri" → "Honda Brio - Andri"
   Example: "Toyota Fortuner #01"      → "Toyota Fortuner #01" (no underscore)

   The parsing rule:
   - Split on "_"
   - First segment is the license plate prefix (discarded)
   - Remaining segments form the vehicle name
   - If 2+ segments remain: join first n-1 with spaces, then " - " + last
   - If 1 segment remains: use as-is
   - If no underscore: use the whole name as-is
   */
function parseVehicleName(rawName: string): string {
  if (!rawName || rawName.trim() === "") {
    return "Unknown Vehicle";
  }

  const parts = rawName.split("_");
  if (parts.length <= 1) {
    return rawName.trim();
  }

  // Everything after the first underscore is the vehicle name
  const nameParts = parts.slice(1);

  if (nameParts.length === 1) {
    return nameParts[0].trim();
  }

  // Multiple parts: join all but last with spaces, then " - " + last
  const prefix = nameParts.slice(0, -1).join(" ").trim();
  const suffix = nameParts[nameParts.length - 1].trim();
  return `${prefix} - ${suffix}`;
}

function mapLiveUser(raw: RawMyGeotabUser): ResolvedUser {
  return {
    id: raw.id,
    name: raw.name || "Unknown",
    roles: raw.role ? [raw.role] : ["EMPLOYEE"],
    companyGroups: raw.companyGroups ?? [],
  };
}

function mapLiveGroup(raw: RawMyGeotabGroup): MyGeotabGroup {
  return {
    id: raw.id,
    name: raw.name,
    parentId: raw.parentId,
  };
}

/*───────────────────── Booking serialization (10,000-char limit) ─────────────────────*/

function serializeBooking(booking: OpexBooking): OpexBooking {
  assertDetailsWithinLimit(booking);
  return booking;
}
function deserializeBooking(details: AddInDataDetails): OpexBooking {
  return normalizeBooking(toDetailsObject<OpexBooking>(details));
}

/*───────────────────── Legacy schema normalization ─────────────────────*/
/* Ensures legacy AddInData records (written before recordType/schemaVersion
   existed) are normalized on read so downstream code can rely on those
   fields being present. Does not mutate the stored record. */

function normalizeBooking(b: OpexBooking): OpexBooking {
  if (b.recordType) return b;
  return { ...b, recordType: "booking", schemaVersion: SCHEMA_VERSION };
}

function normalizeNotification(n: OpexNotification): OpexNotification {
  if (n.recordType) return n;
  return { ...n, recordType: "notification", schemaVersion: SCHEMA_VERSION };
}

function normalizeAudit(a: OpexBookingAudit): OpexBookingAudit {
  if (a.recordType) return a;
  return { ...a, recordType: "booking_audit", schemaVersion: SCHEMA_VERSION };
}

/*───────────────────── Conflict check helper ─────────────────────*/

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/*───────────────────── Classify record type ─────────────────────*/
/* Classify a raw AddInData record's logical type. Prefers an explicit
   details.recordType; for legacy records that predate recordType it infers the
   type from the record's shape so existing data remains visible. Returns
   undefined when the type cannot be determined (e.g., malformed details). */
export function classifyRecordType(details: AddInDataDetails | undefined): RecordType | undefined {
  const obj = safeParse(details ?? undefined);
  if (!obj || typeof obj !== "object") return undefined;
  const rt = obj.recordType;
  if (
    rt === "booking" ||
    rt === "booking_audit" ||
    rt === "bookingAudit" ||
    rt === "notification" ||
    rt === "audit_dead_letter" ||
    rt === "reconciliation_finding" ||
    rt === "vehicle_hold"
  ) {
    return rt;
  }
  /* Legacy inference (no explicit recordType) — by structural shape. */
  if ("dead_lettered_at" in obj) return "audit_dead_letter";
  if ("recipient_user_id" in obj) return "notification";
  if ("retry_count" in obj && "next_retry_at" in obj) return "booking_audit";
  if ("deviceId" in obj || "requesterUserId" in obj) return "booking";
  if ("booking_id" in obj && "action" in obj && "actor_user_id" in obj) return "booking_audit";
  return undefined;
}

/*───────────────────── AddInData Booking Data Provider ─────────────────────*/

export class AddInDataBookingDataProvider implements BookingDataProvider, NotificationDataProvider {
  private readonly api: GeotabApi | null;
  private readonly addInId: string | null;
  private readonly groupId: string;
  private readonly serverAuthz: ServerAuthzClient | null;
  private creds: ServerAuthzSessionCreds | null;

  /*───────────────────── Read cache & request coalescing ─────────────────────*/
  /* Master data (devices/users/groups) changes infrequently; cached with a
     longer TTL and fetched together via ExecuteMultiCall on a cold cache.
     AddInData query results are cached with a short TTL and coalesced so
     identical concurrent reads share one network call. All read caches are
     invalidated after any write. */
  private masterCache: { devices: RawMyGeotabDevice[]; users: RawMyGeotabUser[]; groups: RawMyGeotabGroup[]; ts: number } | null = null;
  private masterInFlight: Promise<{ devices: RawMyGeotabDevice[]; users: RawMyGeotabUser[]; groups: RawMyGeotabGroup[] }> | null = null;
  private readonly recordsCache = new RequestCache<AddInDataRecord[]>(RECORDS_CACHE_TTL_MS);

  constructor(api: GeotabApi | null, addInId: string | null, groupId: string = DEFAULT_GROUP_ID, serverAuthz: ServerAuthzClient | null = null, creds: ServerAuthzSessionCreds | null = null) {
    this.api = api;
    this.addInId = addInId;
    this.groupId = groupId;
    this.serverAuthz = serverAuthz;
    this.creds = creds;
    diagLog("AddInDataBookingDataProvider constructed", {
      hasApi: !!api,
      hasAddInId: !!addInId,
      addInIdValid: addInId ? isValidAddInId(addInId) : false,
      hasServerAuthz: !!serverAuthz,
      hasCreds: !!creds,
    });
  }

  /* Update session credentials used for Worker-routed protected writes.
     Called by App.tsx when the MyGeotab identity resolves. */
  setCredentials(creds: ServerAuthzSessionCreds | null): void {
    this.creds = creds;
    diagLog("AddInDataBookingDataProvider credentials updated", { hasCreds: !!creds });
  }

  /* Invalidate every read cache after a write so subsequent reads are fresh. */
  private invalidateAllReadCaches(): void {
    this.recordsCache.invalidate();
    this.masterCache = null;
    this.masterInFlight = null;
  }

  /* Route a protected booking write through the Cloudflare Authorization
     Worker (/authz/execute). The Worker independently verifies the session,
     enforces RBAC, computes the SHA-256 payload fingerprint, enforces
     idempotency, and performs the AddInData write using the service account.

     When both serverAuthz and session creds are present (the LIVE path wired by
     App.tsx), the write is sent to the Worker and the Worker's response is
     returned verbatim. Otherwise a direct apiCall is performed — this branch
     exists only for non-server/test contexts and is never reached on the LIVE
     path, because App.tsx calls authorizeServerAction() first, which throws
     SERVER_AUTHZ_NOT_CONFIGURED in ADDIN_DATA mode when creds/serverAuthz are
     missing. This method does not itself distinguish LIVE from DEMO; the
     fail-closed guarantee for LIVE is enforced by that caller gate. */
  private async executeProtectedWrite<T>(
    action: string,
    bookingId: string,
    bookingData: Record<string, unknown> | null,
    operation: "add" | "set" | "remove",
    recordId?: string,
  ): Promise<{ success: true; recordId: string; actorUserId: string } | { success: false; error: string; reason: string }> {
    if (this.serverAuthz && this.creds) {
      /* Deterministic idempotency key: stable across retries of the same logical
         operation (same action/booking/operation/record/version) so the Worker
         can deduplicate, while distinct transitions (different version) get a
         distinct key and never false-conflict. The Worker requires this key. */
      const version = (bookingData as { version?: unknown } | null)?.version;
      const idempotencyKey = `idem:${action}:${bookingId}:${operation}:${recordId ?? ""}:${version ?? ""}`;
      const result = await this.serverAuthz.execute(
        this.creds.sessionId,
        this.creds.database,
        this.creds.server,
        action,
        bookingId,
        bookingData ?? undefined,
        operation,
        recordId,
        idempotencyKey,
        this.creds.userName,
      );
      return result;
    }
    /* DEMO mode: direct write (no server authorization required) */
    if (operation === "add") {
      const response = await this.apiCall<{ id?: string }>("Add", {
        typeName: "AddInData",
        entity: {
          addInId: this.addInId,
          details: bookingData,
          groups: [{ id: this.groupId }],
        },
      });
      return {
        success: true,
        recordId: response?.id ?? bookingId,
        actorUserId: (bookingData as { actorUserId?: string })?.actorUserId ?? "",
      };
    }
    if (operation === "set" && recordId) {
      await this.apiCall<unknown>("Set", {
        typeName: "AddInData",
        entity: {
          addInId: this.addInId,
          id: recordId,
          details: bookingData,
          groups: [{ id: this.groupId }],
        },
      });
      return { success: true, recordId, actorUserId: "" };
    }
    if (operation === "remove" && recordId) {
      await this.apiCall<unknown>("Remove", {
        typeName: "AddInData",
        entity: { id: recordId },
      });
      return { success: true, recordId, actorUserId: "" };
    }
    return { success: false, error: "SERVER_AUTHZ_NOT_CONFIGURED", reason: "SERVER_AUTHZ_NOT_CONFIGURED" };
  }

  /* Load master data (Device/User/Group) in a single ExecuteMultiCall
     round-trip when the cache is cold, coalescing concurrent callers. Falls
     back to individual Get calls internally when ExecuteMultiCall is
     unavailable or fails. */
  private async ensureMasterData(): Promise<{ devices: RawMyGeotabDevice[]; users: RawMyGeotabUser[]; groups: RawMyGeotabGroup[] }> {
    const now = Date.now();
    if (this.masterCache && now - this.masterCache.ts < MASTER_DATA_TTL_MS) {
      return { devices: this.masterCache.devices, users: this.masterCache.users, groups: this.masterCache.groups };
    }
    if (this.masterInFlight) return this.masterInFlight;

    const call = this.api?.call;
    const requests: MultiGetRequest[] = [
      { typeName: "Device", resultsLimit: MASTER_DATA_LIMIT },
      { typeName: "User", resultsLimit: MASTER_DATA_LIMIT },
      { typeName: "Group", resultsLimit: MASTER_DATA_LIMIT },
    ];

    this.masterInFlight = (async () => {
      const results = await executeMultiGet<unknown>(call ?? null, requests);
      const devices = (results[0] ?? []) as RawMyGeotabDevice[];
      const users = (results[1] ?? []) as RawMyGeotabUser[];
      const groups = (results[2] ?? []) as RawMyGeotabGroup[];
      const data = { devices, users, groups };
      this.masterCache = { devices, users, groups, ts: Date.now() };
      return data;
    })();

    try {
      return await this.masterInFlight;
    } finally {
      this.masterInFlight = null;
    }
  }

  /* Execute a selective, bounded AddInData Get. A recordType whereClause is
     added as a server-side optimization when provided; client-side filtering
     via classifyRecordType / explicit filters remains authoritative so legacy
     records (which lack recordType) are never silently dropped when a mock or
     older runtime ignores the whereClause. */
  private async queryAddInData(recordType: string | undefined, resultsLimit?: number): Promise<AddInDataRecord[]> {
    const search: Record<string, unknown> = { addInId: this.addInId };
    if (recordType) {
      search.whereClause = `details.recordType = "${recordType}"`;
    }
    if (typeof resultsLimit === "number") {
      search.resultsLimit = resultsLimit;
    }
    return (await this.apiCall<AddInDataRecord[]>("Get", { typeName: "AddInData", search })) ?? [];
  }

  /* Fetch a selective record type through the short-TTL request cache so
     identical concurrent/repeated reads share one network call, and are
     invalidated after every write. */
  private async queryAddInDataCached(recordType: string, resultsLimit: number): Promise<AddInDataRecord[]> {
    return this.recordsCache.fetch(`records:${recordType}`, async () => {
      return this.queryAddInData(recordType, resultsLimit);
    });
  }

  /*───────────────────── JSON-RPC wrapper over geotab.addin API ─────────────────────*/

  private async apiCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
    diagLog(`AddInData API call started`, { method, typeName: params.typeName });
    return new Promise((resolve, reject) => {
      if (!this.api?.call) {
        diagLog("AddInData API call failed: geotabApi.call not available", { method });
        reject(new Error("GEOTAB_API_NOT_AVAILABLE: running outside MyGeotab Add-In context"));
        return;
      }
      if ((method === "Add" || method === "Set" || method === "Remove" || method === "Delete") && !this.addInId) {
        diagLog("AddInData API call failed: addInId not configured", { method });
        reject(new Error("ADDIN_ID_NOT_CONFIGURED: set addInId before using AddInData storage"));
        return;
      }
      if ((method === "Add" || method === "Set" || method === "Remove" || method === "Delete") && this.addInId && !isValidAddInId(this.addInId)) {
        diagLog("AddInData API call failed: addInId invalid format", { method });
        reject(new Error("ADDIN_ID_INVALID: stored addInId does not match Geotab Storage API format. Enter a valid AddInId."));
        return;
      }
      this.api.call(method, params, (result: unknown) => {
        diagLog(`AddInData API call succeeded`, { method, typeName: params.typeName });
        resolve(result as T);
      }, (error: unknown) => {
        diagLog(`AddInData API call failed`, { method, typeName: params.typeName, error: error instanceof Error ? error.message : String(error) });
        reject(error ?? new Error("GEOTAB_API_ERROR"));
      });
    });
  }

  /*───────────────────── Read-only master data (live from MyGeotab) ─────────────────────*/

  async getAssets(): Promise<ResolvedAsset[]> {
    const devices = await this.getDevicesRaw();
    return devices.map(mapLiveAsset);
  }

  async getUsers(): Promise<ResolvedUser[]> {
    const users = await this.getUsersRaw();
    return users.map(mapLiveUser);
  }

  async getGroups(): Promise<MyGeotabGroup[]> {
    const groups = await this.getGroupsRaw();
    return groups.map(mapLiveGroup);
  }

  async getStatusData(): Promise<MyGeotabStatusData[]> {
    return [];
  }

  async getLogRecords(): Promise<MyGeotabLogRecord[]> {
    return [];
  }

  /*───────────────────── Booking transactions (AddInData storage) ─────────────────────*/

  private async getDevicesRaw(): Promise<RawMyGeotabDevice[]> {
    const master = await this.ensureMasterData();
    return master.devices;
  }

  private async getUsersRaw(): Promise<RawMyGeotabUser[]> {
    const master = await this.ensureMasterData();
    return master.users;
  }

  private async getGroupsRaw(): Promise<RawMyGeotabGroup[]> {
    const master = await this.ensureMasterData();
    return master.groups;
  }

  async getBookings(): Promise<ResolvedBooking[]> {
    const [records, devices, users] = await Promise.all([
      this.queryAddInDataCached("booking", BOOKING_QUERY_LIMIT),
      this.getDevicesRaw(),
      this.getUsersRaw(),
    ]);
    const deviceMap = new Map(devices.map(d => [d.id, d]));
    const userMap = new Map(users.map(u => [u.id, u]));
    const bookings = (records || [])
      .filter(r => classifyRecordType(r.details) === "booking")
      .map(r => resolveAddInDataBooking(r, deviceMap, userMap));
    return bookings;
  }

  async createBooking(input: {
    deviceId: string;
    requesterUserId: string;
    requestedClass: "OPERATIONAL_4X4" | "PASSENGER";
    startAt: string;
    endAt: string;
    purpose: string;
    destination: string | null;
    passengerCount: number | null;
    driverId?: string | null;
    driverName?: string | null;
  }): Promise<ResolvedBooking> {
    // Best-effort conflict check: load all bookings, filter overlaps for same asset
    const existing = await this.getBookings();
    const conflictStatuses = ["PENDING_APPROVAL", "APPROVED", "ASSIGNED"];
    const newStart = new Date(input.startAt);
    const newEnd = new Date(input.endAt);
    const conflict = existing.find(b => {
      if (b.asset_id !== input.deviceId) return false;
      if (!conflictStatuses.includes(b.status)) return false;
      return overlaps(newStart, newEnd, new Date(b.start_at), new Date(b.end_at));
    });
    if (conflict) {
      throw new Error(`ASSET_CONFLICT: Asset ${input.deviceId} already has a ${conflict.status.replace(/_/g, " ").toLowerCase()} booking overlapping the requested time.`);
    }

    const now = new Date().toISOString();
    const businessId = generateBusinessId();
    const booking: OpexBooking = {
      recordType: "booking",
      schemaVersion: SCHEMA_VERSION,
      id: businessId,
      deviceId: input.deviceId,
      requesterUserId: input.requesterUserId,
      requestedClass: input.requestedClass,
      startAt: input.startAt,
      endAt: input.endAt,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 30,
      purpose: input.purpose,
      destination: input.destination,
      passengerCount: input.passengerCount,
      status: "PENDING_APPROVAL",
      assignedDriverUserId: input.driverId ?? null,
      approverId: null,
      approvalRemarks: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    const details = serializeBooking(booking);
    const writeResult = await this.executeProtectedWrite(
      "create_booking",
      businessId,
      details as unknown as Record<string, unknown>,
      "add",
    );
    if (!writeResult.success) {
      throw new Error(`WORKER_WRITE_FAILED: ${writeResult.error}`);
    }
    this.invalidateAllReadCaches();
    if (writeResult.recordId) {
      booking.id = writeResult.recordId;
    }

    const resolved = await this.getBookings();
    return resolved.find(b => b.id === booking.id) ?? resolveBookingToResolved(booking);
  }

  async updateBookingStatus(id: string, status: string, expectedVersion: number, approverId?: string, approvalRemarks?: string): Promise<void> {
    const record = await this.findBookingRecord(id);
    if (!record) throw new Error(`BOOKING_NOT_FOUND: ${id}`);
    const booking = deserializeBooking(record.details);
    if ((booking.version || 0) !== expectedVersion) {
      throw new Error(`OPTIMISTIC_LOCK_CONFLICT: Booking ${id} version is ${booking.version || 0}, expected ${expectedVersion}. It may have been modified by another user.`);
    }
    booking.status = status as OpexBooking["status"];
    if (approverId !== undefined) booking.approverId = approverId;
    if (approvalRemarks !== undefined) booking.approvalRemarks = approvalRemarks;
    booking.updatedAt = new Date().toISOString();
    booking.version = (booking.version || 0) + 1;
    /* Map the target status to the canonical Worker action name. Unknown
       statuses fail closed rather than sending an unrecognized action that the
       Worker would reject with UNKNOWN_ACTION. */
    const action = STATUS_TO_ACTION[status];
    if (!action) {
      throw new Error(`UNSUPPORTED_STATUS_ACTION: ${status}`);
    }
    const writeResult = await this.executeProtectedWrite(
      action,
      id,
      serializeBooking(booking) as unknown as Record<string, unknown>,
      "set",
      record.id,
    );
    if (!writeResult.success) {
      throw new Error(`WORKER_WRITE_FAILED: ${writeResult.error}`);
    }
    this.invalidateAllReadCaches();
  }

  /**
   * Shared booking record lookup that resolves the AddInData server record ID.
   * Matches by either:
   *   - record.id === bookingId (server record ID)
   *   - deserializeBooking(record.details).id === bookingId (application ID stored in details)
   * Malformed details are skipped gracefully so a single bad record cannot break the lookup.
   * Performs a fresh bounded Get each call so server-assigned IDs and legacy
   * records written outside this provider instance are always visible.
   */
  async findBookingRecord(bookingId: string): Promise<AddInDataRecord | null> {
    const records = await this.queryAddInData(undefined, BOOKING_QUERY_LIMIT);
    for (const record of records || []) {
      if (record.id === bookingId) return record;
      try {
        const booking = deserializeBooking(record.details);
        if (booking && booking.id === bookingId) return record;
      } catch {
        // Skip malformed records
      }
    }
    return null;
  }

  async deleteBooking(id: string): Promise<void> {
    const record = await this.findBookingRecord(id);
    if (!record) throw new Error(`BOOKING_NOT_FOUND: ${id}`);
    const writeResult = await this.executeProtectedWrite(
      "delete_booking",
      id,
      null,
      "remove",
      record.id,
    );
    if (!writeResult.success) {
      throw new Error(`WORKER_WRITE_FAILED: ${writeResult.error}`);
    }
    this.invalidateAllReadCaches();
  }

  async resetDemoData(): Promise<void> {
    // AddInData mode does not use local demo data. No-op here.
    // DEMO mode uses LocalBookingDataProvider.resetDemoData().
  }

  /*───────────────────── Notification operations (AddInData) ─────────────────────*/
  async getNotifications(userId: string, opts?: { limit?: number; offset?: number; unreadOnly?: boolean; type?: NotificationType }): Promise<OpexNotification[]> {
    const records = await this.queryAddInDataCached("notification", NOTIFICATION_QUERY_LIMIT);
    return (records || [])
      .map(r => deserializeNotification(r.details))
      .filter(n => n.recipient_user_id === userId)
      .filter(n => (opts?.unreadOnly ? !n.is_read : true))
      .filter(n => (opts?.type ? n.type === opts.type : true))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(opts?.offset ?? 0, opts?.offset ?? 0 + (opts?.limit ?? Infinity));
  }

  async getUnreadCount(userId: string): Promise<number> {
    const records = await this.queryAddInDataCached("notification", NOTIFICATION_QUERY_LIMIT);
    return (records || [])
      .map(r => deserializeNotification(r.details))
      .filter(n => n.recipient_user_id === userId && !n.is_read).length;
  }

  async createNotification(input: {
    eventId: string;
    idempotencyKey: string;
    type: NotificationType;
    recipient_user_id: string;
    related_booking_id: string | null;
    title: string;
    message: string;
  }): Promise<OpexNotification> {
    // Duplicate prevention: skip if a notification with this idempotency key already exists
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    const now = new Date().toISOString();
    const notification: OpexNotification = {
      recordType: "notification",
      schemaVersion: SCHEMA_VERSION,
      id: generateBusinessId(),
      eventId: input.eventId,
      idempotencyKey: input.idempotencyKey,
      type: input.type,
      recipient_user_id: input.recipient_user_id,
      related_booking_id: input.related_booking_id,
      title: input.title,
      message: input.message,
      is_read: false,
      delivery_status: "pending",
      delivered_at: null,
      created_at: now,
      updated_at: now,
    };
    const details = serializeNotification(notification);
    await this.apiCall<{ id?: string }>("Add", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        details,
        groups: [{ id: NOTIFICATION_GROUP_ID }],
      },
    });
    this.invalidateAllReadCaches();
    return notification;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<OpexNotification | null> {
    const records = await this.queryAddInDataCached("notification", NOTIFICATION_QUERY_LIMIT);
    for (const record of records || []) {
      try {
        const n = deserializeNotification(record.details);
        if (n.idempotencyKey === idempotencyKey) return n;
      } catch {
        // Skip malformed records
      }
    }
    return null;
  }

  async markAsRead(notificationId: string, actorUserId: string): Promise<void> {
    const records = await this.queryAddInDataCached("notification", NOTIFICATION_QUERY_LIMIT);
    const record = (records || []).find(r => {
      try {
        return deserializeNotification(r.details).id === notificationId;
      } catch {
        return false;
      }
    });
    if (!record) return;
    const n = deserializeNotification(record.details);
    /* Recipient ownership validation (mandatory): only the verified actor may
       mark their own notifications as read. Fail closed when the actor is
       missing/blank or does not own the notification. */
    if (!actorUserId || !actorUserId.trim() || n.recipient_user_id !== actorUserId) {
      return;
    }
    n.is_read = true;
    n.updated_at = new Date().toISOString();
    await this.apiCall<unknown>("Set", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        id: record.id,
        details: serializeNotification(n),
        groups: [{ id: NOTIFICATION_GROUP_ID }],
      },
    });
    this.invalidateAllReadCaches();
  }

  async markAllAsRead(userId: string, actorUserId: string): Promise<void> {
    /* Mandatory actor validation: only the verified actor may mark their own
       notifications as read. Fail closed when the actor is missing/blank or
       the target userId is not the actor. Prevents cross-user marking. */
    if (!actorUserId || !actorUserId.trim() || userId !== actorUserId) {
      return;
    }
    const records = await this.queryAddInDataCached("notification", NOTIFICATION_QUERY_LIMIT);
    const now = new Date().toISOString();
    for (const record of records || []) {
      try {
        const n = deserializeNotification(record.details);
        if (n.recipient_user_id === userId && !n.is_read) {
          n.is_read = true;
          n.updated_at = now;
          await this.apiCall<unknown>("Set", {
            typeName: "AddInData",
            entity: {
              addInId: this.addInId,
              id: record.id,
              details: serializeNotification(n),
              groups: [{ id: NOTIFICATION_GROUP_ID }],
            },
          });
        }
      } catch {
        // Skip malformed records
      }
    }
    this.invalidateAllReadCaches();
  }

  async markDeliveryStatus(notificationId: string, status: "pending" | "delivered" | "failed", actorUserId: string): Promise<void> {
    const records = await this.queryAddInDataCached("notification", NOTIFICATION_QUERY_LIMIT);
    const record = (records || []).find(r => {
      try {
        return deserializeNotification(r.details).id === notificationId;
      } catch {
        return false;
      }
    });
    if (!record) return;
    const n = deserializeNotification(record.details);
    /* Recipient ownership validation (mandatory): only the verified actor may
       update delivery status for their own notifications. Fail closed when the
       actor is missing/blank or does not own the notification. */
    if (!actorUserId || !actorUserId.trim() || n.recipient_user_id !== actorUserId) {
      return;
    }
    n.delivery_status = status;
    n.delivered_at = status === "delivered" ? new Date().toISOString() : n.delivered_at;
    n.updated_at = new Date().toISOString();
    await this.apiCall<unknown>("Set", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        id: record.id,
        details: serializeNotification(n),
        groups: [{ id: NOTIFICATION_GROUP_ID }],
      },
    });
    this.invalidateAllReadCaches();
  }

  /*───────────────────── Audit operations (AddInData) ─────────────────────*/
  async createAuditRecord(input: {
    booking_id: string;
    action: string;
    actor_user_id: string;
    previous_status: string | null;
    new_status: string | null;
    details: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const record: OpexBookingAudit = {
      recordType: "booking_audit",
      schemaVersion: SCHEMA_VERSION,
      id: generateBusinessId(),
      booking_id: input.booking_id,
      action: input.action,
      actor_user_id: input.actor_user_id,
      previous_status: input.previous_status,
      new_status: input.new_status,
      details: input.details,
      created_at: now,
    };
    const detailsStr = serializeAudit(record);
    await this.apiCall<{ id?: string }>("Add", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        details: detailsStr,
        groups: [{ id: AUDIT_GROUP_ID }],
      },
    });
    this.invalidateAllReadCaches();
  }

  /* Store a canonical booking audit event (recordType "bookingAudit") as a
     structured AddInData record. The `details` payload is the canonical event
     object itself — never a nested JSON string — so `changes`, `actor` and
     `metadata` remain queryable and readable. Immutable: a new record is
     created for every event with a unique auditKey. */
  async createBookingAuditEvent(input: CanonicalAuditInput): Promise<void> {
    const event: OpexBookingAuditV2 = {
      recordType: "bookingAudit",
      schemaVersion: SCHEMA_VERSION,
      auditKey: input.auditKey ?? generateCanonicalAuditKey(),
      bookingKey: input.bookingKey,
      action: input.action,
      actor: input.actor,
      occurredAtUtc: input.occurredAtUtc ?? new Date().toISOString(),
      previousStatus: input.previousStatus ?? null,
      newStatus: input.newStatus ?? null,
      changes: input.changes,
      metadata: input.metadata,
    };
    await this.apiCall<{ id?: string }>("Add", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        details: event,
        groups: [{ id: AUDIT_GROUP_ID }],
      },
    });
    this.invalidateAllReadCaches();
  }

  async getAuditRecords(bookingId: string): Promise<NormalizedAuditEvent[]> {
    /* Query the legacy "booking_audit" records first (index 0) so existing
       selective-query contracts are honored, then canonical "bookingAudit"
       records. Both formats are normalized to a common in-memory shape so
       legacy and canonical records can coexist and be displayed together. */
    const [legacyRecords, canonicalRecords] = await Promise.all([
      this.queryAddInDataCached("booking_audit", AUDIT_QUERY_LIMIT),
      this.queryAddInDataCached("bookingAudit", AUDIT_QUERY_LIMIT),
    ]);
    const normalized: NormalizedAuditEvent[] = [];
    for (const r of legacyRecords || []) {
      const n = normalizeAuditRecord(deserializeAudit(r.details), r.id);
      if (n) normalized.push(n);
    }
    for (const r of canonicalRecords || []) {
      const n = normalizeAuditRecord(deserializeBookingAudit(r.details), r.id);
      if (n) normalized.push(n);
    }
    return normalized
      .filter(a => a.bookingKey === bookingId)
      .sort((a, b) => {
        const da = a.occurredAtUtc ? new Date(a.occurredAtUtc).getTime() : 0;
        const db = b.occurredAtUtc ? new Date(b.occurredAtUtc).getTime() : 0;
        return db - da;
      });
  }

  async createAuditPending(input: Omit<OpexAuditPending, "id" | "schemaVersion" | "recordType" | "created_at" | "retry_count" | "next_retry_at">): Promise<OpexAuditPending> {
    const now = new Date().toISOString();
    const record: OpexAuditPending = {
      recordType: "booking_audit",
      schemaVersion: SCHEMA_VERSION,
      id: generateBusinessId(),
      booking_id: input.booking_id,
      action: input.action,
      actor_user_id: input.actor_user_id,
      previous_status: input.previous_status,
      new_status: input.new_status,
      details: input.details,
      created_at: now,
      retry_count: 0,
      max_retries: MAX_RETRIES,
      last_error: null,
      next_retry_at: nextRetryAt(0),
    };
    const detailsStr = serializeAuditPending(record);
    await this.apiCall<{ id?: string }>("Add", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        details: detailsStr,
        groups: [{ id: AUDIT_PENDING_GROUP_ID }],
      },
    });
    this.invalidateAllReadCaches();
    return record;
  }

  async getAuditPending(): Promise<OpexAuditPending[]> {
    const records = await this.queryAddInDataCached("booking_audit", AUDIT_QUERY_LIMIT);
    return (records || [])
      .map(r => deserializeAuditPending(r.details))
      .filter(p => p.recordType === "booking_audit")
      .sort((a, b) => {
        const da = a.next_retry_at ? new Date(a.next_retry_at).getTime() : 0;
        const db = b.next_retry_at ? new Date(b.next_retry_at).getTime() : 0;
        return da - db;
      });
  }

  async deleteAuditPending(id: string): Promise<void> {
    if (!id || id.trim() === "") return;
    const records = await this.queryAddInDataCached("booking_audit", AUDIT_QUERY_LIMIT);
    const record = (records || []).find(r => {
      try {
        return deserializeAuditPending(r.details).id === id;
      } catch {
        return false;
      }
    });
    if (!record) return;
    /* Sanity check: only delete records that are genuinely pending audits
       (recordType booking_audit) with a valid server record ID. */
    const pending = deserializeAuditPending(record.details);
    if (pending.recordType !== "booking_audit" || !record.id || record.id.trim() === "") return;
    await this.apiCall<unknown>("Delete", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        id: record.id,
      },
    });
    this.invalidateAllReadCaches();
  }

  async createAuditDeadLetter(input: Omit<OpexAuditDeadLetter, "id" | "schemaVersion" | "recordType" | "created_at" | "dead_lettered_at">): Promise<OpexAuditDeadLetter> {
    const now = new Date().toISOString();
    const record: OpexAuditDeadLetter = {
      recordType: "audit_dead_letter",
      schemaVersion: SCHEMA_VERSION,
      id: generateBusinessId(),
      booking_id: input.booking_id,
      action: input.action,
      actor_user_id: input.actor_user_id,
      previous_status: input.previous_status,
      new_status: input.new_status,
      details: input.details,
      created_at: now,
      retry_count: input.retry_count,
      max_retries: input.max_retries,
      last_error: input.last_error,
      next_retry_at: input.next_retry_at,
      dead_lettered_at: now,
      original_pending_id: input.original_pending_id,
    };
    const detailsStr = serializeAuditDeadLetter(record);
    await this.apiCall<{ id?: string }>("Add", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        details: detailsStr,
        groups: [{ id: AUDIT_DEAD_LETTER_GROUP_ID }],
      },
    });
    this.invalidateAllReadCaches();
    return record;
  }

  async getAuditDeadLetters(): Promise<OpexAuditDeadLetter[]> {
    const records = await this.queryAddInDataCached("audit_dead_letter", DEAD_LETTER_QUERY_LIMIT);
    return (records || [])
      .map(r => deserializeAuditDeadLetter(r.details))
      .filter(d => d.recordType === "audit_dead_letter")
      .sort((a, b) => {
        const da = a.dead_lettered_at ? new Date(a.dead_lettered_at).getTime() : 0;
        const db = b.dead_lettered_at ? new Date(b.dead_lettered_at).getTime() : 0;
        return db - da;
      });
  }

  isLive(): boolean {
    return true;
  }

  async getApprovers(): Promise<ResolvedUser[]> {
    const users = await this.getUsersRaw();
    return (users || [])
      .filter(u => u.role === "APPROVER")
      .map(mapLiveUser);
  }
}

export {
  serializeBooking,
  deserializeBooking,
  serializeNotification,
  deserializeNotification,
  serializeAudit,
  deserializeAudit,
  assertDetailsWithinLimit,
};


export function createAddInDataProvider(api: GeotabApi | null, addInId: string | null, serverAuthz: ServerAuthzClient | null = null): AddInDataBookingDataProvider {
  return new AddInDataBookingDataProvider(api, addInId, DEFAULT_GROUP_ID, serverAuthz);
}

/*───────────────────── Resolve helpers ─────────────────────*/

function resolveAddInDataBooking(
  record: AddInDataRecord,
  devices: Map<string, RawMyGeotabDevice>,
  users: Map<string, RawMyGeotabUser>,
): ResolvedBooking {
  let booking: OpexBooking;
  try {
    booking = deserializeBooking(record.details);
  } catch {
    booking = {
      recordType: "booking",
      schemaVersion: SCHEMA_VERSION,
      id: record.id,
      deviceId: "",
      requesterUserId: "",
      requestedClass: "PASSENGER",
      startAt: "",
      endAt: "",
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      purpose: "",
      destination: null,
      passengerCount: null,
      status: "PENDING_APPROVAL",
      assignedDriverUserId: null,
      approverId: null,
      approvalRemarks: null,
      createdAt: "",
      updatedAt: "",
      version: 0,
    };
  }
  const device = devices.get(booking.deviceId ?? undefined);
  const requester = users.get(booking.requesterUserId ?? undefined);
  const driver = booking.assignedDriverUserId ? users.get(booking.assignedDriverUserId) : undefined;
  const validation = validateResolvedBooking({
    asset_id: booking.deviceId ?? null,
    requester_id: booking.requesterUserId ?? "",
    status: booking.status ?? "",
    start_at: booking.startAt ?? "",
    end_at: booking.endAt ?? "",
  });
  return {
    recordType: booking.recordType,
    schemaVersion: booking.schemaVersion,
    id: booking.id ?? record.id,
    requester_id: booking.requesterUserId ?? "",
    requester_name: requester?.name ?? "Unknown User",
    requested_class: booking.requestedClass,
    asset_id: booking.deviceId ?? null,
    asset_code: device ? `VEH-${device.id.slice(-3).toUpperCase()}` : null,
    asset_name: device ? parseVehicleName(device.name ?? "") : null,
    registration_no: device?.licensePlate ?? null,
    start_at: booking.startAt ?? "",
    end_at: booking.endAt ?? "",
    buffer_before_minutes: booking.bufferBeforeMinutes,
    buffer_after_minutes: booking.bufferAfterMinutes,
    purpose: booking.purpose,
    destination: booking.destination,
    passenger_count: booking.passengerCount,
    status: booking.status ?? "",
    approver_id: booking.approverId ?? null,
    approval_remarks: booking.approvalRemarks ?? null,
    version: booking.version,
    created_at: booking.createdAt ?? "",
    updated_at: booking.updatedAt ?? "",
    driver_id: booking.assignedDriverUserId ?? null,
    driver_name: driver?.name ?? null,
    dataQuality: validation.quality,
  };
}

function resolveBookingToResolved(booking: OpexBooking): ResolvedBooking {
  const validation = validateResolvedBooking({
    asset_id: booking.deviceId ?? null,
    requester_id: booking.requesterUserId,
    status: booking.status ?? "",
    start_at: booking.startAt,
    end_at: booking.endAt,
  });
  return {
    recordType: booking.recordType,
    schemaVersion: booking.schemaVersion,
    id: booking.id,
    requester_id: booking.requesterUserId,
    requester_name: "Unknown User",
    requested_class: booking.requestedClass,
    asset_id: booking.deviceId ?? null,
    asset_code: null,
    asset_name: null,
    registration_no: null,
    start_at: booking.startAt,
    end_at: booking.endAt,
    buffer_before_minutes: booking.bufferBeforeMinutes,
    buffer_after_minutes: booking.bufferAfterMinutes,
    purpose: booking.purpose,
    destination: booking.destination,
    passenger_count: booking.passengerCount,
    status: booking.status,
    approver_id: booking.approverId ?? null,
    approval_remarks: booking.approvalRemarks ?? null,
    version: booking.version,
    created_at: booking.createdAt,
    updated_at: booking.updatedAt,
    driver_id: booking.assignedDriverUserId ?? null,
    driver_name: null,
    dataQuality: validation.quality,
  };
}
