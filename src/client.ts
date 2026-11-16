import * as churchtools from '@churchtools/churchtools-client';
import type { ChurchToolsClient as ChurchToolsClientType } from '@churchtools/churchtools-client';

type ChurchToolsClient = ChurchToolsClientType;

// The client package is CommonJS. Bundlers expose its exports by name; Node's ESM loader finds none by name (its
// export list isn't statically detectable) and only offers `module.exports` as `default`. Take whichever is there.
const ChurchToolsClient: typeof ChurchToolsClientType =
    (churchtools as { ChurchToolsClient?: typeof ChurchToolsClientType }).ChurchToolsClient ??
    (churchtools as unknown as { default: { ChurchToolsClient: typeof ChurchToolsClientType } }).default.ChurchToolsClient;

const MIN_RETRY_MS = 60_000;

/** No `baseUrl` was given and there is no browser to derive one from. */
export class MissingBaseUrlError extends Error {
    constructor() {
        super('No ChurchTools base URL: pass baseUrl outside a browser');
        this.name = 'MissingBaseUrlError';
    }
}

/**
 * The ChurchTools base URL (browser only): `window.settings.base_url` inside ChurchTools, the page origin otherwise (then the dev
 * proxy forwards `/api`). No instance URL is ever part of the bundle.
 */
export function instanceBaseUrl(): string {
    if (typeof window === 'undefined') throw new MissingBaseUrlError();
    const settings = (window as { settings?: { base_url?: string } }).settings;
    return settings?.base_url || window.location.origin;
}

function header(headers: unknown, name: string): string | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    const withGet = headers as { get?: (n: string) => unknown };
    if (typeof withGet.get === 'function') {
        const v = withGet.get(name);
        if (typeof v === 'string') return v;
    }
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === name && typeof value === 'string') return value;
    }
    return undefined;
}

/**
 * How long to wait after a `429`. `Retry-After` may be seconds or an HTTP date, and ChurchTools doesn't necessarily
 * send it. Never below 60 s, the minimum ChurchTools advises (spec ct-extension-info.md, section 7).
 */
export function retryAfterMs(response: { headers?: unknown }, now: number = Date.now()): number {
    const raw = header(response.headers, 'retry-after')?.trim();
    if (!raw) return MIN_RETRY_MS;
    let ms: number;
    if (/^\d+$/.test(raw)) ms = Number(raw) * 1000;
    else {
        const at = Date.parse(raw);
        ms = Number.isNaN(at) ? 0 : at - now;
    }
    return Math.max(MIN_RETRY_MS, ms);
}

/**
 * The one ChurchTools client of the app (browser or Node). Paths passed to it start with `/` and omit `/api` (the client builds
 * `${baseUrl}/api${path}` and strips a trailing slash from the base URL).
 *
 * CSRF: `setLoadCSRFForAPI()` (client >= 1.7.1) makes every REST write fetch `GET /csrftoken` once and send it as
 * `CSRF-Token`. ChurchTools doesn't require it for REST writes yet, but may; sending it is harmless, so it is on.
 *
 * Options: `baseUrl` (browser default: `instanceBaseUrl()`; required outside a browser, else `MissingBaseUrlError`),
 * `loginToken` (sent as `Authorization: Login <token>`, as ct-radius does, without the client's own 401 re-login),
 * `timeoutMs` (per-request timeout). A rejected request never carries the login token: an interceptor removes
 * `Authorization` from the error's config and request headers before rethrowing.
 */
export interface ClientOptions {
    baseUrl?: string;
    loginToken?: string;
    timeoutMs?: number;
}

/** The client's axios instance: `ax` is `private` in its typings but public at runtime (ct-radius uses it the same way). */
interface AxLike {
    defaults: { headers: { common: Record<string, unknown> }; timeout?: number };
    interceptors: { response: { use(onFulfilled?: undefined, onRejected?: (error: unknown) => unknown): number } };
}

type HeaderBag = Record<string, unknown> & { delete?: (name: string) => unknown };

function stripAuthorization(headers: unknown): void {
    if (!headers || typeof headers !== 'object') return;
    const bag = headers as HeaderBag;
    if (typeof bag.delete === 'function') bag.delete('Authorization');
    for (const key of Object.keys(bag)) {
        if (key.toLowerCase() === 'authorization') delete bag[key];
    }
    // axios keeps per-method and common defaults in nested objects
    for (const nested of ['common', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
        const inner = bag[nested];
        if (inner && typeof inner === 'object') stripAuthorization(inner);
    }
}

export function createClient(options: ClientOptions = {}): ChurchToolsClient {
    const client = new ChurchToolsClient();
    const ax = (client as unknown as { ax: AxLike }).ax;
    client.setBaseUrl(options.baseUrl ?? instanceBaseUrl());
    client.setLoadCSRFForAPI();
    // `X-OnlyAuthenticated: 1`: an expired session answers 401 instead of serving anonymous (empty) data.
    client.setNeedsAuthentication(true);
    if (options.loginToken !== undefined) {
        ax.defaults.headers.common['Authorization'] = 'Login ' + options.loginToken;
        ax.interceptors.response.use(undefined, (error: unknown) => {
            const e = error as { config?: { headers?: unknown }; request?: { headers?: unknown }; response?: { config?: { headers?: unknown }; request?: { headers?: unknown } } };
            stripAuthorization(e?.config?.headers);
            stripAuthorization(e?.request?.headers);
            stripAuthorization(e?.response?.config?.headers);
            stripAuthorization(e?.response?.request?.headers);
            return Promise.reject(error);
        });
    }
    if (options.timeoutMs !== undefined) {
        client.setRequestTimeout(options.timeoutMs); // the client's abort signal (what its requests actually use)
        ax.defaults.timeout = options.timeoutMs; // axios' own timeout, same value
    }
    return client;
}
