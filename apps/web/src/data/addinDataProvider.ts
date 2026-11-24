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
  OpexAuditPending,
  OpexAuditDeadLetter,
  NotificationType,
  RecordType,
} from "./types";
import { SCHEMA_VERSION, generateBusinessId } from "./types.ts";
import { isValidAddInId } from "../config/addinId.ts";
import { validateResolvedBooking } from "./bookingValidation.ts";

/*───────────────────── Geotab API type (Add-In context) ─────────────────────*/

type GeotabApi = {
  call?: (method: string, params: Record<string, unknown>, success: (result: unknown) => void, error?: (error: unknown) => void) => void;
  getSession?: (callback: (session: { userName?: string; database?: string; server?: string } | null) => void) => void;
};

const MAX_DETAILS_CHARS = 10000;
const DEFAULT_GROUP_ID = "GroupCompanyId";
const MAX_RETRIES = 5;

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

/*───────────────────── AddInData Booking Data Provider ─────────────────────*/

export class AddInDataBookingDataProvider implements BookingDataProvider, NotificationDataProvider {
  private readonly api: GeotabApi | null;
  private readonly addInId: string | null;
  private readonly groupId: string;

  /*───────────────────── Simple TTL cache for read performance ─────────────────────*/
  /* Master data (devices/users/groups) changes infrequently; cache with TTL.
     Booking results are cached and invalidated on any write. */
  private static readonly MASTER_DATA_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly BOOKING_CACHE_TTL_MS = 30 * 1000; // 30 seconds

  private masterDataCache: { devices: RawMyGeotabDevice[]; users: RawMyGeotabUser[]; groups: RawMyGeotabGroup[]; ts: number } | null = null;
  private bookingCache: { bookings: ResolvedBooking[]; ts: number } | null = null;

  constructor(api: GeotabApi | null, addInId: string | null, groupId: string = DEFAULT_GROUP_ID) {
    this.api = api;
    this.addInId = addInId;
    this.groupId = groupId;
    diagLog("AddInDataBookingDataProvider constructed", {
      hasApi: !!api,
      hasAddInId: !!addInId,
      addInIdValid: addInId ? isValidAddInId(addInId) : false,
    });
  }

  private invalidateBookingCache(): void {
    this.bookingCache = null;
  }

  private invalidateMasterDataCache(): void {
    this.masterDataCache = null;
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
      if ((method === "Add" || method === "Set" || method === "Remove") && !this.addInId) {
        diagLog("AddInData API call failed: addInId not configured", { method });
        reject(new Error("ADDIN_ID_NOT_CONFIGURED: set addInId before using AddInData storage"));
        return;
      }
      if ((method === "Add" || method === "Set" || method === "Remove") && this.addInId && !isValidAddInId(this.addInId)) {
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
    const devices = await this.apiCall<RawMyGeotabDevice[]>("Get", {
      typeName: "Device",
      resultsLimit: 1000,
    });
    return devices.map(mapLiveAsset);
  }

  async getUsers(): Promise<ResolvedUser[]> {
    const users = await this.apiCall<RawMyGeotabUser[]>("Get", {
      typeName: "User",
      resultsLimit: 1000,
    });
    return users.map(mapLiveUser);
  }

  async getGroups(): Promise<MyGeotabGroup[]> {
    const groups = await this.apiCall<RawMyGeotabGroup[]>("Get", {
      typeName: "Group",
      resultsLimit: 1000,
    });
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
    const now = Date.now();
    if (this.masterDataCache && now - this.masterDataCache.ts < AddInDataBookingDataProvider.MASTER_DATA_TTL_MS) {
      return this.masterDataCache.devices;
    }
    const devices = await this.apiCall<RawMyGeotabDevice[]>("Get", { typeName: "Device", resultsLimit: 1000 });
    this.masterDataCache = { devices, users: this.masterDataCache?.users ?? [], groups: this.masterDataCache?.groups ?? [], ts: now };
    return devices;
  }

  private async getUsersRaw(): Promise<RawMyGeotabUser[]> {
    const now = Date.now();
    if (this.masterDataCache && now - this.masterDataCache.ts < AddInDataBookingDataProvider.MASTER_DATA_TTL_MS) {
      return this.masterDataCache.users;
    }
    const users = await this.apiCall<RawMyGeotabUser[]>("Get", { typeName: "User", resultsLimit: 1000 });
    this.masterDataCache = { devices: this.masterDataCache?.devices ?? [], users, groups: this.masterDataCache?.groups ?? [], ts: now };
    return users;
  }

  private async getGroupsRaw(): Promise<RawMyGeotabGroup[]> {
    const now = Date.now();
    if (this.masterDataCache && now - this.masterDataCache.ts < AddInDataBookingDataProvider.MASTER_DATA_TTL_MS) {
      return this.masterDataCache.groups;
    }
    const groups = await this.apiCall<RawMyGeotabGroup[]>("Get", { typeName: "Group", resultsLimit: 1000 });
    this.masterDataCache = { devices: this.masterDataCache?.devices ?? [], users: this.masterDataCache?.users ?? [], groups, ts: now };
    return groups;
  }

  async getBookings(): Promise<ResolvedBooking[]> {
    const now = Date.now();
    if (this.bookingCache && now - this.bookingCache.ts < AddInDataBookingDataProvider.BOOKING_CACHE_TTL_MS) {
      return this.bookingCache.bookings;
    }
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    const devices = await this.getDevicesRaw();
    const users = await this.getUsersRaw();
    const deviceMap = new Map(devices.map(d => [d.id, d]));
    const userMap = new Map(users.map(u => [u.id, u]));
    const bookings = (records || []).map(r => resolveAddInDataBooking(r, deviceMap, userMap));
    this.bookingCache = { bookings, ts: now };
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
    const response = await this.apiCall<{ id?: string }>("Add", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        details,
        groups: [{ id: this.groupId }],
      },
    });
    this.invalidateBookingCache();
    if (response?.id) {
      booking.id = response.id;
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
    await this.apiCall<unknown>("Set", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        id: record.id,
        details: serializeBooking(booking),
        groups: [{ id: this.groupId }],
      },
    });
    this.invalidateBookingCache();
  }

  /**
   * Shared booking record lookup that resolves the AddInData server record ID.
   * Matches by either:
   *   - record.id === bookingId (server record ID)
   *   - deserializeBooking(record.details).id === bookingId (application ID stored in details)
   * Malformed details are skipped gracefully so a single bad record cannot break the lookup.
   */
  async findBookingRecord(bookingId: string): Promise<AddInDataRecord | null> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
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
    await this.apiCall<unknown>("Remove", {
      typeName: "AddInData",
      entity: { id: record.id },
    });
    this.invalidateBookingCache();
  }

  async resetDemoData(): Promise<void> {
    // AddInData mode does not use local demo data. No-op here.
    // DEMO mode uses LocalBookingDataProvider.resetDemoData().
  }

  /*───────────────────── Notification operations (AddInData) ─────────────────────*/
  async getNotifications(userId: string, opts?: { limit?: number; offset?: number; unreadOnly?: boolean; type?: NotificationType }): Promise<OpexNotification[]> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    return (records || [])
      .map(r => deserializeNotification(r.details))
      .filter(n => n.recipient_user_id === userId)
      .filter(n => (opts?.unreadOnly ? !n.is_read : true))
      .filter(n => (opts?.type ? n.type === opts.type : true))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(opts?.offset ?? 0, opts?.offset ?? 0 + (opts?.limit ?? Infinity));
  }

  async getUnreadCount(userId: string): Promise<number> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
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
    return notification;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<OpexNotification | null> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
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

  async markAsRead(notificationId: string): Promise<void> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    const record = (records || []).find(r => {
      try {
        return deserializeNotification(r.details).id === notificationId;
      } catch {
        return false;
      }
    });
    if (!record) return;
    const n = deserializeNotification(record.details);
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
  }

  async markAllAsRead(userId: string): Promise<void> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
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
  }

  async markDeliveryStatus(notificationId: string, status: "pending" | "delivered" | "failed"): Promise<void> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    const record = (records || []).find(r => {
      try {
        return deserializeNotification(r.details).id === notificationId;
      } catch {
        return false;
      }
    });
    if (!record) return;
    const n = deserializeNotification(record.details);
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
  }

  async getAuditRecords(bookingId: string): Promise<OpexBookingAudit[]> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    return (records || [])
      .map(r => deserializeAudit(r.details))
      .filter(a => a.booking_id === bookingId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
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
    return record;
  }

  async getAuditPending(): Promise<OpexAuditPending[]> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
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
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    const record = (records || []).find(r => {
      try {
        return deserializeAuditPending(r.details).id === id;
      } catch {
        return false;
      }
    });
    if (!record) return;
    await this.apiCall<unknown>("Delete", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        id: record.id,
      },
    });
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
    return record;
  }

  async getAuditDeadLetters(): Promise<OpexAuditDeadLetter[]> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
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
    const users = await this.apiCall<RawMyGeotabUser[]>("Get", {
      typeName: "User",
      resultsLimit: 1000,
    });
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


export function createAddInDataProvider(api: GeotabApi | null, addInId: string | null): AddInDataBookingDataProvider {
  return new AddInDataBookingDataProvider(api, addInId);
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
