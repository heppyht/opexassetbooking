# AddInData Permission Matrix

**Status:** Documented behavior (from MyGeotab documentation)
**Tenant validation:** NOT performed — requires access to `opex_trial` tenant

## Source References
- MyGeotab Storage API: https://developers.geotab.com/myGeotab/addIns/addInStorage/
- AddInData Object API Reference: https://developers.geotab.com/myGeotab/apiReference/objects/AddInData/
- SecurityIdentifier Object API Reference: https://developers.geotab.com/myGeotab/apiReference/objects/SecurityIdentifier/
- Security Clearances: https://support.geotab.com/help/mygeotab/managing-users-and-vehicles/users/security-clearances

## Security Clearance → AddInData Operations

| Security Clearance | Add | Set | Get | Remove |
|---|---|---|---|---|
| Administrator | ✅ | ✅ | ✅ | ✅ |
| Supervisor | ✅ | ✅ | ✅ | ✅ |
| Default User | ✅ | ✅ | ✅ | ✅ |
| Drive App User | ✅ | ✅ | ✅ | ✅ |
| ViewOnly | ❌ | ❌ | ✅ | ❌ |
| Nothing | ❌ | ❌ | ❌ | ❌ |

## SecurityIdentifier → AddInData Operations

| Security Identifier | Meaning | AddInData Effect |
|---|---|---|
| ManageAddInData | Allow user to add, edit, or remove AddInData objects | Controls Add/Set/Remove |
| ViewAddInData | Allow user to view AddInData objects | Controls Get |
| AccessAddInManagement | Allow user to access Add-in Management | Controls Add-In configuration view |
| ManageAddinsClearance | Allow user to view and edit addins | Controls Add-In lifecycle |

## Custom Security Identifiers (configuration.json)

| Property | Purpose | Effect on AddInData |
|---|---|---|
| `enableViewSecurityId: true` | Creates "View {Add-In name}" clearance | View gate only (Add-In menu visibility) |
| `securityIds: [...]` | Custom security IDs for granular access | Per-Add-In view control only |

**Critical finding:** Custom security identifiers in `configuration.json` control **whether a user can view/launch the Add-In**, NOT whether they can call AddInData.Add/Set/Get/Remove via the API. The `ManageAddInData` and `ViewAddInData` identifiers are **system-level security clearances** applied at the User/Driver level, not per-Add-In.

## Implications for OPEX Asset Booking

1. **Ordinary employees (Default User clearance) CAN directly call AddInData.Add/Set/Get/Remove** via browser console
2. **Custom security identifiers cannot prevent this** — they only gate Add-In menu visibility
3. **The only way to restrict AddInData writes** is to change the user's security clearance (remove ManageAddInData/ViewAddInData), which affects ALL Add-Ins, not just OPEX
4. **Service account** must have ManageAddInData clearance to perform server-mediated writes

## Rate Limits (AddInData API)

| Method | Limit | Period |
|---|---|---|
| Get | 650 | 1 minute |
| Set | 1,700 | 1 minute |
| Add | 100 | 1 minute |
| Remove | 2,250 | 1 minute |
| GetCountOf | 100 | 1 minute |

## AddInData JSON Restrictions

1. JSON data must be 10,000 characters or less per record
2. No property can use the format `geotabXYZ` (reserved for Geotab)
3. `details` property deserializes as JSON object (preferred over legacy `data`)
4. Object properties can be modified but not deleted

## Tenant Validation Status

| Item | Documented | Tenant-Verified |
|---|---|---|
| Default User has AddInData Add/Set/Get/Remove | ✅ | ❌ |
| Custom security identifiers gate Add-In view only | ✅ | ❌ |
| Service account can write AddInData with ManageAddInData | ✅ | ❌ |
| Rate limits enforced by MyGeotab | ✅ | ❌ |

---

**Tenant validation required:** All AddInData permission claims above are from MyGeotab documentation. They must be validated against the `opex_trial` tenant before production use.
