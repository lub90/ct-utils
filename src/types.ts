/** The rights of the current person on the extension's module (`GET /permissions/global` → `data[<key>]`). */
export interface Permissions {
    view: boolean;
    'create custom category': boolean;
    /** The following are lists of category IDs. Missing rights are `[]`, never missing keys. */
    'view custom category': number[];
    'edit custom category': number[];
    'delete custom category': number[];
    'view custom data': number[];
    'create custom data': number[];
    'edit custom data': number[];
    'delete custom data': number[];
}

export interface CtWhoAmI {
    id: number;
    firstName: string;
    lastName: string;
}

export interface CtCategory {
    id: number;
    name: string;
    shorty: string;
}

/** `value` is a JSON string; parsing and validating it is the store layer's job. */
export interface CtValue {
    id: number;
    dataCategoryId: number;
    value: string;
}

export interface CtGroup {
    id: number;
    name: string;
    memberCount: number;
}

/** The rights catalog of this instance: `"<module key>:<right key>"` → `authId` (never hard-coded, they differ per instance). */
export type PermissionCatalog = Map<string, number>;

/** One entry of `POST /permissions/bulk`. `dataId` are category IDs for rights on categories; omit it for boolean rights. */
export interface PermissionChange {
    /** Measured 2026-11-16 by contract case 'status domain: bulk save, replace (the W24 revoke), holders and status 0': `status` works in the bulk (`save`, `replace` with `[]`) like `person` and `group_role`. */
    domainType: 'person' | 'group_role' | 'status';
    domainId: number;
    /**
     * `save` adds to the selection already assigned (measured 2026-11-15 on a group role and a person, with a category
     * right and with `login to external system`), `replace` sets the whole selection (`[]` removes it), `delete`
     * removes the given selections (or all).
     */
    operation: 'save' | 'replace' | 'delete';
    authId: number;
    dataId?: number[];
}

/** One right of a person and where it comes from (`origins[].type`: `person`, `groupRole`, `superAdmin`, …). */
export interface OriginEntry {
    module: string;
    auth: string;
    authId: number;
    originTypes: string[];
    /**
     * What all origins together give: a flag or the selected IDs. A level (measured 2026-11-15: `security level person`
     * is a plain `1`) is a list of one, `[1]`, as `GET /permissions/global` reports it. A value of any other shape is
     * `true`, so it counts as granted where too many rights are looked for, and as missing where a list is required.
     */
    effectiveValue: boolean | number[];
}

/**
 * Where a holder's right comes from, as a domain the extension can read and change (`GET`/bulk `/permissions/…`).
 * Measured shapes (2026-11-15): a `groupRole` origin names `groupId` and `groupRoleId`, a `status` origin `statusId`
 * (0 is a real status), a `person` origin is the holder's own grant. Every other origin (`groupTypeRole`,
 * `publicUser`, `superAdmin`, or one of those without its IDs) is `other`: listed, never dropped.
 */
export type HolderSource =
    | { domainType: 'person'; domainId: number }
    | { domainType: 'status'; domainId: number }
    | { domainType: 'group_role'; domainId: number; groupId: number }
    | { domainType: 'other'; originType: string };

/** A person who holds a right, and the origin types of it. */
export interface Holder {
    personId: number;
    originTypes: string[];
    /** The origins as domains (the layer always fills it; hand-made holders in tests may leave it out). */
    sources?: HolderSource[];
}

/** The domains `GET /permissions/{domainType}/{domainId}` can read for one owner of rights. */
export type PermissionDomain = 'person' | 'group_role' | 'status';

/**
 * A right granted directly to one domain (no other origins). `dataId` is `null` for a right without selection, else
 * the selected IDs (`-1` = all, also future ones).
 */
export interface DomainRight {
    authId: number;
    dataId: number[] | null;
}

/** One role of a concrete group (`GET /groups/{id}/roles`); rights are granted per role. */
export interface CtGroupRole {
    id: number;
    isDefault: boolean;
    /** The role's name, when ChurchTools gives one (not measured; display only). */
    name?: string;
}

/**
 * The parts of `GET /groups/{id}` the rights check needs (extension spec 16.4 rules 5 and 6 b), named as ChurchTools
 * names them (`information.*`, `settings.*`). `undefined` = missing or of an unexpected type, so the check can say it
 * couldn't verify. `dynamicGroupStatus` is `null` when no status is stored (not dynamic).
 */
export interface CtGroupDetails {
    id: number;
    name: string;
    groupStatusId: number | undefined;
    groupTypeId: number | undefined;
    isOpenForMembers: boolean | undefined;
    autoAccept: boolean | undefined;
    dynamicGroupStatus: string | null | undefined;
}

/** One entry of the person master data (`GET /person/masterdata`). IDs may be `0` (measured: status 0, campus 0). */
export interface CtMasterdataEntry {
    id: number;
    /** The instance's label (`nameTranslated`), else the raw `name` (e.g. `status.friend`). */
    name: string;
}

/** What creating a person needs from the master data. */
export interface CtPersonMasterdata {
    statuses: CtMasterdataEntry[];
    departments: CtMasterdataEntry[];
    campuses: CtMasterdataEntry[];
}

/** A person for `POST /persons`. `privacy` only on instances that require it (`privacy_policy_fields_mandatory`). */
export interface NewPerson {
    firstName: string;
    lastName: string;
    /** The login name; ChurchTools refuses a taken one (`400`, field `cmsUserId`). */
    cmsUserId: string;
    statusId: number;
    departmentIds: number[];
    campusId: number;
    privacy?: { typeId: number; whoId: number; /** `Y-m-d` */ date: string };
}

/** A freshly created OAuth client. `clientSecret` is returned only once and must never be logged or stored. */
export interface CtOAuthClient {
    /** The numeric ID (the `dataId` of "login to external system"). */
    id: number;
    /** The client's public identifier (the `client_id`; single-client calls use it, not the numeric ID). */
    identifier: string;
    clientSecret: string;
}

/** A person as offered in a picker: ID, display name and an optional detail line (e.g. the login name). */
export interface CtPerson {
    id: number;
    name: string;
    detail?: string;
}
