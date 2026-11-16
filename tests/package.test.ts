// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

function sourceFiles(dir: string, skip: (path: string) => boolean = () => false): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (skip(path)) continue;
        if (entry.isDirectory()) files.push(...sourceFiles(path, skip));
        else if (entry.name.endsWith('.ts')) files.push(path);
    }
    return files;
}

/** Every built file reachable from `entry` through relative import/export specifiers, and the bare specifiers they use. */
function reachable(entry: string): { files: string[]; bare: string[] } {
    const files = new Set<string>();
    const bare = new Set<string>();
    const queue = [entry];
    while (queue.length) {
        const file = queue.pop()!;
        if (files.has(file)) continue;
        files.add(file);
        const code = readFileSync(file, 'utf8');
        for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
            const spec = m[1]!;
            if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec));
            else bare.add(spec);
        }
    }
    return { files: [...files], bare: [...bare] };
}

describe('package', () => {
    it('the built entry loads in Node without a window', () => {
        execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
        // execFileSync throws on a non-zero exit.
        const out = execFileSync(
            'node',
            ['-e', "import('./dist/index.js').then(m => console.log(Object.keys(m).length))"],
            { cwd: ROOT, encoding: 'utf8' },
        );
        expect(out.trim()).toMatch(/^\d+$/);
    }, 60_000);

    it('the main entry does not import the testing entry', () => {
        const testingDir = join(ROOT, 'src', 'testing');
        const fakeDir = join(ROOT, 'src', 'fake');
        // Test files may use the testing entry (they are not part of the build); only shipped sources are checked.
        const files = sourceFiles(join(ROOT, 'src'), (p) => p === testingDir || p === fakeDir || p.endsWith('.test.ts'));
        expect(files.length).toBeGreaterThan(0);
        // Import and export specifiers only: `from '...testing...'`, `import('...testing...')`, `import '...testing...'`.
        const specifier = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"][^'"]*(?:testing|fake)[^'"]*['"]/;
        for (const file of files) {
            expect(readFileSync(file, 'utf8'), file).not.toMatch(specifier);
        }
    });

    it('nothing names a consumer', () => {
        const files = sourceFiles(join(ROOT, 'src'));
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            const text = readFileSync(file, 'utf8');
            expect(text, file).not.toMatch(/cps|CtPassStore|ctpassstore/i);
            expect(text, file).not.toContain('EXTENSION_KEY');
        }
    });

    it('the testing entry\u2019s vitest import is an optional peer dependency', () => {
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
        const testing = sourceFiles(join(ROOT, 'src', 'testing'), (p) => p.endsWith('.test.ts'));
        // The shipped contract cases import vitest: a consumer of ./testing needs it, a consumer of . does not.
        expect(testing.some((f) => /from\s*['"]vitest['"]/.test(readFileSync(f, 'utf8')))).toBe(true);
        expect(pkg.peerDependencies.vitest).toBe('>=5.1.0');
        expect(pkg.peerDependenciesMeta).toEqual({ vitest: { optional: true } });
        // The client stays a required peer.
        expect(pkg.peerDependencies['@churchtools/churchtools-client']).toBe('>=1.7.1');
    });

    describe('the fake entry (ct-utils/fake, for dev and demo code)', () => {
        it('is exported with types and import conditions', () => {
            const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
            expect(pkg.exports['./fake']).toEqual({ types: './dist/fake/index.d.ts', import: './dist/fake/index.js' });
        });

        it('exports exactly createFakeChurchTools and FAKE_MARKER (and the type FakeCtSeed), and so does ./testing', () => {
            execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
            const keys = (entry: string) =>
                execFileSync('node', ['-e', `import('./dist/${entry}').then(m => console.log(Object.keys(m).sort().join(',')))`], { cwd: ROOT, encoding: 'utf8' }).trim();
            expect(keys('fake/index.js')).toBe('FAKE_MARKER,createFakeChurchTools');
            expect(keys('testing/index.js').split(',')).toEqual(expect.arrayContaining(['FAKE_MARKER', 'createFakeChurchTools', 'defineCtContract']));
            const types = readFileSync(join(ROOT, 'dist', 'fake', 'index.d.ts'), 'utf8');
            expect(types).toMatch(/\bFakeCtSeed\b/);
        }, 60_000);

        it('no built file reachable from it imports vitest (or anything but the client package)', () => {
            execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
            const { files, bare } = reachable(join(ROOT, 'dist', 'fake', 'index.js'));
            expect(files.length).toBeGreaterThan(1);
            // Specifiers, not text: the entry's comment may name vitest. Only the client package may be imported bare.
            expect(bare).not.toContain('vitest');
            expect(bare.filter((b) => !b.startsWith('@churchtools/'))).toEqual([]);
            for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/['"]vitest(\/[^'"]*)?['"]/);
        }, 60_000);

        it('loads in plain Node without vitest (a copy of dist with no node_modules at all)', () => {
            execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
            const dir = mkdtempSync(join(tmpdir(), 'ct-utils-fake-entry-'));
            try {
                cpSync(join(ROOT, 'dist'), join(dir, 'dist'), { recursive: true });
                writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
                expect(existsSync(join(dir, 'node_modules'))).toBe(false);
                const load = (entry: string) =>
                    spawnSync('node', ['-e', `import('./dist/${entry}').then(m => { const f = m.createFakeChurchTools; console.log(typeof f, m.FAKE_MARKER); })`], { cwd: dir, encoding: 'utf8' });
                const fake = load('fake/index.js');
                expect(fake.stderr).toBe('');
                expect(fake.stdout.trim()).toBe('function __CT_UTILS_FAKE__');
                // Control: the same copy cannot load ./testing, so vitest really is absent there.
                const testing = load('testing/index.js');
                expect(testing.status).not.toBe(0);
                expect(testing.stderr).toMatch(/Cannot find package 'vitest'/);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        }, 60_000);
    });
});

