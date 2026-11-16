/**
 * Every module under `src/fake/` (the `ct-utils/fake` entry) carries `FAKE_MARKER` in its code (not in a comment), so that a consumer's
 * dist check notices the fake in a production build. Each module is bundled and minified on its own, with only its
 * main export used, and the marker must survive. The build goes to a temporary directory, never into the repository.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';
import { FAKE_MARKER } from './index.js';

const DIR = import.meta.dirname;

/** The main export of each fake module: what a leaked import would pull into a bundle. */
const MAIN_EXPORT: Record<string, string> = {
    'marker.ts': 'tagFake',
    'fake-churchtools.ts': 'createFakeChurchTools',
};
/** Modules of the fake entry that are not fake code themselves: the entry, which only re-exports. */
const NOT_FAKE = ['index.ts'];

/** Bundles `export default <name>` of the module, minified, and returns the code. */
async function bundle(file: string, name: string): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-utils-fake-marker-'));
    try {
        const entry = path.join(dir, 'entry.ts');
        fs.writeFileSync(entry, `import { ${name} } from ${JSON.stringify(path.join(DIR, file))};\nexport default ${name};\n`);
        const result = await build({
            configFile: false,
            logLevel: 'silent',
            root: dir,
            build: {
                write: false,
                outDir: path.join(dir, 'dist'),
                minify: true,
                // Not lib mode: an app build, which drops comments, so only code can carry the marker.
                rollupOptions: {
                    input: entry,
                    preserveEntrySignatures: 'exports-only',
                    external: (id) => /^@churchtools(\/|$)/.test(id),
                },
            },
        });
        const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
        return outputs
            .flatMap((o) => o.output)
            .map((chunk) => (chunk.type === 'chunk' ? chunk.code : ''))
            .join('\n');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('fake marker in src/fake', () => {
    it('is the documented string', () => {
        expect(FAKE_MARKER).toBe('__CT_UTILS_FAKE__');
    });

    /** Every file below src/fake (any depth, any kind) except tests. */
    const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.relative(DIR, path.join(dir, e.name))]));
    const modules = walk(DIR).filter((f) => !/\.test\.[jt]s$/.test(f));

    it('knows every module of the fake entry', () => {
        expect(modules.sort()).toEqual([...Object.keys(MAIN_EXPORT), ...NOT_FAKE].sort());
    });

    for (const [file, name] of Object.entries(MAIN_EXPORT)) {
        it(`${file}: the marker survives a minified build of ${name}`, async () => {
            const code = await bundle(file, name);
            expect(code).toContain('__CT_UTILS_FAKE__');
        }, 30_000);
    }
});
