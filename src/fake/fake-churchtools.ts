import type { CtApi } from '../api.js';
import { CtForbiddenError, CtHttpError, CtPasswordNotSetError, CtRateLimitedError, CtValidationError, NotAuthenticatedError, type CtFieldError } from '../errors.js';
import type { CtCategory, CtGroupDetails, CtPerson, CtPersonMasterdata, CtValue, DomainRight, Holder, HolderSource, OriginEntry, PermissionCatalog, PermissionChange, Permissions } from '../types.js';
import { tagFake } from './marker.js';

/**
 * In-memory ChurchTools for tests and demos. Behaves like a measured ChurchTools instance:
 * anonymous `whoami`, unknown module → `null`, categories listed only with `view custom category`, values need
 * `view custom data`, groups readable for members or with "view group". Never import it from production code
 * (it carries `FAKE_MARKER`).
 */
export interface FakeCtSeed {
    moduleKey: string;
    moduleId: number;
    /** `null` = nobody logged in. */
    currentPersonId: number | null;
    persons: FakePerson[];
    groups: FakeGroup[];
    categories: CtCategory[];
    values: CtValue[];
    permissions: Permissions;
    /** Groups the current person has the "view group" right on. */
    viewGroupIds?: number[];
    /** The current person may view every group, also those created later (the operator gave themselves „view group“ on all). */
    viewAllGroups?: boolean;
    /** Group roles that rights can be granted to (`group_role`); every active member of the group holds them. */
    groupRoles?: { id: number; groupId: number; isDefault?: boolean; name?: string }[];
    /**
     * Super admins hold every right of the catalog with the origin `superAdmin`. They are also the fake's only
     * admins: definitions, origins and holders answer 403 (`administer persons`) for everybody else.
     */
    superAdminIds?: number[];
    /**
     * The roles of the group types (`GET /group/roles`): a new group of a type gets one role of its own for each of
     * them. Default: a team (type 2) with a non-default and a default role, and a distribution list (type 4) with one.
     */
    groupTypeRoles?: { id: number; groupTypeId: number; isDefault?: boolean }[];
    /** Statuses, departments and campuses for new persons. Default: one department and one campus, two statuses. */
    masterdata?: CtPersonMasterdata;
    /** `privacy_policy_fields_mandatory` (default `true`, as on the measured instance). */
    privacyMandatory?: boolean;
    /** The `security level person` each status gives its persons (default 1 for every status, as measured). */
    statusSecurityLevels?: Record<number, number>;
    /** The legacy AJAX API is switched off: `setPersonPassword` fails (see `setAjaxDisabled`). */
    ajaxDisabled?: boolean;
    /** OAuth clients that exist already (e.g. one an extension created earlier). */
    oauthClients?: { id: number; identifier: string; name?: string }[];
    /**
     * Rights granted from the start (`applyPermissions` rows): `right` is the module's right without the module key,
     * `ids` the category IDs (empty for a flag).
     */
    grants?: { domainType: 'person' | 'status' | 'group_role'; domainId: number; right: string; ids?: readonly number[] }[];
}

export interface FakePerson {
    id: number;
    firstName: string;
    lastName: string;
    archived?: boolean;
    /** The login name. */
    cmsUserId?: string;
    /** A person with a status gets that status' `security level person` (origin `status`, measured). */
    statusId?: number;
}

const DEFAULT_MASTERDATA: CtPersonMasterdata = {
    statuses: [
        { id: 0, name: 'Interessent' },
        { id: 1, name: 'Freund' },
    ],
    departments: [{ id: 1, name: 'Gemeindeliste' }],
    campuses: [{ id: 0, name: 'Hauptstandort' }],
};
/** The privacy options the measured instance names in its `400` (types 1–4, who 1, 2, 10000). */
const PRIVACY_TYPES = [1, 2, 3, 4];
const PRIVACY_WHO = [1, 2, 10000];

/** The rights of the fake's catalog, in the order of the measured test instance (auth IDs 2050 … 2058). */
const RIGHT_KEYS: (keyof Permissions)[] = [
    'view',
    'view custom category',
    'create custom category',
    'edit custom category',
    'delete custom category',
    'view custom data',
    'create custom data',
    'edit custom data',
    'delete custom data',
];
const FIRST_AUTH_ID = 2050;
const BOOLEAN_RIGHTS = new Set<string>(['view', 'create custom category']);
/**
 * Rights of other modules an extension's setup may grant or check (`[module, key, boolean]`). Their auth IDs here
 * (101 …) are made up; real instances differ, which is why the code looks every ID up in the catalog.
 */
const OTHER_RIGHTS: [string, string, boolean][] = [
    ['churchcore', 'administer settings', true],
    ['churchcore', 'administer persons', true],
    ['churchcore', 'administer custom modules', true],
    ['churchcore', 'login to external system', false],
    ['churchgroup', 'view group', false],
    ['churchdb', 'view', true],
    ['churchdb', 'view alldata', false],
    ['churchdb', 'view archive', true],
    ['churchdb', 'view hidden persons', true],
    ['churchdb', 'write access', true],
    ['churchdb', 'security level person', false],
    ['churchdb', 'edit group memberships', true],
    ['churchdb', 'edit group memberships of group', false],
    ['churchdb', 'edit group memberships of grouptype', false],
    ['churchdb', 'administer groups', true],
];
const FIRST_OTHER_AUTH_ID = 101;

interface Grant {
    /** Category IDs (`-1` = all). */
    ids: Set<number>;
    /** A row without data (boolean rights). */
    plain: boolean;
}

export interface FakeGroup {
    id: number;
    name: string;
    /** Active members. */
    memberIds: number[];
    /** Members with another status (`waiting`, `requested`, `to_delete`): listed by ChurchTools, not counted here. */
    inactiveMemberIds?: number[];
    /** What `groupDetails` answers besides id and name; default: active (status 1), a team (type 2), closed, not dynamic. */
    details?: Partial<Omit<CtGroupDetails, 'id' | 'name'>>;
}

export interface FakeControls {
    /** Every stored value of every category, whatever the rights (e.g. for a demo's persistence). */
    dumpValues(): CtValue[];
    setCurrentPerson(id: number | null): void;
    setPermissions(permissions: Permissions): void;
    setGroups(groups: FakeGroup[]): void;
    setViewGroups(ids: number[]): void;
    /** The active memberships of a group with the type role each was added with (`addMember`). */
    memberRoles(groupId: number): { personId: number; roleId: number }[];
    /** The next call (of any method) fails with the error ChurchTools' status maps to. */
    failNext(status: number): void;
    /** Switches the legacy AJAX API off or on: while off, `setPersonPassword` fails (ASSUMPTION: as a `404`). */
    setAjaxDisabled(disabled: boolean): void;
    /** The persons whose password `setPersonPassword` set, in order (the passwords themselves aren't kept). */
    passwordsSet(): number[];
    /**
     * The same fake as another person (shared rights and groups). `base` replaces the rights that person has besides
     * the granted ones (default: none, the seed's `permissions` belong to the seeded person).
     */
    as(personId: number, base?: Permissions): CtApi;
}

export function createFakeChurchTools(seed: FakeCtSeed): CtApi & FakeControls {
    let current = seed.currentPersonId;
    const persons: FakePerson[] = seed.persons.map((p) => ({ ...p }));
    const masterdata = seed.masterdata ?? DEFAULT_MASTERDATA;
    let ajaxDisabled = seed.ajaxDisabled === true;
    const passwordsSet: number[] = [];
    let permissions = seed.permissions;
    let groups: FakeGroup[] = seed.groups.map((g) => ({ ...g, memberIds: [...g.memberIds], inactiveMemberIds: [...(g.inactiveMemberIds ?? [])] }));
    let viewGroups = [...(seed.viewGroupIds ?? [])];
    const values = seed.values.map((v) => ({ ...v }));
    const categoryList = seed.categories.map((c) => ({ ...c }));
    let nextCategoryId = Math.max(0, ...categoryList.map((c) => c.id)) + 1;
    const typeRoles = seed.groupTypeRoles ?? [
        { id: 900, groupTypeId: 2 },
        { id: 901, groupTypeId: 2, isDefault: true },
        { id: 950, groupTypeId: 4, isDefault: true },
    ];
    /** Roles of the groups (the seeded ones and those of created groups), memberships added with a type role. */
    const roleList = (seed.groupRoles ?? []).map((r) => ({ ...r }));
    let nextRoleId = Math.max(1000, ...roleList.map((r) => r.id + 1));
    const memberships = new Map<number, Map<number, number>>();
    let nextValueId = Math.max(0, ...values.map((v) => v.id)) + 1;
    let failure: number | null = null;
    const oauthClients = new Map<string, { id: number; name: string; redirectUri: string }>((seed.oauthClients ?? []).map((c) => [c.identifier, { id: c.id, name: c.name ?? '', redirectUri: '' }]));
    let nextOAuthClientId = Math.max(0, ...(seed.oauthClients ?? []).map((c) => c.id)) + 1;
    const grants = new Map<string, Grant>();
    /** The whole catalog: `"module:key"` → auth ID and whether the right is a plain flag. */
    const catalog = new Map<string, { authId: number; boolean: boolean }>([
        ...RIGHT_KEYS.map((key, i) => [`${seed.moduleKey}:${key}`, { authId: FIRST_AUTH_ID + i, boolean: BOOLEAN_RIGHTS.has(key) }] as const),
        ...OTHER_RIGHTS.map(([module, key, boolean], i) => [`${module}:${key}`, { authId: FIRST_OTHER_AUTH_ID + i, boolean }] as const),
    ]);
    /** The `"module:key"` of an auth ID, or `undefined`. */
    for (const g of seed.grants ?? []) {
        const authId = catalog.get(`${seed.moduleKey}:${g.right}`)?.authId;
        if (authId === undefined) throw new Error(`Unknown right in the seed: ${g.right}`);
        grants.set(`${g.domainType}:${g.domainId}:${authId}`, { ids: new Set(g.ids ?? []), plain: (g.ids ?? []).length === 0 });
    }
    const rightOf = (authId: number) => [...catalog].find(([, r]) => r.authId === authId)?.[0];
    const isBoolean = (right: string) => catalog.get(right)?.boolean === true;
    const ownKey = (right: string): keyof Permissions | undefined =>
        right.startsWith(`${seed.moduleKey}:`) ? (right.slice(seed.moduleKey.length + 1) as keyof Permissions) : undefined;
    const emptyBase = (): Permissions => ({
        view: false,
        'create custom category': false,
        'view custom category': [],
        'edit custom category': [],
        'delete custom category': [],
        'view custom data': [],
        'create custom data': [],
        'edit custom data': [],
        'delete custom data': [],
    });
    /** The origin types per right (`"module:key"`) of one person, with the data IDs each origin gives. */
    const originsOf = (personId: number, base: Permissions): Map<string, Map<string, { plain: boolean; ids: number[] }>> => {
        const result = new Map<string, Map<string, { plain: boolean; ids: number[] }>>();
        const add = (key: string, type: string, plain: boolean, ids: number[]) => {
            const byType = result.get(key) ?? new Map<string, { plain: boolean; ids: number[] }>();
            const entry = byType.get(type) ?? { plain: false, ids: [] };
            entry.plain ||= plain;
            entry.ids.push(...ids);
            byType.set(type, entry);
            result.set(key, byType);
        };
        for (const key of RIGHT_KEYS) {
            const own = base[key];
            const right = `${seed.moduleKey}:${key}`;
            if (own === true) add(right, 'person', true, []);
            else if (Array.isArray(own) && own.length > 0) add(right, 'person', false, own);
        }
        // Measured: a super admin has the origin `superAdmin` on almost every right; `churchgroup:view group` was one of
        // the three without it.
        if (seed.superAdminIds?.includes(personId)) for (const right of catalog.keys()) if (right !== 'churchgroup:view group') add(right, 'superAdmin', true, [-1]);
        const status = persons.find((p) => p.id === personId)?.statusId;
        if (status !== undefined) add('churchdb:security level person', 'status', false, [seed.statusSecurityLevels?.[status] ?? 1]);
        for (const { right, source, grant } of grantSources(personId)) add(right, ORIGIN_TYPE[source.domainType], grant.plain, [...grant.ids]);
        return result;
    };
    const ORIGIN_TYPE = { person: 'person', group_role: 'groupRole', status: 'status' } as const;
    /** The bulk grants that reach one person: their own, their group roles' and their status' (with the domain). */
    const grantSources = (personId: number): { right: string; source: Exclude<HolderSource, { domainType: 'other' }>; grant: Grant }[] => {
        const status = persons.find((p) => p.id === personId)?.statusId;
        const roles = roleList.filter((r) => groups.find((g) => g.id === r.groupId)?.memberIds.includes(personId));
        const out: { right: string; source: Exclude<HolderSource, { domainType: 'other' }>; grant: Grant }[] = [];
        for (const [rowKey, grant] of grants) {
            const [type, id, authId] = rowKey.split(':');
            const right = rightOf(Number(authId));
            if (!right) continue;
            const domainId = Number(id);
            const role = type === 'group_role' ? roles.find((r) => r.id === domainId) : undefined;
            if (type === 'person' && domainId === personId) out.push({ right, source: { domainType: 'person', domainId }, grant });
            else if (role) out.push({ right, source: { domainType: 'group_role', domainId, groupId: role.groupId }, grant });
            // ASSUMPTION (not measured): a status grant reaches every person of that status, like the measured
            // `security level person` of a status.
            else if (type === 'status' && status !== undefined && domainId === status) out.push({ right, source: { domainType: 'status', domainId }, grant });
        }
        return out;
    };
    const effective = (personId: number, base: Permissions): Permissions => {
        const out = emptyBase() as unknown as Record<string, boolean | number[]>;
        for (const [right, byType] of originsOf(personId, base)) {
            const key = ownKey(right);
            if (!key) continue;
            for (const [type, entry] of byType) {
                // Measured: being a super admin lists `superAdmin` as origin, but gives none of the module's rights
                // (the operator grants them to themselves); only the other origins count for what a person may do.
                if (type === 'superAdmin') continue;
                if (BOOLEAN_RIGHTS.has(key)) out[key] = out[key] === true || entry.plain || entry.ids.length > 0;
                else {
                    // `-1` = all, current and future (measured: ChurchTools lists a category created later).
                    const ids = entry.ids.includes(-1) ? categoryList.map((c) => c.id) : entry.ids.filter((x) => x > 0);
                    out[key] = [...new Set([...(out[key] as number[]), ...ids])];
                }
            }
        }
        return out as unknown as Permissions;
    };

    const nameOf = (id: number): string => {
        const p = persons.find((x) => x.id === id);
        return p ? `${p.firstName} ${p.lastName}`.trim() : '';
    };
    // Like the real layer: active, non-archived members only.
    const listedMembers = (g: FakeGroup): CtPerson[] =>
        g.memberIds
            .filter((id) => persons.find((p) => p.id === id)?.archived !== true)
            .map((id) => ({ id, name: nameOf(id) }));
    const canSeeGroup = (g: FakeGroup) => seed.viewAllGroups === true || viewGroups.includes(g.id) || (current !== null && g.memberIds.includes(current));
    const readableGroup = (id: number): FakeGroup => {
        const g = groups.find((x) => x.id === id);
        if (!g) throw new CtHttpError(404, 'Group not found');
        if (!canSeeGroup(g)) throw new CtForbiddenError('Forbidden to see group', 'view group');
        return g;
    };
    /** Like `readableGroup`, and a super admin (administer persons) sees every group. */
    const visibleGroup = (id: number): FakeGroup => {
        const g = groups.find((x) => x.id === id);
        if (g && current !== null && seed.superAdminIds?.includes(current)) return g;
        return readableGroup(id);
    };
    const step = () => {
        if (failure === null) return;
        const status = failure;
        failure = null;
        if (status === 401) throw new NotAuthenticatedError();
        if (status === 403) throw new CtForbiddenError();
        if (status === 429) throw new CtRateLimitedError(60_000);
        throw new CtHttpError(status);
    };
    /** The permission endpoints need churchcore `administer persons`; the fake models it as being a super admin. */
    const requireAdmin = () => {
        if (current === null || !seed.superAdminIds?.includes(current)) throw new CtForbiddenError('Missing right: administer persons', 'administer persons');
    };
    const requireModule = (moduleId: number) => {
        if (moduleId !== seed.moduleId) throw new CtHttpError(400, 'validation.integer');
    };
    const requireRight = (right: keyof Permissions & `${string} custom data`, categoryId: number) => {
        // The person's own rights and those granted to them (`applyPermissions`).
        const held = current === null ? permissions : effective(current, permissions);
        if (!held[right].includes(categoryId)) throw new CtForbiddenError(`Missing right: ${right}`, right);
    };
    // Measured: ChurchTools stores at most 10,000 characters (code points) per value; more is `400 validation.error`.
    // ASSUMPTION (not measured): the right is checked before the size, so a forbidden write is a 403 whatever its size.
    const requireSize = (value: string) => {
        if ([...value].length > 10_000) throw new CtHttpError(400, 'validation.error');
    };
    const requireCategory = (moduleId: number, categoryId: number) => {
        requireModule(moduleId);
        if (!categoryList.some((c) => c.id === categoryId)) throw new CtHttpError(404, 'Category not found');
    };

    const api: CtApi & FakeControls = tagFake({
        dumpValues: () => values.map((v) => ({ ...v })),
        setCurrentPerson: (id) => void (current = id),
        setPermissions: (p) => void (permissions = p),
        setGroups: (g) => void (groups = g.map((x) => ({ ...x, memberIds: [...x.memberIds] }))),
        setViewGroups: (ids) => void (viewGroups = [...ids]),
        failNext: (status) => void (failure = status),
        setAjaxDisabled: (disabled) => void (ajaxDisabled = disabled),
        passwordsSet: () => [...passwordsSet],
        memberRoles: (groupId) => [...(memberships.get(groupId) ?? [])].map(([personId, roleId]) => ({ personId, roleId })),
        as(personId, base) {
            // Every method of the fake runs synchronously up to its result (no awaits inside), so swapping the
            // current person and the base rights around the call is enough; nothing else can interleave.
            const view: Record<string, unknown> = {};
            for (const [name, method] of Object.entries(api)) {
                if (
                    typeof method !== 'function' ||
                    ['as', 'dumpValues', 'setCurrentPerson', 'setPermissions', 'setGroups', 'setViewGroups', 'failNext', 'memberRoles', 'setAjaxDisabled', 'passwordsSet'].includes(name)
                )
                    continue;
                view[name] = (...args: unknown[]) => {
                    const saved = { current, permissions };
                    current = personId;
                    permissions = base ?? emptyBase();
                    try {
                        return (method as (...a: unknown[]) => unknown).apply(api, args);
                    } finally {
                        current = saved.current;
                        permissions = saved.permissions;
                    }
                };
            }
            return view as unknown as CtApi;
        },

        async whoami() {
            step();
            // Real ChurchTools answers 200 with id -1 for an anonymous caller.
            const id = current ?? -1;
            if (id <= 0) throw new NotAuthenticatedError();
            const p = persons.find((x) => x.id === id);
            return { id, firstName: p?.firstName ?? '', lastName: p?.lastName ?? '' };
        },
        async globalPermissions() {
            step();
            if (current === null) return structuredClone(permissions);
            return structuredClone(effective(current, permissions));
        },
        async moduleId(key) {
            step();
            return key === seed.moduleKey ? seed.moduleId : null;
        },
        async categories(moduleId) {
            step();
            requireModule(moduleId);
            // What the person holds, also through grants (a created category stays unseen until it is granted).
            const visible = current === null ? permissions : effective(current, permissions);
            return categoryList.filter((c) => visible['view custom category'].includes(c.id)).map((c) => ({ ...c }));
        },
        async values(moduleId, categoryId) {
            step();
            requireCategory(moduleId, categoryId);
            requireRight('view custom data', categoryId);
            return values.filter((v) => v.dataCategoryId === categoryId).map((v) => ({ ...v }));
        },
        async createValue(moduleId, categoryId, value) {
            step();
            requireCategory(moduleId, categoryId);
            requireRight('create custom data', categoryId);
            requireSize(value);
            const created = { id: nextValueId++, dataCategoryId: categoryId, value };
            values.push(created);
            return { ...created };
        },
        async updateValue(moduleId, categoryId, valueId, value) {
            step();
            requireCategory(moduleId, categoryId);
            requireRight('edit custom data', categoryId);
            requireSize(value);
            const existing = values.find((v) => v.id === valueId && v.dataCategoryId === categoryId);
            if (!existing) throw new CtHttpError(404, 'Value not found');
            existing.value = value;
            return { ...existing };
        },
        async deleteValue(moduleId, categoryId, valueId) {
            step();
            requireCategory(moduleId, categoryId);
            requireRight('delete custom data', categoryId);
            const index = values.findIndex((v) => v.id === valueId && v.dataCategoryId === categoryId);
            if (index < 0) throw new CtHttpError(404, 'Value not found');
            values.splice(index, 1);
        },
        async groupMembers(groupId): Promise<CtPerson[]> {
            step();
            return listedMembers(readableGroup(groupId));
        },
        async searchPersons(query): Promise<CtPerson[]> {
            step();
            const q = query.trim().toLowerCase();
            if (q === '') return [];
            if (current === null) throw new NotAuthenticatedError();
            // Like `person`: only persons the caller may see (themselves, members of readable groups; a super admin all).
            const all = seed.superAdminIds?.includes(current) === true;
            return persons
                .filter((p) => all || p.id === current || groups.some((g) => canSeeGroup(g) && g.memberIds.includes(p.id)))
                .filter((p) => nameOf(p.id).toLowerCase().includes(q))
                .slice(0, 20)
                .map((p) => ({ id: p.id, name: nameOf(p.id) }));
        },
        async group(groupId) {
            step();
            const g = readableGroup(groupId);
            return { id: g.id, name: g.name, memberCount: listedMembers(g).length };
        },
        async person(id): Promise<CtPerson> {
            step();
            // Persons are visible through readable groups (member or "view group"), and the caller sees themselves.
            const visible = id === current || groups.some((g) => canSeeGroup(g) && g.memberIds.includes(id));
            if (!visible || !persons.some((p) => p.id === id)) throw new CtHttpError(404, 'Person not found');
            return { id, name: nameOf(id) };
        },

        async permissionDefinitions() {
            step();
            requireAdmin();
            const result: PermissionCatalog = new Map();
            for (const [right, { authId }] of catalog) result.set(right, authId);
            return result;
        },
        async applyPermissions(changes: PermissionChange[]) {
            step();
            // Measured 2026-11-15 for a `person` domain: without `administer persons` 403 (`Forbidden to update
            // permission of type: person[<id>]`). ASSUMPTION (not measured): the same for `group_role` domains.
            requireAdmin();
            // At most 100 per request: the layer's limit (api.ts MAX_BULK_CHANGES); ChurchTools' own limit is not measured.
            if (changes.length > 100) throw new Error('At most 100 permission changes per request');
            // Measured 2026-11-15: validate every entry first, then apply all; one bad entry (unknown authId: 400)
            // changes nothing.
            const seen = new Set<string>();
            const staged = changes.map((c, i) => {
                const right = rightOf(c.authId);
                if (!right) throw new CtHttpError(400, `changes.${i}.authId`);
                // Measured 2026-11-15: ChurchTools does not check that the person or group role exists (204, no effect).
                const key = `${c.domainType}:${c.domainId}:${c.authId}`;
                // ASSUMPTION (not measured): the same (domain, right) twice in one bulk is refused with a 400.
                if (seen.has(key)) throw new CtHttpError(400, `changes.${i} duplicate`);
                seen.add(key);
                return { key, c };
            });
            // ASSUMPTION (not measured): `dataId` is neither required nor refused by kind of right; a boolean right
            // saved with data IDs counts as held, a selectable right saved without them is a row without data.
            for (const { key, c } of staged) {
                const row = grants.get(key) ?? { ids: new Set<number>(), plain: false };
                const ids = c.dataId ?? [];
                if (c.operation === 'save') {
                    // ASSUMPTION (not measured; the bulk endpoint's documentation says so): an empty `dataId` writes a
                    // row without data.
                    if (ids.length === 0) row.plain = true;
                    // Measured 2026-11-15 (contract cases "bulk save adds …"): `save` adds to the selection already
                    // assigned, never replaces it; on a group role and a person with a category right, and on a group
                    // role with `login to external system` (OAuth client IDs).
                    ids.forEach((id) => row.ids.add(id));
                } else if (c.operation === 'replace') {
                    // Measured 2026-11-15 (contract case "status domain"): `replace` sets the whole selection, `[]` removes
                    // the assignment. ASSUMPTION (not measured): it also drops a row without data.
                    row.ids = new Set(ids);
                    row.plain = false;
                } else if (ids.length === 0) {
                    // ASSUMPTION (not measured): `delete` without `dataId` removes the whole assignment.
                    row.ids.clear();
                    row.plain = false;
                } else {
                    // Measured 2026-11-15 with a single ID: `delete` with `dataId: [id]` removes that selection.
                    // ASSUMPTION (not measured): with several IDs it removes exactly those and keeps the rest.
                    ids.forEach((id) => row.ids.delete(id));
                }
                if (row.ids.size === 0 && !row.plain) grants.delete(key);
                else grants.set(key, row);
            }
        },
        async permissionOrigins(personId): Promise<OriginEntry[]> {
            step();
            // Measured 2026-11-15: needs `administer persons` (403 otherwise, also for one's own ID).
            requireAdmin();
            // ASSUMPTION (not measured): an unknown person is a 404.
            if (!persons.some((p) => p.id === personId)) throw new CtHttpError(404, 'Person not found');
            const origins = originsOf(personId, personId === current ? permissions : emptyBase());
            return [...origins].map(([right, byType]) => {
                const [module, ...rest] = right.split(':');
                // Measured: `superAdmin` gives none of this module's rights, so it adds nothing to their effective value.
                const counted = [...byType].filter(([type]) => !(type === 'superAdmin' && ownKey(right)));
                const effectiveValue = isBoolean(right)
                    ? counted.length > 0
                    : [...new Set(counted.flatMap(([, e]) => e.ids))];
                return { module: module!, auth: rest.join(':'), authId: catalog.get(right)!.authId, originTypes: [...byType.keys()], effectiveValue };
            });
        },
        async permissionHolders(authId, dataId): Promise<Holder[]> {
            step();
            // Measured 2026-11-15: needs `administer persons`.
            requireAdmin();
            const right = rightOf(authId);
            // ASSUMPTION (not measured): an unknown auth ID is a 404.
            if (!right) throw new CtHttpError(404, 'Unknown permission');
            // Measured API rule: data_id is required for selectable rights and forbidden for boolean ones.
            if (isBoolean(right) === (dataId !== undefined)) throw new CtHttpError(400, 'data_id');
            // ASSUMPTION (not measured): a grant of `-1` (all) makes its holder a holder of every data ID.
            const covers = (ids: Iterable<number>) => dataId === undefined || [...ids].some((id) => id === dataId || id === -1);
            const holders: Holder[] = [];
            for (const person of persons) {
                const byType = originsOf(person.id, person.id === current ? permissions : emptyBase()).get(right);
                const types = [...(byType ?? [])].filter(([, e]) => covers(e.ids)).map(([t]) => t);
                if (types.length === 0) continue;
                const sources = new Map<string, HolderSource>();
                for (const { right: r, source, grant } of grantSources(person.id)) if (r === right && covers(grant.ids)) sources.set(`${source.domainType}:${source.domainId}`, source);
                // The seeded base rights of the current person are their own grant; superAdmin can't be changed here.
                if (types.includes('person')) sources.set(`person:${person.id}`, { domainType: 'person', domainId: person.id });
                if (types.includes('superAdmin')) sources.set('other:superAdmin', { domainType: 'other', originType: 'superAdmin' });
                holders.push({ personId: person.id, originTypes: types, sources: [...sources.values()] });
            }
            return holders;
        },
        async domainPermissions(domainType, id): Promise<DomainRight[]> {
            step();
            // ASSUMPTION (not measured): needs `administer persons` like the other permission endpoints. Measured
            // 2026-11-12: a domain without rights is an empty list; a selection is listed as given (also `[-1]`, 2026-11-15).
            // ASSUMPTION (not measured): a row without data has `dataId: null`.
            requireAdmin();
            // Only rights granted with `applyPermissions`; the seeded base rights of the current person aren't rows.
            const result: DomainRight[] = [];
            for (const [rowKey, grant] of grants) {
                const [type, domainId, authId] = rowKey.split(':');
                if (type !== domainType || Number(domainId) !== id) continue;
                result.push({ authId: Number(authId), dataId: grant.ids.size === 0 ? null : [...grant.ids] });
            }
            return result;
        },
        async groupRoles(groupId) {
            step();
            // ASSUMPTION (not measured): the roles are readable wherever the group is (members, view group, admins).
            visibleGroup(groupId);
            return roleList.filter((r) => r.groupId === groupId).map((r) => ({ id: r.id, isDefault: r.isDefault === true, ...(r.name ? { name: r.name } : {}) }));
        },
        async createCategory(moduleId, category) {
            step();
            requireModule(moduleId);
            // ASSUMPTION (not measured): without `create custom category` a 403. Measured 2026-11-15: the creator sees
            // the new category only once `view custom category` covers it (contract case "create and list a category").
            if (current === null || effective(current, permissions)['create custom category'] !== true) {
                throw new CtForbiddenError('Missing right: create custom category', 'create custom category');
            }
            const created = { id: nextCategoryId++, name: category.name, shorty: category.shorty };
            categoryList.push(created);
            return { ...created };
        },
        async deleteCategory(moduleId, categoryId) {
            step();
            requireCategory(moduleId, categoryId);
            // ASSUMPTION (not measured): the right is `delete custom category` on that category, checked like the data rights.
            const held = current === null ? permissions : effective(current, permissions);
            if (!held['delete custom category'].includes(categoryId)) throw new CtForbiddenError('Missing right: delete custom category', 'delete custom category');
            categoryList.splice(categoryList.findIndex((c) => c.id === categoryId), 1);
            for (let i = values.length - 1; i >= 0; i--) if (values[i]!.dataCategoryId === categoryId) values.splice(i, 1);
        },
        async createGroup(name, groupTypeId) {
            step();
            // ASSUMPTION (not measured here): any logged-in person may create a group; measured only that an admin can.
            if (current === null) throw new NotAuthenticatedError();
            const id = Math.max(0, ...groups.map((g) => g.id)) + 1;
            // Measured 2026-11-15: a new group gets one role of its own per role of its type, one of them the default.
            groups.push({ id, name, memberIds: [], details: { groupTypeId, groupStatusId: 1 } });
            for (const role of typeRoles.filter((r) => r.groupTypeId === groupTypeId)) roleList.push({ id: nextRoleId++, groupId: id, isDefault: role.isDefault });
            return id;
        },
        async defaultRole(groupTypeId) {
            step();
            const role = typeRoles.find((r) => r.groupTypeId === groupTypeId && r.isDefault === true);
            if (!role) throw new Error(`Group type ${groupTypeId} has no default role`);
            return role.id;
        },
        async addMember(groupId, personId, roleId) {
            step();
            const g = visibleGroup(groupId);
            // ASSUMPTION (not measured): an unknown person is a 404, a role of another group type a 400.
            if (!persons.some((p) => p.id === personId)) throw new CtHttpError(404, 'Person not found');
            if (!typeRoles.some((r) => r.id === roleId && r.groupTypeId === (g.details?.groupTypeId ?? 2))) throw new CtHttpError(400, 'groupTypeRoleId');
            if (!g.memberIds.includes(personId)) g.memberIds.push(personId);
            memberships.set(groupId, (memberships.get(groupId) ?? new Map()).set(personId, roleId));
        },
        async personMasterdata() {
            step();
            return structuredClone(masterdata);
        },
        async privacyFieldsMandatory() {
            step();
            return seed.privacyMandatory ?? true;
        },
        async createPerson(person) {
            step();
            // ASSUMPTION (not measured): needs `administer persons`.
            requireAdmin();
            // Like ChurchTools: every field error in one 400 (measured: a taken login together with the privacy fields).
            const fields: CtFieldError[] = [];
            const field = (fieldId: string, messageKey: string, validOptions: number[] = []) => fields.push({ fieldId, messageKey, validOptions });
            // ASSUMPTION (not measured): the status, campus, department and login-name rules below (only the taken login
            // name and the privacy fields are measured, 2026-11-15). Not modelled: `Duplicate found` without `force`.
            if (!masterdata.statuses.some((x) => x.id === person.statusId)) field('statusId', 'validation.db.field.option', masterdata.statuses.map((x) => x.id));
            if (!masterdata.campuses.some((x) => x.id === person.campusId)) field('campusId', 'validation.db.field.option', masterdata.campuses.map((x) => x.id));
            if (person.departmentIds.length === 0 || !person.departmentIds.every((id) => masterdata.departments.some((x) => x.id === id))) field('departmentIds', 'validation.not.empty');
            if (!/^[a-z0-9_\-.]*$/.test(person.cmsUserId) || persons.some((p) => p.cmsUserId === person.cmsUserId)) field('cmsUserId', 'validation.cmsuserid');
            if (seed.privacyMandatory ?? true) {
                const privacy = person.privacy;
                if (!privacy || !PRIVACY_TYPES.includes(privacy.typeId)) field('privacyPolicyAgreementTypeId', 'validation.db.field.option', PRIVACY_TYPES);
                if (!privacy || !PRIVACY_WHO.includes(privacy.whoId)) field('privacyPolicyAgreementWhoId', 'validation.db.field.option', PRIVACY_WHO);
                if (!privacy || !/^\d{4}-\d{2}-\d{2}$/.test(privacy.date)) field('privacyPolicyAgreementDate', 'validation.date.invalid');
            }
            if (fields.length > 0) throw new CtValidationError('There are validation errors', fields);
            const id = Math.max(0, ...persons.map((p) => p.id)) + 1;
            persons.push({ id, firstName: person.firstName, lastName: person.lastName, cmsUserId: person.cmsUserId, statusId: person.statusId });
            return id;
        },
        async deletePerson(personId) {
            step();
            requireAdmin();
            const index = persons.findIndex((p) => p.id === personId);
            if (index < 0) throw new CtHttpError(404, `Person [${personId}] not found.`);
            persons.splice(index, 1);
            // ASSUMPTION (not measured): the person's grants and memberships go with them.
            for (const key of [...grants.keys()]) if (key.startsWith(`person:${personId}:`)) grants.delete(key);
            for (const g of groups) g.memberIds = g.memberIds.filter((id) => id !== personId);
        },
        async personCmsUserId(personId) {
            step();
            requireAdmin();
            const p = persons.find((x) => x.id === personId);
            if (!p) throw new CtHttpError(404, `Person [${personId}] not found.`);
            return p.cmsUserId ?? '';
        },
        async personLogin(personId) {
            step();
            requireAdmin();
            const p = persons.find((x) => x.id === personId);
            if (!p) throw new CtHttpError(404, `Person [${personId}] not found.`);
            return { firstName: p.firstName, lastName: p.lastName, cmsUserId: p.cmsUserId ?? '' };
        },
        async setPersonPassword(personId) {
            step();
            if (ajaxDisabled) throw new CtPasswordNotSetError({ httpStatus: 404 });
            // Measured: without "simulate persons" ChurchTools answers 200 with status fail (2026-11-11); an unknown
            // person, also one deleted a moment ago, is a 404 (2026-11-15). No password is refused (2026-11-15).
            if (current === null || !seed.superAdminIds?.includes(current)) throw new CtPasswordNotSetError({ answer: 'fail' });
            if (!persons.some((p) => p.id === personId)) throw new CtPasswordNotSetError({ httpStatus: 404 });
            passwordsSet.push(personId);
        },
        async createOAuthClient(name, redirectUri) {
            step();
            // ASSUMPTION (not measured): needs `administer persons` (the real right is not known).
            requireAdmin();
            // Measured 2026-11-15: a name that exists is refused with 400, whatever the redirect URI.
            if ([...oauthClients.values()].some((c) => c.name === name)) throw new CtHttpError(400, 'There are validation errors');
            const created = { id: nextOAuthClientId++, identifier: `fake-client-${nextOAuthClientId}`, clientSecret: `fake-secret-${nextOAuthClientId}` };
            oauthClients.set(created.identifier, { id: created.id, name, redirectUri });
            return { ...created };
        },
        async deleteOAuthClient(identifier) {
            step();
            requireAdmin();
            // Measured 2026-11-15: a second delete is refused (an HTTP error); ASSUMPTION (not measured): as a 404.
            if (!oauthClients.delete(identifier)) throw new CtHttpError(404, 'OAuth client not found');
        },
        async oauthClientNumericId(identifier) {
            step();
            requireAdmin();
            // Measured 2026-11-15: found by the identifier; `null` once deleted.
            return oauthClients.get(identifier)?.id ?? null;
        },
        async deleteGroup(groupId) {
            step();
            // Measured 2026-11-12: needs an admin; afterwards the group answers 404 (also 2026-11-15, contract case).
            requireAdmin();
            const index = groups.findIndex((g) => g.id === groupId);
            // ASSUMPTION (not measured): deleting an unknown group is a 404.
            if (index < 0) throw new CtHttpError(404, 'Group not found');
            groups.splice(index, 1);
            // ASSUMPTION (not measured): its roles go with it, and the rights granted to them.
            const roleIds = roleList.filter((r) => r.groupId === groupId).map((r) => r.id);
            for (const key of [...grants.keys()]) if (roleIds.some((id) => key.startsWith(`group_role:${id}:`))) grants.delete(key);
            for (let i = roleList.length - 1; i >= 0; i--) if (roleList[i]!.groupId === groupId) roleList.splice(i, 1);
            memberships.delete(groupId);
        },
        async groupDetails(groupId): Promise<CtGroupDetails> {
            step();
            // Measured 2026-11-15: a deleted or unknown group is a 404. ASSUMPTION (not measured): readable wherever
            // the group is (members, view group, admins).
            const g = visibleGroup(groupId);
            return {
                groupStatusId: 1,
                groupTypeId: 2,
                isOpenForMembers: false,
                autoAccept: false,
                dynamicGroupStatus: null,
                ...g.details,
                id: g.id,
                name: g.name,
            };
        },
    });
    return api;
}
