import { describe, expect, it } from 'vitest';
import { cmsUserIdTaken, createCtApi, mapCtError } from './api.js';
import { createClient } from './client.js';
import { CtForbiddenError, CtHttpError, CtInvalidIdError, CtPasswordNotSetError, CtRateLimitedError, CtValidationError, NotAuthenticatedError } from './errors.js';

interface Seen {
    method: string;
    url: string;
    headers: Record<string, unknown>;
    data: unknown;
    params?: Record<string, unknown>;
}
type Reply = { status: number; data?: unknown; headers?: Record<string, string> };

/** The real client object, with the HTTP transport replaced, so URL building, CSRF and error mapping are real. */
function setup(reply: (seen: Seen) => Reply) {
    const client = createClient({ baseUrl: 'https://example.invalid/' });
    const seen: Seen[] = [];
    const ax = (client as unknown as { ax: { defaults: { adapter: unknown } } }).ax;
    ax.defaults.adapter = async (config: { method: string; baseURL?: string; url: string; headers: Record<string, unknown>; data?: unknown; params?: Record<string, unknown> }) => {
        const entry = { method: config.method, url: config.url, headers: { ...config.headers }, data: config.data, params: config.params };
        seen.push(entry);
        const r = reply(entry);
        const response = { status: r.status, statusText: '', data: r.data ?? {}, headers: r.headers ?? {}, config, request: {} };
        if (r.status >= 400) throw Object.assign(new Error(`HTTP ${r.status}`), { isAxiosError: true, response });
        return response;
    };
    return { api: createCtApi(client, 'testmodule'), seen };
}

describe('createCtApi with the real client', () => {
    it('an empty module key throws TypeError', () => {
        expect(() => createCtApi(createClient({ baseUrl: 'https://x.example' }), ' ')).toThrow(TypeError);
        expect(() => createCtApi(createClient({ baseUrl: 'https://x.example' }), '')).toThrow(TypeError);
    });

    it('builds /api urls and maps whoami', async () => {
        const { api, seen } = setup(() => ({ status: 200, data: { data: { id: 4, firstName: 'A', lastName: 'B' } } }));
        expect(await api.whoami()).toEqual({ id: 4, firstName: 'A', lastName: 'B' });
        expect(seen[0]?.url).toBe('https://example.invalid/api/whoami');
    });

    it('treats id -1 as not logged in', async () => {
        const { api } = setup(() => ({ status: 200, data: { data: { id: -1 } } }));
        await expect(api.whoami()).rejects.toBeInstanceOf(NotAuthenticatedError);
    });

    it('maps 400 of the module lookup to null', async () => {
        const { api } = setup(() => ({ status: 400, data: { messageKey: 'validation.integer' } }));
        expect(await api.moduleId('nope')).toBeNull();
    });

    it('sends the CSRF token with a write', async () => {
        const { api, seen } = setup((s) =>
            s.url.endsWith('/csrftoken')
                ? { status: 200, data: { data: 'tok123' } }
                : { status: 200, data: { data: { id: 9, dataCategoryId: 5, value: '{}' } } },
        );
        await api.createValue(7, 5, '{}');
        const post = seen.find((s) => s.method === 'post');
        expect(post?.url).toBe('https://example.invalid/api/custommodules/7/customdatacategories/5/customdatavalues');
        expect(JSON.stringify(post?.headers)).toContain('tok123');
    });

    it('maps 403 with the missing right, 401, 429 with Retry-After, and other statuses', async () => {
        let status = 403;
        const { api } = setup(() => ({ status, data: { message: 'Forbidden to see group' }, headers: { 'retry-after': '120' } }));
        const forbidden = await api.group(3).catch((e: unknown) => e);
        expect(forbidden).toBeInstanceOf(CtForbiddenError);
        expect((forbidden as CtForbiddenError).missing).toBe('view group');
        status = 401;
        await expect(api.group(3)).rejects.toBeInstanceOf(NotAuthenticatedError);
        status = 429;
        const limited = await api.group(3).catch((e: unknown) => e);
        expect((limited as CtRateLimitedError).retryAfterMs).toBe(120_000);
        status = 500;
        await expect(api.group(3)).rejects.toBeInstanceOf(CtHttpError);
    });

    it('normalises permissions of the extension module', async () => {
        const { api } = setup(() => ({ status: 200, data: { data: { testmodule: { view: true, 'view custom category': [4, 10] } } } }));
        const p = await api.globalPermissions();
        expect(p.view).toBe(true);
        expect(p['view custom category']).toEqual([4, 10]);
        expect(p['edit custom data']).toEqual([]);
        expect(p['create custom category']).toBe(false);
    });

    const member = (personId: number, status: string, over: Record<string, unknown> = {}) => ({
        personId,
        groupMemberStatus: status,
        person: {
            title: `P${personId} Name`,
            domainType: 'person',
            domainIdentifier: String(personId),
            domainAttributes: { firstName: `P${personId}`, lastName: 'Name', isArchived: false, ...over },
        },
    });

    it('reads all pages of members and keeps only active, non-archived ones', async () => {
        const { api, seen } = setup((s) => {
            if (s.url.endsWith('/members')) {
                const page = Number(s.params?.page);
                return {
                    status: 200,
                    data:
                        page === 1
                            ? { data: [member(1, 'active'), member(2, 'waiting')], meta: { pagination: { lastPage: 2, total: 4 } } }
                            : { data: [member(3, 'active', { isArchived: true }), member(4, 'active')], meta: { pagination: { lastPage: 2, total: 4 } } },
                };
            }
            return { status: 200, data: { data: { id: 9, name: 'Team', information: { memberCount: 99 } } } };
        });
        expect((await api.groupMembers(9)).map((m) => m.id)).toEqual([1, 4]);
        expect(seen.filter((s) => s.url.endsWith('/members')).map((s) => s.params?.page)).toEqual([1, 2]);
        // The count comes from the filtered list, not from `information`.
        expect(await api.group(9)).toEqual({ id: 9, name: 'Team', memberCount: 2 });
    });

    it('maps the measured member payload to picker options', async () => {
        const { api } = setup(() => ({
            status: 200,
            data: {
                data: [
                    member(7, 'active'),
                    { personId: 8, groupMemberStatus: 'active', person: { domainAttributes: { firstName: 'Zoe', lastName: 'Zed' } } },
                    { personId: 0, groupMemberStatus: 'active', person: { title: 'Bad' } },
                ],
                meta: { pagination: { lastPage: 1, total: 3 } },
            },
        }));
        expect(await api.groupMembers(1)).toEqual([
            { id: 7, name: 'P7 Name' },
            { id: 8, name: 'Zoe Zed' },
        ]);
    });
});

const headerOf = (headers: Record<string, unknown>, name: string) =>
    Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const body = (s: Seen | undefined) => JSON.parse(typeof s?.data === 'string' ? s.data : '{}') as Record<string, unknown>;
const ok = (data: unknown): Reply => ({ status: 200, data: { data } });
/** Answers `/csrftoken` and delegates the rest. */
const withCsrf = (inner: (s: Seen) => Reply) => (s: Seen): Reply => (s.url.endsWith('/csrftoken') ? ok('tok') : inner(s));
const lastCall = (seen: Seen[]) => seen.filter((s) => !s.url.endsWith('/csrftoken')).at(-1);

describe('whoami with unusable ids', () => {
    it.each([[-1], [0], [undefined], ['x'], ['4'], [null], [1.5]])('id %j is not logged in', async (id) => {
        const { api } = setup(() => ok({ id, firstName: 'A', lastName: 'B' }));
        await expect(api.whoami()).rejects.toBeInstanceOf(NotAuthenticatedError);
    });
});

describe('moduleId errors', () => {
    it.each([
        [403, CtForbiddenError],
        [429, CtRateLimitedError],
        [500, CtHttpError],
        [401, NotAuthenticatedError],
    ])('%i rejects with the mapped error, never null', async (status, error) => {
        const { api } = setup(() => ({ status }));
        await expect(api.moduleId('k')).rejects.toBeInstanceOf(error);
    });

    it('a network error passes through unchanged', async () => {
        const failure = new Error('network down');
        const { api } = setup(() => {
            throw failure;
        });
        await expect(api.moduleId('k')).rejects.toBe(failure);
    });

    it('a 200 whose id is not a number is null; a number is returned; the key is encoded', async () => {
        const bad = setup(() => ok({ id: '7' }));
        expect(await bad.api.moduleId('k')).toBeNull();
        const good = setup(() => ok({ id: 7 }));
        expect(await good.api.moduleId('a/b')).toBe(7);
        expect(good.seen[0]?.url).toBe('https://example.invalid/api/custommodules/a%2Fb');
    });
});

describe('mapCtError', () => {
    it('passes errors without an HTTP response unchanged', () => {
        const e = new Error('x');
        expect(mapCtError(e)).toBe(e);
        expect(mapCtError(null)).toBeNull();
        expect(mapCtError({ response: {} })).toEqual({ response: {} });
    });
});

describe('requests and mapping', () => {
    it('categories: GET url and mapped fields', async () => {
        const { api, seen } = setup(() => ok([{ id: 5, name: 'N', shorty: 's', description: 'd', customModuleId: 7 }]));
        expect(await api.categories(7)).toEqual([{ id: 5, name: 'N', shorty: 's' }]);
        expect(seen[0]).toMatchObject({ method: 'get', url: 'https://example.invalid/api/custommodules/7/customdatacategories' });
    });

    it('values: GET url and mapped fields, 403 names "view custom data"', async () => {
        const { api, seen } = setup(() => ok([{ id: 1, dataCategoryId: 5, value: '{"a":1}' }, { id: 2, value: '{}' }]));
        expect(await api.values(7, 5)).toEqual([
            { id: 1, dataCategoryId: 5, value: '{"a":1}' },
            { id: 2, dataCategoryId: 5, value: '{}' },
        ]);
        expect(seen[0]?.url).toBe('https://example.invalid/api/custommodules/7/customdatacategories/5/customdatavalues');
        const denied = setup(() => ({ status: 403 }));
        expect(await denied.api.values(7, 5).catch((e: unknown) => e)).toMatchObject({ name: 'CtForbiddenError', missing: 'view custom data' });
    });

    it('createValue: POST body and result, 403 names "create custom data"', async () => {
        const { api, seen } = setup(withCsrf(() => ok({ id: 9, dataCategoryId: 5, value: '{"a":1}' })));
        expect(await api.createValue(7, 5, '{"a":1}')).toEqual({ id: 9, dataCategoryId: 5, value: '{"a":1}' });
        const call = lastCall(seen);
        expect(call?.method).toBe('post');
        expect(call?.url).toBe('https://example.invalid/api/custommodules/7/customdatacategories/5/customdatavalues');
        expect(body(call)).toMatchObject({ dataCategoryId: 5, value: '{"a":1}' });
        const denied = setup(withCsrf(() => ({ status: 403 })));
        expect(await denied.api.createValue(7, 5, '{}').catch((e: unknown) => e)).toMatchObject({ missing: 'create custom data' });
    });

    it('updateValue: PUT body and result, 403 names "edit custom data"', async () => {
        const { api, seen } = setup(withCsrf(() => ok({ id: 9, dataCategoryId: 5, value: '{"b":2}' })));
        expect(await api.updateValue(7, 5, 9, '{"b":2}')).toEqual({ id: 9, dataCategoryId: 5, value: '{"b":2}' });
        const call = lastCall(seen);
        expect(call?.method).toBe('put');
        expect(call?.url).toBe('https://example.invalid/api/custommodules/7/customdatacategories/5/customdatavalues/9');
        expect(body(call)).toMatchObject({ dataCategoryId: 5, value: '{"b":2}' });
        const denied = setup(withCsrf(() => ({ status: 403 })));
        expect(await denied.api.updateValue(7, 5, 9, '{}').catch((e: unknown) => e)).toMatchObject({ missing: 'edit custom data' });
    });

    it('deleteValue: DELETE url, 403 names "delete custom data"', async () => {
        const { api, seen } = setup(withCsrf(() => ({ status: 204 })));
        await api.deleteValue(7, 5, 9);
        const call = lastCall(seen);
        expect(call?.method).toBe('delete');
        expect(call?.url).toBe('https://example.invalid/api/custommodules/7/customdatacategories/5/customdatavalues/9');
        const denied = setup(withCsrf(() => ({ status: 403 })));
        expect(await denied.api.deleteValue(7, 5, 9).catch((e: unknown) => e)).toMatchObject({ missing: 'delete custom data' });
    });

    it('person: GET url and name from first and last name; 403 and 404 are mapped', async () => {
        const { api, seen } = setup(() => ok({ id: 3, firstName: 'Ann', lastName: 'Lee', email: 'x' }));
        expect(await api.person(3)).toEqual({ id: 3, name: 'Ann Lee' });
        expect(seen[0]?.url).toBe('https://example.invalid/api/persons/3');
        const missing = setup(() => ({ status: 404 }));
        expect(await missing.api.person(3).catch((e: unknown) => e)).toMatchObject({ name: 'CtHttpError', status: 404 });
    });
});

describe('searchPersons', () => {
    it('GET /persons with the trimmed query; id and name; entries without a usable id are dropped', async () => {
        const { api, seen } = setup(() =>
            ok([
                { id: 3, firstName: 'Ann', lastName: 'Lee' },
                { id: 0, firstName: 'Bad', lastName: 'Zero' },
                { id: '4', firstName: 'Bad', lastName: 'String' },
                { id: 5, firstName: 'Bo', lastName: '' },
            ]),
        );
        expect(await api.searchPersons('  ann ')).toEqual([
            { id: 3, name: 'Ann Lee' },
            { id: 5, name: 'Bo' },
        ]);
        expect(seen[0]?.url).toBe('https://example.invalid/api/persons');
        expect(seen[0]?.params).toMatchObject({ query: 'ann' });
    });

    it('an empty query sends nothing; 403 is mapped', async () => {
        const { api, seen } = setup(() => ok([]));
        expect(await api.searchPersons('   ')).toEqual([]);
        expect(seen).toEqual([]);
        const denied = setup(() => ({ status: 403 }));
        expect(await denied.api.searchPersons('a').catch((e: unknown) => e)).toBeInstanceOf(CtForbiddenError);
    });
});

describe('group members filter', () => {
    const entry = (over: Record<string, unknown>) => ({
        personId: 1,
        groupMemberStatus: 'active',
        person: { title: 'T', domainIdentifier: '1', domainAttributes: { firstName: 'F', lastName: 'L', isArchived: false } },
        ...over,
    });
    const members = async (list: unknown[]) => {
        const { api } = setup(() => ({ status: 200, data: { data: list, meta: { pagination: { lastPage: 1 } } } }));
        return api.groupMembers(1);
    };

    it.each(['waiting', 'requested', 'to_delete', 'bogus', undefined])('status %j is excluded', async (status) => {
        expect(await members([entry({ groupMemberStatus: status })])).toEqual([]);
    });

    it('takes the id from domainIdentifier when personId is missing', async () => {
        expect(await members([entry({ personId: undefined, person: { title: 'T', domainIdentifier: '12' } })])).toEqual([{ id: 12, name: 'T' }]);
    });

    it('skips an unusable personId', async () => {
        expect(await members([entry({ personId: 'abc' }), entry({ personId: -3 })])).toEqual([]);
    });

    it('lists the same person from two pages once', async () => {
        const { api } = setup((s) => ({
            status: 200,
            data: { data: [entry({ personId: 5 }), entry({ personId: Number(s.params?.page) + 5 })], meta: { pagination: { lastPage: 2 } } },
        }));
        expect((await api.groupMembers(1)).map((m) => m.id)).toEqual([5, 6, 7]);
    });

    it('skips a member without title or names', async () => {
        expect(await members([entry({ person: { domainAttributes: {} } }), entry({ person: undefined })])).toEqual([]);
    });
});

describe('globalPermissions safety', () => {
    const perms = async (own: unknown, all: Record<string, unknown> = { testmodule: own }) => {
        const { api } = setup(() => ok(all));
        return api.globalPermissions();
    };

    it.each([['true'], [1], ['yes'], [null], [{}]])('view %j does not grant view', async (view) => {
        expect((await perms({ view })).view).toBe(false);
        expect((await perms({ 'create custom category': view }))['create custom category']).toBe(false);
    });

    it('a missing module key grants nothing', async () => {
        const p = await perms(undefined, { other: { view: true } });
        expect(p.view).toBe(false);
        expect(p['view custom data']).toEqual([]);
    });

    it('a null response grants nothing', async () => {
        expect((await perms(undefined, null as never)).view).toBe(false);
    });

    it('a right that is null, true or an object is []', async () => {
        const p = await perms({ 'view custom data': null, 'edit custom data': true, 'create custom data': { 0: 4 } });
        expect(p['view custom data']).toEqual([]);
        expect(p['edit custom data']).toEqual([]);
        expect(p['create custom data']).toEqual([]);
    });

    it('list entries that are not positive integers are dropped', async () => {
        const p = await perms({ 'view custom data': [4, '5', null, 'x', -1, 0, 1.5, true, 10] });
        expect(p['view custom data']).toEqual([4, 10]);
    });
});

describe('authenticated-only requests (F2)', () => {
    it('sends X-OnlyAuthenticated: 1 on reads and writes', async () => {
        const { api, seen } = setup(withCsrf(() => ok({ id: 9, dataCategoryId: 5, value: '{}' })));
        await api.categories(7).catch(() => undefined);
        await api.createValue(7, 5, '{}');
        const calls = seen.filter((s) => !s.url.endsWith('/csrftoken'));
        expect(calls.length).toBe(2);
        for (const c of calls) expect(headerOf(c.headers, 'X-OnlyAuthenticated')).toBe('1');
    });

    it('an expired session (401) becomes NotAuthenticatedError', async () => {
        const { api } = setup(() => ({ status: 401 }));
        await expect(api.categories(7)).rejects.toBeInstanceOf(NotAuthenticatedError);
    });
});

describe('path ids are checked before any request (F3)', () => {
    const bad = [0, -1, 1.5, NaN, Infinity, 2 ** 53, '3', null, undefined] as unknown as number[];
    it.each(bad.map((b) => [b]))('id %j is rejected', async (id) => {
        const { api, seen } = setup(() => ok({}));
        const calls = [
            () => api.person(id),
            () => api.group(id),
            () => api.groupMembers(id),
            () => api.categories(id),
            () => api.values(id, 5),
            () => api.values(7, id),
            () => api.createValue(id, 5, '{}'),
            () => api.createValue(7, id, '{}'),
            () => api.updateValue(7, 5, id, '{}'),
            () => api.updateValue(id, 5, 1, '{}'),
            () => api.deleteValue(7, id, 1),
            () => api.deleteValue(7, 5, id),
            () => api.permissionOrigins(id),
            () => api.permissionHolders(id),
            () => api.domainPermissions('person', id),
            () => api.groupRoles(id),
            () => api.groupDetails(id),
            () => api.applyPermissions([{ domainType: 'person', domainId: id, operation: 'save', authId: 5 }]),
            () =>
                api.applyPermissions([
                    {
                        domainType: 'group_role',
                        domainId: 3,
                        operation: 'save',
                        authId: id,
                    },
                ]),
        ];
        // `-1` is the one non-positive data ID ChurchTools knows (all, current and future).
        if (id !== -1) calls.push(() => api.applyPermissions([{ domainType: 'person', domainId: 3, operation: 'replace', authId: 5, dataId: [id] }]));
        // `undefined` is a valid dataId for holders (a boolean right), every other bad value is not.
        if (id !== undefined) calls.push(() => api.permissionHolders(5, id));
        for (const call of calls) await expect(call()).rejects.toBeInstanceOf(CtInvalidIdError);
        expect(seen).toEqual([]);
    });
});

describe('rights endpoints', () => {
    const definitions = {
        modules: [
            {
                key: 'testmodule',
                permissions: [
                    { authId: 2050, key: 'view', name: 'view', valueType: 'boolean' },
                    {
                        authId: 2056,
                        key: 'view custom data',
                        name: 'x',
                        valueType: 'selection',
                        selections: [],
                    },
                    { authId: 'bad', key: 'edit custom data' },
                ],
            },
            {
                key: 'churchcore',
                permissions: [
                    { authId: 1, key: 'view', name: 'v' },
                    { authId: 0, key: 'zero' },
                ],
            },
            { permissions: [{ authId: 9, key: 'orphan' }] },
        ],
    };

    it('permissionDefinitions reads the global catalog as "module:key" to authId', async () => {
        const { api, seen } = setup(() => ok(definitions));
        const catalog = await api.permissionDefinitions();
        expect(seen).toHaveLength(1);
        expect(seen[0]?.method).toBe('get');
        expect(seen[0]?.url).toBe('https://example.invalid/api/permissions/definitions');
        expect(seen[0]?.params).toEqual({ scope: 'global' });
        // Entries without a positive integer authId, or a module without a key, are not in the catalog.
        expect([...catalog]).toEqual([
            ['testmodule:view', 2050],
            ['testmodule:view custom data', 2056],
            ['churchcore:view', 1],
        ]);
    });

    it('permissionDefinitions names "administer persons" when it is forbidden', async () => {
        const { api } = setup(() => ({ status: 403 }));
        const e = await api.permissionDefinitions().catch((x: unknown) => x);
        expect(e).toBeInstanceOf(CtForbiddenError);
        expect((e as CtForbiddenError).missing).toBe('administer persons');
    });

    it('applyPermissions posts exactly the bulk body with type grant, with the CSRF token', async () => {
        const { api, seen } = setup(withCsrf(() => ({ status: 204 })));
        await api.applyPermissions([
            {
                domainType: 'group_role',
                domainId: 12,
                operation: 'replace',
                authId: 2056,
                dataId: [4, 5],
            },
            { domainType: 'person', domainId: 3, operation: 'save', authId: 2050 },
            {
                domainType: 'person',
                domainId: 3,
                operation: 'delete',
                authId: 2056,
                dataId: [],
            },
        ]);
        const post = lastCall(seen);
        expect(post?.method).toBe('post');
        expect(post?.url).toBe('https://example.invalid/api/permissions/bulk');
        expect(JSON.stringify(post?.headers)).toContain('tok');
        expect(body(post)).toEqual({
            changes: [
                {
                    domainType: 'group_role',
                    domainId: 12,
                    operation: 'replace',
                    authId: 2056,
                    dataId: [4, 5],
                    type: 'grant',
                },
                {
                    domainType: 'person',
                    domainId: 3,
                    operation: 'save',
                    authId: 2050,
                    type: 'grant',
                },
                {
                    domainType: 'person',
                    domainId: 3,
                    operation: 'delete',
                    authId: 2056,
                    dataId: [],
                    type: 'grant',
                },
            ],
        });
    });

    it('101 changes are refused without a request, 100 are sent', async () => {
        const { api, seen } = setup(withCsrf(() => ({ status: 204 })));
        const change = (i: number) => ({
            domainType: 'person' as const,
            domainId: i + 1,
            operation: 'save' as const,
            authId: 2050,
        });
        await expect(api.applyPermissions(Array.from({ length: 101 }, (_, i) => change(i)))).rejects.toThrow(/100/);
        expect(seen).toEqual([]);
        await api.applyPermissions(Array.from({ length: 100 }, (_, i) => change(i)));
        expect(body(lastCall(seen)).changes).toHaveLength(100);
    });

    it('dataId -1 (all, current and future) is sent; other non-positive ids are refused', async () => {
        const { api, seen } = setup(withCsrf(() => ({ status: 204 })));
        const change = (dataId: number[]) => [{ domainType: 'person' as const, domainId: 1, operation: 'save' as const, authId: 2051, dataId }];
        await api.applyPermissions(change([-1]));
        expect(body(lastCall(seen)).changes).toEqual([expect.objectContaining({ dataId: [-1] })]);
        const before = seen.length;
        for (const bad of [[0], [-2], [1.5]]) await expect(api.applyPermissions(change(bad))).rejects.toBeInstanceOf(CtInvalidIdError);
        expect(seen).toHaveLength(before);
    });

    it('no changes send nothing', async () => {
        const { api, seen } = setup(() => ok({}));
        await api.applyPermissions([]);
        expect(seen).toEqual([]);
    });

    it('an unknown domainType or operation is refused without a request', async () => {
        const { api, seen } = setup(() => ok({}));
        const bad = (over: Record<string, unknown>) =>
            [
                {
                    domainType: 'person',
                    domainId: 1,
                    operation: 'save',
                    authId: 2,
                    ...over,
                },
            ] as never;
        await expect(api.applyPermissions(bad({ domainType: 'group' }))).rejects.toThrow();
        await expect(api.applyPermissions(bad({ domainType: 'grouptype_role' }))).rejects.toThrow();
        await expect(api.applyPermissions(bad({ operation: 'drop' }))).rejects.toThrow();
        expect(seen).toEqual([]);
    });

    it('applyPermissions sends a status domain, also status 0 (a real status ID, measured), and refuses a negative one', async () => {
        const { api, seen } = setup(withCsrf(() => ({ status: 204 })));
        await api.applyPermissions([{ domainType: 'status', domainId: 0, operation: 'replace', authId: 2055, dataId: [4] }]);
        const bulk = seen.find((s) => s.url.endsWith('/permissions/bulk'));
        expect(JSON.parse(String(bulk?.data))).toEqual({ changes: [{ domainType: 'status', domainId: 0, operation: 'replace', authId: 2055, dataId: [4], type: 'grant' }] });
        const before = seen.length;
        for (const bad of [-1, 1.5, '1']) {
            await expect(api.applyPermissions([{ domainType: 'status', domainId: bad as number, operation: 'delete', authId: 2050 }])).rejects.toBeInstanceOf(CtInvalidIdError);
        }
        // Only a status may be 0: a person or group role 0 is no ID.
        await expect(api.applyPermissions([{ domainType: 'person', domainId: 0, operation: 'delete', authId: 2050 }])).rejects.toBeInstanceOf(CtInvalidIdError);
        expect(seen.length).toBe(before);
    });

    it('applyPermissions maps a refused bulk (400) to CtHttpError', async () => {
        const { api } = setup(
            withCsrf(() => ({
                status: 400,
                data: { message: 'changes.0.authId invalid' },
            })),
        );
        const e = await api.applyPermissions([{ domainType: 'person', domainId: 1, operation: 'save', authId: 99 }]).catch((x: unknown) => x);
        expect(e).toMatchObject({ name: 'CtHttpError', status: 400 });
    });

    it('permissionOrigins reads the origin types per permission', async () => {
        const { api, seen } = setup(() =>
            ok({
                permissions: [
                    {
                        authId: 2050,
                        module: 'testmodule',
                        auth: 'view',
                        effectiveValue: true,
                        origins: [
                            { type: 'superAdmin', value: true },
                            { type: 'groupRole', groupId: 3 },
                        ],
                    },
                    {
                        authId: 2051,
                        module: 'testmodule',
                        auth: 'edit',
                        effectiveValue: false,
                        origins: [],
                    },
                    { authId: 'x', module: 'm', auth: 'a', origins: [] },
                ],
            }),
        );
        expect(await api.permissionOrigins(8)).toEqual([
            {
                module: 'testmodule',
                auth: 'view',
                authId: 2050,
                originTypes: ['superAdmin', 'groupRole'],
                effectiveValue: true,
            },
            { module: 'testmodule', auth: 'edit', authId: 2051, originTypes: [], effectiveValue: false },
        ]);
        expect(seen[0]?.url).toBe('https://example.invalid/api/permissions/origins/global/persons/8');
    });

    it('permissionHolders reads all pages with origins and data_id', async () => {
        const person = (personId: number, ...types: string[]) => ({
            personId,
            origins: types.map((type) => ({ type })),
        });
        const { api, seen } = setup((s) => {
            const page = Number(s.params?.page);
            const persons = page === 1 ? [person(1, 'person'), person(2, 'groupRole')] : [person(3, 'groupRole', 'status')];
            return ok({
                authId: 2056,
                meta: { total: 3, page, limit: 2 },
                selections: [{ dataId: 4, personIds: persons.map((p) => p.personId), persons }],
            });
        });
        // limit is fixed at 100, so the fake pages of 2 are cut by `total`, not by page size.
        const holders = await api.permissionHolders(2056, 4);
        expect(holders.map((h) => h.personId)).toEqual([1, 2, 3]);
        expect(holders[2]?.originTypes).toEqual(['groupRole', 'status']);
        expect(holders[0]?.sources).toEqual([{ domainType: 'person', domainId: 1 }]);
        expect(seen.map((s) => s.url)).toEqual(Array(seen.length).fill('https://example.invalid/api/permissions/global/auths/2056/persons'));
        expect(seen[0]?.params).toEqual({
            data_id: 4,
            include: 'origins',
            limit: 100,
            page: 1,
        });
    });

    it('permissionHolders sends no data_id for a boolean right and stops on a short page', async () => {
        const { api, seen } = setup(() =>
            ok({
                authId: 2050,
                meta: { total: 1, page: 1, limit: 100 },
                selections: [
                    {
                        dataId: null,
                        personIds: [7],
                        persons: [{ personId: 7, origins: [{ type: 'person' }] }],
                    },
                ],
            }),
        );
        expect(await api.permissionHolders(2050)).toEqual([{ personId: 7, originTypes: ['person'], sources: [{ domainType: 'person', domainId: 7 }] }]);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.params).not.toHaveProperty('data_id');
    });

    it('permissionHolders names the domain of each origin (measured shapes); what the extension cannot change is "other"', async () => {
        const origins = [
            { type: 'person', value: [4] },
            // Measured 2026-11-15: a group-role origin names the group and the group role; a status origin its status (0 is real).
            { type: 'groupRole', groupId: 12, groupRoleId: 31, groupTypeRoleId: 8, inherited: false, value: [4], revokedByGroupRoleId: null },
            { type: 'status', statusId: 0, value: [4] },
            { type: 'status', statusId: 3, value: [4] },
            // Shapes without the IDs: kept as "other", never dropped.
            { type: 'groupRole', groupId: 12 },
            { type: 'status', statusId: -1 },
            { type: 'groupTypeRole', groupTypeRoleId: 8 },
            { type: 'publicUser' },
            { type: 'superAdmin' },
            { type: 'person' },
            { noType: true },
        ];
        const { api } = setup(() => ok({ meta: { total: 1 }, selections: [{ dataId: 4, persons: [{ personId: 5, origins }] }] }));
        const [holder] = await api.permissionHolders(2056, 4);
        expect(holder?.sources).toEqual([
            { domainType: 'person', domainId: 5 },
            { domainType: 'group_role', domainId: 31, groupId: 12 },
            { domainType: 'status', domainId: 0 },
            { domainType: 'status', domainId: 3 },
            { domainType: 'other', originType: 'groupRole' },
            { domainType: 'other', originType: 'status' },
            { domainType: 'other', originType: 'groupTypeRole' },
            { domainType: 'other', originType: 'publicUser' },
            { domainType: 'other', originType: 'superAdmin' },
        ]);
    });

    it('permissionHolders merges the sources of a person listed on several pages', async () => {
        const { api } = setup((s) =>
            ok({
                meta: { total: 2 },
                selections: [{ dataId: 4, persons: [{ personId: 5, origins: [Number(s.params?.page) === 1 ? { type: 'person' } : { type: 'status', statusId: 2 }] }] }],
            }),
        );
        expect((await api.permissionHolders(2056, 4))[0]?.sources).toEqual([
            { domainType: 'person', domainId: 5 },
            { domainType: 'status', domainId: 2 },
        ]);
    });

    it('permissionOrigins keeps boolean and ID-list values, makes a level a list of one and turns anything else into true (fail closed)', async () => {
        const entry = (authId: number, effectiveValue: unknown) => ({ authId, module: 'churchdb', auth: `a${authId}`, effectiveValue, origins: [] });
        const { api } = setup(() =>
            ok({ permissions: [entry(1, [1, 2]), entry(2, 3), entry(3, false), entry(4, 'all'), entry(5, [1, 'x']), entry(6, null), entry(7, { a: 1 }), entry(8, 1.5)] }),
        );
        expect((await api.permissionOrigins(8)).map((o) => o.effectiveValue)).toEqual([[1, 2], [3], false, true, true, true, true, true]);
    });

    it('permissionOrigins gives the measured security level person (a plain 1) as [1], as GET /permissions/global does', async () => {
        // Measured 2026-11-15 on a new person with status 0 and a person grant of level 1.
        const { api } = setup(() =>
            ok({
                permissions: [
                    {
                        authId: 125,
                        module: 'churchdb',
                        auth: 'security level person',
                        effectiveValue: 1,
                        origins: [
                            { type: 'status', statusId: 0, value: 1, revokedByGroupRoleId: null },
                            { type: 'person', personId: 3040, value: 1, revokedByGroupRoleId: null },
                        ],
                    },
                ],
            }),
        );
        expect(await api.permissionOrigins(3040)).toEqual([{ module: 'churchdb', auth: 'security level person', authId: 125, originTypes: ['status', 'person'], effectiveValue: [1] }]);
    });

    it('domainPermissions reads the grant rows of one domain and groups them per authId', async () => {
        const row = (authId: unknown, dataId: unknown, type = 'grant') => ({ authId, dataId, domainId: 31, domainType: 'group_role', isInherited: false, type, meta: {}, reason: null });
        const { api, seen } = setup(() =>
            ok([row(2050, null), row(2055, 4), row(2055, 5), row(2056, -1), row(2057, 4, 'revoke'), row('x', 1), row(2058, 'all'), row(18, null), row(18, 9)]),
        );
        expect(await api.domainPermissions('group_role', 31)).toEqual([
            { authId: 2050, dataId: null },
            { authId: 2055, dataId: [4, 5] },
            { authId: 2056, dataId: [-1] },
            { authId: 18, dataId: [9] },
        ]);
        expect(seen[0]?.url).toBe('https://example.invalid/api/permissions/group_role/31');
    });

    it('domainPermissions names "administer persons" when it is forbidden, and an empty answer is []', async () => {
        const { api } = setup(() => ({ status: 403 }));
        await expect(api.domainPermissions('person', 3)).rejects.toMatchObject({ name: 'CtForbiddenError', missing: 'administer persons' });
        expect(await setup(() => ok([])).api.domainPermissions('status', 3)).toEqual([]);
        const unknown = setup(() => ok([]));
        await expect(unknown.api.domainPermissions('group' as 'person', 3)).rejects.toThrow('Unknown permission domain type group');
        expect(unknown.seen).toEqual([]);
        expect(await setup(() => ok(null)).api.domainPermissions('status', 3)).toEqual([]);
        // Status 0 is a real status (measured); only a status may be 0.
        const zero = setup(() => ok([]));
        expect(await zero.api.domainPermissions('status', 0)).toEqual([]);
        expect(zero.seen[0]?.url).toBe('https://example.invalid/api/permissions/status/0');
        await expect(zero.api.domainPermissions('person', 0)).rejects.toBeInstanceOf(CtInvalidIdError);
        await expect(zero.api.domainPermissions('status', -1)).rejects.toBeInstanceOf(CtInvalidIdError);
    });
});

describe('group endpoints for the rights check', () => {
    it('groupRoles reads id, isDefault and a name (when it is a non-empty string) from GET /groups/{id}/roles', async () => {
        const { api, seen } = setup(() => ok([{ id: 31, isDefault: true, name: 'Teilnehmer' }, { id: 32, isDefault: false, name: '' }, { id: 33, name: 7 }, { id: 'x', isDefault: true }]));
        expect(await api.groupRoles(12)).toEqual([
            { id: 31, isDefault: true, name: 'Teilnehmer' },
            { id: 32, isDefault: false },
            { id: 33, isDefault: false },
        ]);
        expect(seen[0]?.url).toBe('https://example.invalid/api/groups/12/roles');
    });

    it('groupDetails reads status, type and the membership settings; odd values become undefined', async () => {
        const { api, seen } = setup(() =>
            ok({
                id: 12,
                name: 'TestModule Admins',
                information: { groupStatusId: 1, groupTypeId: 2 },
                settings: { isOpenForMembers: false, autoAccept: true, dynamicGroupStatus: null },
            }),
        );
        expect(await api.groupDetails(12)).toEqual({
            id: 12,
            name: 'TestModule Admins',
            groupStatusId: 1,
            groupTypeId: 2,
            isOpenForMembers: false,
            autoAccept: true,
            dynamicGroupStatus: null,
        });
        expect(seen[0]?.url).toBe('https://example.invalid/api/groups/12');
        const odd = await setup(() => ok({ id: 12, name: 'X', information: { groupStatusId: '1' }, settings: { isOpenForMembers: 'no', dynamicGroupStatus: 7 } })).api.groupDetails(12);
        expect(odd).toEqual({ id: 12, name: 'X', groupStatusId: undefined, groupTypeId: undefined, isOpenForMembers: undefined, autoAccept: undefined, dynamicGroupStatus: undefined });
    });

    it('groupDetails maps 404 to CtHttpError 404 and 403 to CtForbiddenError', async () => {
        await expect(setup(() => ({ status: 404 })).api.groupDetails(12)).rejects.toMatchObject({ name: 'CtHttpError', status: 404 });
        await expect(setup(() => ({ status: 403 })).api.groupDetails(12)).rejects.toBeInstanceOf(CtForbiddenError);
    });
});

describe('provisioning endpoints', () => {
    const csrf = (s: Seen) => s.url.endsWith('/csrftoken');
    const reply = (data: unknown) => (s: Seen): Reply => (csrf(s) ? { status: 200, data: { data: 'tok' } } : { status: 200, data: { data } });
    const writes = (seen: Seen[]) => seen.filter((s) => !csrf(s));

    it('deleteCategory: DELETE url, 403 names "delete custom category"', async () => {
        const { api, seen } = setup(withCsrf(() => ({ status: 204 })));
        await api.deleteCategory(7, 5);
        const call = lastCall(seen);
        expect(call?.method).toBe('delete');
        expect(call?.url).toBe('https://example.invalid/api/custommodules/7/customdatacategories/5');
        const denied = setup(withCsrf(() => ({ status: 403 })));
        expect(await denied.api.deleteCategory(7, 5).catch((e: unknown) => e)).toMatchObject({ missing: 'delete custom category' });
        await expect(api.deleteCategory(7, 0)).rejects.toThrow();
    });

    it('createCategory posts name and shorty and reads the id; a 403 names the right', async () => {
        const { api, seen } = setup(reply({ id: 31, name: 'settings', shorty: 'sett', customModuleId: 7 }));
        expect(await api.createCategory(7, { name: 'settings', shorty: 'sett' })).toEqual({ id: 31, name: 'settings', shorty: 'sett' });
        const post = writes(seen)[0];
        expect(post).toMatchObject({ method: 'post', url: 'https://example.invalid/api/custommodules/7/customdatacategories' });
        expect(JSON.parse(String(post?.data))).toEqual({ customModuleId: 7, name: 'settings', shorty: 'sett' });
        await expect(setup((s) => (csrf(s) ? { status: 200, data: { data: 'tok' } } : { status: 403 })).api.createCategory(7, { name: 'a', shorty: 'b' })).rejects.toMatchObject({
            name: 'CtForbiddenError',
            missing: 'create custom category',
        });
        await expect(setup(reply({})).api.createCategory(7, { name: 'a', shorty: 'b' })).rejects.toThrow('without an id');
    });

    it('createGroup posts an active group of the type and returns its id', async () => {
        const { api, seen } = setup(reply({ id: 44 }));
        expect(await api.createGroup('TestModule Nutzer', 2)).toBe(44);
        const post = writes(seen)[0];
        expect(post?.url).toBe('https://example.invalid/api/groups');
        expect(JSON.parse(String(post?.data))).toEqual({ name: 'TestModule Nutzer', groupTypeId: 2, groupStatusId: 1, force: true });
        await expect(setup(reply({})).api.createGroup('x', 2)).rejects.toThrow('without an id');
    });

    it('defaultRole takes the default role of the group type from GET /group/roles', async () => {
        const roles = [
            { id: 1, groupTypeId: 2, isDefault: false },
            { id: 2, groupTypeId: 3, isDefault: true },
            { id: 3, groupTypeId: 2, isDefault: true },
        ];
        const { api, seen } = setup(reply(roles));
        expect(await api.defaultRole(2)).toBe(3);
        expect(seen[0]?.url).toBe('https://example.invalid/api/group/roles');
        await expect(api.defaultRole(5)).rejects.toThrow('no default role');
    });

    it('addMember puts an active membership with the role, and checks the ids first', async () => {
        const { api, seen } = setup(reply({}));
        await api.addMember(44, 5, 3);
        const put = writes(seen)[0];
        expect(put).toMatchObject({ method: 'put', url: 'https://example.invalid/api/groups/44/members/5' });
        expect(JSON.parse(String(put?.data))).toEqual({ groupMemberStatus: 'active', groupTypeRoleId: 3 });
        const none = setup(reply({}));
        await expect(none.api.addMember(44, 5, 0)).rejects.toBeInstanceOf(CtInvalidIdError);
        await expect(none.api.addMember(-1, 5, 3)).rejects.toBeInstanceOf(CtInvalidIdError);
        expect(none.seen).toEqual([]);
    });
});

describe('service-user endpoints', () => {
    const csrf = (s: Seen) => s.url.endsWith('/csrftoken');
    const reply = (data: unknown) => (s: Seen): Reply => (csrf(s) ? { status: 200, data: { data: 'tok' } } : { status: 200, data: { data } });
    const writes = (seen: Seen[]) => seen.filter((s) => !csrf(s));
    const PASSWORD = 'Secret0Password0Value0123456789x';

    it('personMasterdata reads statuses, departments and campuses, keeps ID 0 and prefers the translated name', async () => {
        const { api, seen } = setup(
            reply({
                statuses: [
                    { id: 0, name: 'status.potential', nameTranslated: 'Interessent', securityLevelId: 1 },
                    { id: 3, name: 'status.member', nameTranslated: '' },
                    { id: -1, name: 'bad' },
                    { id: 'x', name: 'bad' },
                ],
                departments: [{ id: 1, name: 'Gemeindeliste', nameTranslated: 'Gemeindeliste' }],
                campuses: [
                    { id: 0, name: 'Winterhude' },
                    { id: 1, name: 'Hafencity' },
                ],
            }),
        );
        expect(await api.personMasterdata()).toEqual({
            statuses: [
                { id: 0, name: 'Interessent' },
                { id: 3, name: 'status.member' },
            ],
            departments: [{ id: 1, name: 'Gemeindeliste' }],
            campuses: [
                { id: 0, name: 'Winterhude' },
                { id: 1, name: 'Hafencity' },
            ],
        });
        expect(seen[0]?.url).toBe('https://example.invalid/api/person/masterdata');
        expect(await setup(reply({})).api.personMasterdata()).toEqual({ statuses: [], departments: [], campuses: [] });
    });

    it('privacyFieldsMandatory reads GET /config (no data wrapper, measured); only false means not mandatory', async () => {
        const answer = (body: unknown) => setup(() => ({ status: 200, data: body })).api.privacyFieldsMandatory();
        expect(await answer({ privacy_policy_fields_mandatory: false, site_url: 'x' })).toBe(false);
        expect(await answer({ privacy_policy_fields_mandatory: true })).toBe(true);
        expect(await answer({})).toBe(true);
        expect(await answer({ privacy_policy_fields_mandatory: 'no' })).toBe(true);
        const { api, seen } = setup(() => ({ status: 200, data: {} }));
        await api.privacyFieldsMandatory();
        expect(seen[0]?.url).toBe('https://example.invalid/api/config');
    });

    it('createPerson posts the person with force (the name is a duplicate on purpose) and returns the id', async () => {
        const { api, seen } = setup(reply({ id: 3040, cmsUserId: 'testmodule-api' }));
        const person = { firstName: 'TestModule', lastName: 'API', cmsUserId: 'testmodule-api', statusId: 0, departmentIds: [1], campusId: 0 };
        expect(await api.createPerson(person)).toBe(3040);
        const post = writes(seen)[0];
        expect(post).toMatchObject({ method: 'post', url: 'https://example.invalid/api/persons?force=true' });
        expect(JSON.parse(String(post?.data))).toEqual(person);
        expect(JSON.stringify(post?.headers)).toContain('tok');
    });

    it('createPerson sends the privacy fields only when given', async () => {
        const { api, seen } = setup(reply({ id: 5 }));
        await api.createPerson({
            firstName: 'TestModule',
            lastName: 'API',
            cmsUserId: 'testmodule-api',
            statusId: 1,
            departmentIds: [1],
            campusId: 0,
            privacy: { typeId: 1, whoId: 2, date: '2026-11-15' },
        });
        expect(JSON.parse(String(writes(seen)[0]?.data))).toMatchObject({
            privacyPolicyAgreementTypeId: 1,
            privacyPolicyAgreementWhoId: 2,
            privacyPolicyAgreementDate: '2026-11-15',
        });
        expect(JSON.parse(String(writes(seen)[0]?.data))).not.toHaveProperty('privacy');
    });

    it('createPerson refuses bad IDs before any request (0 is a valid status and campus, measured)', async () => {
        const { api, seen } = setup(reply({ id: 5 }));
        const base = { firstName: 'TestModule', lastName: 'API', cmsUserId: 'testmodule-api', statusId: 0, departmentIds: [1], campusId: 0 };
        await expect(api.createPerson({ ...base, statusId: -1 })).rejects.toBeInstanceOf(CtInvalidIdError);
        await expect(api.createPerson({ ...base, campusId: 1.5 })).rejects.toBeInstanceOf(CtInvalidIdError);
        await expect(api.createPerson({ ...base, departmentIds: [] })).rejects.toBeInstanceOf(CtInvalidIdError);
        await expect(api.createPerson({ ...base, departmentIds: [Number.NaN] })).rejects.toBeInstanceOf(CtInvalidIdError);
        expect(writes(seen)).toEqual([]);
        await expect(setup(reply({})).api.createPerson(base)).rejects.toThrow('without an id');
    });

    it('createPerson turns the measured 400 into CtValidationError with the fields and their validOptions as numbers', async () => {
        const errors = [
            { fieldId: 'cmsUserId', message: 'Der Benutzername ist bereits vergeben.', messageKey: 'validation.cmsuserid', args: { regex: '/^[a-z0-9_\\-\\.]*$/', name: 'cmsUserId', value: 'testmodule-api' } },
            { fieldId: 'privacyPolicyAgreementTypeId', message: 'x', messageKey: 'validation.db.field.option', args: { validOptions: '1, 2, 3, 4' } },
            { fieldId: 'privacyPolicyAgreementWhoId', message: 'x', messageKey: 'validation.db.field.option', args: { validOptions: [1, 2, 10000] } },
            { fieldId: 'privacyPolicyAgreementDate', message: 'x', messageKey: 'validation.date.invalid', args: { sample: 'Y-m-d' } },
        ];
        const { api } = setup((s) => (csrf(s) ? { status: 200, data: { data: 'tok' } } : { status: 400, data: { message: 'There are validation errors', args: [], errors } }));
        const error = await api
            .createPerson({ firstName: 'TestModule', lastName: 'API', cmsUserId: 'testmodule-api', statusId: 0, departmentIds: [1], campusId: 0 })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CtValidationError);
        expect(error).toBeInstanceOf(CtHttpError);
        expect((error as CtValidationError).status).toBe(400);
        expect((error as CtValidationError).fields).toEqual([
            { fieldId: 'cmsUserId', messageKey: 'validation.cmsuserid', validOptions: [] },
            { fieldId: 'privacyPolicyAgreementTypeId', messageKey: 'validation.db.field.option', validOptions: [1, 2, 3, 4] },
            { fieldId: 'privacyPolicyAgreementWhoId', messageKey: 'validation.db.field.option', validOptions: [1, 2, 10000] },
            { fieldId: 'privacyPolicyAgreementDate', messageKey: 'validation.date.invalid', validOptions: [] },
        ]);
        expect(cmsUserIdTaken(error)).toBe(true);
    });

    it('createPerson maps other errors as usual (403, 500, a 400 without errors)', async () => {
        const failing = (status: number, data: unknown = {}) =>
            setup((s) => (csrf(s) ? { status: 200, data: { data: 'tok' } } : { status, data })).api.createPerson({
                firstName: 'TestModule',
                lastName: 'API',
                cmsUserId: 'testmodule-api',
                statusId: 0,
                departmentIds: [1],
                campusId: 0,
            });
        await expect(failing(403)).rejects.toBeInstanceOf(CtForbiddenError);
        await expect(failing(500)).rejects.toMatchObject({ name: 'CtHttpError', status: 500 });
        const duplicate = await failing(400, { message: 'Duplicate found.', args: { duplicatePersonId: 2841 }, errors: [] }).catch((e: unknown) => e);
        expect(duplicate).toMatchObject({ name: 'CtValidationError', status: 400, fields: [] });
        expect(cmsUserIdTaken(duplicate)).toBe(false);
    });

    it('cmsUserIdTaken is true only for a validation error on the cmsUserId field', () => {
        expect(cmsUserIdTaken(new CtValidationError('x', [{ fieldId: 'cmsUserId', messageKey: 'validation.cmsuserid', validOptions: [] }]))).toBe(true);
        expect(cmsUserIdTaken(new CtValidationError('x', [{ fieldId: 'lastName', messageKey: 'validation.cmsuserid', validOptions: [] }]))).toBe(false);
        expect(cmsUserIdTaken(new CtHttpError(400, 'cmsUserId'))).toBe(false);
        expect(cmsUserIdTaken(null)).toBe(false);
    });

    it('deletePerson deletes by id and checks it first', async () => {
        const { api, seen } = setup(() => ({ status: 204, data: '' }));
        await api.deletePerson(3040);
        expect(writes(seen)[0]).toMatchObject({ method: 'delete', url: 'https://example.invalid/api/persons/3040' });
        const none = setup(reply({}));
        await expect(none.api.deletePerson(0)).rejects.toBeInstanceOf(CtInvalidIdError);
        expect(none.seen).toEqual([]);
    });

    it('personCmsUserId reads the login name of a person; a deleted one is 404', async () => {
        const { api, seen } = setup(reply({ id: 3040, cmsUserId: 'testmodule-api-2' }));
        expect(await api.personCmsUserId(3040)).toBe('testmodule-api-2');
        expect(seen[0]?.url).toBe('https://example.invalid/api/persons/3040');
        expect(await setup(reply({ id: 3040, cmsUserId: null })).api.personCmsUserId(3040)).toBe('');
        await expect(setup(() => ({ status: 404, data: { message: 'Person [3040] not found.' } })).api.personCmsUserId(3040)).rejects.toMatchObject({ status: 404 });
    });

    it('personLogin reads the name and login name of a person; a deleted one is 404', async () => {
        const { api, seen } = setup(reply({ id: 3040, firstName: 'Vera', lastName: 'Victim', cmsUserId: 'vera' }));
        expect(await api.personLogin(3040)).toEqual({ firstName: 'Vera', lastName: 'Victim', cmsUserId: 'vera' });
        expect(seen[0]?.url).toBe('https://example.invalid/api/persons/3040');
        expect(await setup(reply({ id: 3040, firstName: null, cmsUserId: null })).api.personLogin(3040)).toEqual({ firstName: '', lastName: '', cmsUserId: '' });
        await expect(setup(() => ({ status: 404, data: { message: 'Person [3040] not found.' } })).api.personLogin(3040)).rejects.toMatchObject({ status: 404 });
        const none = setup(reply({}));
        await expect(none.api.personLogin(0)).rejects.toBeInstanceOf(CtInvalidIdError);
        expect(none.seen).toEqual([]);
    });

    describe('setPersonPassword', () => {
        const ajax = (answer: (s: Seen) => Reply) => setup((s) => (csrf(s) ? { status: 200, data: { data: 'tok' } } : answer(s)));

        it('posts func, id and password to the churchdb AJAX with the CSRF token, and resolves on status success', async () => {
            const { api, seen } = ajax(() => ({ status: 200, data: { status: 'success', data: null } }));
            await api.setPersonPassword(3040, PASSWORD);
            const post = writes(seen)[0];
            expect(post).toMatchObject({ method: 'post', url: 'https://example.invalid/?q=churchdb/ajax' });
            expect(JSON.parse(String(post?.data))).toEqual({ func: 'setPersonPassword', id: 3040, password: PASSWORD });
            expect(JSON.stringify(post?.headers)).toContain('tok');
            expect(seen.some(csrf)).toBe(true);
        });

        it('throws CtPasswordNotSetError for every other answer', async () => {
            const cases: [string, Reply, Partial<CtPasswordNotSetError>][] = [
                ['status fail (missing right, measured)', { status: 200, data: { status: 'fail', data: 'Keine ausreichende Berechtigung.' } }, { answer: 'fail' }],
                ['status error', { status: 200, data: { status: 'error', data: null } }, { answer: 'error' }],
                ['no status', { status: 200, data: { data: null } }, {}],
                ['HTML', { status: 200, data: '<html>ChurchTools</html>' }, {}],
                ['404 unknown person (measured)', { status: 404, data: { message: 'Person [1] not found.' } }, { httpStatus: 404 }],
                ['401 bad CSRF token (measured)', { status: 401, data: { message: 'CSRF-Token is invalid' } }, { httpStatus: 401 }],
                ['500', { status: 500, data: 'oops' }, { httpStatus: 500 }],
            ];
            for (const [label, answer, expected] of cases) {
                const error = await ajax(() => answer).api.setPersonPassword(3040, PASSWORD).catch((e: unknown) => e);
                expect(error, label).toBeInstanceOf(CtPasswordNotSetError);
                expect(error, label).toMatchObject(expected);
            }
        });

        it('a network error becomes CtPasswordNotSetError too', async () => {
            const client = createClient({ baseUrl: 'https://example.invalid/' });
            const ax = (client as unknown as { ax: { defaults: { adapter: unknown } } }).ax;
            ax.defaults.adapter = async (config: { url: string; data?: unknown }) => {
                if (config.url.endsWith('/csrftoken')) return { status: 200, statusText: '', data: { data: 'tok' }, headers: {}, config, request: {} };
                throw Object.assign(new Error(`Network Error while sending ${String(config.data)}`), { code: 'ERR_NETWORK', config });
            };
            const error = await createCtApi(client, 'testmodule').setPersonPassword(3040, PASSWORD).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(CtPasswordNotSetError);
            expect((error as CtPasswordNotSetError).httpStatus).toBeUndefined();
        });

        it('the password never appears in an error, its message, its properties or its stack', async () => {
            const answers: Reply[] = [
                { status: 200, data: { status: 'fail', data: `refused ${PASSWORD}` } },
                { status: 500, data: { message: `boom ${PASSWORD}` } },
                { status: 200, data: `<html>${PASSWORD}</html>` },
            ];
            for (const answer of answers) {
                const error = await ajax(() => answer).api.setPersonPassword(3040, PASSWORD).catch((e: unknown) => e);
                expect(error).toBeInstanceOf(CtPasswordNotSetError);
                const e = error as Error;
                expect(e.message).not.toContain(PASSWORD);
                expect(String(e.stack)).not.toContain(PASSWORD);
                expect(JSON.stringify(e)).not.toContain(PASSWORD);
                expect(e.cause).toBeUndefined();
            }
        });

        it('checks the id before any request', async () => {
            const { api, seen } = ajax(() => ({ status: 200, data: { status: 'success' } }));
            await expect(api.setPersonPassword(0, PASSWORD)).rejects.toBeInstanceOf(CtInvalidIdError);
            expect(seen).toEqual([]);
        });
    });
});

describe('OAuth clients', () => {
    const CSRF = (s: Seen) => (s.url.endsWith('/csrftoken') ? { status: 200, data: { data: 'tok' } } : undefined);

    it('createOAuthClient posts name, redirectUri and confidential and returns id, identifier and secret', async () => {
        const { api, seen } = setup((s) => CSRF(s) ?? { status: 200, data: { data: { id: 5, identifier: 'abc', clientSecret: 's3cret', name: 'x' } } });
        expect(await api.createOAuthClient('TestModule', 'https://a.example/cb')).toEqual({ id: 5, identifier: 'abc', clientSecret: 's3cret' });
        const post = seen.find((s) => s.method === 'post');
        expect(post?.url).toBe('https://example.invalid/api/oauthclients');
        expect(JSON.parse(String(post?.data))).toEqual({ name: 'TestModule', redirectUri: 'https://a.example/cb', confidential: true });
    });

    it('a list answer is unwrapped', async () => {
        const { api } = setup((s) => CSRF(s) ?? { status: 200, data: { data: [{ id: 5, identifier: 'abc', clientSecret: 's3cret' }] } });
        expect(await api.createOAuthClient('n', 'https://a.example/cb')).toEqual({ id: 5, identifier: 'abc', clientSecret: 's3cret' });
    });

    it.each([
        ['an empty list', []],
        ['two entries', [{ id: 5, identifier: 'a', clientSecret: 's' }, { id: 6, identifier: 'b', clientSecret: 't' }]],
        ['no secret', { id: 5, identifier: 'a' }],
        ['no identifier', { id: 5, clientSecret: 's' }],
        ['a bad id', { id: 'x', identifier: 'a', clientSecret: 's' }],
        ['nothing', null],
    ])('an answer with %s throws without naming the secret', async (_name, data) => {
        const { api } = setup((s) => CSRF(s) ?? { status: 200, data: { data } });
        const error = await api.createOAuthClient('n', 'https://a.example/cb').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(String((error as Error).message) + JSON.stringify(error)).not.toMatch(/"s"|'s'|\bs3cret\b|clientSecret":"/);
    });

    it('deleteOAuthClient deletes by identifier, encoded, and refuses an empty one', async () => {
        const { api, seen } = setup((s) => CSRF(s) ?? { status: 204 });
        await api.deleteOAuthClient('a/b c');
        const del = seen.find((s) => s.method === 'delete');
        expect(del?.url).toBe('https://example.invalid/api/oauthclients/a%2Fb%20c');
        await expect(api.deleteOAuthClient('')).rejects.toBeInstanceOf(CtInvalidIdError);
    });

    it('oauthClientNumericId finds the numeric id of an identifier in GET /oauthclients, without keeping any secret', async () => {
        const { api, seen } = setup(() => ({ status: 200, data: { data: [{ id: 3, identifier: 'other', clientSecret: 'x1' }, { id: 7, identifier: 'mine', clientSecret: 'x2' }, { id: 'bad', identifier: 'odd' }] } }));
        expect(await api.oauthClientNumericId('mine')).toBe(7);
        expect(seen[0]?.method).toBe('get');
        expect(seen[0]?.url).toBe('https://example.invalid/api/oauthclients');
        expect(await api.oauthClientNumericId('missing')).toBeNull();
        // An entry without a usable id is not found.
        expect(await api.oauthClientNumericId('odd')).toBeNull();
        await expect(api.oauthClientNumericId('')).rejects.toBeInstanceOf(CtInvalidIdError);
    });

    it('oauthClientNumericId: two entries with the identifier are an error (no guessing)', async () => {
        const { api } = setup(() => ({ status: 200, data: { data: [{ id: 3, identifier: 'mine' }, { id: 7, identifier: 'mine' }] } }));
        await expect(api.oauthClientNumericId('mine')).rejects.toThrow('more than one');
    });

    it('deleteGroup deletes by id and refuses a bad id before any request', async () => {
        const { api, seen } = setup((s) => CSRF(s) ?? { status: 204 });
        await api.deleteGroup(44);
        const del = seen.find((s) => s.method === 'delete');
        expect(del?.url).toBe('https://example.invalid/api/groups/44');
        const before = seen.length;
        await expect(api.deleteGroup(0)).rejects.toBeInstanceOf(CtInvalidIdError);
        expect(seen.length).toBe(before);
    });
});

