/*───────────────────── MyGeotab-Aligned Types ─────────────────────*/

/* Local MyGeotab type definitions (no dependency on external API backend). */
export type GeotabDevice = { id: string; name?: string; serialNumber?: string };
export type GeotabUser = { id: string; name?: string; firstName?: string; lastName?: string };
export type GeotabTrip = { id?: string; device?: { id: string }; start?: string; stop?: string };
export type GeotabLocation = { device?: { id: string }; dateTime?: string; latitude?: number; longitude?: number };

/*───────────────────── Groups ─────────────────────*/
export interface MyGeotabGroup {
  id: string;
  name: string;
  parentId?: string;
}

/*───────────────────── Devices (extended GeotabDevice) ─────────────────────*/
export interface MyGeotabDevice extends GeotabDevice {
  licensePlate?: string;
  make?: string;
  model?: string;
  vehicleClass?: "OPERATIONAL_4X4" | "PASSENGER";
  groupIds: string[];
  status: "AVAILABLE" | "MAINTENANCE" | "OUT_OF_SERVICE";
}

/*───────────────────── Users (extended GeotabUser) ─────────────────────*/
export interface MyGeotabUser extends GeotabUser {
  email: string;
  companyGroups: string[];
  securityClearance?: string[];
  role?: "EMPLOYEE" | "APPROVER" | "GA" | "MANAGEMENT" | "ADMIN";
  siteCode?: string;
}

/*───────────────────── Telemetry ─────────────────────*/
export interface MyGeotabStatusData extends GeotabLocation {
  id: string;
  deviceId: string;
  odometer?: number;
  fuelLevel?: number;
  engineHours?: number;
}

export interface MyGeotabLogRecord extends GeotabLocation {
  id: string;
  deviceId: string;
  speed?: number;
  heading?: number;
}

/*───────────────────── OPEX Booking data quality ─────────────────────*/

export type BookingDataQuality =
  | "VALID"
  | "MISSING_ASSET"
  | "MISSING_REQUESTER"
  | "MISSING_STATUS"
  | "INVALID_DATETIME"
  | "MALFORMED_DETAILS"
  | "MULTIPLE_VALIDATION_ERRORS";

export interface BookingValidationResult {
  quality: BookingDataQuality;
  issues: string[];
}

/*───────────────────── Record type discriminator ─────────────────────*/
/* Discriminates the logical entity kind stored in a single AddInData
   entity store. Every persistent record carries recordType and
   schemaVersion so the client can normalize legacy records and evolve
   the schema without server-side migrations. */
export type RecordType = "booking" | "booking_audit" | "bookingAudit" | "notification" | "vehicle_hold" | "audit_dead_letter" | "reconciliation_finding";

export const SCHEMA_VERSION = 1;

/* Stable business identifier generator. Produces a UUID v4 string used
   as the logical business id (details.id), distinct from the MyGeotab
   AddInData server record id (record.id). */
export function generateBusinessId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  /* Fallback for environments without crypto.randomUUID. */
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/*───────────────────── OPEX Booking (MyGeotab-aligned) ─────────────────────*/
export interface OpexBooking {
  recordType: RecordType;
  schemaVersion: number;
  id: string;
  deviceId: string;
  requesterUserId: string;
  requestedClass: "OPERATIONAL_4X4" | "PASSENGER";
  startAt: string;
  endAt: string;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  purpose: string;
  destination: string | null;
  passengerCount: number | null;
  status:
    | "DRAFT"
    | "SUBMITTED"
    | "PENDING_APPROVAL"
    | "APPROVED"
    | "ASSIGNED"
    | "CHECKED_OUT"
    | "OVERDUE"
    | "RETURNED"
    | "CLOSED"
    | "COMPLETED"
    | "REJECTED"
    | "CANCELLED"
    | "EXPIRED";
  assignedDriverUserId: string | null;
  approverId: string | null;
  approvalRemarks: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/*───────────────────── Vehicle hold (MyGeotab-aligned) ─────────────────────*/
export interface OpexVehicleHold {
  recordType: RecordType;
  schemaVersion: number;
  id: string;
  vehicleId: string;
  startAt: string;
  endAt: string;
  reason: string;
  status: "ACTIVE" | "CANCELLED";
  createdBy: string | null;
  createdAt: string;
}

/*───────────────────── Frontend-view types (resolved through master data) ─────────────────────*/
export interface ResolvedAsset {
  id: string;
  asset_code: string;
  asset_name: string;
  serial_number: string | null;
  make_model: string;
  asset_class: string;
  registration_no: string | null;
  status: string;
  geotab_device_id: string | null;
}

export interface ResolvedBooking {
  recordType: RecordType;
  schemaVersion: number;
  id: string;
  requester_id: string;
  requester_name: string;
  requested_class: string;
  asset_id: string | null;
  asset_code: string | null;
  asset_name: string | null;
  registration_no: string | null;
  start_at: string;
  end_at: string;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  purpose: string;
  destination: string | null;
  passenger_count: number | null;
  status: string;
  approver_id: string | null;
  approval_remarks: string | null;
  version: number;
  created_at: string;
  updated_at: string;
    driver_id: string | null;
    driver_name: string | null;
    dataQuality: BookingDataQuality;
}

export interface ResolvedUser {
  id: string;
  name: string;
  roles: string[];
  companyGroups?: string[];
}

/*───────────────────── Data Provider Interface ─────────────────────*/
export interface BookingDataProvider {
  getAssets(): Promise<ResolvedAsset[]>;
  getUsers(): Promise<ResolvedUser[]>;
  getGroups(): Promise<MyGeotabGroup[]>;
  getStatusData(): Promise<MyGeotabStatusData[]>;
  getLogRecords(): Promise<MyGeotabLogRecord[]>;
  getBookings(): Promise<ResolvedBooking[]>;
  createBooking(input: {
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
  }): Promise<ResolvedBooking>;
  updateBookingStatus(id: string, status: string, expectedVersion: number, approverId?: string, approvalRemarks?: string): Promise<void>;
  deleteBooking(id: string): Promise<void>;
  resetDemoData(): Promise<void>;
  isLive(): boolean;
  getApprovers(): Promise<ResolvedUser[]>;
}

/*───────────────────── Notification Types ─────────────────────*/

export type NotificationType =
  | "booking_created"
  | "booking_approved"
  | "booking_rejected"
  | "vehicle_assigned"
  | "booking_cancelled";

export interface OpexNotification {
  recordType: RecordType;
  schemaVersion: number;
  id: string;
  eventId: string;
  idempotencyKey: string;
  type: NotificationType;
  recipient_user_id: string;
  related_booking_id: string | null;
  title: string;
  message: string;
  is_read: boolean;
  delivery_status: "pending" | "delivered" | "failed";
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OpexBookingAudit {
  recordType: RecordType;
  schemaVersion: number;
  id: string;
  booking_id: string;
  action: string;
  actor_user_id: string;
  previous_status: string | null;
  new_status: string | null;
  details: string | null;
  created_at: string;
}

/*───────────────────── Canonical Booking Audit Event (bookingAudit) ─────────────────────*/
/* Canonical, structured, compact audit event schema. recordType "bookingAudit"
   is the new standard; legacy "booking_audit" records remain readable via the
   normalization layer (auditEvent.ts) and are never rewritten or deleted. */

/* Standardized business event names emitted by the booking audit trail. */
export type BookingAction =
  | "BOOKING_CREATED"
  | "BOOKING_UPDATED"
  | "BOOKING_SUBMITTED"
  | "BOOKING_APPROVED"
  | "BOOKING_REJECTED"
  | "BOOKING_CANCELLED"
  | "BOOKING_RESCHEDULED"
  | "VEHICLE_ASSIGNED"
  | "DRIVER_ASSIGNED"
  | "BOOKING_COMPLETED";

/* Verified actor identity derived from the authenticated MyGeotab principal.
   userId is the primary identifier; userName and role are included only when
   verified and available (never trusted from the browser). */
export interface ActorInfo {
  userId: string;
  userName?: string;
  role?: string;
}

/* A single changed field with before/after values. null means the field did
   not previously exist. Only fields that actually changed are stored. */
export interface AuditChange {
  from: unknown;
  to: unknown;
}

/* Minimal technical context. No session IDs, credentials, or request bodies. */
export interface AuditMetadata {
  source: string;
  mode: "ADDIN_DATA" | "DEMO";
}

/* Canonical booking audit event stored in AddInData as recordType "bookingAudit". */
export interface OpexBookingAuditV2 {
  recordType: "bookingAudit";
  schemaVersion: 1;
  auditKey: string;
  bookingKey: string;
  action: BookingAction;
  actor: ActorInfo;
  occurredAtUtc: string;
  previousStatus: string | null;
  newStatus: string | null;
  changes: Record<string, AuditChange>;
  metadata: AuditMetadata;
}

/* Guard: true when a parsed AddInData record is a canonical bookingAudit event. */
export function isCanonicalAudit(record: unknown): record is OpexBookingAuditV2 {
  return typeof record === "object" && record !== null && (record as Record<string, unknown>).recordType === "bookingAudit";
}

/* Input for creating a canonical booking audit event (recordType/schemaVersion
   are set by the provider at write time). */
export type CanonicalAuditInput = Omit<OpexBookingAuditV2, "recordType" | "schemaVersion">;

/* Normalized audit event usable by UI/reconciliation regardless of storage
   format (legacy "booking_audit" or canonical "bookingAudit"). */
export interface NormalizedAuditEvent {
  recordType: RecordType;
  schemaVersion: number;
  id: string;
  auditKey?: string;
  bookingKey?: string;
  action: string;
  actor: ActorInfo;
  occurredAtUtc?: string;
  previousStatus: string | null;
  newStatus: string | null;
  changes: Record<string, AuditChange> | null;
  metadata: AuditMetadata | null;
  sourceFormat: "canonical" | "legacy";
}

/* Normalize any AddInData audit record (legacy or canonical) into a common
   in-memory shape. Records that cannot be normalized are preserved as
   legacy/insufficient-evidence entries rather than silently dropped. */
export function normalizeAuditRecord(
  raw: unknown,
  addInRecordId?: string,
): NormalizedAuditEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const recordType = obj.recordType;
  const now = new Date().toISOString();

  if (recordType === "bookingAudit") {
    const actorRaw = obj.actor && typeof obj.actor === "object" ? (obj.actor as Record<string, unknown>) : null;
    const actor: ActorInfo = actorRaw
      ? {
          userId: String(actorRaw.userId ?? ""),
          ...(typeof actorRaw.userName === "string" ? { userName: actorRaw.userName } : {}),
          ...(typeof actorRaw.role === "string" ? { role: actorRaw.role } : {}),
        }
      : { userId: String(obj.actor_user_id ?? ""), userName: undefined, role: undefined };
    return {
      recordType: "bookingAudit",
      schemaVersion: Number(obj.schemaVersion ?? 1),
      id: String(obj.auditKey ?? obj.id ?? addInRecordId ?? ""),
      auditKey: String(obj.auditKey ?? ""),
      bookingKey: String(obj.bookingKey ?? obj.booking_id ?? ""),
      action: String(obj.action ?? ""),
      actor,
      occurredAtUtc: typeof obj.occurredAtUtc === "string" ? obj.occurredAtUtc : undefined,
      previousStatus: (obj.previousStatus as string | null) ?? null,
      newStatus: (obj.newStatus as string | null) ?? null,
      changes: obj.changes && typeof obj.changes === "object" ? (obj.changes as Record<string, AuditChange>) : null,
      metadata: obj.metadata && typeof obj.metadata === "object" ? (obj.metadata as AuditMetadata) : null,
      sourceFormat: "canonical",
    };
  }

  /* Legacy "booking_audit" normalization. */
  if (recordType === "booking_audit") {
    return {
      recordType: "booking_audit",
      schemaVersion: Number(obj.schemaVersion ?? 1),
      id: String(obj.id ?? addInRecordId ?? ""),
      auditKey: undefined,
      bookingKey: String(obj.booking_id ?? ""),
      action: String(obj.action ?? ""),
      actor: { userId: String(obj.actor_user_id ?? ""), userName: undefined, role: undefined },
      occurredAtUtc: typeof obj.created_at === "string" ? obj.created_at : undefined,
      previousStatus: (obj.previous_status as string | null) ?? null,
      newStatus: (obj.new_status as string | null) ?? null,
      changes: null,
      metadata: null,
      sourceFormat: "legacy",
    };
  }

  return null;
}

/*───────────────────── Audit pending queue (retry/recovery) ─────────────────────*/
/* Audit records that failed to write to AddInData are stored here as pending
   records with recordType "booking_audit". A recovery process retries them
   with exponential backoff until they succeed or reach max attempts. */
export interface OpexAuditPending {
  recordType: RecordType;
  schemaVersion: number;
  id: string;
  booking_id: string;
  action: string;
  actor_user_id: string;
  previous_status: string | null;
  new_status: string | null;
  details: string | null;
  created_at: string;
  retry_count: number;
  max_retries: number;
  last_error: string | null;
  next_retry_at: string | null;
}

/*───────────────────── Audit dead letter (exhausted retries) ─────────────────────*/
/* Audit records that exceed max_retries are moved to dead-letter state instead
   of being deleted. This preserves the original event, error, and retry metadata
   for later inspection and manual recovery. */
export interface OpexAuditDeadLetter {
  recordType: RecordType;
  schemaVersion: number;
  id: string;
  booking_id: string;
  action: string;
  actor_user_id: string;
  previous_status: string | null;
  new_status: string | null;
  details: string | null;
  created_at: string;
  retry_count: number;
  max_retries: number;
  last_error: string | null;
  next_retry_at: string | null;
  dead_lettered_at: string;
  original_pending_id: string;
}

/*───────────────────── Audit reconciliation ─────────────────────*/
/* Result of reconciling bookings against audit records to find
   bookings that are missing expected audit events. */
export interface AuditReconciliationResult {
  booking_id: string;
  booking_status: string;
  missing_audit_actions: string[];
  last_audit_action: string | null;
  last_audit_timestamp: string | null;
}

/*───────────────────── Reconciliation Finding Types ─────────────────────*/
/* Classification of reconciliation findings. Distinguishes between
   legitimate partial writes, interrupted application operations,
   potential unauthorized direct writes, and insufficient evidence. */
export type ReconciliationFindingType =
  | "MISSING_AUDIT_EVENT"
  | "UNEXPECTED_STATUS_TRANSITION"
  | "INVALID_ACTOR_ATTRIBUTION"
  | "VERSION_MISMATCH"
  | "DUPLICATE_BOOKING_RECORD"
  | "DUPLICATE_AUDIT_EVENT"
  | "RECORD_MODIFIED_WITHOUT_AUDIT"
  | "RECORD_DELETED_WITHOUT_AUDIT"
  | "NOTIFICATION_MANIPULATION"
  | "INCONSISTENT_BOOKING_STATE"
  | "INSUFFICIENT_EVIDENCE";

export type ReconciliationSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type ReconciliationStatus = "OPEN" | "INVESTIGATING" | "RESOLVED" | "FALSE_POSITIVE";

/* A structured reconciliation finding. Stored in AddInData as recordType
   "reconciliation_finding" and exposed through the security monitoring
   dashboard. Original audit evidence is never overwritten. */
export interface OpexReconciliationFinding {
  recordType: RecordType;
  schemaVersion: number;
  id: string;
  finding_id: string;
  booking_id: string;
  finding_type: ReconciliationFindingType;
  severity: ReconciliationSeverity;
  expected_state: string | null;
  observed_state: string | null;
  detection_timestamp: string;
  related_audit_references: string[];
  reconciliation_status: ReconciliationStatus;
  evidence_classification: "LEGITIMATE_PARTIAL_WRITE" | "INTERRUPTED_OPERATION" | "POTENTIAL_UNAUTHORIZED_WRITE" | "INSUFFICIENT_EVIDENCE";
  notes: string | null;
}

/*───────────────────── Reconciliation State (Service Add-In) ─────────────────────*/
/* Tracks reconciliation run state for the Service Add-In. Stored in
   localStorage to prevent overlapping runs within the same instance.
   NOTE: localStorage does not provide atomic distributed locking — it is
   a best-effort, single-origin mechanism shared across tabs. */
export interface ReconciliationRunState {
  last_successful_reconciliation: string | null;
  last_error: string | null;
  last_error_timestamp: string | null;
  last_run_timestamp: string | null;
  reconciliation_in_progress: boolean;
  total_findings: number;
  open_findings: number;
  lock_owner: string | null;
  lock_acquired_at: string | null;
}

/*───────────────────── Notification Provider Interface ─────────────────────*/

export interface NotificationDataProvider {
  getNotifications(userId: string, opts?: { limit?: number; offset?: number; unreadOnly?: boolean; type?: NotificationType }): Promise<OpexNotification[]>;
  getUnreadCount(userId: string): Promise<number>;
  createNotification(input: {
    eventId: string;
    idempotencyKey: string;
    type: NotificationType;
    recipient_user_id: string;
    related_booking_id: string | null;
    title: string;
    message: string;
  }): Promise<OpexNotification>;
  findByIdempotencyKey(idempotencyKey: string): Promise<OpexNotification | null>;
  markAsRead(notificationId: string, actorUserId: string): Promise<void>;
  markAllAsRead(userId: string, actorUserId: string): Promise<void>;
  markDeliveryStatus(notificationId: string, status: "pending" | "delivered" | "failed", actorUserId: string): Promise<void>;
  createAuditRecord(input: {
    booking_id: string;
    action: string;
    actor_user_id: string;
    previous_status: string | null;
    new_status: string | null;
    details: string | null;
  }): Promise<void>;
  createBookingAuditEvent(input: CanonicalAuditInput): Promise<void>;
  getAuditRecords(bookingId: string): Promise<NormalizedAuditEvent[]>;
  createAuditPending(input: Omit<OpexAuditPending, "id" | "schemaVersion" | "recordType" | "created_at" | "retry_count" | "next_retry_at" | "max_retries" | "last_error">): Promise<OpexAuditPending>;
  getAuditPending(): Promise<OpexAuditPending[]>;
  deleteAuditPending(id: string): Promise<void>;
  createAuditDeadLetter(input: Omit<OpexAuditDeadLetter, "id" | "schemaVersion" | "recordType" | "created_at" | "dead_lettered_at">): Promise<OpexAuditDeadLetter>;
  getAuditDeadLetters(): Promise<OpexAuditDeadLetter[]>;
  isLive(): boolean;
}
