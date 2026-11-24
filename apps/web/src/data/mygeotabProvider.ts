/*───────────────────── MyGeotab Live Data Provider ─────────────────────*/
/* Read-only master data from MyGeotab (devices, users, groups).
   Booking transactions remain local/simulated via LocalBookingDataProvider. */

import type {
  MyGeotabGroup,
  MyGeotabStatusData,
  MyGeotabLogRecord,
  ResolvedAsset,
  ResolvedBooking,
  ResolvedUser,
  BookingDataProvider,
} from "./types";
import {
  mockMyGeotabStatusData,
  mockMyGeotabLogRecords,
} from "./mockMyGeotab";
import { LocalBookingDataProvider } from "./dataProvider";

/*───────────────────── Geotab API type (Add-In context) ─────────────────────*/

type GeotabApi = {
  call?: (method: string, params: Record<string, unknown>, success: (result: unknown) => void, error?: (error: unknown) => void) => void;
  getSession?: (callback: (session: { userName?: string; database?: string; server?: string } | null) => void) => void;
};

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
  };
}

function mapLiveGroup(raw: RawMyGeotabGroup): MyGeotabGroup {
  return {
    id: raw.id,
    name: raw.name,
    parentId: raw.parentId,
  };
}

/*───────────────────── MyGeotab Booking Data Provider ─────────────────────*/

export class MyGeotabBookingDataProvider implements BookingDataProvider {
  private readonly localProvider: LocalBookingDataProvider;
  private readonly api: GeotabApi | null;

  constructor(api: GeotabApi | null) {
    this.localProvider = new LocalBookingDataProvider();
    this.api = api;
  }

  /*───────────────────── JSON-RPC wrapper over geotab.addin API ─────────────────────*/

  private async apiCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.api?.call) {
        reject(new Error("GEOTAB_API_NOT_AVAILABLE: running outside MyGeotab Add-In context"));
        return;
      }
      this.api.call(method, params, (result: unknown) => resolve(result as T), (error: unknown) => reject(error ?? new Error("GEOTAB_API_ERROR")));
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

  async getApprovers(): Promise<ResolvedUser[]> {
    const users = await this.getUsers();
    return users.filter(u => u.roles.includes("APPROVER"));
  }

  async getGroups(): Promise<MyGeotabGroup[]> {
    const groups = await this.apiCall<RawMyGeotabGroup[]>("Get", {
      typeName: "Group",
      resultsLimit: 1000,
    });
    return groups.map(mapLiveGroup);
  }

  async getStatusData(): Promise<MyGeotabStatusData[]> {
    return [...mockMyGeotabStatusData];
  }

  async getLogRecords(): Promise<MyGeotabLogRecord[]> {
    return [...mockMyGeotabLogRecords];
  }

  /*───────────────────── Booking transactions (always local/simulated) ─────────────────────*/

  async getBookings(): Promise<ResolvedBooking[]> {
    return this.localProvider.getBookings();
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
  }): Promise<ResolvedBooking> {
    return this.localProvider.createBooking(input);
  }

  async updateBookingStatus(id: string, status: string, expectedVersion: number, approverId?: string, approvalRemarks?: string): Promise<void> {
    return this.localProvider.updateBookingStatus(id, status, expectedVersion, approverId, approvalRemarks);
  }

  async deleteBooking(id: string): Promise<void> {
    return this.localProvider.deleteBooking(id);
  }

  async resetDemoData(): Promise<void> {
    return this.localProvider.resetDemoData();
  }

  isLive(): boolean {
    return true;
  }
}

/*───────────────────── Helper: build provider from Add-In API context ─────────────────────*/

export function createMyGeotabProvider(api: GeotabApi | null): MyGeotabBookingDataProvider {
  return new MyGeotabBookingDataProvider(api);
}
