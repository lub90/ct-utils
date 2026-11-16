import { describe, expect, it } from 'vitest';
import { createFakeChurchTools, type FakeCtSeed } from './fake-churchtools.js';
import { defineCtContract } from './ct-contract.js';
import { CtForbiddenError, CtHttpError, CtRateLimitedError, NotAuthenticatedError } from '../errors.js';
import type { Permissions } from '../types.js';

const all = (ids: number[]): Permissions => ({
    view: true,
    'view custom category': ids,
    'create custom category': false,
    'edit custom category': [],
    'delete custom category': [],
    'view custom data': ids,
    'create custom data': ids,
    'edit custom data': ids,
    'delete custom data': ids,
});

const seed = (over: Partial<FakeCtSeed> = {}): FakeCtSeed => ({
    moduleKey: 'testmodule',
    moduleId: 7,
    currentPersonId: 1,
    persons: [
        { id: 1, firstName: 'Anna', lastName: 'Admin' },
        { id: 2, firstName: 'Ben', lastName: 'Member' },
        { id: 3, firstName: 'Cora', lastName: 'Other' },
        { id: 4, firstName: 'Dan', lastName: 'Waiting' },
        { id: 5, firstName: 'Eva', lastName: 'Archived', archived: true },
    ],
    groups: [
        { id: 10, name: 'Team', memberIds: [1, 2, 5], inactiveMemberIds: [4] },
        { id: 11, name: 'Others', memberIds: [3] },
    ],
    categories: [{ id: 5, name: 'Settings', shorty: 'settings' }],
    values: [],
    permissions: all([5]),
    ...over,
});

defineCtContract('in-memory fake', async () => {
    // A second category, so the revoke case has an assignment with two selections.
    const fake = createFakeChurchTools(
        seed({
            groupRoles: [{ id: 100, groupId: 10, isDefault: true }],
            superAdminIds: [1],
            categories: [
                { id: 5, name: 'Settings', shorty: 'settings' },
                { id: 6, name: 'Access', shorty: 'access' },
            ],
            permissions: { ...all([5, 6]), 'create custom category': true },
        }),
    );
    return {
        ...fake,
        provision: { adminId: 1, removeCategory: async () => undefined, removeGroup: async () => undefined, removePerson: async () => undefined },
        rights: { admin: fake, personId: 2, personApi: async () => fake.as(2), categoryId: 5, undo: () => undefined, groupRoleIds: [100], memberId: 2, statusCategoryIds: [5, 6] },
        knownPersonId: 1,
        knownGroupId: 10,
        foreignGroupId: 11,
        moduleKey: 'testmodule',
        tempName: 'Temp',
        anonymous: async () => createFakeChurchTools(seed({ currentPersonId: null })),
        limited: async () => createFakeChurchTools(seed({ permissions: all([]) })),
        readOnly: async () =>
            createFakeChurchTools(seed({ permissions: { ...all([5]), 'create custom data': [], 'edit custom data': [], 'delete custom data': [] } })),
        inactiveMemberId: 4,
        archivedMemberId: 5,
        writeCategoryId: 5,
    };
});

describe('fake controls', () => {
    it('currentPersonId 0 or -1 is anonymous', async () => {
        for (const id of [0, -1]) {
            await expect(createFakeChurchTools(seed({ currentPersonId: id })).whoami()).rejects.toBeInstanceOf(NotAuthenticatedError);
        }
    });

    it('lists and counts only active, non-archived members', async () => {
        const fake = createFakeChurchTools(seed());
        expect((await fake.groupMembers(10)).map((m) => m.id)).toEqual([1, 2]);
        expect((await fake.group(10)).memberCount).toBe(2);
    });

    it('failNext fails exactly one call with the mapped error', async () => {
        const fake = createFakeChurchTools(seed());
        fake.failNext(403);
        await expect(fake.whoami()).rejects.toBeInstanceOf(CtForbiddenError);
        await expect(fake.whoami()).resolves.toMatchObject({ id: 1 });
        fake.failNext(401);
        await expect(fake.whoami()).rejects.toBeInstanceOf(NotAuthenticatedError);
        fake.failNext(429);
        const e = await fake.whoami().catch((x: unknown) => x);
        expect(e).toBeInstanceOf(CtRateLimitedError);
        expect((e as CtRateLimitedError).retryAfterMs).toBe(60_000);
        fake.failNext(500);
        await expect(fake.whoami()).rejects.toBeInstanceOf(CtHttpError);
    });

    it('"view group" opens a group and makes its members findable', async () => {
        const fake = createFakeChurchTools(seed());
        await expect(fake.groupMembers(11)).rejects.toBeInstanceOf(CtForbiddenError);
        await expect(fake.person(3)).rejects.toBeInstanceOf(CtHttpError);
        fake.setViewGroups([11]);
        expect((await fake.groupMembers(11)).map((m) => m.name)).toEqual(['Cora Other']);
        expect((await fake.person(3)).name).toBe('Cora Other');
    });

    it('setCurrentPerson and setGroups change what is readable', async () => {
        const fake = createFakeChurchTools(seed());
        fake.setCurrentPerson(3);
        await expect(fake.group(10)).rejects.toBeInstanceOf(CtForbiddenError);
        fake.setGroups([{ id: 10, name: 'Team', memberIds: [1, 2, 3] }]);
        expect((await fake.group(10)).memberCount).toBe(3);
    });

    it('a value needs the matching right per category', async () => {
        const fake = createFakeChurchTools(seed());
        fake.setPermissions({ ...all([5]), 'view custom data': [], 'create custom data': [] });
        await expect(fake.values(7, 5)).rejects.toBeInstanceOf(CtForbiddenError);
        await expect(fake.createValue(7, 5, '{}')).rejects.toBeInstanceOf(CtForbiddenError);
        expect((await fake.categories(7)).map((c) => c.shorty)).toEqual(['settings']);
    });
});

describe('fake rights', () => {
    const catalogId = async (fake: ReturnType<typeof createFakeChurchTools>, key: string) => (await fake.permissionDefinitions()).get(`testmodule:${key}`)!;

    it('has the catalog of the measured instance (2050 view … 2058 delete custom data)', async () => {
        const catalog = await createFakeChurchTools(seed({ superAdminIds: [1] })).permissionDefinitions();
        expect(catalog.get('testmodule:view')).toBe(2050);
        expect(catalog.get('testmodule:delete custom data')).toBe(2058);
    });

    it('a group role right reaches the members of the group, as origin groupRole', async () => {
        const fake = createFakeChurchTools(seed({ groupRoles: [{ id: 100, groupId: 10 }], superAdminIds: [1] }));
        const authId = await catalogId(fake, 'view custom data');
        await fake.applyPermissions([{ domainType: 'group_role', domainId: 100, operation: 'save', authId, dataId: [5] }]);
        expect(await fake.permissionHolders(authId, 5)).toEqual(
            expect.arrayContaining([
                { personId: 2, originTypes: ['groupRole'], sources: [{ domainType: 'group_role', domainId: 100, groupId: 10 }] },
                expect.objectContaining({ personId: 1, originTypes: expect.arrayContaining(['groupRole']) }),
            ]),
        );
        expect((await fake.as(2).globalPermissions())['view custom data']).toEqual([5]);
        expect((await fake.as(3).globalPermissions())['view custom data']).toEqual([]);
    });

    it('replace sets the selection, delete without dataId removes the assignment', async () => {
        const fake = createFakeChurchTools(seed({ superAdminIds: [1] }));
        const authId = await catalogId(fake, 'view custom data');
        const on = (operation: 'save' | 'replace' | 'delete', dataId?: number[]) => fake.applyPermissions([{ domainType: 'person', domainId: 3, operation, authId, dataId }]);
        await on('save', [5]);
        await on('replace', [7]);
        expect((await fake.as(3).globalPermissions())['view custom data']).toEqual([7]);
        await on('delete');
        expect((await fake.as(3).globalPermissions())['view custom data']).toEqual([]);
    });

    it('an unknown authId refuses the whole bulk, an unknown person or role is accepted without effect (as measured)', async () => {
        const fake = createFakeChurchTools(seed({ superAdminIds: [1] }));
        const authId = await catalogId(fake, 'view custom data');
        const good = { domainType: 'person' as const, domainId: 3, operation: 'save' as const, authId, dataId: [5] };
        await expect(fake.applyPermissions([good, { ...good, domainId: 2, authId: 1 }])).rejects.toMatchObject({ status: 400 });
        expect((await fake.as(3).globalPermissions())['view custom data']).toEqual([]);
        await fake.applyPermissions([{ ...good, domainId: 999 }, { ...good, domainType: 'group_role', domainId: 999 }]);
        expect((await fake.permissionHolders(authId, 5)).map((h) => h.personId)).toEqual([1]); // only the seeded base right
    });

    it('holders need data_id for a selectable right and refuse it for a boolean one', async () => {
        const fake = createFakeChurchTools(seed({ superAdminIds: [1] }));
        await expect(fake.permissionHolders(await catalogId(fake, 'view custom data'))).rejects.toMatchObject({ status: 400 });
        await expect(fake.permissionHolders(await catalogId(fake, 'view'), 5)).rejects.toMatchObject({ status: 400 });
    });
});
