import { describe, expect, it } from 'vitest';
import { cmsUserIdTaken, type CtApi } from '../api.js';
import { CtForbiddenError, CtPasswordNotSetError, CtValidationError, NotAuthenticatedError } from '../errors.js';
import type { DomainRight, NewPerson } from '../types.js';

/**
 * What a contract run needs. `anonymous` and `limited` are optional because not every subject can offer them
 * (the real test instance needs a second session); the cases that need them are skipped without them.
 */
export type CtContractSubject = CtApi & {
    /** A person the current session may read, and who is a member of `knownGroupId`. */
    knownPersonId: number;
    /** A group the current person is a member of. */
    knownGroupId: number;
    /** A group the current person is not a member of and has no "view group" right on. */
    foreignGroupId: number;
    moduleKey: string;
    /**
     * The first name of every person the cases create (the last name is `<moduleKey> extension contract test`, the
     * login `<moduleKey>-contract-…`), so a consumer can find leftovers of a crashed run.
     */
    tempName: string;
    /** An API without a login. */
    anonymous?: () => Promise<CtApi>;
    /** An API of a person with `view` on the module but no rights on its categories or their data. */
    limited?: () => Promise<CtApi>;
    /** An API of a person who may read the categories and values but not create, edit or delete values. */
    readOnly?: () => Promise<CtApi>;
    /** A member of `knownGroupId` whose status isn't `active` (e.g. `waiting`); must not be listed or counted. */
    inactiveMemberId?: number;
    /** An archived member of `knownGroupId`; must not be listed or counted. */
    archivedMemberId?: number;
    /**
     * The category the write cases use (the subject must see it and may write it). Without it, the first category the
     * subject sees. The real instance names one explicitly, so probes never land in a category by accident.
     */
    writeCategoryId?: number;
    /**
     * Rights administration (the rights cases are skipped without it): `admin` may administer persons and rights;
     * `personId` is a person who holds no right on `categoryId` at the start, `personApi` is that person's own API
     * (to see what they are granted); `undo` registers a step that runs at the end even when a case crashes.
     */
    rights?: {
        admin: CtApi;
        personId: number;
        personApi: () => Promise<CtApi>;
        categoryId: number;
        undo: (label: string, run: () => Promise<void>) => void;
        /** All group roles of a group that `memberId` is an active member of (a role right goes to every role of the group). */
        groupRoleIds: number[];
        memberId: number;
        /**
         * At most two categories the status case may grant `view custom category` on to a whole status for a moment
         * (never a secret one: every person of that status can see it meanwhile). Without it, that case is skipped.
         */
        statusCategoryIds?: number[];
    };
    /**
     * Provisioning cases (skipped without it, and without `rights`): `rights.admin` holds `create custom category` and
     * may create groups; `adminId` is that person. The removers undo what the cases create (the real instance deletes
     * them; the fake has nothing to clean up).
     */
    provision?: {
        adminId: number;
        removeCategory: (moduleId: number, categoryId: number) => Promise<void>;
        removeGroup: (groupId: number) => Promise<void>;
        /** Deletes a person the cases created; one that is already gone counts as removed. */
        removePerson: (personId: number) => Promise<void>;
    };
};

/**
 * The name of everything the cases create (persons' last name, groups; categories add ` category`), so a consumer can
 * remove leftovers of a crashed run by it.
 */
const tempLabel = (s: CtContractSubject): string => `${s.moduleKey} extension contract test`;

/**
 * A throwaway person through `createPerson`, as an extension's setup would create one: without the privacy fields
 * first and, if the instance requires them, again with the first of each `validOptions` and today's date. Its removal
 * is registered before anything else happens to it.
 */
async function throwawayPerson(s: CtContractSubject): Promise<{ id: number; cmsUserId: string; person: NewPerson }> {
    const { admin, undo } = s.rights!;
    const md = await admin.personMasterdata();
    const cmsUserId = `${s.moduleKey}-contract-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    let person: NewPerson = {
        firstName: s.tempName,
        lastName: tempLabel(s),
        cmsUserId,
        statusId: md.statuses[0]!.id,
        departmentIds: [md.departments[0]!.id],
        campusId: md.campuses[0]!.id,
    };
    let id: number;
    try {
        id = await admin.createPerson(person);
    } catch (error) {
        if (!(error instanceof CtValidationError) || !(await admin.privacyFieldsMandatory())) throw error;
        const first = (fieldId: string) => error.fields.find((f) => f.fieldId === fieldId)?.validOptions[0];
        person = { ...person, privacy: { typeId: first('privacyPolicyAgreementTypeId')!, whoId: first('privacyPolicyAgreementWhoId')!, date: new Date().toISOString().slice(0, 10) } };
        id = await admin.createPerson(person);
    }
    undo(`temporary person ${id} deleted`, () => s.provision!.removePerson(id));
    return { id, cmsUserId, person };
}

/** Rights and ChurchTools' brief cache of them: waits until `check` passes, at most `seconds`. */
async function eventually(check: () => Promise<void>, seconds = 30): Promise<void> {
    let last: unknown;
    for (let i = 0; i < seconds; i++) {
        try {
            return await check();
        } catch (e) {
            last = e;
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
    throw last;
}

/** The category the cases read and write. */
async function caseCategory(s: CtContractSubject, moduleId: number) {
    const categories = await s.categories(moduleId);
    const category = s.writeCategoryId === undefined ? categories[0] : categories.find((c) => c.id === s.writeCategoryId);
    expect(category, 'the subject sees the category the cases use').toBeDefined();
    return category!;
}

/**
 * A precondition of a case that writes and then removes a whole assignment. A leftover (e.g. from a crashed run) fails
 * the case with what to remove, instead of skipping it silently.
 */
function requireUnassigned(row: DomainRight | undefined, what: string): void {
    if (row !== undefined) throw new Error(`Leftover assignment of ${what} (dataId ${JSON.stringify(row.dataId)}); remove it on the test instance and run again`);
}

/** A second category the admin sees besides the cases' own; its absence fails the case (the subject must offer one). */
async function secondCategory(s: CtContractSubject, moduleId: number) {
    const other = (await s.rights!.admin.categories(moduleId)).find((c) => c.id !== s.rights!.categoryId);
    if (!other) throw new Error('The admin sees no second category of the module; the save and revoke cases need one');
    return other;
}

/**
 * `save [a]`, then `save [b]` on one assignment that doesn't exist yet: reads back `[a, b]` (`save` adds, never
 * replaces). The assignment is removed again (registered before the first write), also when the case fails.
 */
async function expectSaveAdds(
    admin: CtApi,
    undo: (label: string, run: () => Promise<void>) => void,
    target: { domainType: 'group_role' | 'person'; domainId: number; authId: number; what: string },
    a: number,
    b: number,
): Promise<void> {
    const { domainType, domainId, authId, what } = target;
    const row = async () => (await admin.domainPermissions(domainType, domainId)).find((r) => r.authId === authId);
    const sorted = (ids: readonly number[] | null | undefined) => [...(ids ?? [])].sort((x, y) => x - y);
    requireUnassigned(await row(), `${what} on ${domainType} ${domainId}`);
    const clear = () => admin.applyPermissions([{ domainType, domainId, operation: 'replace', authId, dataId: [] }]);
    undo(`${domainType} ${domainId}: ${what} removed (save-adds case)`, async () => {
        if ((await row()) !== undefined) await clear();
    });
    const save = (id: number) => admin.applyPermissions([{ domainType, domainId, operation: 'save', authId, dataId: [id] }]);
    try {
        await save(a);
        await eventually(async () => expect((await row())?.dataId).toEqual([a]));
        await save(b);
        await eventually(async () => expect(sorted((await row())?.dataId)).toEqual(sorted([a, b])));
    } finally {
        if ((await row()) !== undefined) await clear();
    }
    await eventually(async () => expect(await row()).toBeUndefined());
}

/** The cases are written once and run against the fake now and against the real test instance later. */
export function defineCtContract(name: string, make: () => Promise<CtContractSubject>): void {
    describe(`ChurchTools contract: ${name}`, () => {
        it('whoami answers the current person', async () => {
            const s = await make();
            const me = await s.whoami();
            expect(me.id).toBeGreaterThan(0);
            expect(typeof me.firstName).toBe('string');
        });

        it('whoami without a login throws NotAuthenticatedError (id -1 or 0)', async (ctx) => {
            const s = await make();
            if (!s.anonymous) return ctx.skip();
            const anonymous = await s.anonymous();
            await expect(anonymous.whoami()).rejects.toBeInstanceOf(NotAuthenticatedError);
        });

        it('globalPermissions has the documented shape', async () => {
            const s = await make();
            const p = await s.globalPermissions();
            expect(typeof p.view).toBe('boolean');
            expect(Array.isArray(p['view custom category'])).toBe(true);
            expect(Array.isArray(p['edit custom data'])).toBe(true);
        });

        it('an unknown module key gives null, a known one an id', async () => {
            const s = await make();
            expect(await s.moduleId('no-such-module-key')).toBeNull();
            expect(typeof (await s.moduleId(s.moduleKey))).toBe('number');
        });

        it('categories without "view custom category" are absent', async (ctx) => {
            const s = await make();
            if (!s.limited) return ctx.skip();
            const moduleId = (await s.moduleId(s.moduleKey)) as number;
            expect(await (await s.limited()).categories(moduleId)).toEqual([]);
        });

        it('values without "view custom data" give CtForbiddenError', async (ctx) => {
            const s = await make();
            if (!s.limited) return ctx.skip();
            const moduleId = (await s.moduleId(s.moduleKey)) as number;
            const categoryId = (await caseCategory(s, moduleId)).id;
            await expect((await s.limited()).values(moduleId, categoryId)).rejects.toBeInstanceOf(CtForbiddenError);
        });

        it('writes without the create, edit or delete right give CtForbiddenError', async (ctx) => {
            const s = await make();
            if (!s.readOnly) return ctx.skip();
            const readOnly = await s.readOnly();
            const moduleId = (await s.moduleId(s.moduleKey)) as number;
            const categoryId = (await caseCategory(s, moduleId)).id;
            await expect(readOnly.createValue(moduleId, categoryId, '{}')).rejects.toBeInstanceOf(CtForbiddenError);
            const created = await s.createValue(moduleId, categoryId, '{"probe":0}');
            try {
                await expect(readOnly.updateValue(moduleId, categoryId, created.id, '{}')).rejects.toBeInstanceOf(CtForbiddenError);
                await expect(readOnly.deleteValue(moduleId, categoryId, created.id)).rejects.toBeInstanceOf(CtForbiddenError);
                expect((await s.values(moduleId, categoryId)).some((v) => v.id === created.id)).toBe(true);
            } finally {
                await s.deleteValue(moduleId, categoryId, created.id);
            }
        });

        it('a value survives a create, read, update, delete round trip', async () => {
            const s = await make();
            const moduleId = (await s.moduleId(s.moduleKey)) as number;
            const category = await caseCategory(s, moduleId);
            expect(category).toBeDefined();
            const categoryId = category!.id;
            expect(typeof category!.name).toBe('string');
            expect(typeof category!.shorty).toBe('string');

            const created = await s.createValue(moduleId, categoryId, '{"probe":1}');
            try {
                expect(created.dataCategoryId).toBe(categoryId);
                expect((await s.values(moduleId, categoryId)).find((v) => v.id === created.id)?.value).toBe('{"probe":1}');
                const updated = await s.updateValue(moduleId, categoryId, created.id, '{"probe":2}');
                expect(updated.value).toBe('{"probe":2}');
                expect((await s.values(moduleId, categoryId)).find((v) => v.id === created.id)?.value).toBe('{"probe":2}');
            } finally {
                await s.deleteValue(moduleId, categoryId, created.id);
            }
            expect((await s.values(moduleId, categoryId)).some((v) => v.id === created.id)).toBe(false);
        });

        it('a value may have 10,000 characters, counted as code points (multibyte too), not one more', async () => {
            // Measured 2026-11-14: ChurchTools counts characters (code points), not bytes or UTF-16 units: 10,000 × "ä"
            // (20,000 bytes), "€" (30,000 bytes) and "😀" (20,000 UTF-16 units) are stored and read back unchanged; 10,001
            // characters give 400 validation.error. The repository's own limit counts UTF-16 units, so it stays below.
            const s = await make();
            const moduleId = (await s.moduleId(s.moduleKey)) as number;
            const categoryId = (await caseCategory(s, moduleId)).id;
            // A write that wrongly succeeds is removed again before the assertion fails.
            const refused = async (write: Promise<{ id: number }>, keep?: number) => {
                const result = await write.catch((e: unknown) => e);
                if (!(result instanceof Error) && (result as { id: number }).id !== keep) await s.deleteValue(moduleId, categoryId, (result as { id: number }).id);
                return result;
            };
            for (const char of ['a', 'ä', '€', '😀']) {
                const value = char.repeat(10_000);
                const created = await s.createValue(moduleId, categoryId, value);
                try {
                    expect((await s.values(moduleId, categoryId)).find((v) => v.id === created.id)?.value === value, char).toBe(true);
                    expect(await refused(s.updateValue(moduleId, categoryId, created.id, char.repeat(10_001)), created.id), char).toMatchObject({ name: 'CtHttpError', status: 400 });
                    expect((await s.values(moduleId, categoryId)).find((v) => v.id === created.id)?.value === value, char).toBe(true);
                } finally {
                    await s.deleteValue(moduleId, categoryId, created.id);
                }
                expect(await refused(s.createValue(moduleId, categoryId, char.repeat(10_001))), char).toMatchObject({ name: 'CtHttpError', status: 400 });
            }
        });

        it('a group the person is a member of is readable', async () => {
            const s = await make();
            const group = await s.group(s.knownGroupId);
            expect(group.id).toBe(s.knownGroupId);
            expect(group.name.length).toBeGreaterThan(0);
            expect(group.memberCount).toBeGreaterThanOrEqual(1);
            const members = await s.groupMembers(s.knownGroupId);
            expect(members.some((m) => m.id === s.knownPersonId)).toBe(true);
            expect(members.every((m) => m.name.length > 0)).toBe(true);
            // Only active, non-archived members are listed (a `waiting` member or an archived person is not), and
            // the count is that list's length, never an `information` key of the group.
            expect(group.memberCount).toBe(members.length);
            for (const excluded of [s.inactiveMemberId, s.archivedMemberId]) {
                if (excluded !== undefined) expect(members.some((m) => m.id === excluded)).toBe(false);
            }
        });

        it('another group gives CtForbiddenError', async () => {
            const s = await make();
            await expect(s.group(s.foreignGroupId)).rejects.toBeInstanceOf(CtForbiddenError);
            await expect(s.groupMembers(s.foreignGroupId)).rejects.toBeInstanceOf(CtForbiddenError);
        });

        it('the catalog names the module rights', async (ctx) => {
            const s = await make();
            if (!s.rights) return ctx.skip();
            const catalog = await s.rights.admin.permissionDefinitions();
            for (const key of ['view', 'edit custom data', 'view custom data', 'delete custom data']) {
                const authId = catalog.get(`${s.moduleKey}:${key}`);
                expect(Number.isSafeInteger(authId) && (authId as number) > 0, key).toBe(true);
            }
            expect(catalog.get(`${s.moduleKey}:no such right`)).toBeUndefined();
        });

        it('bulk grants a person right that globalPermissions then shows', async (ctx) => {
            const s = await make();
            if (!s.rights) return ctx.skip();
            const { admin, personId, categoryId, undo } = s.rights;
            const authId = (await admin.permissionDefinitions()).get(`${s.moduleKey}:view custom data`)!;
            const person = await s.rights.personApi();
            expect((await person.globalPermissions())['view custom data']).not.toContain(categoryId);
            const revoke = () =>
                admin.applyPermissions([
                    {
                        domainType: 'person',
                        domainId: personId,
                        operation: 'delete',
                        authId,
                        dataId: [categoryId],
                    },
                ]);
            undo(`person ${personId}: view custom data on category ${categoryId} removed`, revoke);
            await admin.applyPermissions([
                {
                    domainType: 'person',
                    domainId: personId,
                    operation: 'save',
                    authId,
                    dataId: [categoryId],
                },
            ]);
            try {
                await eventually(async () => expect((await person.globalPermissions())['view custom data']).toContain(categoryId));
            } finally {
                await revoke();
            }
            await eventually(async () => expect((await person.globalPermissions())['view custom data']).not.toContain(categoryId));
        });

        it('bulk with one bad entry changes nothing', async (ctx) => {
            const s = await make();
            if (!s.rights) return ctx.skip();
            const { admin, personId, categoryId, undo } = s.rights;
            const authId = (await admin.permissionDefinitions()).get(`${s.moduleKey}:view custom data`)!;
            const person = await s.rights.personApi();
            undo(`person ${personId}: view custom data on category ${categoryId} removed (bad-entry case)`, () =>
                admin.applyPermissions([
                    {
                        domainType: 'person',
                        domainId: personId,
                        operation: 'delete',
                        authId,
                        dataId: [categoryId],
                    },
                ]),
            );
            const refused = await admin
                .applyPermissions([
                    {
                        domainType: 'person',
                        domainId: personId,
                        operation: 'save',
                        authId,
                        dataId: [categoryId],
                    },
                    {
                        domainType: 'person',
                        domainId: personId,
                        operation: 'save',
                        authId: 987654321,
                    },
                ])
                .catch((e: unknown) => e);
            expect(refused).toMatchObject({ name: 'CtHttpError' });
            // The valid first entry was not applied either (the cache needs a moment, so look a few times).
            for (let i = 0; i < 3; i++) {
                expect((await person.globalPermissions())['view custom data']).not.toContain(categoryId);
                await new Promise((r) => setTimeout(r, 1000));
            }
        });

        it('origins of the current person list origin types', async (ctx) => {
            const s = await make();
            if (!s.rights) return ctx.skip();
            const me = await s.rights.admin.whoami();
            const origins = await s.rights.admin.permissionOrigins(me.id);
            expect(origins.length).toBeGreaterThan(0);
            for (const o of origins) {
                expect(o.authId).toBeGreaterThan(0);
                expect(Array.isArray(o.originTypes)).toBe(true);
                expect(typeof o.effectiveValue === 'boolean' || typeof o.effectiveValue === 'number' || Array.isArray(o.effectiveValue)).toBe(true);
                for (const t of o.originTypes) expect(typeof t).toBe('string');
            }
            const catalog = await s.rights.admin.permissionDefinitions();
            const viewAuthId = catalog.get(`${s.moduleKey}:view`);
            expect(origins.some((o) => o.authId === viewAuthId)).toBe(true);
        });

        it('a person without admin rights gets CtForbiddenError on the origins of a person', async (ctx) => {
            const s = await make();
            if (!s.limited) return ctx.skip();
            const limited = await s.limited();
            const me = await limited.whoami();
            await expect(limited.permissionOrigins(me.id)).rejects.toBeInstanceOf(CtForbiddenError);
        });

        it('holders of a category right include a granted person', async (ctx) => {
            const s = await make();
            if (!s.rights) return ctx.skip();
            const { admin, personId, categoryId, undo } = s.rights;
            const catalog = await admin.permissionDefinitions();
            const authId = catalog.get(`${s.moduleKey}:view custom data`)!;
            const revoke = () =>
                admin.applyPermissions([
                    {
                        domainType: 'person',
                        domainId: personId,
                        operation: 'delete',
                        authId,
                        dataId: [categoryId],
                    },
                ]);
            undo(`person ${personId}: view custom data on category ${categoryId} removed (holders case)`, revoke);
            await admin.applyPermissions([
                {
                    domainType: 'person',
                    domainId: personId,
                    operation: 'save',
                    authId,
                    dataId: [categoryId],
                },
            ]);
            try {
                await eventually(async () => {
                    const holder = (await admin.permissionHolders(authId, categoryId)).find((h) => h.personId === personId);
                    expect(holder?.originTypes).toContain('person');
                });
                // A boolean right takes no dataId; every holder has a positive personId.
                const viewers = await admin.permissionHolders(catalog.get(`${s.moduleKey}:view`)!);
                expect(viewers.length).toBeGreaterThan(0);
                for (const h of viewers) expect(h.personId).toBeGreaterThan(0);
            } finally {
                await revoke();
            }
            await eventually(async () =>
                expect((await admin.permissionHolders(authId, categoryId)).some((h) => h.personId === personId && h.originTypes.includes('person'))).toBe(false),
            );
        });

        it('a group role right shows its members as holders with the origin groupRole', async (ctx) => {
            const s = await make();
            if (!s.rights) return ctx.skip();
            const { admin, categoryId, undo, groupRoleIds, memberId } = s.rights;
            const authId = (await admin.permissionDefinitions()).get(`${s.moduleKey}:view custom data`)!;
            const changes = (operation: 'save' | 'delete') =>
                groupRoleIds.map((domainId) => ({ domainType: 'group_role' as const, domainId, operation, authId, dataId: [categoryId] }));
            const revoke = () => admin.applyPermissions(changes('delete'));
            undo(`group roles ${groupRoleIds.join(',')}: view custom data on category ${categoryId} removed`, revoke);
            expect((await admin.permissionHolders(authId, categoryId)).some((h) => h.personId === memberId && h.originTypes.includes('groupRole'))).toBe(false);
            await admin.applyPermissions(changes('save'));
            try {
                await eventually(async () => {
                    const holder = (await admin.permissionHolders(authId, categoryId)).find((h) => h.personId === memberId);
                    expect(holder?.originTypes).toContain('groupRole');
                });
                const own = (await admin.permissionOrigins(memberId)).find((o) => o.authId === authId);
                expect(own?.originTypes).toContain('groupRole');
                expect(own?.effectiveValue).toContain(categoryId);
            } finally {
                await revoke();
            }
            await eventually(async () =>
                expect((await admin.permissionHolders(authId, categoryId)).some((h) => h.personId === memberId && h.originTypes.includes('groupRole'))).toBe(false),
            );
        });

        it('domainPermissions shows a bulk grant on a group role, and nothing for it before and after', async (ctx) => {
            const s = await make();
            if (!s.rights) return ctx.skip();
            const { admin, categoryId, undo, groupRoleIds } = s.rights;
            const roleId = groupRoleIds[0]!;
            const authId = (await admin.permissionDefinitions()).get(`${s.moduleKey}:view custom data`)!;
            const change = (operation: 'save' | 'delete') => [{ domainType: 'group_role' as const, domainId: roleId, operation, authId, dataId: [categoryId] }];
            const row = async () => (await admin.domainPermissions('group_role', roleId)).find((r) => r.authId === authId);
            const revoke = () => admin.applyPermissions(change('delete'));
            undo(`group role ${roleId}: view custom data on category ${categoryId} removed (domain case)`, revoke);
            expect(await row()).toBeUndefined();
            await admin.applyPermissions(change('save'));
            try {
                await eventually(async () => expect((await row())?.dataId).toEqual([categoryId]));
            } finally {
                await revoke();
            }
            await eventually(async () => expect(await row()).toBeUndefined());
        });

        // A setup saves into assignments the role or person may hold already (an existing group, an operator with own
        // rights): `save` must add, never replace the selection.
        for (const domainType of ['group_role', 'person'] as const) {
            it(`bulk save adds to the selection a ${domainType} already holds ([a], save [b] → [a, b])`, async (ctx) => {
                const s = await make();
                if (!s.rights) return ctx.skip();
                const { admin, categoryId, undo, groupRoleIds, personId } = s.rights;
                const other = await secondCategory(s, (await s.moduleId(s.moduleKey)) as number);
                const domainId = domainType === 'group_role' ? groupRoleIds[0]! : personId;
                const authId = (await admin.permissionDefinitions()).get(`${s.moduleKey}:view custom data`)!;
                await expectSaveAdds(admin, undo, { domainType, domainId, authId, what: 'view custom data' }, categoryId, other.id);
            });
        }

        // Lists, grants and removes rights of a status. This case briefly grants one harmless view right on the subject's
        // chosen categories to a real status and removes it again.
        it('status domain: bulk save, replace (the W24 revoke), holders and status 0', async (ctx) => {
            const s = await make();
            if (!s.rights) return ctx.skip();
            const { admin, undo } = s.rights;
            // Never on a secret category, not even a view right: only the ones the subject names as safe.
            const picked = (s.rights.statusCategoryIds ?? []).slice(0, 2);
            if (picked.length === 0) return ctx.skip(); // no category the subject allows a view right on
            const [first] = picked as [number, ...number[]];
            const authId = (await admin.permissionDefinitions()).get(`${s.moduleKey}:view custom category`)!;
            // Status 0 is read only (never written): what `GET /permissions/status/0` answers.
            const zero = await admin.domainPermissions('status', 0);
            expect(Array.isArray(zero)).toBe(true);
            // A status other than 0 that doesn't hold this right yet (so the restore is `[]`); the last one first, as the
            // statuses that were added later tend to have the fewest persons.
            const statuses = [...(await admin.personMasterdata()).statuses].reverse().filter((x) => x.id !== 0);
            let statusId: number | undefined;
            let before: DomainRight[] = [];
            for (const status of statuses) {
                const rows = await admin.domainPermissions('status', status.id);
                if (!rows.some((r) => r.authId === authId)) {
                    statusId = status.id;
                    before = rows;
                    break;
                }
            }
            if (statusId === undefined) throw new Error('Every status except 0 holds "view custom category" already; the status case needs one that does not');
            const id = statusId;
            const row = async () => (await admin.domainPermissions('status', id)).find((r) => r.authId === authId);
            const others = async () => (await admin.domainPermissions('status', id)).filter((r) => r.authId !== authId);
            const sorted = (rights: DomainRight[]) => [...rights].sort((a, b) => a.authId - b.authId);
            const ids = async () => [...((await row())?.dataId ?? [])].sort((a, b) => a - b);
            // The restore: the right is absent before, so remove the whole assignment (`replace` with `[]`). Registered
            // before the first write; it also runs when the case fails.
            const clear = () => admin.applyPermissions([{ domainType: 'status', domainId: id, operation: 'replace', authId, dataId: [] }]);
            undo(`status ${id}: view custom category removed (status case)`, async () => {
                if ((await row()) !== undefined) await clear();
                await eventually(async () => expect(await row()).toBeUndefined());
            });

            // 1. `save` with domainType status grants the right on the safe categories, read back from the status.
            await admin.applyPermissions([{ domainType: 'status', domainId: id, operation: 'save', authId, dataId: picked }]);
            try {
                await eventually(async () => expect(await ids()).toEqual([...picked].sort((a, b) => a - b)));
                expect(sorted(await others())).toEqual(sorted(before)); // the status' other rights are untouched

                // 3. A person of that status (if any exists) is a holder with origin `status` and this status as domain.
                // ChurchTools' holder list may lag, so look for up to 30 s before calling it not measurable.
                let total = 0;
                let holders: Awaited<ReturnType<typeof admin.permissionHolders>> = [];
                await eventually(async () => {
                    const all = await admin.permissionHolders(authId, first);
                    total = all.length;
                    holders = all.filter((h) => h.sources?.some((x) => x.domainType === 'status' && x.domainId === id));
                    if (holders.length === 0) throw new Error('no holder of this status yet');
                }, 6).catch(() => undefined);
                console.info(`[contract] status domain: ${total} holders of view custom category on category ${first} in all, ${holders.length} via status ${id}`);
                if (holders.length === 0) console.info(`[contract] status domain: no person has status ${id}, so the holder shape is not measurable here`);
                for (const h of holders) {
                    expect(h.originTypes).toContain('status');
                    expect(h.sources).toContainEqual({ domainType: 'status', domainId: id });
                }

                // 2. Removing one category: `replace` with the rest of the selection removes exactly that one and keeps
                // the other. With only one category it is `[id]` → `[]`.
                const rest = picked.filter((x) => x !== first);
                await admin.applyPermissions([{ domainType: 'status', domainId: id, operation: 'replace', authId, dataId: rest }]);
                if (rest.length === 0) await eventually(async () => expect(await row()).toBeUndefined());
                else await eventually(async () => expect(await ids()).toEqual(rest));
                expect(sorted(await others())).toEqual(sorted(before));
            } finally {
                if ((await row()) !== undefined) await clear();
            }
            await eventually(async () => expect(await row()).toBeUndefined());
            // Status 0 was never written.
            expect(await admin.domainPermissions('status', 0)).toEqual(zero);
        }, 120_000);

        it('groupRoles lists every role of a group, one of them the default', async (ctx) => {
            const s = await make();
            if (!s.rights) return ctx.skip();
            const roles = await s.rights.admin.groupRoles(s.knownGroupId);
            expect(roles.map((r) => r.id).sort((a, b) => a - b)).toEqual([...s.rights.groupRoleIds].sort((a, b) => a - b));
            expect(roles.filter((r) => r.isDefault)).toHaveLength(1);
        });

        it('groupDetails answers status, type and the membership settings; a deleted group is 404', async (ctx) => {
            const s = await make();
            if (!s.rights) return ctx.skip();
            const details = await s.rights.admin.groupDetails(s.knownGroupId);
            // The cases' groups are teams (type 2) created with the active status 1.
            expect(details).toMatchObject({ id: s.knownGroupId, groupStatusId: 1, groupTypeId: 2 });
            expect(typeof details.isOpenForMembers).toBe('boolean');
            expect(typeof details.autoAccept).toBe('boolean');
            expect(details.dynamicGroupStatus === null || typeof details.dynamicGroupStatus === 'string').toBe(true);
            await expect(s.rights.admin.groupDetails(987654321)).rejects.toMatchObject({ name: 'CtHttpError', status: 404 });
        });

        it('create and list a category', async (ctx) => {
            const s = await make();
            if (!s.rights || !s.provision) return ctx.skip();
            const { admin, undo } = s.rights;
            const { adminId, removeCategory } = s.provision;
            const moduleId = (await s.moduleId(s.moduleKey)) as number;
            const name = `${tempLabel(s)} category`;
            const created = await admin.createCategory(moduleId, { name, shorty: 'ctpTmp' });
            undo(`temporary category ${created.id} deleted`, () => removeCategory(moduleId, created.id));
            expect(created).toMatchObject({ name, shorty: 'ctpTmp' });
            expect(created.id).toBeGreaterThan(0);
            // The creator sees the category only with `view custom category` on it.
            const authId = (await admin.permissionDefinitions()).get(`${s.moduleKey}:view custom category`)!;
            const grant = (operation: 'save' | 'delete') => admin.applyPermissions([{ domainType: 'person', domainId: adminId, operation, authId, dataId: [created.id] }]);
            undo(`person ${adminId}: view custom category on the temporary category removed`, () => grant('delete'));
            await grant('save');
            await eventually(async () => expect((await admin.categories(moduleId)).find((c) => c.id === created.id)).toEqual({ id: created.id, name, shorty: 'ctpTmp' }));
        });

        it('deleteCategory removes a throwaway category (needs delete custom category on it)', async (ctx) => {
            const s = await make();
            if (!s.rights || !s.provision) return ctx.skip();
            const { admin, undo } = s.rights;
            const { adminId, removeCategory } = s.provision;
            const moduleId = (await s.moduleId(s.moduleKey)) as number;
            const name = `${tempLabel(s)} category`;
            const created = await admin.createCategory(moduleId, { name, shorty: 'ctpDel' });
            // Registered first, so it runs last (LIFO) and only deletes the category if the case failed before the delete.
            let deleted = false;
            undo(`temporary category ${created.id} deleted (deleteCategory case)`, async () => {
                if (!deleted) await removeCategory(moduleId, created.id);
            });
            const catalog = await admin.permissionDefinitions();
            for (const key of ['view custom category', 'delete custom category']) {
                const authId = catalog.get(`${s.moduleKey}:${key}`)!;
                const grant = (operation: 'save' | 'delete') => admin.applyPermissions([{ domainType: 'person', domainId: adminId, operation, authId, dataId: [created.id] }]);
                undo(`person ${adminId}: ${key} on the temporary category removed (deleteCategory case)`, () => grant('delete'));
                await grant('save');
            }
            await eventually(async () => expect((await admin.categories(moduleId)).some((c) => c.id === created.id)).toBe(true));
            await eventually(async () => expect((await admin.globalPermissions())['delete custom category']).toContain(created.id));
            await eventually(() => admin.deleteCategory(moduleId, created.id));
            deleted = true;
            await eventually(async () => expect((await admin.categories(moduleId)).some((c) => c.id === created.id)).toBe(false));
        });

        it('view custom category with dataId -1 lists a category created later', async (ctx) => {
            const s = await make();
            if (!s.rights || !s.provision) return ctx.skip();
            const { admin, undo, personId, personApi } = s.rights;
            const moduleId = (await s.moduleId(s.moduleKey)) as number;
            const authId = (await admin.permissionDefinitions()).get(`${s.moduleKey}:view custom category`)!;
            const grant = (operation: 'save' | 'delete') => admin.applyPermissions([{ domainType: 'person', domainId: personId, operation, authId, dataId: [-1] }]);
            const person = await personApi();
            undo(`person ${personId}: view custom category -1 removed`, () => grant('delete'));
            await grant('save');
            // Measured: the origins list expands -1 to the IDs of the current categories; the direct grant keeps -1.
            await eventually(async () => {
                const row = (await admin.domainPermissions('person', personId)).find((r) => r.authId === authId);
                expect(row?.dataId).toEqual([-1]);
            });
            const name = `${tempLabel(s)} category`;
            const created = await admin.createCategory(moduleId, { name, shorty: 'ctpTm2' });
            undo(`temporary category ${created.id} deleted (-1 case)`, () => s.provision!.removeCategory(moduleId, created.id));
            await eventually(async () => expect((await person.categories(moduleId)).map((c) => c.id)).toContain(created.id));
        });

        it('create a group with the default role: its member reads it', async (ctx) => {
            const s = await make();
            if (!s.rights || !s.provision) return ctx.skip();
            const { admin, undo, memberId, personApi } = s.rights;
            const role = await admin.defaultRole(2);
            expect(role).toBeGreaterThan(0);
            const groupId = await admin.createGroup(tempLabel(s), 2);
            undo(`temporary group ${groupId} deleted`, () => s.provision!.removeGroup(groupId));
            await admin.addMember(groupId, memberId, role);
            const member = await personApi();
            // Rights and memberships take a moment to show.
            await eventually(async () => expect((await member.group(groupId)).memberCount).toBeGreaterThan(0));
            expect(await admin.groupDetails(groupId)).toMatchObject({ id: groupId, groupTypeId: 2, groupStatusId: 1 });
            const roles = await admin.groupRoles(groupId);
            expect(roles.length).toBeGreaterThan(0);
            expect(roles.filter((r) => r.isDefault)).toHaveLength(1);
        });

        it('deleteGroup deletes a group: it then answers 404', async (ctx) => {
            const s = await make();
            if (!s.rights || !s.provision) return ctx.skip();
            const { admin, undo } = s.rights;
            const groupId = await admin.createGroup(tempLabel(s), 2);
            // Registered right after the create; once deleted, there is nothing left to undo.
            let deleted = false;
            undo(`temporary group ${groupId} deleted (deleteGroup case)`, async () => {
                if (!deleted) await s.provision!.removeGroup(groupId);
            });
            await admin.deleteGroup(groupId);
            deleted = true;
            await expect(admin.groupDetails(groupId)).rejects.toMatchObject({ name: 'CtHttpError', status: 404 });
        });

        it('personMasterdata names statuses, departments and campuses; privacyFieldsMandatory is a boolean', async (ctx) => {
            const s = await make();
            if (!s.rights || !s.provision) return ctx.skip();
            const md = await s.rights.admin.personMasterdata();
            for (const list of [md.statuses, md.departments, md.campuses]) {
                expect(list.length).toBeGreaterThan(0);
                for (const e of list) {
                    // Measured: 0 is a real status and campus ID.
                    expect(Number.isSafeInteger(e.id) && e.id >= 0).toBe(true);
                    expect(e.name.length).toBeGreaterThan(0);
                }
            }
            expect(typeof (await s.rights.admin.privacyFieldsMandatory())).toBe('boolean');
        });

        it('create and delete a person', async (ctx) => {
            const s = await make();
            if (!s.rights || !s.provision) return ctx.skip();
            const { admin } = s.rights;
            if (await admin.privacyFieldsMandatory()) {
                // Measured: without the privacy fields the 400 names their valid IDs (the only place they are listed).
                const md = await admin.personMasterdata();
                const refused = await admin
                    .createPerson({ firstName: s.tempName, lastName: tempLabel(s), cmsUserId: `${s.moduleKey}-contract-np-${Date.now()}`, statusId: md.statuses[0]!.id, departmentIds: [md.departments[0]!.id], campusId: md.campuses[0]!.id })
                    .catch((e: unknown) => e);
                // A create that wrongly succeeded is removed by its id (registered right away).
                if (typeof refused === 'number') s.rights.undo(`temporary person ${refused} deleted (privacy case)`, () => s.provision!.removePerson(refused));
                expect(refused).toBeInstanceOf(CtValidationError);
                const fields = (refused as CtValidationError).fields;
                expect(fields.find((f) => f.fieldId === 'privacyPolicyAgreementTypeId')?.validOptions.length).toBeGreaterThan(0);
                expect(fields.find((f) => f.fieldId === 'privacyPolicyAgreementWhoId')?.validOptions.length).toBeGreaterThan(0);
            }
            const { id, cmsUserId, person } = await throwawayPerson(s);
            expect(id).toBeGreaterThan(0);
            expect(await admin.personCmsUserId(id)).toBe(cmsUserId);
            expect(await admin.personLogin(id)).toEqual({ firstName: s.tempName, lastName: tempLabel(s), cmsUserId });
            // The same login again (the name is a duplicate on purpose, `force`): refused on the cmsUserId field.
            const again = await admin.createPerson(person).catch((e: unknown) => e);
            if (typeof again === 'number') s.rights.undo(`temporary person ${again} deleted (duplicate case)`, () => s.provision!.removePerson(again));
            expect(cmsUserIdTaken(again)).toBe(true);
            await admin.deletePerson(id);
            await expect(admin.personCmsUserId(id)).rejects.toMatchObject({ status: 404 });
        });

        it('setPersonPassword answers status', async (ctx) => {
            const s = await make();
            if (!s.rights || !s.provision) return ctx.skip();
            const { admin } = s.rights;
            const { id } = await throwawayPerson(s);
            await expect(admin.setPersonPassword(id, 'Contract0Probe0Password0Value0Ab')).resolves.toBeUndefined();
            // Measured 2026-11-15: ChurchTools refuses no password through this call, not even one with a part of the
            // name; so a refusal can't be told from a failure, and a caller has to check its own rules.
            await expect(admin.setPersonPassword(id, `xx${s.tempName}Api0xx`)).resolves.toBeUndefined();
            // A person that existed a moment ago (never a guessed ID, which could belong to a real person): 404.
            const gone = await throwawayPerson(s);
            await admin.deletePerson(gone.id);
            await expect(admin.setPersonPassword(gone.id, 'Contract0Probe0Password0Value0Ab')).rejects.toMatchObject({ name: 'CtPasswordNotSetError', httpStatus: 404 });
            if (s.limited) {
                // Without "simulate persons": 200 with status fail (measured 2026-11-11).
                const error = await (await s.limited()).setPersonPassword(id, 'Contract0Probe0Password0Value0Ab').catch((e: unknown) => e);
                expect(error).toBeInstanceOf(CtPasswordNotSetError);
                expect(error).toMatchObject({ answer: 'fail' });
            }
        });

        it('searchPersons finds a person the session may read, by a part of the name', async () => {
            const s = await make();
            const known = await s.person(s.knownPersonId);
            const part = known.name.split(' ').filter(Boolean).pop()!;
            const hits = await s.searchPersons(part);
            expect(hits.some((h) => h.id === s.knownPersonId)).toBe(true);
            for (const h of hits) {
                expect(Number.isSafeInteger(h.id) && h.id > 0).toBe(true);
                expect(typeof h.name).toBe('string');
            }
            expect(await s.searchPersons('  ')).toEqual([]);
            // The query really filters: a name nobody has finds nobody.
            expect(await s.searchPersons(`zqxj${Date.now()}`)).toEqual([]);
        });

        it('person answers id and name', async () => {
            const s = await make();
            const person = await s.person(s.knownPersonId);
            expect(person.id).toBe(s.knownPersonId);
            expect(person.name.length).toBeGreaterThan(0);
        });
    });
}
