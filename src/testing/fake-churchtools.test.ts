/** Fake-only controls (not part of the contract). */
import { describe, expect, it } from 'vitest';
import { CtForbiddenError } from '../errors.js';
import { createFakeChurchTools, type FakeCtSeed } from './fake-churchtools.js';

const NONE = {
    view: true,
    'create custom category': false,
    'view custom category': [],
    'edit custom category': [],
    'delete custom category': [],
    'view custom data': [],
    'create custom data': [1],
    'edit custom data': [],
    'delete custom data': [],
};

describe('fake ChurchTools dumpValues', () => {
    it('returns every value, also of categories the person cannot read, as copies', async () => {
        const fake = createFakeChurchTools({
            moduleKey: 'k',
            moduleId: 7,
            currentPersonId: 1,
            persons: [{ id: 1, firstName: 'A', lastName: 'B' }],
            groups: [],
            categories: [{ id: 1, name: 'one', shorty: 'one' }, { id: 2, name: 'two', shorty: 'two' }],
            values: [{ id: 5, dataCategoryId: 2, value: '"x"' }],
            permissions: NONE,
        });
        await fake.createValue(7, 1, '"y"');
        const dump = fake.dumpValues();
        expect(dump).toEqual([
            { id: 5, dataCategoryId: 2, value: '"x"' },
            { id: 6, dataCategoryId: 1, value: '"y"' },
        ]);
        dump[0]!.value = 'changed';
        expect(fake.dumpValues()[0]!.value).toBe('"x"');
    });
});

const seed = (over: Partial<FakeCtSeed> = {}): FakeCtSeed => ({
    moduleKey: 'k',
    moduleId: 7,
    currentPersonId: 1,
    persons: [
        { id: 1, firstName: 'A', lastName: 'B' },
        { id: 2, firstName: 'C', lastName: 'D' },
    ],
    groups: [],
    categories: [],
    values: [],
    permissions: NONE,
    ...over,
});

describe('fake ChurchTools rights catalog and admin gate', () => {
    it('lists the rights in the order measured on the instance (2050 … 2058)', async () => {
        const catalog = await createFakeChurchTools(seed({ superAdminIds: [1] })).permissionDefinitions();
        expect([...catalog].filter(([key]) => key.startsWith('k:'))).toEqual([
            ['k:view', 2050],
            ['k:view custom category', 2051],
            ['k:create custom category', 2052],
            ['k:edit custom category', 2053],
            ['k:delete custom category', 2054],
            ['k:view custom data', 2055],
            ['k:create custom data', 2056],
            ['k:edit custom data', 2057],
            ['k:delete custom data', 2058],
        ]);
    });

    it('also has the rights of other modules the setup grants and the rights check reads, with their own auth IDs', async () => {
        const catalog = await createFakeChurchTools(seed({ superAdminIds: [1] })).permissionDefinitions();
        for (const key of ['churchcore:login to external system', 'churchcore:administer persons', 'churchgroup:view group', 'churchdb:view alldata', 'churchdb:view hidden persons', 'churchdb:edit group memberships of group']) {
            expect(catalog.get(key), key).toBeGreaterThan(0);
        }
        expect(new Set(catalog.values()).size).toBe(catalog.size);
    });

    it('answers definitions, origins and holders with 403 (missing administer persons) for a non-admin', async () => {
        const fake = createFakeChurchTools(seed());
        for (const call of [() => fake.permissionDefinitions(), () => fake.permissionOrigins(1), () => fake.permissionHolders(2050)]) {
            const e = await call().catch((x: unknown) => x);
            expect(e).toBeInstanceOf(CtForbiddenError);
            expect(e).toMatchObject({ missing: 'administer persons' });
        }
    });

    it('a super admin (seed superAdminIds) may read them, and has the superAdmin origin on every right', async () => {
        const fake = createFakeChurchTools(seed({ superAdminIds: [1] }));
        const origins = await fake.permissionOrigins(1);
        expect(origins.filter((o) => o.module === 'k')).toHaveLength(9);
        // Measured: `churchgroup:view group` has no superAdmin origin; every other right has it.
        expect(origins.find((o) => o.module === 'churchgroup')).toBeUndefined();
        expect(origins.every((o) => o.originTypes.includes('superAdmin'))).toBe(true);
        // It adds nothing to the module's effective rights, but administers persons.
        expect(origins.find((o) => o.module === 'k' && o.auth === 'create custom category')?.effectiveValue).toBe(false);
        expect(origins.find((o) => o.auth === 'administer persons')?.effectiveValue).toBe(true);
        await expect(fake.permissionHolders(2050)).resolves.toEqual([
            { personId: 1, originTypes: expect.arrayContaining(['superAdmin']), sources: expect.arrayContaining([{ domainType: 'other', originType: 'superAdmin' }]) },
        ]);
        // The origin lists the right, but a super admin doesn't hold the module's rights by that alone.
        expect(await fake.globalPermissions()).toMatchObject({ 'create custom category': false });
        // The gate follows the current person: the same fake as a non-admin is refused.
        await expect(fake.as(2).permissionOrigins(2)).rejects.toBeInstanceOf(CtForbiddenError);
    });
});

describe('fake ChurchTools domain rights and group data', () => {
    const groups = [{ id: 10, name: 'Admins', memberIds: [2], details: { autoAccept: true } }, { id: 11, name: 'Other', memberIds: [] }];
    const roles = [
        { id: 100, groupId: 10, isDefault: true },
        { id: 101, groupId: 10 },
        { id: 110, groupId: 11 },
    ];

    it('domainPermissions lists the bulk grants of exactly that domain, flags with dataId null', async () => {
        const fake = createFakeChurchTools(seed({ superAdminIds: [1], groups, groupRoles: roles }));
        const catalog = await fake.permissionDefinitions();
        const login = catalog.get('churchcore:login to external system')!;
        await fake.applyPermissions([
            { domainType: 'group_role', domainId: 100, operation: 'save', authId: 2050 },
            { domainType: 'group_role', domainId: 100, operation: 'save', authId: login, dataId: [9] },
            { domainType: 'person', domainId: 100, operation: 'save', authId: 2055, dataId: [4] },
        ]);
        expect(await fake.domainPermissions('group_role', 100)).toEqual([
            { authId: 2050, dataId: null },
            { authId: login, dataId: [9] },
        ]);
        expect(await fake.domainPermissions('person', 100)).toEqual([{ authId: 2055, dataId: [4] }]);
        expect(await fake.domainPermissions('group_role', 101)).toEqual([]);
        await expect(fake.as(2).domainPermissions('group_role', 100)).rejects.toMatchObject({ missing: 'administer persons' });
    });

    it('applyPermissions needs administer persons (measured: 403) and then changes nothing', async () => {
        const fake = createFakeChurchTools(seed({ superAdminIds: [1], groups, groupRoles: roles }));
        await expect(fake.as(2).applyPermissions([{ domainType: 'person', domainId: 2, operation: 'save', authId: 2055, dataId: [4] }])).rejects.toMatchObject({
            missing: 'administer persons',
        });
        expect(await fake.domainPermissions('person', 2)).toEqual([]);
    });

    it('a granted right of another module shows in the origins with its effective value', async () => {
        const fake = createFakeChurchTools(seed({ superAdminIds: [1] }));
        const alldata = (await fake.permissionDefinitions()).get('churchdb:view alldata')!;
        await fake.applyPermissions([{ domainType: 'person', domainId: 2, operation: 'save', authId: alldata, dataId: [1, 2] }]);
        expect((await fake.permissionOrigins(2)).find((o) => o.authId === alldata)).toEqual({
            module: 'churchdb',
            auth: 'view alldata',
            authId: alldata,
            originTypes: ['person'],
            effectiveValue: [1, 2],
        });
    });

    it('a status grant goes to every person of that status (also status 0) and shows in origins, holders and domainPermissions', async () => {
        const fake = createFakeChurchTools(
            seed({
                superAdminIds: [1],
                persons: [
                    { id: 1, firstName: 'A', lastName: 'B' },
                    { id: 2, firstName: 'C', lastName: 'D', statusId: 0 },
                    { id: 3, firstName: 'E', lastName: 'F', statusId: 1 },
                ],
            }),
        );
        await fake.applyPermissions([{ domainType: 'status', domainId: 0, operation: 'save', authId: 2055, dataId: [4, 5] }]);
        expect(await fake.domainPermissions('status', 0)).toEqual([{ authId: 2055, dataId: [4, 5] }]);
        expect((await fake.permissionOrigins(2)).find((o) => o.authId === 2055)).toMatchObject({ originTypes: ['status'], effectiveValue: [4, 5] });
        // Person 1 is the super admin: listed with that origin only.
        const notAdmin = async (dataId: number) => (await fake.permissionHolders(2055, dataId)).filter((h) => h.personId !== 1);
        expect(await notAdmin(4)).toEqual([{ personId: 2, originTypes: ['status'], sources: [{ domainType: 'status', domainId: 0 }] }]);
        // `replace` keeps what isn't named.
        await fake.applyPermissions([{ domainType: 'status', domainId: 0, operation: 'replace', authId: 2055, dataId: [5] }]);
        expect(await notAdmin(4)).toEqual([]);
        expect((await notAdmin(5)).map((h) => h.personId)).toEqual([2]);
    });

    it('holders name the domain of each origin: the person, the group role with its group, or the status', async () => {
        const fake = createFakeChurchTools(seed({ superAdminIds: [1], groups, groupRoles: roles, persons: [{ id: 1, firstName: 'A', lastName: 'B' }, { id: 2, firstName: 'C', lastName: 'D', statusId: 1 }] }));
        await fake.applyPermissions([
            { domainType: 'person', domainId: 2, operation: 'save', authId: 2057, dataId: [4] },
            { domainType: 'group_role', domainId: 100, operation: 'save', authId: 2057, dataId: [-1] },
            { domainType: 'group_role', domainId: 101, operation: 'save', authId: 2057, dataId: [5] },
            { domainType: 'status', domainId: 1, operation: 'save', authId: 2057, dataId: [4] },
        ]);
        const holder = (await fake.permissionHolders(2057, 4)).find((h) => h.personId === 2);
        expect(holder?.sources).toEqual(
            expect.arrayContaining([
                { domainType: 'person', domainId: 2 },
                { domainType: 'group_role', domainId: 100, groupId: 10 },
                { domainType: 'status', domainId: 1 },
            ]),
        );
        // Role 101 holds category 5 only, so it isn't a source of category 4.
        expect(holder?.sources).toHaveLength(3);
    });

    it('groupRoles names a role when the seed gives a name', async () => {
        const fake = createFakeChurchTools(seed({ superAdminIds: [1], groups, groupRoles: [{ id: 100, groupId: 10, isDefault: true, name: 'Leiter' }] }));
        expect(await fake.groupRoles(10)).toEqual([{ id: 100, isDefault: true, name: 'Leiter' }]);
    });

    it('groupRoles and groupDetails answer for members and super admins, 403 for others, 404 for a gone group', async () => {
        const fake = createFakeChurchTools(seed({ superAdminIds: [1], groups, groupRoles: roles }));
        expect(await fake.groupRoles(10)).toEqual([
            { id: 100, isDefault: true },
            { id: 101, isDefault: false },
        ]);
        expect(await fake.groupDetails(10)).toEqual({
            id: 10,
            name: 'Admins',
            groupStatusId: 1,
            groupTypeId: 2,
            isOpenForMembers: false,
            autoAccept: true,
            dynamicGroupStatus: null,
        });
        expect((await fake.as(2).groupRoles(10)).map((r) => r.id)).toEqual([100, 101]);
        await expect(fake.as(2).groupDetails(11)).rejects.toBeInstanceOf(CtForbiddenError);
        await expect(fake.groupDetails(99)).rejects.toMatchObject({ status: 404 });
    });
});
