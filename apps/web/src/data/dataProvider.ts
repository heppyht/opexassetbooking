/*â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Local MyGeotab-Aligned Data Provider â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€*/

import type {
  MyGeotabDevice,
  MyGeotabUser,
  MyGeotabGroup,
  MyGeotabStatusData,
  MyGeotabLogRecord,
  OpexBooking,
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
  CanonicalAuditInput,
  NormalizedAuditEvent,
} from "./types";
import { SCHEMA_VERSION, generateBusinessId } from "./types.ts";
import {
  mockMyGeotabDevices,
  mockMyGeotabUsers,
  mockMyGeotabGroups,
  mockMyGeotabStatusData,
  mockMyGeotabLogRecords,
  mockOpexBookings,
} from "./mockMyGeotab.ts";
import { validateResolvedBooking } from "./bookingValidation.ts";
import { buildBookingAuditEvent, generateCanonicalAuditKey, normalizeAuditRecord } from "./auditEvent.ts";

const MAX_RETRIES = 5;

function nextRetryAt(retryCount: number): string {
  return new Date(Date.now() + Math.min(1000 * 2 ** retryCount, 30000)).toISOString();
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/*â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Helper: resolve master data references â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€*/

function resolveAsset(device: MyGeotabDevice): ResolvedAsset {
  return {
    id: device.id,
    asset_code: `VEH-${device.id.slice(-3).toUpperCase()}`,
    asset_name: parseVehicleName(device.name ?? ""),
    serial_number: device.serialNumber ?? null,
    make_model: `${device.make ?? "Unknown"} ${device.model ?? "Asset"}`,
    asset_class: device.vehicleClass ?? "OPERATIONAL_4X4",
    registration_no: device.licensePlate ?? null,
    status: device.status,
    geotab_device_id: device.id,
  };
}

function parseVehicleName(rawName: string): string {
  if (!rawName || rawName.trim() === "") {
    return "Unknown Vehicle";
  }

  const parts = rawName.split("_");
  if (parts.length <= 1) {
    return rawName.trim();
  }

  const nameParts = parts.slice(1);
  if (nameParts.length === 1) {
    return nameParts[0].trim();
  }

  const prefix = nameParts.slice(0, -1).join(" ").trim();
  const suffix = nameParts[nameParts.length - 1].trim();
  return `${prefix} - ${suffix}`;
}

function resolveUser(user: MyGeotabUser): ResolvedUser {
  return {
    id: user.id,
    name: user.name || "Unknown",
    roles: user.role ? [user.role] : ["EMPLOYEE"],
    companyGroups: user.companyGroups ?? [],
  };
}

function resolveBooking(
  booking: OpexBooking,
  devices: Map<string, MyGeotabDevice>,
  users: Map<string, MyGeotabUser>,
): ResolvedBooking {
  const device = devices.get(booking.deviceId);
  const requester = users.get(booking.requesterUserId);
  const driver = booking.assignedDriverUserId ? users.get(booking.assignedDriverUserId) : undefined;
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
    requester_name: requester?.name ?? "Unknown User",
    requested_class: booking.requestedClass,
    asset_id: booking.deviceId ?? null,
    asset_code: device ? `VEH-${device.id.slice(-3).toUpperCase()}` : null,
    asset_name: device ? parseVehicleName(device.name ?? "") : null,
    registration_no: device?.licensePlate ?? null,
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
    driver_name: driver?.name ?? null,
    dataQuality: validation.quality,
  };
}

/*â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Local Data Provider Implementation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€*/
export class LocalBookingDataProvider implements BookingDataProvider, NotificationDataProvider {
  private devices: MyGeotabDevice[];
  private users: MyGeotabUser[];
  private groups: MyGeotabGroup[];
  private statusData: MyGeotabStatusData[];
  private logRecords: MyGeotabLogRecord[];
  private bookings: OpexBooking[];
  private notifications: OpexNotification[];
  private auditRecords: OpexBookingAudit[];
  private canonicalAuditRecords: OpexBookingAuditV2[];
  private pendingAuditRecords: OpexAuditPending[];
  private deadLetterRecords: OpexAuditDeadLetter[];

  constructor() {
    this.devices = [...mockMyGeotabDevices];
    this.users = [...mockMyGeotabUsers];
    this.groups = [...mockMyGeotabGroups];
    this.statusData = [...mockMyGeotabStatusData];
    this.logRecords = [...mockMyGeotabLogRecords];
    this.bookings = [...mockOpexBookings];
    this.notifications = [];
    this.auditRecords = [];
    this.canonicalAuditRecords = [];
    this.pendingAuditRecords = [];
    this.deadLetterRecords = [];
  }

  /*â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Master data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€*/
  async getAssets(): Promise<ResolvedAsset[]> {
    return this.devices.map(resolveAsset);
  }

  async getUsers(): Promise<ResolvedUser[]> {
    return this.users.map(resolveUser);
  }

  async getGroups(): Promise<MyGeotabGroup[]> {
    return [...this.groups];
  }

  async getStatusData(): Promise<MyGeotabStatusData[]> {
    return [...this.statusData];
  }

  async getLogRecords(): Promise<MyGeotabLogRecord[]> {
    return [...this.logRecords];
  }

  /*â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Booking operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€*/
  async getBookings(): Promise<ResolvedBooking[]> {
    const deviceMap = new Map(this.devices.map(d => [d.id, d]));
    const userMap = new Map(this.users.map(u => [u.id, u]));
    return this.bookings.map(b => resolveBooking(b, deviceMap, userMap));
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
    const newId = generateBusinessId();
    const now = new Date().toISOString();

    const booking: OpexBooking = {
      recordType: "booking",
      schemaVersion: SCHEMA_VERSION,
      id: newId,
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

    this.bookings.push(booking);

    const deviceMap = new Map(this.devices.map(d => [d.id, d]));
    const userMap = new Map(this.users.map(u => [u.id, u]));
    return resolveBooking(booking, deviceMap, userMap);
  }

  async updateBookingStatus(id: string, status: string, expectedVersion: number, approverId?: string, approvalRemarks?: string): Promise<void> {
    const idx = this.bookings.findIndex(b => b.id === id);
    if (idx === -1) throw new Error(`BOOKING_NOT_FOUND: ${id}`);
    if (this.bookings[idx].version !== expectedVersion) {
      throw new Error(`OPTIMISTIC_LOCK_CONFLICT: Booking ${id} version is ${this.bookings[idx].version}, expected ${expectedVersion}. It may have been modified by another user.`);
    }
    this.bookings[idx] = {
      ...this.bookings[idx],
      status: status as OpexBooking["status"],
      ...(approverId !== undefined ? { approverId } : {}),
      ...(approvalRemarks !== undefined ? { approvalRemarks } : {}),
      updatedAt: new Date().toISOString(),
      version: this.bookings[idx].version + 1,
    };
  }

  async deleteBooking(id: string): Promise<void> {
    const idx = this.bookings.findIndex(b => b.id === id);
    if (idx === -1) throw new Error(`BOOKING_NOT_FOUND: ${id}`);
    this.bookings.splice(idx, 1);
  }

  async resetDemoData(): Promise<void> {
    this.bookings = [...mockOpexBookings];
    this.notifications = [];
    this.auditRecords = [];
    this.canonicalAuditRecords = [];
    this.pendingAuditRecords = [];
  }

  /*â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Notification operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€*/
  async getNotifications(userId: string, opts?: { limit?: number; offset?: number; unreadOnly?: boolean; type?: NotificationType }): Promise<OpexNotification[]> {
    let result = this.notifications
      .filter(n => n.recipient_user_id === userId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    if (opts?.unreadOnly) result = result.filter(n => !n.is_read);
    if (opts?.type) result = result.filter(n => n.type === opts.type);
    const start = opts?.offset ?? 0;
    const end = opts?.limit !== undefined ? start + opts.limit : result.length;
    return result.slice(start, end);
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.notifications.filter(n => n.recipient_user_id === userId && !n.is_read).length;
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
    this.notifications.push(notification);
    return notification;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<OpexNotification | null> {
    const found = this.notifications.find(n => n.idempotencyKey === idempotencyKey);
    return found ?? null;
  }

  async markAsRead(notificationId: string, actorUserId: string): Promise<void> {
    const idx = this.notifications.findIndex(n => n.id === notificationId);
    if (idx === -1) return;
    /* Mandatory actor validation: fail closed when the actor is missing/blank
       or does not own the notification. */
    if (!actorUserId || !actorUserId.trim() || this.notifications[idx].recipient_user_id !== actorUserId) return;
    this.notifications[idx] = { ...this.notifications[idx], is_read: true, updated_at: new Date().toISOString() };
  }

  async markAllAsRead(userId: string, actorUserId: string): Promise<void> {
    /* Mandatory actor validation: only the verified actor may mark their own
       notifications as read. */
    if (!actorUserId || !actorUserId.trim() || userId !== actorUserId) return;
    const now = new Date().toISOString();
    this.notifications = this.notifications.map(n =>
      n.recipient_user_id === userId && !n.is_read
        ? { ...n, is_read: true, updated_at: now }
        : n
    );
  }

  async markDeliveryStatus(notificationId: string, status: "pending" | "delivered" | "failed", actorUserId: string): Promise<void> {
    const idx = this.notifications.findIndex(n => n.id === notificationId);
    if (idx === -1) return;
    /* Mandatory actor validation: fail closed when the actor is missing/blank
       or does not own the notification. */
    if (!actorUserId || !actorUserId.trim() || this.notifications[idx].recipient_user_id !== actorUserId) return;
    this.notifications[idx] = {
      ...this.notifications[idx],
      delivery_status: status,
      delivered_at: status === "delivered" ? new Date().toISOString() : this.notifications[idx].delivered_at,
      updated_at: new Date().toISOString(),
    };
  }

  /*â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Audit operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€*/
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
    this.auditRecords.push(record);
  }

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
    this.canonicalAuditRecords.push(event);
  }

  async getAuditRecords(bookingId: string): Promise<NormalizedAuditEvent[]> {
    const normalized: NormalizedAuditEvent[] = [];
    for (const r of this.auditRecords) {
      if (r.booking_id !== bookingId) continue;
      normalized.push({
        recordType: "booking_audit",
        schemaVersion: r.schemaVersion,
        id: r.id,
        auditKey: undefined,
        bookingKey: r.booking_id,
        action: r.action,
        actor: { userId: r.actor_user_id, userName: undefined, role: undefined },
        occurredAtUtc: r.created_at,
        previousStatus: r.previous_status,
        newStatus: r.new_status,
        changes: null,
        metadata: null,
        sourceFormat: "legacy",
      });
    }
    for (const r of this.canonicalAuditRecords) {
      if (r.bookingKey !== bookingId) continue;
      const n = normalizeAuditRecord(r, r.auditKey);
      if (n) normalized.push(n);
    }
    return normalized.sort((a, b) => {
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
    this.pendingAuditRecords.push(record);
    return record;
  }

  async getAuditPending(): Promise<OpexAuditPending[]> {
    return [...this.pendingAuditRecords]
      .sort((a, b) => {
        const da = a.next_retry_at ? new Date(a.next_retry_at).getTime() : 0;
        const db = b.next_retry_at ? new Date(b.next_retry_at).getTime() : 0;
        return da - db;
      });
  }

  async deleteAuditPending(id: string): Promise<void> {
    this.pendingAuditRecords = this.pendingAuditRecords.filter(p => p.id !== id);
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
    this.deadLetterRecords.push(record);
    return record;
  }

  async getAuditDeadLetters(): Promise<OpexAuditDeadLetter[]> {
    return [...this.deadLetterRecords]
      .sort((a, b) => {
        const da = a.dead_lettered_at ? new Date(a.dead_lettered_at).getTime() : 0;
        const db = b.dead_lettered_at ? new Date(b.dead_lettered_at).getTime() : 0;
        return db - da;
      });
  }

  isLive(): boolean {
    return false;
  }

  async getApprovers(): Promise<ResolvedUser[]> {
    return this.users
      .filter(u => u.role === "APPROVER")
      .map(resolveUser);
  }
}

/*â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Singleton instance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€*/
export const bookingDataProvider = new LocalBookingDataProvider();
