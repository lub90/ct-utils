// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
        // Test files may use the testing entry (they are not part of the build); only shipped sources are checked.
        const files = sourceFiles(join(ROOT, 'src'), (p) => p === testingDir || p.endsWith('.test.ts'));
        expect(files.length).toBeGreaterThan(0);
        // Import and export specifiers only: `from '...testing...'`, `import('...testing...')`, `import '...testing...'`.
        const specifier = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"][^'"]*testing[^'"]*['"]/;
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
});

