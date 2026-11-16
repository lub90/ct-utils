// @vitest-environment node
import { inspect } from 'node:util';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCtApi } from './api';
import { createClient } from './client';
import { containsDeep } from './test-helpers';

const TOKEN = 'tok-dummy-value';

describe('createCtApi with the real Node http adapter', () => {
    let server: Server;
    let port = 0;
    beforeAll(async () => {
        server = createServer((req, res) => {
            res.statusCode = Number(req.headers['x-test-status'] ?? 500);
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

    it.each([401, 403, 500, 'refused'] as const)(
        'a mapped error from a request with a login token does not contain the token (%s)',
        async (kind) => {
            const target = kind === 'refused' ? await freePort() : port;
            const client = createClient({ baseUrl: `http://127.0.0.1:${target}`, loginToken: TOKEN });
            // make the server answer with the wanted status
            (client as unknown as { ax: { defaults: { headers: { common: Record<string, string> } } } }).ax.defaults.headers.common['X-Test-Status'] = String(kind);
            const err = await createCtApi(client, 'testmodule')
                .whoami()
                .then(
                    () => new Error('expected a rejection'),
                    (e: unknown) => e as Error,
                );
            expect(err.message).not.toBe('expected a rejection');
            expect(containsDeep(err, TOKEN)).toBe(false);
            expect(inspect(err, { depth: null, showHidden: true })).not.toContain(TOKEN);
            expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(TOKEN);
        },
    );
});
