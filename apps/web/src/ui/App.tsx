import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { bookingDataProvider } from "../data/dataProvider";
import type { ResolvedAsset, ResolvedBooking, ResolvedUser, BookingDataProvider, OpexNotification, NotificationType, NotificationDataProvider } from "../data/types";
import { createAddInDataProvider } from "../data/addinDataProvider";
import { createNotificationEngine } from "../data/notificationService";
import { useAutoRefresh } from "./autoRefresh";
import { formatStatusLabel, statusClassKey } from "./statusHelpers";
import { DEFAULT_ADDIN_ID, ADDIN_ID_STORAGE_KEY, resolveAddInId, isValidAddInId } from "../config/addinId";
import { getLifecycleApi, subscribeToLifecycle } from "../config/lifecycleBridge";
import {
  resolveAuthenticatedPrincipal,
  canPerformLiveWrite,
  getLiveBlockedReason,
  getActorIdForMode,
  getSessionCredentials,
  type IdentityResolutionState,
  type AppMode,
} from "../auth/identityResolver";
import {
  authorizeAction,
  canPerformAction,
  type BookingAction,
} from "../auth/authorization";
import { ServerAuthzClient } from "../auth/serverAuthzClient";
import { canRunDemoOnlyOperation, assertDemoOnlyOperation, assertProviderNotLiveForDemoOperation, getStateResetOnModeSwitch, isKnownMode } from "../safety/modeGuards";
import { emitAuditEvent, snapshotBooking, type AuditAction } from "../audit/auditTrail";
import { getTenantTimezone, toTenantLocalParts, toIsoFromTenantParts, formatTenantDateTime } from "../config/tenantTimezone";
import { sortByDateTimeAccessor } from "./sortingHelpers";
import { validateResolvedBooking, type BookingDataQuality } from "../data/bookingValidation";
import { ErrorBoundary } from "./errorBoundary";

const TENANT = import.meta.env.VITE_GEOTAB_DATABASE || "opex_trial";
const AUTHZ_API_BASE_URL = import.meta.env.VITE_AUTHZ_API_BASE_URL || "";

type GeotabApi = {
  call?: (method: string, params: Record<string, unknown>, success: (result: unknown) => void, error?: (error: unknown) => void) => void;
  getSession?: (callback: (session: { userName?: string; database?: string; server?: string } | null) => void) => void;
};

type ActorContext = {
  id: string;
  name: string;
  roles: string[];
  kind: "authenticated" | "demo";
};

/*───────────────────── Types ─────────────────────*/

type Asset = {
  id: string;
  asset_code: string;
  asset_name: string;
  serial_number: string | null;
  make_model: string;
  asset_class: string;
  registration_no: string | null;
  status: string;
  geotab_device_id: string | null;
  groupIds?: string[];
};
type Booking = {
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
  version: number;
  created_at: string;
  updated_at: string;
  driver_id: string | null;
  driver_name: string | null;
  approver_id: string | null;
  approval_remarks: string | null;
  dataQuality: BookingDataQuality;
};

type Toast = {
  id: string;
  type: "success" | "error" | "warn";
  text: string;
};

type ConfirmDialog = {
  id: string;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/*───────────────────── Navigation ─────────────────────*/

const NAV_ITEMS: Array<{ key: string; label: string }> = [
  { key: "Dashboard", label: "Dashboard" },
  { key: "New Booking", label: "New Booking" },
  { key: "My Bookings", label: "My Bookings" },
  { key: "Approval Inbox", label: "Approval Inbox" },
  { key: "Notifications", label: "Notifications" },
  { key: "Asset Availability", label: "Asset Availability" },
  { key: "Booking Reports", label: "Booking Reports" },
];

/*───────────────────── Helpers ─────────────────────*/

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function parseISO(s: string): Date { return new Date(s); }

function formatDate(s: string): string {
  return new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatTime(s: string): string {
  return new Date(s).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(s: string): string {
  return new Date(s).toLocaleString();
}

function computeTimeRange(range: string, customFrom?: string, customTo?: string): { from: string; to: string } | null {
  const now = new Date();
  if (range === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { from: start.toISOString(), to: end.toISOString() };
  }
  if (range === "thisWeek") {
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    return { from: monday.toISOString(), to: sunday.toISOString() };
  }
  if (range === "thisMonth") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { from: start.toISOString(), to: end.toISOString() };
  }
  if (range === "last30Days") {
    const start = new Date(now);
    start.setDate(now.getDate() - 30);
    start.setHours(0, 0, 0, 0);
    return { from: start.toISOString(), to: now.toISOString() };
  }
  if (range === "custom" && customFrom && customTo) {
    const start = new Date(`${customFrom}T00:00:00`);
    const end = new Date(`${customTo}T23:59:59.999`);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
    return { from: start.toISOString(), to: end.toISOString() };
  }
  return null;
}

function filterBookings(bookings: ResolvedBooking[], f: {
  timeRange: string; customFrom: string; customTo: string;
  statusFilter: string; asset: string; user: string;
}): ResolvedBooking[] {
  const range = computeTimeRange(f.timeRange, f.customFrom, f.customTo);
  return bookings.filter(b => {
    if (range) {
      const bStart = new Date(b.start_at).getTime();
      const bEnd = new Date(b.end_at).getTime();
      const fFrom = new Date(range.from).getTime();
      const fTo = new Date(range.to).getTime();
      if (bEnd < fFrom || bStart > fTo) return false;
    }
    if (f.statusFilter && b.status !== f.statusFilter) return false;
    if (f.asset && b.asset_id !== f.asset) return false;
    if (f.user && b.requester_id !== f.user) return false;
    return true;
  });
}

function exportCSV(data: Array<Record<string, unknown>>, filename: string) {
  if (!data.length) return;
  const headers = Object.keys(data[0]);
  const escape = (val: unknown) => {
    const s = String(val ?? "");
    if (/[",\n]/.test(s)) return `"${String(s).replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(","), ...data.map(row => headers.map(h => escape(row[h])).join(","))];
  const csv = lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/*───────────────────── Toast System ─────────────────────*/

function pushToast(setToasts: React.Dispatch<React.SetStateAction<Toast[]>>, type: Toast["type"], text: string) {
  const id = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  setToasts(prev => [...prev, { id, type, text }]);
  setTimeout(() => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, 5000);
}

/*───────────────────── Reusable UI Components ─────────────────────*/

function StatCard({ label, value, sub, trend }: {
  label: string; value: string | number; sub: string; trend?: { dir: "up" | "down" | "neutral"; label: string };
}) {
  return (
    <article className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
      {trend && (
        <div className={`stat-trend ${trend.dir}`}>{trend.dir === "up" ? "▲" : trend.dir === "down" ? "▼" : "—"} {trend.label}</div>
      )}
    </article>
  );
}

function StatusBadge({ status }: { status?: string }) {
  const cls = "badge " + statusClassKey(status);
  const label = formatStatusLabel(status);
  return <span className={cls}>{label}</span>;
}

function AssetStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    AVAILABLE: "badge-asset-available",
    MAINTENANCE: "badge-asset-maintenance",
    OUT_OF_SERVICE: "badge-asset-unavailable",
  };
  const cls = "badge " + (map[status] || "badge-asset-unavailable");
  const label = status === "AVAILABLE" ? "Available" : status === "MAINTENANCE" ? "Maintenance" : "Unavailable";
  return <span className={cls}>{label}</span>;
}

function LoadingState({ message = "Loading…" }: { message?: string }) {
  return (
    <div className="loading-state">
      <b>{message}</b>
    </div>
  );
}

function EmptyState({ title, message, action }: { title: string; message: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="empty-state">
      <b>{title}</b>
      <p>{message}</p>
      {action && (
        <button className="btn btn-primary" onClick={action.onClick} style={{ marginTop: 16 }}>
          {action.label}
        </button>
      )}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state">
      <b>Error</b>
      <p>{message}</p>
      {onRetry && <button className="btn btn-primary" onClick={onRetry} style={{ marginTop: 16 }}>Retry</button>}
    </div>
  );
}

function PageHeader({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }) {
  return (
    <div className="page-header">
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  return (
    <div className={`toast toast-${toast.type}`}>
      <span className="toast-message">{toast.text}</span>
      <button className="toast-dismiss" onClick={() => onDismiss(toast.id)}>×</button>
    </div>
  );
}

function ConfirmDialog({
  dialog,
  onConfirm,
  onCancel,
}: {
  dialog: ConfirmDialog;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{dialog.title}</h2>
          <button className="btn btn-sm btn-secondary" onClick={onCancel}>Close</button>
        </div>
        <div className="modal-body confirm-dialog">
          <p>{dialog.message}</p>
          <div className="confirm-actions">
            <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
            <button className="btn btn-primary" onClick={onConfirm}>Confirm</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/*───────────────────── Booking Filter Bar ─────────────────────*/

function BookingFilterBar({
  filters,
  onFilterChange,
  onApplyFilters,
  onResetFilters,
  assets,
  users,
  isApprovalInbox = false,
}: {
  filters: { timeRange: string; customFrom: string; customTo: string; statusFilter: string; asset: string; user: string };
  onFilterChange: (key: string, value: string) => void;
  onApplyFilters: () => void;
  onResetFilters: () => void;
  assets: Asset[];
  users: ResolvedUser[];
  isApprovalInbox?: boolean;
}) {
  const timeRangeOptions = [
    { value: "", label: "All Time" },
    { value: "today", label: "Today" },
    { value: "thisWeek", label: "This Week" },
    { value: "thisMonth", label: "This Month" },
    { value: "last30Days", label: "Last 30 Days" },
    { value: "custom", label: "Custom Date Range" },
  ];
  const statusOptions = [
    { value: "", label: "All Status" },
    { value: "PENDING_APPROVAL", label: "Pending Approval" },
    { value: "APPROVED", label: "Approved" },
    { value: "REJECTED", label: "Rejected" },
    { value: "CANCELLED", label: "Cancelled" },
    { value: "COMPLETED", label: "Completed" },
  ];
  const hasActiveFilters = filters.timeRange || filters.customFrom || filters.customTo || filters.statusFilter || filters.asset || filters.user;
  const customInvalid = filters.timeRange === "custom" && filters.customFrom && filters.customTo && filters.customFrom > filters.customTo;

  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-head-content">
          <h2>Filters</h2>
          <p>Filter bookings by time range, status, asset, and user.</p>
        </div>
      </div>
      <div className="panel-body">
        <div className="filters">
          <div className="form-group">
            <label>Time Range</label>
            <select className="form-control" value={filters.timeRange} onChange={e => onFilterChange("timeRange", e.target.value)}>
              {timeRangeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {!isApprovalInbox && (
            <div className="form-group">
              <label>Status</label>
              <select className="form-control" value={filters.statusFilter} onChange={e => onFilterChange("statusFilter", e.target.value)}>
                {statusOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          )}
          <div className="form-group">
            <label>Asset</label>
            <select className="form-control" value={filters.asset} onChange={e => onFilterChange("asset", e.target.value)}>
              <option value="">All Assets</option>
              {assets.map(a => <option key={a.id} value={a.id}>{a.asset_code}</option>)}
            </select>
          </div>
          {!isApprovalInbox && (
            <div className="form-group">
              <label>User</label>
              <select className="form-control" value={filters.user} onChange={e => onFilterChange("user", e.target.value)}>
                <option value="">All Users</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          )}
          {filters.timeRange === "custom" && (
            <div className="form-group">
              <label>Start Date</label>
              <input className="form-control" type="date" value={filters.customFrom} onChange={e => onFilterChange("customFrom", e.target.value)} />
            </div>
          )}
          {filters.timeRange === "custom" && (
            <div className="form-group">
              <label>End Date</label>
              <input className="form-control" type="date" value={filters.customTo} onChange={e => onFilterChange("customTo", e.target.value)} />
            </div>
          )}
          <div className="form-group filter-actions">
            <button className="btn btn-primary" onClick={onApplyFilters} disabled={customInvalid || (filters.timeRange === "custom" && !filters.customFrom && !filters.customTo)}>
              Apply Filters
            </button>
            <button className="btn btn-secondary" onClick={onResetFilters}>Reset Filters</button>
          </div>
        </div>
        {hasActiveFilters && (
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginTop: 8 }}>
            Active filters applied — click Reset Filters to clear
          </div>
        )}
        {customInvalid && (
          <div style={{ fontSize: "var(--text-xs)", color: "var(--status-rejected)", marginTop: 8 }}>
            Start date must be on or before end date.
          </div>
        )}
      </div>
    </section>
  );
}

/*───────────────────── Notification Dropdown ─────────────────────*/

function NotificationDropdown({
  notifications,
  unreadCount,
  onMarkAsRead,
  onMarkAllAsRead,
  onClose,
  onNotificationClick,
}: {
  notifications: OpexNotification[];
  unreadCount: number;
  onMarkAsRead: (id: string) => void;
  onMarkAllAsRead: () => void;
  onClose: () => void;
  onNotificationClick: (id: string) => void;
}) {
  const unread = notifications.filter(n => !n.is_read);
  const read = notifications.filter(n => n.is_read);

  return (
    <div style={{
      position: "absolute", top: "100%", right: 0,
      width: 340, background: "#fff", border: "1px solid var(--border)",
      borderRadius: "var(--radius)", boxShadow: "var(--shadow-xl)",
      zIndex: 100, marginTop: 6,
    }}>
      <div style={{ padding: 12, borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ fontSize: 14, margin: 0 }}>Notifications</h2>
        {unreadCount > 0 && (
          <button className="btn btn-sm btn-secondary" onClick={onMarkAllAsRead} style={{ padding: "4px 8px", fontSize: 11 }}>
            Mark all as read
          </button>
        )}
      </div>
      <div style={{ maxHeight: 400, overflowY: "auto", padding: 8 }}>
        {notifications.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: "#6B7280", textAlign: "center" }}>
            No notifications
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {notifications.map(n => (
              <div
                key={n.id}
                onClick={() => onNotificationClick(n.id)}
                style={{
                  padding: 10, borderRadius: "var(--radius-sm)",
                  background: n.is_read ? "#fff" : "#FEF3C7",
                  cursor: "pointer", border: `1px solid ${n.is_read ? "var(--border)" : "#F59E0B"}`,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ flex: 1, fontSize: 12, fontWeight: 600, color: "#1F2937" }}>{n.title}</div>
                  <div style={{ fontSize: 10, color: "#9CA3AF" }}>{new Date(n.created_at).toLocaleString()}</div>
                </div>
                <div style={{ fontSize: 11, color: "#6B7280", marginTop: 4 }}>{n.message}</div>
                {n.related_booking_id && (
                  <div style={{ fontSize: 10, color: "#2563EB", marginTop: 6, fontWeight: 600 }}>
                    Booking #{n.related_booking_id.slice(-4)} · Click to open
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ padding: 8, borderTop: "1px solid var(--border)", textAlign: "right" }}>
        <button className="btn btn-sm btn-secondary" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/*───────────────────── Pages ─────────────────────*/

function Dashboard({
  bookings,
  assets,
  loading,
  onLoadData,
  onExport,
  onNewBooking,
  addToast,
  filters,
  onFilterChange,
  onApplyFilters,
  onResetFilters,
  users,
}: {
  bookings: Booking[];
  assets: Asset[];
  loading: boolean;
  onLoadData: () => void;
  onExport: () => void;
  onNewBooking: () => void;
  addToast: (type: Toast["type"], text: string) => void;
  filters: { timeRange: string; customFrom: string; customTo: string; statusFilter: string; asset: string; user: string };
  onFilterChange: (key: string, value: string) => void;
  onApplyFilters: () => void;
  onResetFilters: () => void;
  users: ResolvedUser[];
}) {
  const totalAssets = assets.length;
  const availableAssets = assets.filter(a => a.status === "AVAILABLE").length;
  const pendingApproval = bookings.filter(b => b.status === "PENDING_APPROVAL").length;
  const activeBookings = bookings.filter(b => b.status === "APPROVED" || b.status === "ASSIGNED").length;

  const handleLoad = () => {
    onLoadData();
    addToast("success", "Data refreshed.");
  };

  const recent = sortByDateTimeAccessor(bookings, b => b.created_at).slice(0, 5);

  return (
    <div className="page">
      <PageHeader
        eyebrow="OPEX Asset Booking Management"
        title="Dashboard"
        subtitle={`MyGeotab database: ${TENANT} — fleet coordination and booking workspace`}
      />

      <BookingFilterBar
        filters={filters}
        onFilterChange={onFilterChange}
        onApplyFilters={onApplyFilters}
        onResetFilters={onResetFilters}
        assets={assets}
        users={users}
      />

      <section className="stats">
        <StatCard
          label="Total Assets"
          value={totalAssets}
          sub="Registered fleet"
        />
        <StatCard
          label="Available Assets"
          value={availableAssets}
          sub="Ready for booking"
        />
        <StatCard
          label="Pending Approval"
          value={pendingApproval}
          sub="Awaiting decision"
        />
        <StatCard
          label="Active Bookings"
          value={activeBookings}
          sub="Approved or assigned"
        />
      </section>

      <div className="dashboard-actions" style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <button className="btn btn-primary" onClick={handleLoad} disabled={loading}>
          {loading ? "Loading…" : "Load Data"}
        </button>
        <button className="btn btn-secondary" onClick={onExport}>Export CSV</button>
        <button className="btn btn-primary" onClick={onNewBooking}>Create New Booking</button>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div className="panel-head-content">
            <h2>Recent Bookings</h2>
            <p>Latest booking activity across the fleet.</p>
          </div>
          <div className="panel-head-actions">
            <span className="badge badge-approved">{recent.length} records</span>
          </div>
        </div>
        <div className="panel-body">
          {loading ? (
            <LoadingState message="Loading data…" />
          ) : recent.length === 0 ? (
            <EmptyState
              title="No bookings found"
              message="Create your first booking to see activity here."
              action={{ label: "Create Booking", onClick: onNewBooking }}
            />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                    <tr>
                    <th>Booking ID</th><th>Asset</th><th>User</th><th>Date</th><th>Time</th><th>Destination</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map(b => (
                    <tr key={b.id}>
                      <td>#{b.id.slice(-4)}</td>
                      <td><b>{b.asset_name || "Unassigned"}</b></td>
                      <td>{b.requester_name}</td>
                      <td>{formatDate(b.start_at)}</td>
                      <td>{formatTime(b.start_at)} – {formatTime(b.end_at)}</td>
                      <td>{b.destination || "—"}</td>
                      <td><StatusBadge status={b.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function NewBooking({
  assets,
  bookings,
  actor,
  canWrite,
  blockedReason,
  onCreateBooking,
  submitting = false,
  addToast,
  navigateToMyBookings,
  users,
}: {
  assets: Asset[];
  bookings: Booking[];
  actor: ActorContext | null;
  canWrite: boolean;
  blockedReason: string | null;
  onCreateBooking: (input: {
    assetId: string; startAt: string; endAt: string; destination: string;
    purpose: string; notes: string;
    driverId?: string | null; driverName?: string | null;
  }) => void;
  submitting?: boolean;
  addToast: (type: Toast["type"], text: string) => void;
  navigateToMyBookings: () => void;
  users: ResolvedUser[];
}) {
  const tenant = getTenantTimezone();
  const [form, setForm] = useState({
    asset: "", driver: "", startDate: "", endDate: "", startTime: "", endTime: "", destination: "", purpose: "", notes: "",
  });
  const [driverError, setDriverError] = useState<string | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const availableAssets = assets.filter(a => a.status === "AVAILABLE");
  const eligibleDrivers = users.filter(u => u.roles?.some(r => r === "EMPLOYEE" || r === "GA" || r === "MANAGEMENT"));

  const resolveDriverForAsset = (assetId: string): ResolvedUser | null => {
    if (!assetId) return null;
    const asset = assets.find(a => a.id === assetId);
    if (!asset) return null;
    // Auto-resolution: prefer a driver whose company group overlaps the asset group.
    // The mock/live data does not store per-asset driver mappings, so we pick the first
    // eligible driver that shares a group with the asset; otherwise the first eligible driver.
    const assetGroups = (asset as any).groupIds as string[] | undefined;
    if (Array.isArray(assetGroups) && assetGroups.length > 0) {
      const byGroup = eligibleDrivers.find(u => Array.isArray((u as any).companyGroups) && (u as any).companyGroups.some((g: string) => assetGroups.includes(g)));
      if (byGroup) return byGroup;
    }
    return eligibleDrivers.length > 0 ? eligibleDrivers[0] : null;
  };

  const handleChange = (key: string, value: string) => {
    setForm(prev => {
      const next = { ...prev, [key]: value };
      if (key === "asset") {
        // Auto-resolve driver when asset changes and no manual override is set.
        if (value) {
          const resolved = resolveDriverForAsset(value);
          if (resolved) {
            next.driver = resolved.id;
            setDriverError(null);
          } else {
            next.driver = "";
          }
        } else {
          next.driver = "";
        }
      }
      return next;
    });
    setConflictError(null);
    setDriverError(null);
  };

  const handleDriverChange = (value: string) => {
    setForm(prev => ({ ...prev, driver: value }));
    setDriverError(null);
  };

  const handleClearDriver = () => {
    setForm(prev => ({ ...prev, driver: "" }));
    // Re-resolve from current asset so the field stays populated when possible.
    if (form.asset) {
      const resolved = resolveDriverForAsset(form.asset);
      if (resolved) {
        setForm(prev => ({ ...prev, driver: resolved.id }));
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setConflictError(null);
    setDriverError(null);

    if (!actor) {
      addToast("error", blockedReason || "No acting identity available.");
      return;
    }
    if (!canWrite) {
      addToast("error", blockedReason || "Writes are not available.");
      return;
    }
    if (!form.asset || !form.startDate || !form.endDate || !form.startTime || !form.endTime || !form.destination || !form.purpose) {
      addToast("error", "Please fill in all required fields.");
      return;
    }

    const startIso = toIsoFromTenantParts(form.startDate, form.startTime, tenant.timezone);
    const endIso = toIsoFromTenantParts(form.endDate, form.endTime, tenant.timezone);
    if (!startIso || !endIso) {
      addToast("error", "Invalid date or time. Please use the format shown.");
      return;
    }
    const start = new Date(startIso);
    const end = new Date(endIso);
    if (end <= start) {
      addToast("error", "End date/time must be after start date/time.");
      return;
    }

    const selectedAsset = assets.find(a => a.id === form.asset);
    if (!selectedAsset || selectedAsset.status !== "AVAILABLE") {
      addToast("error", "Selected asset is not available.");
      return;
    }

    // Driver is optional. If provided, it must be a known user.
    let driverId: string | null = null;
    let driverName: string | null = null;
    if (form.driver) {
      const driver = users.find(u => u.id === form.driver);
      if (!driver) {
        setDriverError("Selected driver is not recognized.");
        addToast("error", "Selected driver is not recognized.");
        return;
      }
      driverId = driver.id;
      driverName = driver.name;
    }

    const conflictStatuses = ["PENDING_APPROVAL", "APPROVED", "ASSIGNED"];
    const conflictBooking = bookings.find(b => {
      if (b.asset_id !== form.asset) return false;
      if (!conflictStatuses.includes(b.status)) return false;
      const bStart = parseISO(b.start_at);
      const bEnd = parseISO(b.end_at);
      return overlaps(start, end, bStart, bEnd);
    });

    if (conflictBooking) {
      setConflictError(`Asset ${selectedAsset.asset_code} already has a ${conflictBooking.status.replace(/_/g, " ").toLowerCase()} booking from ${formatDateTime(conflictBooking.start_at)} to ${formatDateTime(conflictBooking.end_at)}. Please choose another time or asset.`);
      return;
    }

    setConfirmOpen(true);
  };

  const handleConfirmSubmit = () => {
    setConfirmOpen(false);
    const startIso = toIsoFromTenantParts(form.startDate, form.startTime, tenant.timezone)!;
    const endIso = toIsoFromTenantParts(form.endDate, form.endTime, tenant.timezone)!;
    onCreateBooking({
      assetId: form.asset,
      driverId: form.driver || null,
      driverName: form.driver ? (users.find(u => u.id === form.driver)?.name || null) : null,
      startAt: startIso,
      endAt: endIso,
      destination: form.destination,
      purpose: form.purpose,
      notes: form.notes,
    });
    addToast("success", "Booking created successfully as PENDING_APPROVAL.");
    navigateToMyBookings();
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Asset Booking"
        title="Create New Booking"
        subtitle="Reserve an asset for your trip. Conflicting bookings are blocked automatically."
      />

      {actor && !blockedReason && (
        <div className="notice demo">
          <span style={{ fontWeight: 600 }}>Booking as:</span> <b>{actor.name}</b> ({actor.id}) — {actor.kind === "authenticated" ? "verified MyGeotab identity" : "demo identity, not authenticated MyGeotab"}
        </div>
      )}
      {blockedReason && (
        <div className="notice error">
          {blockedReason}
        </div>
      )}

            {conflictError && (
        <div className="notice error">{conflictError}</div>
      )}

      <section className="panel">
        <div className="panel-head">
          <div className="panel-head-content">
            <h2>Booking Form</h2>
            <p>Select asset and trip details. Times are interpreted in the tenant timezone (Asia/Jakarta, WIB UTC+7).</p>
          </div>
        </div>
        <div className="panel-body">
          <form onSubmit={handleSubmit}>
            <div className="form-section">
              <div className="form-section-label">Request Details</div>
              <div className="form-row">
                <div className="form-group">
                  <label>User</label>
                  <select className="form-control" value={actor?.id || ""} disabled onChange={() => {}}>
                    <option value={actor?.id || ""}>{actor ? actor.name : "Select user"}</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Booking Purpose</label>
                  <input className="form-control" value={form.purpose} onChange={e => handleChange("purpose", e.target.value)} placeholder="Purpose of trip" required />
                </div>
                <div className="form-group">
                  <label>Destination</label>
                  <input className="form-control" value={form.destination} onChange={e => handleChange("destination", e.target.value)} placeholder="Destination" required />
                </div>
              </div>
            </div>

            <div className="form-section">
              <div className="form-section-label">Asset Selection</div>
              <div className="form-group">
                <label>Available Asset</label>
                <select className="form-control" value={form.asset} onChange={e => handleChange("asset", e.target.value)} required>
                  <option value="">Select an asset</option>
                  {availableAssets.map(a => (
                    <option key={a.id} value={a.id}>{a.asset_name} · {a.registration_no || "No plate"}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Driver <span style={{ color: "#9CA3AF", fontWeight: 400 }}>(optional — auto-resolved from asset, overrideable)</span></label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select className="form-control" value={form.driver} onChange={e => handleDriverChange(e.target.value)}>
                    <option value="">Auto-resolve from asset</option>
                    {eligibleDrivers.map(u => (
                      <option key={u.id} value={u.id}>{u.name} ({u.id})</option>
                    ))}
                  </select>
                  {form.driver && (
                    <button type="button" className="btn btn-secondary" style={{ whiteSpace: "nowrap" }} onClick={handleClearDriver}>Clear</button>
                  )}
                </div>
                {driverError && <span style={{ color: "#DC2626", fontSize: 12 }}>{driverError}</span>}
                <span style={{ fontSize: 12, color: "#6B7280" }}>Leave blank to auto-assign a driver based on the selected asset. You may override at any time.</span>
              </div>
            </div>

            <div className="form-section">
              <div className="form-section-label">Schedule</div>
              <div className="form-row">
                <div className="form-group">
                  <label>Start Date</label>
                  <input className="form-control" type="date" value={form.startDate} onChange={e => handleChange("startDate", e.target.value)} required />
                </div>
                <div className="form-group">
                  <label>Start Time</label>
                  <input className="form-control" type="time" value={form.startTime} onChange={e => handleChange("startTime", e.target.value)} required />
                </div>
                <div className="form-group">
                  <label>End Date</label>
                  <input className="form-control" type="date" value={form.endDate} onChange={e => handleChange("endDate", e.target.value)} required />
                </div>
                <div className="form-group">
                  <label>End Time</label>
                  <input className="form-control" type="time" value={form.endTime} onChange={e => handleChange("endTime", e.target.value)} required />
                </div>
              </div>
              <div className="form-group">
                <label>Buffer Time</label>
                <span style={{ fontSize: 12, color: "#6B7280" }}>Standard buffers applied: 0 min before, 30 min after. Multi-day / overnight bookings are supported.</span>
              </div>
            </div>

            <div className="form-section">
              <div className="form-section-label">Additional Information</div>
              <div className="form-group">
                <label>Notes</label>
                <textarea className="form-control" value={form.notes} onChange={e => handleChange("notes", e.target.value)} rows={3} placeholder="Any special instructions..." />
              </div>
            </div>

            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setForm({ asset: "", driver: "", startDate: "", endDate: "", startTime: "", endTime: "", destination: "", purpose: "", notes: "" })}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={submitting || !actor || !canWrite}>{submitting ? "Submitting…" : "Create Booking"}</button>
            </div>
          </form>
        </div>
      </section>

      {confirmOpen && (
        <ConfirmDialog
          dialog={{
            id: "confirm-booking",
            title: "Confirm Booking Submission",
            message: "Submit this booking request? It will be created as PENDING_APPROVAL and require approval before assignment.",
            onConfirm: handleConfirmSubmit,
            onCancel: () => setConfirmOpen(false),
          }}
          onConfirm={handleConfirmSubmit}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

function MyBookings({
  bookings,
  actor,
  isLiveMode,
  demoActor,
  users,
  setDemoActor,
  onExport,
  onView,
  onCancel,
  addToast,
  filters,
  onFilterChange,
  onApplyFilters,
  onResetFilters,
}: {
  bookings: Booking[];
  actor: ActorContext | null;
  isLiveMode: boolean;
  demoActor: ResolvedUser | null;
  users: ResolvedUser[];
  setDemoActor: (u: ResolvedUser | null) => void;
  onExport: () => void;
  onView: (id: string) => void;
  onCancel: (id: string) => void;
  addToast: (type: Toast["type"], text: string) => void;
  filters: { timeRange: string; customFrom: string; customTo: string; statusFilter: string; asset: string; user: string };
  onFilterChange: (key: string, value: string) => void;
  onApplyFilters: () => void;
  onResetFilters: () => void;
}) {
  const rows = bookings;
  const [tab, setTab] = useState<"upcoming" | "past" | "all">("upcoming");

  const now = new Date().toISOString();
  const upcoming = rows.filter(b => b.end_at >= now && b.status !== "CANCELLED" && b.status !== "REJECTED" && b.status !== "COMPLETED");
  const past = rows.filter(b => b.end_at < now || b.status === "CANCELLED" || b.status === "REJECTED" || b.status === "COMPLETED");
  const activeTab = tab === "upcoming" ? upcoming : tab === "past" ? past : rows;

  const handleCancel = (id: string) => {
    if (!window.confirm("Cancel this booking?")) return;
    onCancel(id);
    addToast("success", "Booking cancelled.");
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="My Bookings"
        title="My Bookings"
        subtitle={actor ? `Bookings for ${actor.name}` : (isLiveMode ? "Authenticated MyGeotab identity required." : "Select a demo user from the topbar.")}
      />

      {!actor && (
        <div className="notice error">
          {isLiveMode ? "Authenticated MyGeotab identity could not be verified." : "Select a demo user from the topbar to view their bookings."}
        </div>
      )}

      <BookingFilterBar
        filters={filters}
        onFilterChange={onFilterChange}
        onApplyFilters={onApplyFilters}
        onResetFilters={onResetFilters}
        assets={[]}
        users={users}
      />

      <section className="panel">
        <div className="panel-head">
          <div className="panel-head-content">
            <h2>My Bookings</h2>
            <p>Booking history filtered by the selected demo user.</p>
          </div>
          <div className="panel-head-actions">
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button className={`btn btn-sm ${tab === "upcoming" ? "btn-primary" : "btn-outline"}`} onClick={() => setTab("upcoming")}>Upcoming</button>
              <button className={`btn btn-sm ${tab === "past" ? "btn-primary" : "btn-outline"}`} onClick={() => setTab("past")}>Past</button>
              <button className={`btn btn-sm ${tab === "all" ? "btn-primary" : "btn-outline"}`} onClick={() => setTab("all")}>All</button>
              <select
                className="form-control"
                style={{ width: "220px", maxWidth: "300px" }}
                value={demoActor ? demoActor.id : ""}
                disabled={isLiveMode}
                onChange={e => {
                  const emp = users.find(x => x.id === e.target.value) || null;
                  setDemoActor(emp);
                }}
              >
                <option value="">{isLiveMode ? "Verified identity" : "Select demo user"}</option>
                {users.map(emp => (
                  <option key={emp.id} value={emp.id}>{emp.name} ({emp.id})</option>
                ))}
              </select>
              <button className="btn btn-secondary btn-sm" onClick={onExport}>Export CSV</button>
            </div>
          </div>
        </div>
        <div className="panel-body">
          {!actor ? (
            <EmptyState title="No identity selected" message={isLiveMode ? "Authenticated MyGeotab identity could not be verified." : "Choose a demo user from the topbar selector."} />
          ) : activeTab.length === 0 ? (
            <EmptyState title="No bookings" message={`No ${tab} bookings found for ${actor?.name || "current user"}.`} />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                    <tr>
                    <th>Booking ID</th><th>Asset</th><th>Booking Date</th><th>Time</th><th>Destination</th><th>Booking Status</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {activeTab.map(b => (
                    <tr key={b.id}>
                      <td>#{b.id.slice(-4)}</td>
                      <td><b>{b.asset_name || "Unassigned"}</b></td>
                      <td>{formatDate(b.start_at)}</td>
                      <td>{formatTime(b.start_at)} – {formatTime(b.end_at)}</td>
                      <td>{b.destination || "—"}</td>
                      <td><StatusBadge status={b.status} /></td>
                      <td className="actions">
                        <button className="btn btn-sm btn-view" onClick={() => onView(b.id)}>View</button>
                        {(b.status === "PENDING_APPROVAL" || b.status === "APPROVED" || b.status === "ASSIGNED") && (
                          <button className="btn btn-sm btn-outline" onClick={() => handleCancel(b.id)}>Cancel</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ApprovalInbox({
  bookings,
  onApprove,
  onReject,
  onView,
  rejectingId,
  onConfirmReject,
  onCancelReject,
  onExport,
  addToast,
  rejectReason,
  setRejectReason,
  filters,
  onFilterChange,
  onApplyFilters,
  onResetFilters,
  assets,
}: {
  bookings: Booking[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onView: (id: string) => void;
  rejectingId: string | null;
  onConfirmReject: (id: string) => void;
  onCancelReject: () => void;
  onExport: () => void;
  addToast: (type: Toast["type"], text: string) => void;
  rejectReason: { [id: string]: string };
  setRejectReason: (id: string, reason: string) => void;
  filters: { timeRange: string; customFrom: string; customTo: string; statusFilter: string; asset: string; user: string };
  onFilterChange: (key: string, value: string) => void;
  onApplyFilters: () => void;
  onResetFilters: () => void;
  assets: Asset[];
}) {
  const pending = bookings;

  const handleAction = (id: string, action: "approve" | "reject" | "view") => {
    if (action === "approve") { onApprove(id); }
    else if (action === "reject") { onReject(id); }
    else { onView(id); }
  };

  const handleConfirmRejectWithReason = (id: string) => {
    const reason = rejectReason[id] || "";
    if (!reason.trim()) {
      addToast("error", "Please provide a rejection reason.");
      return;
    }
    onConfirmReject(id);
    addToast("success", `Booking #${id.slice(-4)} rejected.`);
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Approval Inbox"
        title="Pending Approvals"
        subtitle="Review and act on booking requests awaiting your decision."
      />

      <BookingFilterBar
        filters={filters}
        onFilterChange={onFilterChange}
        onApplyFilters={onApplyFilters}
        onResetFilters={onResetFilters}
        assets={assets}
        users={[]}
        isApprovalInbox
      />

      <section className="panel">
        <div className="panel-head">
          <div className="panel-head-content">
            <h2>Approval Requests</h2>
            <p>Bookings pending approval from authorized approvers.</p>
          </div>
          <div className="panel-head-actions">
            <span className="badge badge-pending">{pending.length} pending</span>
            <button className="btn btn-secondary btn-sm" onClick={onExport}>Export CSV</button>
          </div>
        </div>
        <div className="panel-body">
          {pending.length === 0 ? (
            <EmptyState title="No pending approvals" message="All booking requests have been reviewed." />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Request ID</th><th>User</th><th>Asset</th><th>Booking Date</th><th>Destination</th><th>Request Date</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map(b => (
                    <tr key={b.id}>
                      <td>#{b.id.slice(-4)}</td>
                      <td>{b.requester_name}</td>
                      <td>{b.asset_name || "Unassigned"}</td>
                      <td>{formatDate(b.start_at)}</td>
                      <td>{b.destination || "—"}</td>
                      <td>{formatDate(b.created_at)}</td>
                      <td className="actions">
                        {rejectingId === b.id ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            <textarea
                              className="form-control"
                              value={rejectReason[b.id] || ""}
                              onChange={e => setRejectReason(b.id, e.target.value)}
                              rows={2}
                              placeholder="Rejection reason"
                            />
                            <div className="action-group">
                              <button className="btn btn-sm btn-secondary" onClick={() => handleConfirmRejectWithReason(b.id)}>Confirm Reject</button>
                              <button className="btn btn-sm btn-secondary" onClick={onCancelReject}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div className="action-group">
                            <button className="btn btn-sm btn-view" onClick={() => handleAction(b.id, "view")}>View Details</button>
                            <button className="btn btn-sm btn-primary" onClick={() => handleAction(b.id, "approve")}>Approve</button>
                            <button className="btn btn-sm btn-outline" onClick={() => handleAction(b.id, "reject")}>Reject</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function AssetAvailability({
  assets,
  bookings,
  onExport,
  filters,
  onFilterChange,
  onApplyFilters,
  onResetFilters,
  users,
}: {
  assets: Asset[];
  bookings: Booking[];
  onExport: () => void;
  filters: { timeRange: string; customFrom: string; customTo: string; statusFilter: string; asset: string; user: string };
  onFilterChange: (key: string, value: string) => void;
  onApplyFilters: () => void;
  onResetFilters: () => void;
  users: ResolvedUser[];
}) {
  const bookingByAsset = new Map<string, Booking>();
  bookings.forEach(b => {
    if (b.asset_id && (b.status === "PENDING_APPROVAL" || b.status === "APPROVED" || b.status === "ASSIGNED")) {
      const existing = bookingByAsset.get(b.asset_id);
      if (!existing || b.created_at > existing.created_at) {
        bookingByAsset.set(b.asset_id, b);
      }
    }
  });

  return (
    <div className="page">
      <PageHeader
        eyebrow="Asset Availability"
        title="Asset Availability"
        subtitle="Real-time view of fleet availability and current bookings."
      />

      <BookingFilterBar
        filters={filters}
        onFilterChange={onFilterChange}
        onApplyFilters={onApplyFilters}
        onResetFilters={onResetFilters}
        assets={assets}
        users={users}
      />

      <section className="stats">
        <StatCard
          label="Total Fleet"
          value={assets.length}
          sub="All registered assets"
        />
        <StatCard
          label="Available"
          value={assets.filter(a => a.status === "AVAILABLE").length}
          sub="Ready for booking"
        />
        <StatCard
          label="Maintenance"
          value={assets.filter(a => a.status === "MAINTENANCE").length}
          sub="Out of service"
        />
        <StatCard
          label="Out of Service"
          value={assets.filter(a => a.status === "OUT_OF_SERVICE").length}
          sub="Not available"
        />
      </section>

      <section className="panel">
        <div className="panel-head">
          <div className="panel-head-content">
            <h2>Asset Register</h2>
            <p>Fleet inventory with current availability and booking status.</p>
          </div>
          <div className="panel-head-actions">
            <span className="badge badge-approved">{assets.length} assets</span>
            <button className="btn btn-secondary btn-sm" onClick={onExport}>Export CSV</button>
          </div>
        </div>
        <div className="panel-body">
          {assets.length === 0 ? (
            <EmptyState title="No assets registered" message="No asset data available." />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Asset Name</th><th>License Plate</th><th>Serial Number</th><th>Asset Type</th><th>MyGeotab Device ID</th><th>Availability</th><th>Current Booking</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map(a => {
                    const currentBooking = bookingByAsset.get(a.id);
                    return (
                      <tr key={a.id}>
                        <td><b>{a.asset_name}</b></td>
                        <td>{a.registration_no || "—"}</td>
                        <td>{a.serial_number || "—"}</td>
                        <td>{a.asset_class.replace(/_/g, " ")}</td>
                        <td>{a.geotab_device_id || "Not mapped"}</td>
                        <td><AssetStatusBadge status={a.status} /></td>
                        <td>
                          {currentBooking ? (
                            <span style={{ fontSize: 11, color: "#1E3A5F", fontWeight: 600 }}>{`#${currentBooking.id.slice(-4)} · ${currentBooking.status.replace(/_/g, " ")}`}</span>
                          ) : (
                            <span style={{ color: "#9CA3AF" }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function BookingReports({
  bookings,
  assets,
  onExport,
  filters,
  onFilterChange,
  onApplyFilters,
  onResetFilters,
  users,
}: {
  bookings: Booking[];
  assets: Asset[];
  onExport: () => void;
  filters: { timeRange: string; customFrom: string; customTo: string; statusFilter: string; asset: string; user: string };
  onFilterChange: (key: string, value: string) => void;
  onApplyFilters: () => void;
  onResetFilters: () => void;
  users: ResolvedUser[];
}) {
  const validationResults = bookings.map(b => validateResolvedBooking(b));
  const validBookings = bookings.filter((_, i) => validationResults[i].quality === "VALID");
  const invalidBookings = bookings.filter((_, i) => validationResults[i].quality !== "VALID");

  const total = validBookings.length;
  const invalidTotal = invalidBookings.length;

  const byStatus = validBookings.reduce<Record<string, number>>((acc, b) => { acc[b.status] = (acc[b.status] || 0) + 1; return acc; }, {});
  const byAsset = validBookings.reduce<Record<string, number>>((acc, b) => { if (b.asset_code) acc[b.asset_code] = (acc[b.asset_code] || 0) + 1; return acc; }, {});
  const mostBooked = Object.entries(byAsset).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const assetsWithBookings = new Set(validBookings.filter(b => b.asset_id).map(b => b.asset_id)).size;
  const utilization = assets.length > 0 ? Math.round((assetsWithBookings / assets.length) * 100) : 0;

  const dataQualityByIssue = invalidBookings.reduce<Record<string, number>>((acc, b) => {
    const result = validationResults[bookings.indexOf(b)];
    result.issues.forEach((issue: string) => { acc[issue] = (acc[issue] || 0) + 1; });
    return acc;
  }, {});

  return (
    <div className="page">
      <PageHeader
        eyebrow="Booking Reports"
        title="Booking Reports"
        subtitle="Fleet utilization and booking analytics based on actual data."
      />

      <BookingFilterBar
        filters={filters}
        onFilterChange={onFilterChange}
        onApplyFilters={onApplyFilters}
        onResetFilters={onResetFilters}
        assets={assets}
        users={users}
      />

      <section className="stats">
        <StatCard label="Total Bookings" value={total} sub="Valid bookings" />
        {invalidTotal > 0 && (
          <StatCard label="Data Quality Issues" value={invalidTotal} sub="Invalid records" />
        )}
        <StatCard label="Asset Utilization" value={`${utilization}%`} sub={`${assetsWithBookings} of ${assets.length} assets used`} />
        <StatCard label="Most Booked Asset" value={mostBooked[0]?.[0] || "—"} sub={mostBooked[0]?.[1] ? `${mostBooked[0][1]} bookings` : "No data"} />
        <StatCard label="Status Summary" value={Object.keys(byStatus).length} sub="Different statuses" />
      </section>

      <div className="filters" style={{ marginBottom: 0 }}>
        <div className="filter-actions">
          <button className="btn btn-secondary" onClick={onExport}>Export CSV</button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div className="panel-head-content">
            <h2>Booking Status Summary</h2>
            <p>Breakdown of bookings by status.</p>
          </div>
        </div>
        <div className="panel-body">
          {total === 0 ? (
            <EmptyState title="No data available" message="Create some bookings to see reports." />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14 }}>
              {Object.entries(byStatus).map(([status, count]) => (
                <div key={status} className="stat-card">
                  <div className="stat-label">{formatStatusLabel(status)}</div>
                  <div className="stat-value">{count}</div>
                  <div className="stat-sub">bookings</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {invalidTotal > 0 && (
        <section className="panel">
          <div className="panel-head">
            <div className="panel-head-content">
              <h2>Data Quality Issues</h2>
              <p>Bookings with missing or invalid data that are excluded from operational metrics.</p>
            </div>
          </div>
          <div className="panel-body">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14 }}>
              {Object.entries(dataQualityByIssue).map(([issue, count]) => (
                <div key={issue} className="stat-card" style={{ borderLeft: "4px solid #DC2626" }}>
                  <div className="stat-label">{issue.replace(/_/g, " ")}</div>
                  <div className="stat-value">{count}</div>
                  <div className="stat-sub">records</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <div className="panel-head-content">
            <h2>Most Booked Assets</h2>
            <p>Top assets by number of bookings.</p>
          </div>
        </div>
        <div className="panel-body">
          {mostBooked.length === 0 ? (
            <EmptyState title="No asset data" message="Bookings will populate this report." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {mostBooked.map(([code, count]) => (
                <div key={code} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: "#fff", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
                  <div><b>{code}</b></div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: "140px", height: "8px", background: "#E5E7EB", borderRadius: "4px" }}>
                      <div style={{ width: `${Math.min((count / Math.max(...mostBooked.map(([, c]) => c)) * 100, 100))}%`, height: "8px", background: "#2563EB", borderRadius: "4px" }}></div>
                    </div>
                    <span className="text-blue" style={{ fontWeight: 600 }}>{count} bookings</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/*───────────────────── Notification Center Page ─────────────────────*/

function NotificationCenter({
  notifications,
  actor,
  onMarkAsRead,
  onMarkAllAsRead,
  onNotificationClick,
  unreadCount,
}: {
  notifications: OpexNotification[];
  actor: ActorContext | null;
  onMarkAsRead: (id: string) => void | Promise<void>;
  onMarkAllAsRead: () => void | Promise<void>;
  onNotificationClick: (id: string) => void | Promise<void>;
  unreadCount: number;
}) {
  const [filter, setFilter] = useState<"all" | "unread" | "booking_created" | "booking_approved" | "booking_rejected" | "vehicle_assigned">("all");

  const filtered = notifications.filter(n => {
    if (filter === "all") return true;
    if (filter === "unread") return !n.is_read;
    return n.type === filter;
  });

  const typeLabel: Record<string, string> = {
    booking_created: "Booking Created",
    booking_approved: "Booking Approved",
    booking_rejected: "Booking Rejected",
    vehicle_assigned: "Vehicle Assigned",
  };

  const handleMarkAsRead = async (id: string) => {
    await onMarkAsRead(id);
  };

  const handleMarkAllAsRead = async () => {
    await onMarkAllAsRead();
  };

  const handleNotificationClick = async (id: string) => {
    await onNotificationClick(id);
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Notifications"
        title="Notification Center"
        subtitle={`${unreadCount} unread · notification history for ${actor?.name || "current user"}`}
      />

      <section className="panel">
        <div className="panel-head">
          <div className="panel-head-content">
            <h2>Notification History</h2>
            <p>All notifications across booking lifecycle events.</p>
          </div>
          <div className="panel-head-actions">
            {unreadCount > 0 && (
              <button className="btn btn-sm btn-secondary" onClick={handleMarkAllAsRead}>
                Mark All as Read
              </button>
            )}
          </div>
        </div>
        <div className="panel-body">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            <button
              className={`btn btn-sm ${filter === "all" ? "btn-primary" : "btn-outline"}`}
              onClick={() => setFilter("all")}
            >
              All
            </button>
            <button
              className={`btn btn-sm ${filter === "unread" ? "btn-primary" : "btn-outline"}`}
              onClick={() => setFilter("unread")}
            >
              Unread ({notifications.filter(n => !n.is_read).length})
            </button>
            {Object.entries(typeLabel).map(([type, label]) => (
              <button
                key={type}
                className={`btn btn-sm ${filter === type ? "btn-primary" : "btn-outline"}`}
                onClick={() => setFilter(type as any)}
              >
                {label}
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "#6B7280" }}>
              {filter === "all" ? "No notifications yet." : `No ${typeLabel[filter]} notifications.`}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Type</th><th>Title</th><th>Message</th><th>Booking</th><th>Received</th><th>Status</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(n => (
                    <tr
                      key={n.id}
                      style={{ background: n.is_read ? "#fff" : "#FEF3C7" }}
                    >
                      <td style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, color: "#2563EB" }}>
                        {typeLabel[n.type] || n.type}
                      </td>
                      <td><b style={{ fontSize: 13 }}>{n.title}</b></td>
                      <td style={{ fontSize: 12, color: "#4B5563" }}>{n.message}</td>
                      <td>
                        {n.related_booking_id ? (
                          <span style={{ fontSize: 11, color: "#2563EB", fontWeight: 600, cursor: "pointer" }} onClick={e => { e.stopPropagation(); handleNotificationClick(n.id); }}>
                            #{n.related_booking_id.slice(-4)}
                          </span>
                        ) : (
                          <span style={{ color: "#9CA3AF", fontSize: 11 }}>—</span>
                        )}
                      </td>
                      <td style={{ fontSize: 11, color: "#6B7280" }}>{new Date(n.created_at).toLocaleString()}</td>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10 }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: n.is_read ? "#9CA3AF" : "#EF4444" }}></span>
                          {n.is_read ? "Read" : "Unread"}
                        </span>
                      </td>
                      <td className="actions">
                        {!n.is_read && (
                          <button className="btn btn-sm btn-outline" onClick={e => { e.stopPropagation(); handleMarkAsRead(n.id); }}>
                            Mark Read
                          </button>
                        )}
                        {n.related_booking_id && (
                          <button className="btn btn-sm btn-view" onClick={e => { e.stopPropagation(); handleNotificationClick(n.id); }}>
                            Open Booking
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/*───────────────────── View Details Modal ─────────────────────*/

function ViewDetailsModal({
  booking,
  assets,
  onClose,
  onApprove,
  onReject,
  onAssign,
  onComplete,
  onCancel,
  rejectingId,
  onConfirmReject,
  onCancelReject,
  addToast,
  rejectReason,
  setRejectReason,
}: {
  booking: Booking | null;
  assets: Asset[];
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onAssign: (id: string) => void;
  onComplete: (id: string) => void;
  onCancel: (id: string) => void;
  rejectingId: string | null;
  onConfirmReject: (id: string) => void;
  onCancelReject: () => void;
  addToast: (type: Toast["type"], text: string) => void;
  rejectReason: { [id: string]: string };
  setRejectReason: (id: string, reason: string) => void;
}) {
  if (!booking) return null;
  const asset = assets.find(a => a.id === booking.asset_id);
  const handleModalApprove = () => { onApprove(booking.id); onClose(); addToast("success", `Booking #${booking.id.slice(-4)} approved.`); };
  const handleModalReject = () => { onReject(booking.id); };
  const handleModalAssign = () => { onAssign(booking.id); onClose(); addToast("success", `Booking #${booking.id.slice(-4)} assigned.`); };
  const handleModalComplete = () => { onComplete(booking.id); onClose(); addToast("success", `Booking #${booking.id.slice(-4)} completed.`); };
  const handleModalCancel = () => { onCancel(booking.id); onClose(); addToast("success", `Booking #${booking.id.slice(-4)} cancelled.`); };
  const handleModalConfirmReject = () => {
    const reason = rejectReason[booking.id] || "";
    if (!reason.trim()) {
      addToast("error", "Please provide a rejection reason.");
      return;
    }
    onConfirmReject(booking.id);
    onClose();
    addToast("success", `Booking #${booking.id.slice(-4)} rejected.`);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Booking Details</h2>
          <button className="btn btn-sm btn-secondary" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body">
          <div className="detail-grid">
            <div className="detail-row"><label>Booking ID</label><span className="value">#{booking.id.slice(-4)}</span></div>
            <div className="detail-row"><label>User</label><span className="value">{booking.requester_name}</span></div>
            <div className="detail-row"><label>Asset</label><span className="value">{booking.asset_name || "Unassigned"} {asset ? `(${asset.registration_no || "No plate"})` : ""}</span></div>
            <div className="detail-row"><label>Asset Class</label><span className="value">{booking.requested_class.replace(/_/g, " ")}</span></div>
            <div className="detail-row"><label>Start</label><span className="value">{formatDateTime(booking.start_at)}</span></div>
            <div className="detail-row"><label>End</label><span className="value">{formatDateTime(booking.end_at)}</span></div>
            <div className="detail-row"><label>Destination</label><span className="value">{booking.destination || "—"}</span></div>
            <div className="detail-row"><label>Purpose</label><span className="value">{booking.purpose}</span></div>
            <div className="detail-row"><label>Status</label><span className="value"><StatusBadge status={booking.status} /></span></div>
            <div className="detail-row"><label>Created</label><span className="value">{formatDateTime(booking.created_at)}</span></div>
            <div className="detail-row"><label>Version</label><span className="value">{booking.version}</span></div>
            {rejectingId === booking.id && (
              <div className="detail-row" style={{ gridColumn: "1 / -1" }}>
                <label>Rejection Reason</label>
                <textarea
                  className="form-control"
                  value={rejectReason[booking.id] || ""}
                  onChange={e => setRejectReason(booking.id, e.target.value)}
                  rows={2}
                  placeholder="Enter rejection reason"
                />
              </div>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {booking.status === "PENDING_APPROVAL" ? (
              <>
                <button className="btn btn-sm btn-primary" onClick={handleModalApprove}>Approve</button>
                <button className="btn btn-sm btn-outline" onClick={handleModalReject}>Reject</button>
              </>
            ) : null}
            {booking.status === "APPROVED" ? (
              <button className="btn btn-sm btn-primary" onClick={handleModalAssign}>Assign Asset</button>
            ) : null}
            {booking.status === "ASSIGNED" ? (
              <button className="btn btn-sm btn-primary" onClick={handleModalComplete}>Complete Booking</button>
            ) : null}
            {["PENDING_APPROVAL", "APPROVED", "ASSIGNED"].includes(booking.status) ? (
              <button className="btn btn-sm btn-outline" onClick={handleModalCancel}>Cancel Booking</button>
            ) : null}
            {rejectingId === booking.id ? (
              <>
                <button className="btn btn-sm btn-primary" onClick={handleModalConfirmReject}>Confirm Reject</button>
                <button className="btn btn-sm btn-secondary" onClick={onCancelReject}>Cancel</button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/*───────────────────── Main App ─────────────────────*/

export default function App() {
  const [bookings, setBookings] = useState<ResolvedBooking[]>([]);
  const [assets, setAssets] = useState<ResolvedAsset[]>([]);
  const [users, setUsers] = useState<ResolvedUser[]>([]);
  const [demoActor, setDemoActor] = useState<ResolvedUser | null>(null);
  const [identityState, setIdentityState] = useState<IdentityResolutionState>({ status: "unresolved", reason: "MyGeotab runtime not initialized." });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [active, setActive] = useState("Dashboard");
  const [filters, setFilters] = useState({
    timeRange: "",
    customFrom: "",
    customTo: "",
    statusFilter: "",
    asset: "",
    user: "",
  });
  const [selectedBooking, setSelectedBooking] = useState<ResolvedBooking | null>(null);
  const [geotabApi, setGeotabApi] = useState<GeotabApi | null>(null);
  const [mode, _setMode] = useState<AppMode>("DEMO");
  const setMode = useCallback((next: AppMode) => {
    if (!isKnownMode(next)) {
      // Fail closed: ambiguous mode - keep current mode and do not clear/transition unsafely
      return;
    }
    _setMode((prev) => {
      if (prev === next) return prev;
      // Clear stale actor/notification/pending state on every mode switch
      setDemoActor(null);
      setNotifications([]);
      setUnreadCount(0);
      setNotificationDropdownOpen(false);
      setSelectedBooking(null);
      setRejectingId(null);
      setRejectReasonState({});
      setMessage(null);
      return next;
    });
  }, []);
  const [myGeotabError, setMyGeotabError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [rejectReason, setRejectReasonState] = useState<{ [id: string]: string }>({});
  const [addInId, setAddInId] = useState<string | null>(() => {
    try {
      return resolveAddInId(localStorage.getItem(ADDIN_ID_STORAGE_KEY) || null);
    } catch {
      return DEFAULT_ADDIN_ID;
    }
  });
  const [addInIdInput, setAddInIdInput] = useState<string>("");
  const addInIdValid = isValidAddInId(addInId);

  // Refs to avoid stale closures in lifecycle subscription
  const geotabApiRef = useRef<GeotabApi | null>(null);
  const addInIdRef = useRef(addInId);
  const modeRef = useRef(mode);
  const identityResolveSeq = useRef(0);

  // Server-side authorization client (created once, reused across renders)
  const serverAuthz = useMemo(() => {
    if (!AUTHZ_API_BASE_URL) return null;
    return new ServerAuthzClient({ baseUrl: AUTHZ_API_BASE_URL });
  }, [AUTHZ_API_BASE_URL]);

  // Keep refs in sync with state
  useEffect(() => {
    geotabApiRef.current = geotabApi;
  }, [geotabApi]);
  useEffect(() => {
    addInIdRef.current = addInId;
  }, [addInId]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<OpexNotification[]>([]);
  const [notificationDropdownOpen, setNotificationDropdownOpen] = useState(false);

  const isLiveMode = mode === "ADDIN_DATA";
  const liveBlockedReason = getLiveBlockedReason(mode, identityState);
  const verifiedPrincipal = identityState.status === "authenticated" ? identityState.principal : null;
  const actor: ActorContext | null = isLiveMode
    ? (verifiedPrincipal ? { id: verifiedPrincipal.id, name: verifiedPrincipal.name, roles: verifiedPrincipal.roles, kind: "authenticated" } : null)
    : (demoActor ? { id: demoActor.id, name: demoActor.name, roles: demoActor.roles, kind: "demo" } : null);
  const actorId = actor?.id ?? null;

  const onFilterChange = useCallback((key: string, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  }, []);

  const onResetFilters = useCallback(() => {
    setFilters({ timeRange: "", customFrom: "", customTo: "", statusFilter: "", asset: "", user: "" });
  }, []);

  const dashboardBookings = useMemo(() => filterBookings(bookings, filters), [bookings, filters]);
  const myBookingsData = useMemo(() => {
    let result = filterBookings(bookings, filters);
    if (actorId) result = result.filter(b => b.requester_id === actorId);
    return result;
  }, [bookings, filters, actorId]);
  const approvalBookings = useMemo(() => filterBookings(bookings, { ...filters, statusFilter: "PENDING_APPROVAL" }), [bookings, filters]);
  const availabilityBookings = useMemo(() => filterBookings(bookings, filters), [bookings, filters]);
  const reportsBookings = useMemo(() => filterBookings(bookings, filters), [bookings, filters]);

  // ── Lifecycle bridge + deterministic authenticated identity resolution ──
  useEffect(() => {
    let mounted = true;
    let seq = 0;

    const applyApi = (api: GeotabApi | null) => {
      if (!mounted) return;
      setGeotabApi(api);
      geotabApiRef.current = api;
      if (!api) {
        setIdentityState({ status: "unresolved", reason: "MyGeotab runtime not initialized." });
        return;
      }
      if (addInIdRef.current && modeRef.current === "DEMO") {
        setMode("ADDIN_DATA");
        modeRef.current = "ADDIN_DATA";
        setProviderError(null);
      }
      const mySeq = ++seq;
      identityResolveSeq.current = mySeq;
      setIdentityState({ status: "loading" });
      void resolveAuthenticatedPrincipal(api).then((resolved) => {
        if (!mounted || identityResolveSeq.current !== mySeq) return;
        setIdentityState(resolved);
        if (resolved.status === "error") {
          setMyGeotabError(resolved.reason);
        }
      });
    };

    const initialBridgeState = getLifecycleApi();
    if (initialBridgeState.api) {
      applyApi(initialBridgeState.api);
    }

    const unsubscribe = subscribeToLifecycle((bridgeState) => {
      if (!mounted) return;
      if (bridgeState.api !== geotabApiRef.current) {
        applyApi(bridgeState.api);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // ── Main data loading effect: re-runs when mode/geotabApi/addInId change ─
  useEffect(() => {
      let mounted = true;

      const effectiveMode = isKnownMode(mode) ? mode : "DEMO";
      const dataProvider: BookingDataProvider = effectiveMode === "ADDIN_DATA"
        ? createAddInDataProvider(geotabApi, addInId)
        : bookingDataProvider;

      const loadMasterData = async () => {
        try {
          const [a, u, b] = await Promise.all([
            dataProvider.getAssets(),
            dataProvider.getUsers(),
            dataProvider.getBookings(),
          ]);
          if (mounted) {
            setAssets(a);
            setUsers(u);
            setBookings(b);
            setProviderError(null);
          }
        } catch (e) {
          if (mounted) {
            const msg = e instanceof Error ? e.message : "Failed to load data from MyGeotab.";
            setMyGeotabError(msg);
            if (mode === "ADDIN_DATA" && !geotabApi) {
              setProviderError("MyGeotab Add-In API is not available. ADDIN_DATA mode requires running inside a registered MyGeotab Add-In.");
            } else if (mode === "ADDIN_DATA" && !addInId) {
              setProviderError("Add-In Id is not configured. Enter your AddInId to use ADDIN_DATA storage.");
            } else {
              setProviderError(msg);
            }
            if (mode === "DEMO") {
              const fb = bookingDataProvider;
              // Fail closed: demo fallback only to local non-live provider
              if (!fb.isLive()) {
                Promise.all([
                  fb.getAssets(),
                  fb.getUsers(),
                  fb.getBookings(),
                ]).then(([fa, fu, fbk]) => {
                  if (mounted) {
                    setAssets(fa);
                    setUsers(fu);
                    setBookings(fbk);
                  }
                });
              }
            }
          }
        }
      };

      loadMasterData();

      return () => {
        mounted = false;
      };
    }, [mode, geotabApi, addInId]);

  // Enforce separation and clear stale state on mode changes (defense in depth)
  useEffect(() => {
    if (mode === "ADDIN_DATA") {
      setDemoActor(null);
    }
    setNotifications([]);
    setUnreadCount(0);
    setNotificationDropdownOpen(false);
    setSelectedBooking(null);
    setRejectingId(null);
    setRejectReasonState({});
  }, [mode]);

  // Keep the AddInId text input in sync with the persisted value
  useEffect(() => {
    setAddInIdInput(addInId ?? "");
  }, [addInId]);

  const provider = useMemo(() => {
    // Fail closed: only explicit DEMO uses local demo provider; only explicit ADDIN_DATA uses live provider.
    if (mode === "ADDIN_DATA") {
      return createAddInDataProvider(geotabApi, addInId);
    }
    if (mode === "DEMO") {
      return bookingDataProvider;
    }
    // Ambiguous mode: do not select live provider; return local provider but operations remain guarded/fail-closed elsewhere.
    return bookingDataProvider;
  }, [mode, geotabApi, addInId]);

  const notificationEngine = useMemo(() => {
    return createNotificationEngine(provider as NotificationDataProvider, provider);
  }, [provider]);

  /*───────────────────── Auto Refresh Configuration ─────────────────────*/
  const REFRESH_INTERVALS: Record<string, number> = {
    Dashboard: 30000,
    "My Bookings": 15000,
    "Approval Inbox": 10000,
    "Asset Availability": 15000,
    "Booking Reports": 60000,
  };
  const activeInterval = REFRESH_INTERVALS[active] || 0;

  const {
    isRefreshing: refreshIsRefreshing,
    lastUpdated: refreshLastUpdated,
    manualRefresh: refreshManualRefresh,
  } = useAutoRefresh({
    intervalMs: activeInterval,
    enabled: activeInterval > 0,
    onRefresh: () => onLoadData(),
    onError: (e) => {
      setMessage({ type: "error", text: `Auto-refresh failed: ${e.message}` });
    },
  });
  const pushToastCb = useCallback((type: Toast["type"], text: string) => {
    pushToast(setToasts, type, text);
  }, []);

  const updateBookingStatus = useCallback(async (id: string, newStatus: string, expectedVersion: number, action: BookingAction, approverId?: string, approvalRemarks?: string) => {
    /* Server-side authorization gate: verify session and enforce RBAC before any write */
    const creds = getSessionCredentials(mode, identityState);
    if (!creds || !serverAuthz) {
      if (mode === "ADDIN_DATA") {
        throw new Error("SERVER_AUTHZ_NOT_CONFIGURED");
      }
    } else {
      const authz = await serverAuthz.authorize(creds.sessionId, creds.database, creds.server, action, id);
      if (!authz.authorized) {
        throw new Error(`NOT_AUTHORIZED: ${authz.error}`);
      }
    }

    await provider.updateBookingStatus(id, newStatus, expectedVersion, approverId, approvalRemarks);
    const updated = await provider.getBookings();
    setBookings(updated);
  }, [provider, mode, identityState, serverAuthz]);

  const onLoadData = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    setProviderError(null);
    try {
      const refreshed = await provider.getBookings();
      setBookings(refreshed);
      setLoading(false);
      setMessage({ type: "success", text: mode === "ADDIN_DATA" ? "Bookings reloaded from MyGeotab AddInData." : "Demo data reloaded from local storage." });
    } catch (e) {
      setLoading(false);
      const msg = e instanceof Error ? e.message : "Failed to reload data.";
      setMessage({ type: "error", text: msg });
      setProviderError(msg);
      if (mode === "ADDIN_DATA" && !geotabApi) {
        setProviderError("MyGeotab Add-In API is not available. ADDIN_DATA mode requires running inside a registered MyGeotab Add-In.");
      } else if (mode === "ADDIN_DATA" && !addInId) {
        setProviderError("Add-In Id is not configured. Enter your AddInId to use ADDIN_DATA storage.");
      }
    } finally {
      const currentActorId = getActorIdForMode(mode, identityState, demoActor?.id ?? null);
      if (currentActorId && notificationEngine) {
        notificationEngine.getNotificationsForUser(currentActorId).then(ns => {
          setNotifications(ns);
          setUnreadCount(ns.filter(n => !n.is_read).length);
        });
      }
    }
  }, [provider, mode, geotabApi, addInId, identityState, demoActor, notificationEngine]);

  // Refresh notifications when actor context changes
  useEffect(() => {
    if (!actorId || !notificationEngine) return;
    let mounted = true;
    notificationEngine.getNotificationsForUser(actorId).then(ns => {
      if (mounted) {
        setNotifications(ns);
        setUnreadCount(ns.filter(n => !n.is_read).length);
      }
    }).catch(() => {});
    return () => { mounted = false; };
  }, [actorId, notificationEngine]);

  const onResetDemoData = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      // Demo-only operation: explicit DEMO mode required, never executable in LIVE, never against live provider.
      assertDemoOnlyOperation(mode, "Demo reset");
      assertProviderNotLiveForDemoOperation(provider, "Demo reset");
      await provider.resetDemoData();
      const refreshed = await provider.getBookings();
      setBookings(refreshed);
      // Clear stale pending/notification state after demo reset
      setNotifications([]);
      setUnreadCount(0);
      setNotificationDropdownOpen(false);
      setSelectedBooking(null);
      setRejectingId(null);
      setRejectReasonState({});
      setLoading(false);
      setMessage({ type: "success", text: "Demo data reset to initial state." });
    } catch (e) {
      setLoading(false);
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Failed to reset demo data." });
    }
  }, [mode, provider]);

  const onSaveAddInId = useCallback(async () => {
    const trimmed = addInIdInput.trim();
    if (!trimmed) {
      setAddInId(null);
      try { localStorage.removeItem(ADDIN_ID_STORAGE_KEY); } catch { }
      setProviderError(null);
      setMode("DEMO");
      setMessage({ type: "success", text: "Add-In Id cleared. Running in DEMO mode." });
      return;
    }
    try {
      localStorage.setItem(ADDIN_ID_STORAGE_KEY, trimmed);
      setAddInId(trimmed);
      setProviderError(null);
      // When inside MyGeotab, switch to LIVE (ADDIN_DATA); otherwise stay DEMO until API is available
      if (geotabApi) {
        setMode("ADDIN_DATA");
        setMessage({ type: "success", text: "Add-In Id saved. LIVE mode active inside MyGeotab." });
      } else {
        setMessage({ type: "success", text: "Add-In Id saved. Switch to LIVE mode when running inside MyGeotab." });
      }
    } catch (e) {
      setProviderError(e instanceof Error ? e.message : "Failed to save Add-In Id.");
    }
  }, [addInIdInput, geotabApi]);

  const onCreateBooking = useCallback(async (input: {
    assetId: string; startAt: string; endAt: string; destination: string;
    purpose: string; notes: string;
    driverId?: string | null; driverName?: string | null;
  }) => {
    const currentActorId = getActorIdForMode(mode, identityState, demoActor?.id ?? null);
    if (!currentActorId) {
      setMessage({ type: "error", text: isLiveMode ? (liveBlockedReason || "Authenticated MyGeotab identity could not be verified.") : "Select a demo user to create bookings." });
      return;
    }
    if (!canPerformLiveWrite(mode, identityState)) {
      setMessage({ type: "error", text: liveBlockedReason || "Authenticated MyGeotab identity could not be verified." });
      return;
    }
    /* Server-side authorization gate for booking creation */
    const createCreds = getSessionCredentials(mode, identityState);
    if (createCreds && serverAuthz) {
      const createAuthz = await serverAuthz.authorize(createCreds.sessionId, createCreds.database, createCreds.server, "create_booking");
      if (!createAuthz.authorized) {
        setMessage({ type: "error", text: `Not authorized to create bookings (requires ${createAuthz.requiredRole ?? "EMPLOYEE"} role).` });
        return;
      }
    } else if (mode === "ADDIN_DATA") {
      setMessage({ type: "error", text: "Server-side authorization is not configured." });
      return;
    }
    try {
      const created = await provider.createBooking({
        deviceId: input.assetId,
        requesterUserId: currentActorId,
        requestedClass: "PASSENGER",
        startAt: input.startAt,
        endAt: input.endAt,
        purpose: input.purpose,
        destination: input.destination,
        passengerCount: null,
        driverId: input.driverId ?? null,
        driverName: input.driverName ?? null,
      });
      const refreshed = await provider.getBookings();
      setBookings(refreshed);

      // Audit: BOOKING_CREATED (post-persist). Do not claim complete success if audit fails; do not re-create booking.
      const auditCreated = await emitAuditEvent({
        mode,
        provider: provider as any,
        entityId: created.id,
        action: "BOOKING_CREATED",
        actorUserId: currentActorId,
        identity: identityState,
        previousStatus: null,
        newStatus: "PENDING_APPROVAL",
        previous: null,
        next: snapshotBooking(created),
        metadata: { source: "ui.createBooking" },
        idempotencyKey: `${mode}:${created.id}:BOOKING_CREATED`,
      });
      if (!auditCreated.ok) {
        setMessage({ type: "error", text: `Booking #${created.id.slice(-4)} created, but audit persistence failed: ${auditCreated.error}. Booking was not re-created; audit may require recovery.` });
      } else {
        setMessage({ type: "success", text: `Booking #${created.id.slice(-4)} created successfully as PENDING_APPROVAL.` });
      }

      if (notificationEngine) {
        try {
          const approvers = await provider.getApprovers();
          await notificationEngine.onBookingCreated(created, approvers);
          const ns = await notificationEngine.getNotificationsForUser(currentActorId);
          setNotifications(ns);
          setUnreadCount(ns.filter(n => !n.is_read).length);
        } catch (notifyError) {
          setMessage({
            type: "error",
            text: `Booking #${created.id.slice(-4)} created, but notification delivery failed: ${notifyError instanceof Error ? notifyError.message : "Unknown error"}.${auditCreated.ok ? "" : " Audit persistence also failed."}`,
          });
        }
      }
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Failed to create booking." });
    }
  }, [mode, identityState, demoActor, isLiveMode, liveBlockedReason, provider, notificationEngine]);

  const onApprove = useCallback(async (id: string) => {
    if (!canPerformLiveWrite(mode, identityState)) {
      setMessage({ type: "error", text: liveBlockedReason || "Authenticated MyGeotab identity could not be verified." });
      return;
    }
    const authz = authorizeAction("approve_booking", identityState);
    if (!authz.authorized) {
      setMessage({ type: "error", text: `Not authorized to approve bookings (requires ${authz.requiredRole ?? "APPROVER"} role).` });
      return;
    }
    const approverActor = isLiveMode ? (verifiedPrincipal ? { id: verifiedPrincipal.id, name: verifiedPrincipal.name, roles: verifiedPrincipal.roles } : null) : (demoActor ? { id: demoActor.id, name: demoActor.name, roles: demoActor.roles } : null);
    const approverId = getActorIdForMode(mode, identityState, demoActor?.id ?? null) ?? undefined;
    const previous = bookings.find(b => b.id === id) || null;
    try {
      await updateBookingStatus(id, "APPROVED", previous?.version ?? 0, "approve_booking", approverId);
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Failed to approve booking." });
      return;
    }
    const updated = await provider.getBookings();
    setBookings(updated);
    const booking = updated.find(b => b.id === id) || null;
    const audit = await emitAuditEvent({
      mode,
      provider: provider as any,
      entityId: id,
      action: "BOOKING_APPROVED",
      actorUserId: approverId || "",
      identity: identityState,
      previousStatus: previous?.status ?? null,
      newStatus: "APPROVED",
      previous: snapshotBooking(previous),
      next: snapshotBooking(booking),
      metadata: { approverId: approverId ?? null },
      idempotencyKey: `${mode}:${id}:BOOKING_APPROVED:${previous?.status ?? ""}:APPROVED:${approverId ?? ""}`,
    });
    if (!audit.ok) {
      setMessage({ type: "error", text: `Booking #${id.slice(-4)} approved, but audit persistence failed: ${audit.error}. Booking was not reverted; audit may require recovery.` });
    }
    if (notificationEngine && booking) {
      try {
        await notificationEngine.onBookingApproved(booking, approverActor);
      } catch { /* notification failure reported elsewhere where applicable */ }
      const notifUserId = getActorIdForMode(mode, identityState, demoActor?.id ?? null);
      if (notifUserId) {
        const ns = await notificationEngine.getNotificationsForUser(notifUserId);
        setNotifications(ns);
        setUnreadCount(ns.filter(n => !n.is_read).length);
      }
    }
  }, [mode, identityState, isLiveMode, liveBlockedReason, verifiedPrincipal, demoActor, updateBookingStatus, provider, notificationEngine]);

  const onReject = useCallback((id: string) => {
    setRejectingId(id);
  }, []);

  const onConfirmReject = useCallback(async (id: string) => {
    if (!canPerformLiveWrite(mode, identityState)) {
      setMessage({ type: "error", text: liveBlockedReason || "Authenticated MyGeotab identity could not be verified." });
      setRejectingId(null);
      return;
    }
    const authz = authorizeAction("reject_booking", identityState);
    if (!authz.authorized) {
      setMessage({ type: "error", text: `Not authorized to reject bookings (requires ${authz.requiredRole ?? "APPROVER"} role).` });
      setRejectingId(null);
      return;
    }
    const approverActor = isLiveMode ? (verifiedPrincipal ? { id: verifiedPrincipal.id, name: verifiedPrincipal.name, roles: verifiedPrincipal.roles } : null) : (demoActor ? { id: demoActor.id, name: demoActor.name, roles: demoActor.roles } : null);
    const approverId = getActorIdForMode(mode, identityState, demoActor?.id ?? null) ?? undefined;
    const previous = bookings.find(b => b.id === id) || null;
    const reason = rejectReason[id] ?? undefined;
    try {
      await updateBookingStatus(id, "REJECTED", previous?.version ?? 0, "reject_booking", approverId, reason);
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Failed to reject booking." });
      return;
    }
    const updated = await provider.getBookings();
    setBookings(updated);
    const booking = updated.find(b => b.id === id) || null;
    const audit = await emitAuditEvent({
      mode,
      provider: provider as any,
      entityId: id,
      action: "BOOKING_REJECTED",
      actorUserId: approverId || "",
      identity: identityState,
      previousStatus: previous?.status ?? null,
      newStatus: "REJECTED",
      previous: snapshotBooking(previous),
      next: snapshotBooking(booking),
      metadata: { approverId: approverId ?? null, reason: reason ?? null },
      idempotencyKey: `${mode}:${id}:BOOKING_REJECTED:${previous?.status ?? ""}:REJECTED:${approverId ?? ""}`,
    });
    if (!audit.ok) {
      setMessage({ type: "error", text: `Booking #${id.slice(-4)} rejected, but audit persistence failed: ${audit.error}. Booking was not reverted; audit may require recovery.` });
    }
    if (notificationEngine && booking) {
      try {
        await notificationEngine.onBookingRejected(booking, approverActor, reason);
      } catch { }
      const notifUserId = getActorIdForMode(mode, identityState, demoActor?.id ?? null);
      if (notifUserId) {
        const ns = await notificationEngine.getNotificationsForUser(notifUserId);
        setNotifications(ns);
        setUnreadCount(ns.filter(n => !n.is_read).length);
      }
    }
    setRejectingId(null);
  }, [mode, identityState, isLiveMode, liveBlockedReason, verifiedPrincipal, demoActor, updateBookingStatus, provider, rejectReason, notificationEngine]);

  const onCancelReject = useCallback(() => {
    setRejectingId(null);
  }, []);

  const onAssign = useCallback(async (id: string) => {
    const b = bookings.find(x => x.id === id);
    if (!b || b.status !== "APPROVED") return;
    if (!canPerformLiveWrite(mode, identityState)) {
      setMessage({ type: "error", text: liveBlockedReason || "Authenticated MyGeotab identity could not be verified." });
      return;
    }
    const authz = authorizeAction("assign_driver", identityState);
    if (!authz.authorized) {
      setMessage({ type: "error", text: `Not authorized to assign drivers (requires ${authz.requiredRole ?? "APPROVER"} role).` });
      return;
    }
    const previous = bookings.find(x => x.id === id) || null;
    const actorIdForOp = getActorIdForMode(mode, identityState, demoActor?.id ?? null) ?? undefined;
    try {
      await updateBookingStatus(id, "ASSIGNED", previous?.version ?? 0, "assign_driver", actorIdForOp);
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Failed to assign booking." });
      return;
    }
    const updated = await provider.getBookings();
    setBookings(updated);
    const booking = updated.find(x => x.id === id) || null;
    const audit = await emitAuditEvent({
      mode,
      provider: provider as any,
      entityId: id,
      action: "VEHICLE_ASSIGNED",
      actorUserId: actorIdForOp || "",
      identity: identityState,
      previousStatus: previous?.status ?? null,
      newStatus: "ASSIGNED",
      previous: snapshotBooking(previous),
      next: snapshotBooking(booking),
      metadata: { assignedBy: actorIdForOp ?? null },
      idempotencyKey: `${mode}:${id}:VEHICLE_ASSIGNED:${previous?.status ?? ""}:ASSIGNED:${actorIdForOp ?? ""}`,
    });
    if (!audit.ok) {
      setMessage({ type: "error", text: `Booking #${id.slice(-4)} assigned, but audit persistence failed: ${audit.error}. Booking was not reverted; audit may require recovery.` });
    }
    if (notificationEngine && booking) {
      const assigner = isLiveMode ? (verifiedPrincipal ? { id: verifiedPrincipal.id, name: verifiedPrincipal.name, roles: verifiedPrincipal.roles } : null) : (demoActor ? { id: demoActor.id, name: demoActor.name, roles: demoActor.roles } : null);
      try {
        await notificationEngine.onVehicleAssigned(booking, assigner);
      } catch { }
      const notifUserId = getActorIdForMode(mode, identityState, demoActor?.id ?? null);
      if (notifUserId) {
        const ns = await notificationEngine.getNotificationsForUser(notifUserId);
        setNotifications(ns);
        setUnreadCount(ns.filter(n => !n.is_read).length);
      }
    }
  }, [bookings, mode, identityState, isLiveMode, liveBlockedReason, verifiedPrincipal, demoActor, updateBookingStatus, provider, notificationEngine]);

  const onComplete = useCallback(async (id: string) => {
    const b = bookings.find(x => x.id === id);
    if (!b || b.status !== "ASSIGNED") return;
    if (!canPerformLiveWrite(mode, identityState)) {
      setMessage({ type: "error", text: liveBlockedReason || "Authenticated MyGeotab identity could not be verified." });
      return;
    }
    const actorIdForOp = getActorIdForMode(mode, identityState, demoActor?.id ?? null) ?? "";
    const authz = authorizeAction("complete_booking", identityState);
    if (!authz.authorized) {
      setMessage({ type: "error", text: `Not authorized to complete bookings (requires ${authz.requiredRole ?? "EMPLOYEE"} role).` });
      return;
    }
    const previous = b;
    try {
      await updateBookingStatus(id, "COMPLETED", previous.version, "complete_booking", actorIdForOp || undefined);
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Failed to complete booking." });
      return;
    }
    const updated = await provider.getBookings();
    setBookings(updated);
    const booking = updated.find(x => x.id === id) || null;
    const audit = await emitAuditEvent({
      mode,
      provider: provider as any,
      entityId: id,
      action: "BOOKING_COMPLETED",
      actorUserId: actorIdForOp,
      identity: identityState,
      previousStatus: previous.status,
      newStatus: "COMPLETED",
      previous: snapshotBooking(previous),
      next: snapshotBooking(booking),
      metadata: {},
      idempotencyKey: `${mode}:${id}:BOOKING_COMPLETED:${previous.status}:COMPLETED:${actorIdForOp}`,
    });
    if (!audit.ok) {
      setMessage({ type: "error", text: `Booking #${id.slice(-4)} completed, but audit persistence failed: ${audit.error}. Booking was not reverted; audit may require recovery.` });
    }
  }, [bookings, mode, identityState, liveBlockedReason, demoActor, updateBookingStatus, provider]);

  const onCancel = useCallback(async (id: string) => {
    const b = bookings.find(x => x.id === id);
    if (!b || !["PENDING_APPROVAL", "APPROVED", "ASSIGNED"].includes(b.status)) return;
    if (!canPerformLiveWrite(mode, identityState)) {
      setMessage({ type: "error", text: liveBlockedReason || "Authenticated MyGeotab identity could not be verified." });
      return;
    }
    const actorIdForOp = getActorIdForMode(mode, identityState, demoActor?.id ?? null) ?? "";
    const authz = authorizeAction("cancel_booking", identityState);
    if (!authz.authorized) {
      setMessage({ type: "error", text: `Not authorized to cancel bookings (requires ${authz.requiredRole ?? "EMPLOYEE"} role).` });
      return;
    }
    const previous = b;
    try {
      await updateBookingStatus(id, "CANCELLED", previous.version, "cancel_booking", actorIdForOp || undefined);
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Failed to cancel booking." });
      return;
    }
    const updated = await provider.getBookings();
    setBookings(updated);
    const booking = updated.find(x => x.id === id) || null;
    const audit = await emitAuditEvent({
      mode,
      provider: provider as any,
      entityId: id,
      action: "BOOKING_CANCELLED",
      actorUserId: actorIdForOp,
      identity: identityState,
      previousStatus: previous.status,
      newStatus: "CANCELLED",
      previous: snapshotBooking(previous),
      next: snapshotBooking(booking),
      metadata: {},
      idempotencyKey: `${mode}:${id}:BOOKING_CANCELLED:${previous.status}:CANCELLED:${actorIdForOp}`,
    });
    if (!audit.ok) {
      setMessage({ type: "error", text: `Booking #${id.slice(-4)} cancelled, but audit persistence failed: ${audit.error}. Booking was not reverted; audit may require recovery.` });
    }
  }, [bookings, mode, identityState, liveBlockedReason, demoActor, updateBookingStatus, provider]);

  const setRejectReason = useCallback((id: string, reason: string) => {
    setRejectReasonState(prev => ({ ...prev, [id]: reason }));
  }, []);

  const onExportDashboard = useCallback(() => {
    const data = dashboardBookings.map(b => ({
      "Booking ID": b.id,
      Asset: b.asset_name || "Unassigned",
      "License Plate": b.registration_no || "",
      User: b.requester_name,
      "Booking Date": b.start_at,
      "Start Time": b.start_at,
      "End Time": b.end_at,
      Destination: b.destination || "",
      "Booking Status": b.status,
    }));
    exportCSV(data, `opex-vbm-dashboard-bookings-${new Date().toISOString().slice(0,10)}.csv`);
  }, [dashboardBookings]);

  const onExportMyBookings = useCallback(() => {
    const data = myBookingsData.map(b => ({
      "Booking ID": b.id,
      Asset: b.asset_name || "Unassigned",
      "Booking Date": b.start_at,
      "Start Time": b.start_at,
      "End Time": b.end_at,
      Destination: b.destination || "",
      "Booking Status": b.status,
    }));
    exportCSV(data, `opex-vbm-mybookings-${actor?.name || "all"}-${new Date().toISOString().slice(0,10)}.csv`);
  }, [myBookingsData, actor]);

  const onExportApprovals = useCallback(() => {
    const data = approvalBookings.map(b => ({
      "Request ID": b.id,
      User: b.requester_name,
      Asset: b.asset_name || "Unassigned",
      "Booking Date": b.start_at,
      Destination: b.destination || "",
      "Request Date": b.created_at,
    }));
    exportCSV(data, `opex-vbm-approvals-${new Date().toISOString().slice(0,10)}.csv`);
  }, [approvalBookings]);

  const onExportFleet = useCallback(() => {
    const data = assets.map(a => ({
      "Asset Name": a.asset_name,
      "License Plate": a.registration_no || "",
      "Serial Number": a.serial_number || "",
      "Asset Type": a.asset_class,
      "MyGeotab Device ID": a.geotab_device_id || "",
      "Asset Group": "North Sumatra",
      Availability: a.status,
      "Current Booking": "",
    }));
    exportCSV(data, `opex-vbm-fleet-${new Date().toISOString().slice(0,10)}.csv`);
  }, [assets]);

  const navigateTo = (key: string) => {
    setActive(key);
  };

  const Page = (() => {
    switch (active) {
      case "Dashboard": return (
        <ErrorBoundary fallbackTitle="Dashboard Temporarily Unavailable" fallbackMessage="The dashboard section encountered an error.">
          <Dashboard
            bookings={dashboardBookings}
            assets={assets}
            loading={loading}
            onLoadData={onLoadData}
            onExport={onExportDashboard}
            onNewBooking={() => navigateTo("New Booking")}
            addToast={pushToastCb}
            filters={filters}
            onFilterChange={onFilterChange}
            onApplyFilters={onLoadData}
            onResetFilters={onResetFilters}
            users={users}
          />
        </ErrorBoundary>
      );
      case "New Booking": return (
        <NewBooking
          assets={assets}
          bookings={bookings}
          actor={actor}
          canWrite={canPerformLiveWrite(mode, identityState)}
          blockedReason={isLiveMode ? liveBlockedReason : (!actor ? "Select a demo user to create bookings." : null)}
          onCreateBooking={onCreateBooking}
          addToast={pushToastCb}
          navigateToMyBookings={() => navigateTo("My Bookings")}
          users={users}
        />
      );
      case "My Bookings": return (
        <MyBookings
          bookings={myBookingsData}
          actor={actor}
          isLiveMode={isLiveMode}
          demoActor={demoActor}
          users={users}
          setDemoActor={setDemoActor}
          onExport={onExportMyBookings}
          onView={id => setSelectedBooking(myBookingsData.find(b => b.id === id) || null)}
          onCancel={onCancel}
          addToast={pushToastCb}
          filters={filters}
          onFilterChange={onFilterChange}
          onApplyFilters={onLoadData}
          onResetFilters={onResetFilters}
        />
      );
      case "Approval Inbox": return (
        <ApprovalInbox
          bookings={approvalBookings}
          onApprove={onApprove}
          onReject={onReject}
          onView={id => setSelectedBooking(approvalBookings.find(b => b.id === id) || null)}
          rejectingId={rejectingId}
          onConfirmReject={onConfirmReject}
          onCancelReject={onCancelReject}
          onExport={onExportApprovals}
          addToast={pushToastCb}
          rejectReason={rejectReason}
          setRejectReason={setRejectReason}
          filters={filters}
          onFilterChange={onFilterChange}
          onApplyFilters={onLoadData}
          onResetFilters={onResetFilters}
          assets={assets}
        />
      );
      case "Notifications": return (
        <NotificationCenter
          notifications={notifications}
          actor={actor}
          unreadCount={unreadCount}
          onMarkAsRead={async (id: string) => {
            if (notificationEngine && actorId) {
              await notificationEngine.markAsRead(id);
              const ns = await notificationEngine.getNotificationsForUser(actorId);
              setNotifications(ns);
              setUnreadCount(ns.filter(n => !n.is_read).length);
            }
          }}
          onMarkAllAsRead={async () => {
            if (notificationEngine && actorId) {
              await notificationEngine.markAllAsRead(actorId);
              const ns = await notificationEngine.getNotificationsForUser(actorId);
              setNotifications(ns);
              setUnreadCount(0);
            }
          }}
          onNotificationClick={async (id: string) => {
            const n = notifications.find(x => x.id === id);
            if (n?.related_booking_id) {
              setSelectedBooking(bookings.find(b => b.id === n.related_booking_id) || null);
              setActive("My Bookings");
              if (notificationEngine && actorId) {
                await notificationEngine.markAsRead(id);
                const ns = await notificationEngine.getNotificationsForUser(actorId);
                setNotifications(ns);
                setUnreadCount(ns.filter(x => !x.is_read).length);
              }
            }
          }}
        />
      );
      case "Asset Availability": return (
        <ErrorBoundary fallbackTitle="Asset Availability Temporarily Unavailable" fallbackMessage="The asset availability section encountered an error.">
          <AssetAvailability assets={assets} bookings={availabilityBookings} onExport={onExportFleet}
            filters={filters}
            onFilterChange={onFilterChange}
            onApplyFilters={onLoadData}
            onResetFilters={onResetFilters}
            users={users} />
        </ErrorBoundary>
      );
      case "Booking Reports": return (
        <ErrorBoundary fallbackTitle="Booking Reports Temporarily Unavailable" fallbackMessage="The booking reports section encountered an error.">
          <BookingReports bookings={reportsBookings} assets={assets} onExport={onExportDashboard}
            filters={filters}
            onFilterChange={onFilterChange}
            onApplyFilters={onLoadData}
            onResetFilters={onResetFilters}
            users={users} />
        </ErrorBoundary>
      );
      default: return (
        <Dashboard
          bookings={dashboardBookings}
          assets={assets}
          loading={loading}
          onLoadData={onLoadData}
          onExport={onExportDashboard}
          onNewBooking={() => navigateTo("New Booking")}
          addToast={pushToastCb}
          filters={filters}
          onFilterChange={onFilterChange}
          onApplyFilters={onLoadData}
          onResetFilters={onResetFilters}
          users={users}
        />
      );
    }
  })();

  const pendingCount = bookings.filter(b => b.status === "PENDING_APPROVAL").length;

  return (
    <div className="shell">
      <main className="main">
        <div className="topbar">
          <div className="topbar-left">
            <div className="topbar-brand">
              <div className="topbar-brand-text"><b>OPEX VBM</b><small>Asset Booking</small></div>
            </div>
            <div className="topbar-divider"></div>
            <div className="topbar-info">
              <div className="topbar-tenant">{TENANT}</div>
              <div className="topbar-source">{mode === "ADDIN_DATA" ? "ADDIN DATA" : "DEMO MODE"}</div>
            </div>
          </div>
          <div className="topbar-right">
            {/* Mode toggle: DEMO (standalone) vs LIVE / ADDIN_DATA (inside MyGeotab) */}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <label style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>Mode</label>
              <select
                className="form-control"
                style={{ width: "130px", fontSize: "var(--text-sm)" }}
                value={mode}
                onChange={e => setMode(e.target.value as "DEMO" | "ADDIN_DATA")}
                disabled={mode === "ADDIN_DATA" && !geotabApi}
              >
                <option value="DEMO">DEMO (standalone)</option>
                <option value="ADDIN_DATA">LIVE (MyGeotab AddInData)</option>
              </select>
              {mode === "ADDIN_DATA" && !geotabApi && (
                <span style={{ fontSize: "var(--text-xs)", color: "#EF4444" }}>API not available</span>
              )}
            </div>

            {/* AddInId input: required for ADDIN_DATA write operations */}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <label style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>AddInId</label>
              <input
                className="form-control"
                style={{ width: "180px", fontSize: "var(--text-sm)" }}
                value={addInIdInput}
                onChange={e => setAddInIdInput(e.target.value)}
                placeholder="e.g. 0sLv7MVYQSy5TwusJHpGQA"
                disabled={mode === "DEMO" && !geotabApi}
              />
              <button
                className="btn btn-primary"
                onClick={onSaveAddInId}
                disabled={mode === "DEMO" && !geotabApi}
                style={{ fontSize: "var(--text-sm)", padding: "4px 10px" }}
              >
                Save
              </button>
              {addInId && addInIdValid ? (
                <span style={{ fontSize: "var(--text-xs)", color: "#10B981" }}>● configured</span>
              ) : addInId && !addInIdValid ? (
                <span style={{ fontSize: "var(--text-xs)", color: "#EF4444" }}>⚠ invalid format</span>
              ) : null}
            </div>

            {/* Authenticated MyGeotab identity (verified principal only) */}
            {isLiveMode && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 12, borderLeft: "1px solid var(--border)" }}>
                <div>
                  <div style={{ fontSize: "var(--text-xs)", color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>MyGeotab Identity</div>
                  {identityState.status === "authenticated" && verifiedPrincipal ? (
                    <>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{verifiedPrincipal.name}</div>
                      <div style={{ fontSize: 10, color: "#6B7280" }}>{verifiedPrincipal.id}{identityState.session.database ? ` · ${identityState.session.database}` : ""}</div>
                    </>
                  ) : (
                    <div style={{ fontSize: 11, color: "#EF4444" }}>{identityState.status === "loading" ? "Resolving…" : (liveBlockedReason || "Unverified")}</div>
                  )}
                </div>
              </div>
            )}

            {/* Demo actor select (DEMO mode only; never used in LIVE) */}
            {!isLiveMode && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 12, borderLeft: "1px solid var(--border)" }}>
                <label style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>Demo User</label>
                <select
                  className="form-control"
                  style={{ width: "180px", fontSize: "var(--text-sm)" }}
                  value={demoActor ? demoActor.id : ""}
                  onChange={e => {
                    const emp = users.find(x => x.id === e.target.value) || null;
                    setDemoActor(emp);
                  }}
                >
                  <option value="">Select demo user</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>{u.name} ({u.id})</option>
                  ))}
                </select>
              </div>
            )}

            {/* Notification Bell */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 12, borderLeft: "1px solid var(--border)" }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setNotificationDropdownOpen(!notificationDropdownOpen)}
                style={{ position: "relative", padding: 6, display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <span style={{ fontSize: 16 }}>𔔡</span>
                {unreadCount > 0 && (
                  <span style={{
                    position: "absolute", top: 2, right: 2,
                    background: "#EF4444", color: "#fff", fontSize: 10, fontWeight: 700,
                    borderRadius: "50%", minWidth: 16, height: 16,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                )}
              </button>
              {notificationDropdownOpen && (
                <NotificationDropdown
                  notifications={notifications}
                  unreadCount={unreadCount}
                  onMarkAsRead={async (id: string) => {
                    if (notificationEngine && actorId) {
                      await notificationEngine.markAsRead(id);
                      const ns = await notificationEngine.getNotificationsForUser(actorId);
                      setNotifications(ns);
                      setUnreadCount(ns.filter(n => !n.is_read).length);
                    }
                  }}
                  onMarkAllAsRead={async () => {
                    if (notificationEngine && actorId) {
                      await notificationEngine.markAllAsRead(actorId);
                      const ns = await notificationEngine.getNotificationsForUser(actorId);
                      setNotifications(ns);
                      setUnreadCount(0);
                    }
                    setNotificationDropdownOpen(false);
                  }}
                  onClose={() => setNotificationDropdownOpen(false)}
                  onNotificationClick={async (id: string) => {
                    const n = notifications.find(x => x.id === id);
                    if (n?.related_booking_id) {
                      setSelectedBooking(bookings.find(b => b.id === n.related_booking_id) || null);
                      setActive("My Bookings");
                      setNotificationDropdownOpen(false);
                      if (notificationEngine && actorId) {
                        await notificationEngine.markAsRead(id);
                        const ns = await notificationEngine.getNotificationsForUser(actorId);
                        setNotifications(ns);
                        setUnreadCount(ns.filter(x => !x.is_read).length);
                      }
                    }
                  }}
                />
              )}
            </div>

            <div className="user-badge">
              {actor ? (
                <div>
                  <div style={{ fontSize: 12 }}>{actor.name}</div>
                  <div style={{ fontSize: 10, color: "#6B7280" }}>{actor.kind === "authenticated" ? "Verified MyGeotab" : "Demo"} · {actor.roles.join(", ")}</div>
                </div>
              ) : (
                <div style={{ fontSize: 11, color: isLiveMode ? "#EF4444" : "#9CA3AF" }}>{isLiveMode ? "Identity unverified" : "No demo user"}</div>
              )}
            </div>
          </div>

          {/* Provider error banner (never silently swallowed) */}
          {providerError && (
            <div style={{ marginLeft: 16, padding: 8, background: "#FEF2F2", border: "1px solid #FECACA", color: "#991B1B", fontSize: "var(--text-xs)", borderRadius: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "400px" }}>
              {providerError}
            </div>
          )}

          {/* Last Updated indicator */}
          {activeInterval > 0 && (
            <div style={{ marginLeft: 16, padding: 6, fontSize: "var(--text-xs)", color: "#6B7280", background: "#F8FAFC", borderRadius: 4, border: "1px solid var(--border)", whiteSpace: "nowrap" }}>
              <span style={{ fontWeight: 600, color: "#2563EB" }}>⟳</span>
              {refreshLastUpdated ? `Last updated: ${refreshLastUpdated.toLocaleTimeString()}` : "Last updated: —"}
              {refreshIsRefreshing ? " · refreshing…" : ""}
            </div>
          )}

          {/* Manual Refresh button */}
          {activeInterval > 0 && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={refreshManualRefresh}
              disabled={refreshIsRefreshing}
              style={{ marginLeft: 8, padding: "6px 10px", fontSize: "var(--text-xs)" }}
            >
              {refreshIsRefreshing ? "⟳ Refreshing…" : "⟳ Refresh"}
            </button>
          )}
        </div>

        <nav className="tab-nav">
          {NAV_ITEMS.map(item => {
            const isActive = active === item.key;
            const pendingBadge = item.key === "Approval Inbox" && pendingCount > 0 ? pendingCount : 0;
            const notifBadge = item.key === "Approval Inbox" && unreadCount > 0 ? unreadCount : 0;
            const totalBadge = pendingBadge + notifBadge;
            const badge = totalBadge > 0 ? (
              <span className="tab-badge">{totalBadge}</span>
            ) : null;
            return (
              <button
                key={item.key}
                className={`tab ${isActive ? "tab-active" : ""}`}
                onClick={() => navigateTo(item.key)}
              >
                {item.label}{badge}
              </button>
            );
          })}
        </nav>

        {message && (
          <div className={`notice ${message.type === "success" ? "success" : "error"}`} style={{ marginBottom: 0 }}>
            {message.text}
          </div>
        )}

        <div className="page-container">
          {Page}
          <ViewDetailsModal
            booking={selectedBooking}
            assets={assets}
            onClose={() => setSelectedBooking(null)}
            onApprove={onApprove}
            onReject={onReject}
            onAssign={onAssign}
            onComplete={onComplete}
            onCancel={onCancel}
            rejectingId={rejectingId}
            onConfirmReject={onConfirmReject}
            onCancelReject={onCancelReject}
            addToast={pushToastCb}
            rejectReason={rejectReason}
            setRejectReason={setRejectReason}
          />
        </div>

        <div className="toast-container">
          {toasts.map(t => (
            <ToastItem key={t.id} toast={t} onDismiss={id => setToasts(prev => prev.filter(x => x.id !== id))} />
          ))}
        </div>

        <footer style={{ marginTop: 40, paddingTop: 20, borderTop: "1px solid var(--border)", fontSize: 11, color: "#6B7280" }}>
          OPEX Asset Booking Management · v0.1.0 · {mode} · Bookings: {mode === "ADDIN_DATA" ? "MyGeotab AddInData" : "local mock"}
        </footer>
      </main>
    </div>
  );
}
