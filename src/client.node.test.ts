// @vitest-environment node
import { inspect } from 'node:util';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AxiosRequestConfig } from 'axios';
import type { AxiosInstance } from 'axios';
import { createClient, MissingBaseUrlError } from './client';
import { containsDeep } from './test-helpers';

/** `ax` is `private` in the client's typings but public at runtime. */
const ax = (client: unknown): AxiosInstance => (client as { ax: AxiosInstance }).ax;

const BASE = 'https://x.example';
const TOKEN = 'tok-dummy-value';

describe('Node', () => {
    it('without baseUrl outside a browser it throws MissingBaseUrlError', () => {
        expect(() => createClient()).toThrow(MissingBaseUrlError);
        expect(() => createClient()).toThrow(expect.objectContaining({ name: 'MissingBaseUrlError' }));
    });

    it('loginToken sets Authorization: Login <token>', () => {
        const client = createClient({ baseUrl: BASE, loginToken: 'tok' });
        expect(ax(client).defaults.headers.common.Authorization).toBe('Login tok');
    });

    it('without a loginToken no Authorization header is set', () => {
        const client = createClient({ baseUrl: BASE });
        expect(ax(client).defaults.headers.common.Authorization).toBeUndefined();
    });

    it('timeoutMs sets the request timeout', () => {
        const client = createClient({ baseUrl: BASE, timeoutMs: 5000 });
        expect(ax(client).defaults.timeout).toBe(5000);
    });

    it('timeoutMs also reaches the client abort signal timeout', () => {
        const client = createClient({ baseUrl: BASE, timeoutMs: 5000 });
        expect((client as unknown as { requestTimeout: number }).requestTimeout).toBe(5000);
    });

    it('CSRF and X-OnlyAuthenticated stay on with a login token', async () => {
        const client = createClient({ baseUrl: BASE, loginToken: 'tok' });
        expect((client as unknown as { loadCSRFForApi: boolean }).loadCSRFForApi).toBe(true);
        let sent: Record<string, unknown> = {};
        ax(client).defaults.adapter = (async (config: AxiosRequestConfig) => {
            sent = { ...(config.headers as Record<string, unknown>) };
            return { status: 200, statusText: 'OK', data: {}, headers: {}, config };
        }) as never;
        await client.get('/whoami');
        expect(sent['X-OnlyAuthenticated']).toBe('1');
        expect(sent['Authorization']).toBe('Login tok');
    });

    it('an error from a request with a login token does not contain the token', async () => {
        const answers: Array<(config: AxiosRequestConfig) => Promise<never>> = [];
        const reject = (status: number) => async (config: AxiosRequestConfig): Promise<never> => {
            const response = { status, statusText: 'x', data: {}, headers: {}, config, request: { headers: config.headers } };
            throw Object.assign(new Error(`Request failed with status code ${status}`), {
                isAxiosError: true,
                config,
                request: { headers: config.headers, getHeader: () => `Login ${TOKEN}` },
                response,
            });
        };
        answers.push(reject(401), reject(403), reject(500), async (config) => {
            throw Object.assign(new Error('Network Error'), { isAxiosError: true, config, request: { headers: config.headers } });
        });
        for (const answer of answers) {
            const client = createClient({ baseUrl: BASE, loginToken: TOKEN });
            ax(client).defaults.adapter = answer as never;
            const err = await client.get('/whoami').then(
                () => new Error('expected a rejection'),
                (e: unknown) => e as Error,
            );
            expect(err.message).not.toBe('expected a rejection');
            expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(TOKEN);
            expect(String(err)).not.toContain(TOKEN);
            // JSON.stringify with a name list only filters nested keys too, so also walk the whole graph
            expect(containsDeep(err, TOKEN)).toBe(false);
            expect(inspect(err, { depth: null, showHidden: true })).not.toContain(TOKEN);
        }
    });

    it('stripping the token from an error does not remove it from later requests', async () => {
        const client = createClient({ baseUrl: BASE, loginToken: 'tok' });
        const sent: unknown[] = [];
        let fail = true;
        ax(client).defaults.adapter = (async (config: AxiosRequestConfig) => {
            sent.push((config.headers as { Authorization?: string }).Authorization);
            if (fail) throw Object.assign(new Error('Network Error'), { isAxiosError: true, config });
            return { status: 200, statusText: 'OK', data: {}, headers: {}, config };
        }) as never;
        await client.get('/whoami').catch(() => undefined);
        fail = false;
        await client.get('/whoami');
        expect(sent).toEqual(['Login tok', 'Login tok']);
    });

    describe('with the real Node http adapter', () => {
        let server: Server;
        let port = 0;
        beforeAll(async () => {
            server = createServer((req, res) => {
                const status = Number((req.url ?? '').match(/\/api\/status\/(\d+)/)?.[1] ?? 500);
                res.statusCode = status;
                res.setHeader('content-type', 'application/json');
                res.end('{}');
            });
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            port = (server.address() as AddressInfo).port;
        });
        afterAll(async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        });

        async function freePort(): Promise<number> {
            const probe = createServer();
            await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
            const free = (probe.address() as AddressInfo).port;
            await new Promise<void>((resolve) => probe.close(() => resolve()));
            return free;
        }

        it.each([401, 403, 500, 'refused'] as const)('an error (%s) does not contain the token anywhere', async (kind) => {
            const target = kind === 'refused' ? await freePort() : port;
            const client = createClient({ baseUrl: `http://127.0.0.1:${target}`, loginToken: TOKEN });
            const err = await client.get(`/status/${kind}`).then(
                () => new Error('expected a rejection'),
                (e: unknown) => e as Error,
            );
            expect(err.message).not.toBe('expected a rejection');
            expect(containsDeep(err, TOKEN)).toBe(false);
            expect(inspect(err, { depth: null, showHidden: true })).not.toContain(TOKEN);
            expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(TOKEN);
        });
    });
});
