import type { ChurchToolsClient } from '@churchtools/churchtools-client';
import { retryAfterMs } from './client.js';
import { CtForbiddenError, CtHttpError, CtInvalidIdError, CtPasswordNotSetError, CtRateLimitedError, CtValidationError, NotAuthenticatedError, type CtFieldError } from './errors.js';
import type {
    CtCategory,
    CtGroup,
    CtGroupDetails,
    CtGroupRole,
    CtMasterdataEntry,
    CtOAuthClient,
    CtPerson,
    CtPersonMasterdata,
    CtValue,
    CtWhoAmI,
    DomainRight,
    Holder,
    HolderSource,
    NewPerson,
    OriginEntry,
    PermissionCatalog,
    PermissionChange,
    PermissionDomain,
    Permissions,
} from './types.js';

/**
 * Everything the app asks of ChurchTools. Only this module (with `store/` and `backend/`) talks to the network.
 * The measured quirks are documented on the members below; details in specs/ct-extension-info.md.
 */
export interface CtApi {
    /**
     * The current person. QUIRK: with nobody logged in, ChurchTools answers `200` with `id` -1 (or 0), not `401`;
     * both become `NotAuthenticatedError`.
     */
    whoami(): Promise<CtWhoAmI>;
    /**
     * The person's rights on this extension's module. Don't read them from the page's embedded settings (pruned,
     * differently encoded). Missing rights are normalised to `false` / `[]`. May be cached by ChurchTools briefly.
     */
    globalPermissions(): Promise<Permissions>;
    /**
     * The module ID for an extension key, or `null`. QUIRK: for an unknown key (or a module the person can't see)
     * ChurchTools answers `400 validation.integer`, not `404`, because it tries to read the key as a numeric ID.
     */
    moduleId(key: string): Promise<number | null>;
    /**
     * The categories the person may see. QUIRK: a category is listed only with `view custom category`; its values
     * additionally need `view custom data`. Without the right it is absent, not an error.
     */
    categories(moduleId: number): Promise<CtCategory[]>;
    /** All values of a category. Needs `view custom data` on it (`403` otherwise, `missing` names the right). */
    values(moduleId: number, categoryId: number): Promise<CtValue[]>;
    /** `value` is a JSON string of at most 10,000 characters. Needs `create custom data`. */
    createValue(moduleId: number, categoryId: number, value: string): Promise<CtValue>;
    /** Needs `edit custom data`. There is no version or ETag: concurrent writers overwrite each other silently. */
    updateValue(moduleId: number, categoryId: number, valueId: number, value: string): Promise<CtValue>;
    /** Needs `delete custom data`. */
    deleteValue(moduleId: number, categoryId: number, valueId: number): Promise<void>;
    /**
     * Members of a group, with names. QUIRK: readable for a group the person is a member of, or with the
     * `churchgroup` right "view group" on it; any other group answers `403 Forbidden to see group`.
     */
    groupMembers(groupId: number): Promise<CtPerson[]>;
    /** Same visibility rule as `groupMembers`: `CtForbiddenError` for a group the person may not see. */
    group(groupId: number): Promise<CtGroup>;
    /**
     * One person. Only persons the caller may see are readable (members of readable groups, via "view group", or
     * everyone with `view alldata`).
     */
    person(id: number): Promise<CtPerson>;
    /**
     * Persons whose name matches `query` (`GET /persons?query=…`, first page): needs only `churchdb` `view` and finds only
     * the persons the caller may see (measured). The query is trimmed; an empty one sends nothing. Entries without a
     * positive integer ID are dropped.
     */
    searchPersons(query: string): Promise<CtPerson[]>;
    /**
     * The global rights catalog (`GET /permissions/definitions?scope=global`): `"module:key"` → `authId`. Look rights
     * up here, never hard-code IDs. Needs `administer persons` (`CtForbiddenError`, `missing` names it).
     */
    permissionDefinitions(): Promise<PermissionCatalog>;
    /**
     * Grants or removes rights with `POST /permissions/bulk`, always `type: 'grant'`. At most 100 changes, atomic:
     * ChurchTools validates all first, and any failure leaves everything unchanged. More than 100 throw before a request.
     */
    applyPermissions(changes: PermissionChange[]): Promise<void>;
    /** Every global right of a person with its origin types. Needs `administer persons`. */
    permissionOrigins(personId: number): Promise<OriginEntry[]>;
    /**
     * Persons who hold a right, with origin types; all pages. `dataId` (a category ID) is required by ChurchTools for
     * rights on categories and forbidden for boolean ones. Needs `administer persons`.
     */
    permissionHolders(authId: number, dataId?: number): Promise<Holder[]>;
    /**
     * The rights granted directly to one person, status or group role (`GET /permissions/{domainType}/{domainId}`),
     * grouped per `authId`. Only `grant` rows count; `revoke` rows are dropped. An unknown owner (or a role without
     * rights) is `[]`, not an error. Needs `administer persons`.
     */
    domainPermissions(domainType: PermissionDomain, id: number): Promise<DomainRight[]>;
    /** The roles of a group (`GET /groups/{id}/roles`). A right for a group goes to every one of them. */
    groupRoles(groupId: number): Promise<CtGroupRole[]>;
    /** Status, type and the membership settings of a group (`GET /groups/{id}`); `404` for a deleted group. */
    groupDetails(groupId: number): Promise<CtGroupDetails>;
    /**
     * Creates a category of the module (`POST …/customdatacategories`). Needs `create custom category` (`CtForbiddenError`,
     * `missing` names it). The creator doesn't see it in `categories` before they hold `view custom category` on it.
     */
    createCategory(moduleId: number, category: { name: string; shorty: string }): Promise<CtCategory>;
    /**
     * Deletes a category with its values (`DELETE …/customdatacategories/{id}`). Needs `delete custom category` on it
     * (`CtForbiddenError`, `missing` names it); `CtHttpError` 404 if it doesn't exist.
     */
    deleteCategory(moduleId: number, categoryId: number): Promise<void>;
    /**
     * Creates a group of a group type, active (status 1) (`POST /groups`, `force`). Returns its ID. QUIRK: its members
     * can't read it until they hold a role (`addMember` with the type's default role).
     */
    createGroup(name: string, groupTypeId: number): Promise<number>;
    /** The ID of the default role of a group type (`GET /group/roles`, `isDefault`); throws when the type has none. */
    defaultRole(groupTypeId: number): Promise<number>;
    /** Adds a person as an active member with a role of the group's type (`PUT /groups/{id}/members/{personId}`). */
    addMember(groupId: number, personId: number, roleId: number): Promise<void>;
    /** Statuses, departments and campuses for a new person (`GET /person/masterdata`). IDs may be 0 (measured). */
    personMasterdata(): Promise<CtPersonMasterdata>;
    /**
     * Whether new persons need the privacy fields (`GET /config`, `privacy_policy_fields_mandatory`; the answer has no
     * `data` wrapper, measured). Only `false` counts as not mandatory.
     */
    privacyFieldsMandatory(): Promise<boolean>;
    /**
     * Creates a person (`POST /persons?force=true`: the name may be a duplicate on purpose, the login name may not) and
     * returns its ID. A `400` with field errors is `CtValidationError`: a taken `cmsUserId` (see `cmsUserIdTaken`), and,
     * when required, the privacy fields with their `validOptions` (the only place ChurchTools names them, measured).
     */
    createPerson(person: NewPerson): Promise<number>;
    /** Deletes a person completely (`DELETE /persons/{id}`, `204`, then `404`). */
    deletePerson(personId: number): Promise<void>;
    /** The login name (`cmsUserId`) of a person, `''` if it has none; `404` (`CtHttpError`) for a deleted person. */
    personCmsUserId(personId: number): Promise<string>;
    /**
     * Name and login name of a person (`GET /persons/{id}`; `''` for a missing field), to name a stored service user
     * before it is reused; `404` (`CtHttpError`) for a deleted person.
     */
    personLogin(personId: number): Promise<{ firstName: string; lastName: string; cmsUserId: string }>;
    /**
     * Sets another person's password with the legacy AJAX call `churchdb/ajax` `setPersonPassword` (wizard spec W8; no
     * REST call can, and `PUT /persons/{id}/password` changes the caller's own). Through the client's `oldApi`: it
     * fetches the CSRF token, sends it as `CSRF-Token` and resolves only on a JSON answer with `status: 'success'`.
     * Every other outcome is `CtPasswordNotSetError` (measured: `200 status fail` without "simulate persons", `401`
     * without the token, `404` for an unknown person). The password is never logged and never part of an error.
     */
    setPersonPassword(personId: number, password: string): Promise<void>;
    /**
     * Creates a confidential OAuth client (`POST /oauthclients`). QUIRK: `data` may be a list of one entry; anything
     * else (none, several, a missing field) is an error that names no value. The secret is returned only once.
     */
    createOAuthClient(name: string, redirectUri: string): Promise<CtOAuthClient>;
    /** Deletes an OAuth client by its `identifier` (`DELETE /oauthclients/{identifier}`, not by the numeric ID). */
    deleteOAuthClient(identifier: string): Promise<void>;
    /**
     * The numeric ID (the `dataId` of "login to external system") of the client with this `identifier`, from
     * `GET /oauthclients`; `null` when none is listed. Nothing else of the answer is kept (it may hold secrets).
     */
    oauthClientNumericId(identifier: string): Promise<number | null>;
    /** Deletes a group (`DELETE /groups/{id}`, `204`, then `404`). */
    deleteGroup(groupId: number): Promise<void>;
}

/** A taken login name: `createPerson`'s `400` names the field `cmsUserId` (measured: `validation.cmsuserid`). */
export function cmsUserIdTaken(error: unknown): boolean {
    return error instanceof CtValidationError && error.fields.some((f) => f.fieldId === 'cmsUserId');
}

/** ChurchTools' limit for one `POST /permissions/bulk`. */
const MAX_BULK_CHANGES = 100;
const HOLDERS_PAGE_SIZE = 100;
const DOMAIN_TYPES: readonly string[] = ['person', 'group_role', 'status'];
const READ_DOMAIN_TYPES: readonly string[] = ['person', 'group_role', 'status'];
const OPERATIONS: readonly string[] = ['save', 'replace', 'delete'];

interface HttpErrorLike {
    response?: { status?: number; headers?: unknown; data?: { message?: unknown } };
}

/** Maps an axios error to the layer's errors; anything else (network error, our own errors) passes unchanged. */
export function mapCtError(error: unknown, missing?: string): unknown {
    const response = (error as HttpErrorLike | null)?.response;
    const status = response?.status;
    if (typeof status !== 'number') return error;
    const message = typeof response?.data?.message === 'string' ? response.data.message : undefined;
    if (status === 401) return new NotAuthenticatedError(message);
    if (status === 403) return new CtForbiddenError(message, missing);
    if (status === 429) return new CtRateLimitedError(retryAfterMs(response ?? {}));
    return new CtHttpError(status, message);
}

async function guarded<T>(call: () => Promise<T>, missing?: string): Promise<T> {
    try {
        return await call();
    } catch (error) {
        throw mapCtError(error, missing);
    }
}

type Json = Record<string, unknown>;
/** The `churchcore` right the rights catalog, origins and holders endpoints need (named in `CtForbiddenError.missing`). */
const ADMIN_RIGHT = 'administer persons';
/** Hits of a person search: one page is enough for a picker. */
const SEARCH_LIMIT = 20;
/** Every ID that ends up in a request path goes through this first: a positive safe integer, or no request. */
function assertId(n: unknown): asserts n is number {
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new CtInvalidIdError(n);
}
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const originTypes = (origins: unknown): string[] => list(origins).flatMap((o) => (typeof o.type === 'string' ? [o.type] : []));
/** A domain ID: positive, except a status, where 0 is a real ID (measured: status 0 „status.potential“). */
function assertDomainId(domainType: string, n: unknown): asserts n is number {
    if (domainType === 'status') assertBodyId(n);
    else assertId(n);
}
/** The origins of one holder as domains (see `HolderSource`). */
const sourcesOf = (personId: number, origins: unknown): HolderSource[] =>
    list(origins).flatMap((o): HolderSource[] => {
        if (typeof o.type !== 'string') return [];
        if (o.type === 'person') return [{ domainType: 'person', domainId: personId }];
        if (o.type === 'status' && bodyId(o.statusId)) return [{ domainType: 'status', domainId: o.statusId }];
        if (o.type === 'groupRole' && positiveInt(o.groupRoleId) && positiveInt(o.groupId)) return [{ domainType: 'group_role', domainId: o.groupRoleId, groupId: o.groupId }];
        return [{ domainType: 'other', originType: o.type }];
    });
const sourceKey = (s: HolderSource) => (s.domainType === 'other' ? `other:${s.originType}` : `${s.domainType}:${s.domainId}`);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const intList = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isSafeInteger(x));
/**
 * Fail closed: a value of an unexpected shape counts as granted (see `OriginEntry.effectiveValue`). A level (a plain
 * integer, measured for `security level person`) becomes a list of one, the shape `GET /permissions/global` uses.
 */
const effectiveValue = (v: unknown): boolean | number[] =>
    typeof v === 'boolean' ? v : typeof v === 'number' && Number.isSafeInteger(v) ? [v] : intList(v) ? [...v] : true;
/** A master-data ID or one in a request body: unlike path IDs, `0` is valid (measured: status 0, campus 0). */
const bodyId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function assertBodyId(n: unknown): asserts n is number {
    if (!bodyId(n)) throw new CtInvalidIdError(n);
}
const masterdataList = (v: unknown): CtMasterdataEntry[] =>
    list(v).flatMap((e) => (bodyId(e.id) ? [{ id: e.id, name: text(e.nameTranslated) || text(e.name) }] : []));
/** `validOptions` come as a string `"1, 2, 3, 4"` (measured) or a list; only non-negative integers are kept. */
const options = (v: unknown): number[] =>
    (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => (typeof x === 'string' && /^\s*\d+\s*$/.test(x) ? Number(x) : x)).filter(bodyId);
const fieldErrors = (v: unknown): CtFieldError[] =>
    list(v).flatMap((e) =>
        typeof e.fieldId === 'string' ? [{ fieldId: e.fieldId, messageKey: text(e.messageKey), validOptions: isRecord(e.args) ? options(e.args.validOptions) : [] }] : [],
    );
/** A JSON `status` worth naming in an error: a short word, never anything that could carry request data. */
const statusWord = (v: unknown): string | undefined => (typeof v === 'string' && /^[a-z]{1,20}$/.test(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const optionalInt = (v: unknown): number | undefined => (positiveInt(v) ? v : undefined);
const fullName = (first: unknown, last: unknown): string => `${text(first)} ${text(last)}`.trim();

/** The real implementation. Both parameters are required: the client (see `createClient`) and the key of the ChurchTools custom module. */
export function createCtApi(client: ChurchToolsClient, moduleKey: string): CtApi {
    if (typeof moduleKey !== 'string' || moduleKey.trim() === '') throw new TypeError('createCtApi: moduleKey must be a non-empty string');
    const categoryPath = (moduleId: number) => `/custommodules/${moduleId}/customdatacategories`;
    const valuesPath = (moduleId: number, categoryId: number) => `${categoryPath(moduleId)}/${categoryId}/customdatavalues`;

    /**
     * Only members with `groupMemberStatus === 'active'` (ChurchTools also has `waiting`, `requested`, `to_delete`)
     * who aren't archived. Paged: the default limit is 10, so all pages are read.
     */
    async function activeMembers(groupId: number): Promise<CtPerson[]> {
        assertId(groupId);
        const members = await guarded(() => client.getAllPages<Json>(`/groups/${groupId}/members`), 'view group');
        const result = new Map<number, CtPerson>();
        for (const m of members) {
            const person = (m.person ?? {}) as Json;
            const attrs = (person.domainAttributes ?? {}) as Json;
            if (m.groupMemberStatus !== 'active' || attrs.isArchived === true) continue;
            // `personId` is a number here; `domainIdentifier` is a string (as in persons/{id}/groups).
            const id = Number(m.personId ?? person.domainIdentifier);
            if (!Number.isSafeInteger(id) || id <= 0 || result.has(id)) continue;
            const name = text(person.title) || fullName(attrs.firstName, attrs.lastName);
            if (name) result.set(id, { id, name });
        }
        return [...result.values()];
    }

    return {
        async whoami() {
            const me = await guarded(() => client.get<Json>('/whoami'));
            // Fail closed: anything but a positive integer (-1, 0, missing, a string) counts as not logged in.
            const id = me.id;
            if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new NotAuthenticatedError();
            return { id, firstName: text(me.firstName), lastName: text(me.lastName) };
        },

        async globalPermissions() {
            const all = await guarded(() => client.get<unknown>('/permissions/global'));
            const entry = all && typeof all === 'object' ? (all as Record<string, unknown>)[moduleKey] : undefined;
            const own: Record<string, unknown> = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
            // Only real positive integers count as category IDs; anything else grants nothing.
            const ids = (key: string): number[] => {
                const list = own[key];
                return Array.isArray(list) ? list.filter((x): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0) : [];
            };
            return {
                view: own.view === true,
                'create custom category': own['create custom category'] === true,
                'view custom category': ids('view custom category'),
                'edit custom category': ids('edit custom category'),
                'delete custom category': ids('delete custom category'),
                'view custom data': ids('view custom data'),
                'create custom data': ids('create custom data'),
                'edit custom data': ids('edit custom data'),
                'delete custom data': ids('delete custom data'),
            };
        },

        async moduleId(key) {
            try {
                const module = await client.get<Json>(`/custommodules/${encodeURIComponent(key)}`);
                return typeof module.id === 'number' ? module.id : null;
            } catch (error) {
                if ((error as HttpErrorLike | null)?.response?.status === 400) return null;
                throw mapCtError(error);
            }
        },

        async categories(moduleId) {
            assertId(moduleId);
            const list = await guarded(() => client.get<Json[]>(categoryPath(moduleId)));
            return list.map((c) => ({ id: Number(c.id), name: text(c.name), shorty: text(c.shorty) }));
        },

        async values(moduleId, categoryId) {
            assertId(moduleId);
            assertId(categoryId);
            const list = await guarded(() => client.get<Json[]>(valuesPath(moduleId, categoryId)), 'view custom data');
            return list.map((v) => toValue(v, categoryId));
        },

        async createValue(moduleId, categoryId, value) {
            assertId(moduleId);
            assertId(categoryId);
            const created = await guarded(
                () => client.post<Json>(valuesPath(moduleId, categoryId), { dataCategoryId: categoryId, value }),
                'create custom data',
            );
            return toValue(created, categoryId);
        },

        async updateValue(moduleId, categoryId, valueId, value) {
            assertId(moduleId);
            assertId(categoryId);
            assertId(valueId);
            const updated = await guarded(
                () => client.put<Json>(`${valuesPath(moduleId, categoryId)}/${valueId}`, { dataCategoryId: categoryId, value }),
                'edit custom data',
            );
            return toValue(updated, categoryId);
        },

        async deleteValue(moduleId, categoryId, valueId) {
            assertId(moduleId);
            assertId(categoryId);
            assertId(valueId);
            await guarded(() => client.deleteApi<unknown>(`${valuesPath(moduleId, categoryId)}/${valueId}`), 'delete custom data');
        },

        async groupMembers(groupId) {
            return activeMembers(groupId);
        },

        async group(groupId) {
            assertId(groupId);
            // `GET /groups/{id}` has no member count (`information.memberCount` doesn't exist, `memberStatistics` is
            // null), so it is the length of the filtered member list. That list needs the same right as the group.
            const g = await guarded(() => client.get<Json>(`/groups/${groupId}`), 'view group');
            return { id: Number(g.id), name: text(g.name), memberCount: (await activeMembers(groupId)).length };
        },

        async person(id) {
            assertId(id);
            const p = await guarded(() => client.get<Json>(`/persons/${id}`));
            return { id: Number(p.id), name: fullName(p.firstName, p.lastName) };
        },

        async searchPersons(query) {
            const q = query.trim();
            if (q === '') return [];
            const found = await guarded(() => client.get<unknown>('/persons', { query: q, limit: SEARCH_LIMIT }));
            const result = new Map<number, CtPerson>();
            for (const p of list(found)) if (positiveInt(p.id) && !result.has(p.id)) result.set(p.id, { id: p.id, name: fullName(p.firstName, p.lastName) });
            return [...result.values()];
        },

        async permissionDefinitions() {
            const data = await guarded(() => client.get<Json>('/permissions/definitions', { scope: 'global' }), ADMIN_RIGHT);
            const catalog: PermissionCatalog = new Map();
            for (const module of list(data.modules)) {
                if (typeof module.key !== 'string') continue;
                for (const right of list(module.permissions)) {
                    if (typeof right.key === 'string' && positiveInt(right.authId)) catalog.set(`${module.key}:${right.key}`, right.authId);
                }
            }
            return catalog;
        },

        async applyPermissions(changes) {
            if (changes.length > MAX_BULK_CHANGES) throw new Error(`At most ${MAX_BULK_CHANGES} permission changes per request, got ${changes.length}`);
            if (changes.length === 0) return;
            const body = changes.map((c) => {
                if (!DOMAIN_TYPES.includes(c.domainType)) throw new Error(`Unknown permission domain type ${String(c.domainType)}`);
                if (!OPERATIONS.includes(c.operation)) throw new Error(`Unknown permission operation ${String(c.operation)}`);
                assertDomainId(c.domainType, c.domainId);
                assertId(c.authId);
                if (c.dataId !== undefined) {
                    if (!Array.isArray(c.dataId)) throw new CtInvalidIdError(c.dataId);
                    // `-1` is ChurchTools' "all, current and future" selection.
                    c.dataId.forEach((id) => (id === -1 ? undefined : assertId(id)));
                }
                return {
                    domainType: c.domainType,
                    domainId: c.domainId,
                    operation: c.operation,
                    authId: c.authId,
                    ...(c.dataId === undefined ? {} : { dataId: [...c.dataId] }),
                    type: 'grant',
                };
            });
            await guarded(() => client.post<unknown>('/permissions/bulk', { changes: body }));
        },

        async permissionOrigins(personId) {
            assertId(personId);
            const data = await guarded(() => client.get<Json>(`/permissions/origins/global/persons/${personId}`), ADMIN_RIGHT);
            return list(data.permissions).flatMap((p) =>
                positiveInt(p.authId)
                    ? [
                          {
                              module: text(p.module),
                              auth: text(p.auth),
                              authId: p.authId,
                              originTypes: originTypes(p.origins),
                              effectiveValue: effectiveValue(p.effectiveValue),
                          },
                      ]
                    : [],
            );
        },

        async permissionHolders(authId, dataId) {
            assertId(authId);
            if (dataId !== undefined) assertId(dataId);
            const holders = new Map<number, { types: Set<string>; sources: Map<string, HolderSource> }>();
            let seen = 0;
            for (let page = 1; ; page++) {
                const params = {
                    ...(dataId === undefined ? {} : { data_id: dataId }),
                    include: 'origins',
                    limit: HOLDERS_PAGE_SIZE,
                    page,
                };
                const data = await guarded(() => client.get<Json>(`/permissions/global/auths/${authId}/persons`, params), ADMIN_RIGHT);
                let onPage = 0;
                for (const selection of list(data.selections)) {
                    for (const person of list(selection.persons)) {
                        onPage++;
                        if (!positiveInt(person.personId)) continue;
                        const held = holders.get(person.personId) ?? { types: new Set<string>(), sources: new Map<string, HolderSource>() };
                        originTypes(person.origins).forEach((t) => held.types.add(t));
                        sourcesOf(person.personId, person.origins).forEach((source) => held.sources.set(sourceKey(source), source));
                        holders.set(person.personId, held);
                    }
                }
                seen += onPage;
                const total = isRecord(data.meta) ? data.meta.total : undefined;
                if (onPage === 0 || (typeof total === 'number' ? seen >= total : onPage < HOLDERS_PAGE_SIZE)) break;
            }
            return [...holders].map(([personId, held]) => ({
                personId,
                originTypes: [...held.types],
                sources: [...held.sources.values()],
            }));
        },

        async domainPermissions(domainType, id) {
            if (!READ_DOMAIN_TYPES.includes(domainType)) throw new Error(`Unknown permission domain type ${String(domainType)}`);
            assertDomainId(domainType, id);
            const rows = await guarded(() => client.get<unknown>(`/permissions/${domainType}/${id}`), ADMIN_RIGHT);
            const rights = new Map<number, number[] | null>();
            for (const row of list(rows)) {
                if (row.type !== 'grant' || !positiveInt(row.authId)) continue;
                const ids = rights.get(row.authId) ?? null;
                if (row.dataId === null) rights.set(row.authId, ids);
                else if (typeof row.dataId === 'number' && Number.isSafeInteger(row.dataId)) rights.set(row.authId, [...(ids ?? []), row.dataId]);
            }
            return [...rights].map(([authId, dataId]) => ({ authId, dataId }));
        },

        async createCategory(moduleId, category) {
            assertId(moduleId);
            const created = await guarded(() => client.post<Json>(categoryPath(moduleId), { customModuleId: moduleId, name: category.name, shorty: category.shorty }), 'create custom category');
            if (!positiveInt(created.id)) throw new Error('ChurchTools created the category without an id');
            return { id: created.id, name: text(created.name) || category.name, shorty: text(created.shorty) || category.shorty };
        },

        async deleteCategory(moduleId, categoryId) {
            assertId(moduleId);
            assertId(categoryId);
            await guarded(() => client.deleteApi<unknown>(`${categoryPath(moduleId)}/${categoryId}`), 'delete custom category');
        },

        async createGroup(name, groupTypeId) {
            assertId(groupTypeId);
            const created = await guarded(() => client.post<Json>('/groups', { name, groupTypeId, groupStatusId: 1, force: true }));
            if (!positiveInt(created.id)) throw new Error('ChurchTools created the group without an id');
            return created.id;
        },

        async createOAuthClient(name, redirectUri) {
            const created = await guarded(() => client.post<unknown>('/oauthclients', { name, redirectUri, confidential: true }));
            const entry = Array.isArray(created) ? (created.length === 1 ? created[0] : undefined) : created;
            // No value of the answer goes into an error: it holds the secret.
            if (!isRecord(entry) || !positiveInt(entry.id) || typeof entry.identifier !== 'string' || entry.identifier === '' || typeof entry.clientSecret !== 'string' || entry.clientSecret === '') {
                throw new Error('ChurchTools answered the OAuth client without exactly one entry with id, identifier and secret');
            }
            return { id: entry.id, identifier: entry.identifier, clientSecret: entry.clientSecret };
        },

        async deleteOAuthClient(identifier) {
            if (typeof identifier !== 'string' || identifier === '') throw new CtInvalidIdError(identifier);
            await guarded(() => client.deleteApi<unknown>(`/oauthclients/${encodeURIComponent(identifier)}`));
        },

        async oauthClientNumericId(identifier) {
            if (typeof identifier !== 'string' || identifier === '') throw new CtInvalidIdError(identifier);
            const listed = await guarded(() => client.get<unknown>('/oauthclients'));
            // Only the IDs: no other value of the answer goes anywhere.
            const ids = list(listed).flatMap((c) => (c.identifier === identifier && positiveInt(c.id) ? [c.id] : []));
            if (ids.length > 1) throw new Error('ChurchTools lists more than one OAuth client with this identifier');
            return ids[0] ?? null;
        },

        async deleteGroup(groupId) {
            assertId(groupId);
            await guarded(() => client.deleteApi<unknown>(`/groups/${groupId}`));
        },

        async defaultRole(groupTypeId) {
            assertId(groupTypeId);
            const roles = await guarded(() => client.get<unknown>('/group/roles'));
            const role = list(roles).find((r) => r.groupTypeId === groupTypeId && r.isDefault === true && positiveInt(r.id));
            if (!role) throw new Error(`Group type ${groupTypeId} has no default role`);
            return role.id as number;
        },

        async addMember(groupId, personId, roleId) {
            assertId(groupId);
            assertId(personId);
            assertId(roleId);
            await guarded(() => client.put<unknown>(`/groups/${groupId}/members/${personId}`, { groupMemberStatus: 'active', groupTypeRoleId: roleId }));
        },

        async personMasterdata() {
            const data = await guarded(() => client.get<unknown>('/person/masterdata'));
            const d = isRecord(data) ? data : {};
            return { statuses: masterdataList(d.statuses), departments: masterdataList(d.departments), campuses: masterdataList(d.campuses) };
        },

        async privacyFieldsMandatory() {
            const config = await guarded(() => client.get<unknown>('/config'));
            return !(isRecord(config) && config.privacy_policy_fields_mandatory === false);
        },

        async createPerson(person) {
            assertBodyId(person.statusId);
            assertBodyId(person.campusId);
            if (!Array.isArray(person.departmentIds) || person.departmentIds.length === 0) throw new CtInvalidIdError(person.departmentIds);
            person.departmentIds.forEach(assertBodyId);
            const body = {
                firstName: person.firstName,
                lastName: person.lastName,
                cmsUserId: person.cmsUserId,
                statusId: person.statusId,
                departmentIds: [...person.departmentIds],
                campusId: person.campusId,
                ...(person.privacy
                    ? {
                          privacyPolicyAgreementTypeId: person.privacy.typeId,
                          privacyPolicyAgreementWhoId: person.privacy.whoId,
                          privacyPolicyAgreementDate: person.privacy.date,
                      }
                    : {}),
            };
            let created: Json;
            try {
                created = await client.post<Json>('/persons?force=true', body);
            } catch (error) {
                const response = (error as HttpErrorLike | null)?.response;
                const data = response?.data as { message?: unknown; errors?: unknown } | undefined;
                if (response?.status === 400 && isRecord(data)) throw new CtValidationError(text(data.message) || undefined, fieldErrors(data.errors));
                throw mapCtError(error);
            }
            if (!positiveInt(created?.id)) throw new Error('ChurchTools created the person without an id');
            return created.id;
        },

        async deletePerson(personId) {
            assertId(personId);
            await guarded(() => client.deleteApi<unknown>(`/persons/${personId}`));
        },

        async personCmsUserId(personId) {
            assertId(personId);
            const p = await guarded(() => client.get<Json>(`/persons/${personId}`));
            return text(p.cmsUserId);
        },

        async personLogin(personId) {
            assertId(personId);
            const p = await guarded(() => client.get<Json>(`/persons/${personId}`));
            return { firstName: text(p.firstName), lastName: text(p.lastName), cmsUserId: text(p.cmsUserId) };
        },

        async setPersonPassword(personId, password) {
            assertId(personId);
            try {
                await client.oldApi('churchdb/ajax', 'setPersonPassword', { id: personId, password });
            } catch (error) {
                // `oldApi` rejects with `{response}` for a 200 without `status: 'success'`, and with the axios error
                // otherwise. Both carry the request (with the password), so only the status is kept, never the error.
                const response = (error as HttpErrorLike | null)?.response;
                const status = response?.status;
                const answer = statusWord((response?.data as { status?: unknown } | undefined)?.status);
                throw new CtPasswordNotSetError(typeof status === 'number' && status !== 200 ? { httpStatus: status } : { answer });
            }
        },

        async groupRoles(groupId) {
            assertId(groupId);
            const roles = await guarded(() => client.get<unknown>(`/groups/${groupId}/roles`), 'view group');
            return list(roles).flatMap((r) => (positiveInt(r.id) ? [{ id: r.id, isDefault: r.isDefault === true, ...(typeof r.name === 'string' && r.name !== '' ? { name: r.name } : {}) }] : []));
        },

        async groupDetails(groupId) {
            assertId(groupId);
            const g = await guarded(() => client.get<Json>(`/groups/${groupId}`), 'view group');
            const information = isRecord(g.information) ? g.information : {};
            const settings = isRecord(g.settings) ? g.settings : {};
            const dynamic = settings.dynamicGroupStatus;
            return {
                id: Number(g.id),
                name: text(g.name),
                groupStatusId: optionalInt(information.groupStatusId),
                groupTypeId: optionalInt(information.groupTypeId),
                isOpenForMembers: bool(settings.isOpenForMembers),
                autoAccept: bool(settings.autoAccept),
                dynamicGroupStatus: dynamic === null || typeof dynamic === 'string' ? dynamic : undefined,
            };
        },
    };
}

function toValue(v: Json, fallbackCategoryId: number): CtValue {
    return { id: Number(v.id), dataCategoryId: Number(v.dataCategoryId ?? fallbackCategoryId), value: text(v.value) };
}
