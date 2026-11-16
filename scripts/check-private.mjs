#!/usr/bin/env node
// Privacy and secrets check for commits (run by .githooks/pre-commit; docs: CONTRIBUTING.md, "Pre-commit check").
//
//   node scripts/check-private.mjs [--staged]     lines added in the staged diff (default)
//   node scripts/check-private.mjs --range A..B   lines added by every commit in the range (merges: their own lines)
//   node scripts/check-private.mjs --all          every line of every tracked file
//
// Forbidden values come from a local block list only, and are NEVER printed (not even in error messages). The list is
// the file named by $CT_PRIVATE_TERMS if set, else ../ct-pass-store/.private-terms (relative to the repository root),
// else the repository's own .private-terms (gitignored; see .private-terms.example).
// A hit prints "<file>:<line>: matches <source> entry #<n>" and the exit code is 1. No hit: exit 0, no output.
// Exit code 2: usage or git error.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Harmless words that coincide with terms. A match that lies entirely
// inside one of these words is not a hit.
const ALLOWLIST = ['churchtools'];
const SEPARATORS = '[\\s._-]';

class UsageError extends Error {}

function usage(message) {
  throw new UsageError(message);
}

function parseArgs(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--staged')) return { mode: 'staged' };
  if (argv.length === 1 && argv[0] === '--all') return { mode: 'all' };
  if (argv.length === 2 && argv[0] === '--range' && argv[1] && !argv[1].startsWith('-')) {
    return { mode: 'range', range: argv[1] };
  }
  if (argv.length === 1 && argv[0].startsWith('--range=') && argv[0].length > 8 && argv[0][8] !== '-') {
    return { mode: 'range', range: argv[0].slice(8) };
  }
  return usage('usage: check-private.mjs [--staged | --range <A..B> | --all]');
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    let i = 0;
    while (args[i] === '-c') i += 2; // name the subcommand, not the leading "-c key=value" options
    return usage(`check-private: git ${args[i]} failed`);
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------------------------------------------
// Sources

// A block-list term: any run of separators (space, dot, hyphen, underscore) inside it matches any run of separators
// or none, so "ab cd" matches "ab-cd", "AB_CD", "ab.cd" and "abcd".
function termPattern(term) {
  const parts = term.split(new RegExp(`${SEPARATORS}+`)).filter(Boolean);
  return parts.map(escapeRegExp).join(`${SEPARATORS}*`);
}

// Glob on the repo-relative path, anchored at the root: "*" and "?" stay within one path segment, "**" crosses them.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else {
        re += '.*';
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += escapeRegExp(c);
  }
  return new RegExp(`^${re}$`);
}

function readBlockList(file, entries) {
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((raw, i) => {
    let line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let allow = [];
    const exception = /\s*##\s*allow:(.*)$/i.exec(line);
    if (exception) {
      allow = exception[1]
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map(globToRegExp);
      line = line.slice(0, exception.index).trim();
    }
    const pattern = termPattern(line);
    if (pattern) entries.push({ source: 'block list', n: i + 1, pattern, allow, value: line });
  });
  return true;
}

function termsFile(root) {
  const fromEnv = process.env.CT_PRIVATE_TERMS;
  if (fromEnv) return resolve(fromEnv);
  const sibling = resolve(root, '..', 'ct-pass-store', '.private-terms');
  return existsSync(sibling) ? sibling : join(root, '.private-terms');
}

function loadEntries(root) {
  const entries = [];
  const notes = [];
  if (!readBlockList(termsFile(root), entries)) {
    notes.push('check-private: hint: no block list found; set CT_PRIVATE_TERMS or copy .private-terms.example to .private-terms');
  }

  // Duplicate terms are reported once, under the first entry.
  const seen = new Set();
  const unique = [];
  for (const e of entries) {
    const key = e.pattern.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    e.regex = new RegExp(e.pattern, 'giu');
    delete e.value;
    unique.push(e);
  }
  return { entries: unique, notes };
}

// ---------------------------------------------------------------------------------------------------------------
// Matching

const allowRegex = new RegExp(ALLOWLIST.map(escapeRegExp).join('|'), 'giu');

function allowedSpans(text) {
  const spans = [];
  for (const m of text.matchAll(allowRegex)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

function hits(entry, text, spans) {
  entry.regex.lastIndex = 0;
  for (let i = 0; i <= text.length; ) {
    entry.regex.lastIndex = i;
    const m = entry.regex.exec(text);
    if (!m) return false;
    const end = m.index + m[0].length;
    if (!spans.some(([a, b]) => a <= m.index && end <= b)) return true;
    i = m.index + 1;
  }
  return false;
}

function checker(entries, report) {
  const pathHit = new Map();
  return {
    line(file, lineNo, text, suffix) {
      const spans = allowedSpans(text);
      for (const e of entries) {
        if (e.allow.some((g) => g.test(file))) continue;
        if (hits(e, text, spans)) {
          report(`${file}:${lineNo}: matches ${e.source} entry #${e.n}${suffix}`);
        }
      }
    },
    path(file, suffix) {
      const spans = allowedSpans(file);
      for (const e of entries) {
        if (e.allow.some((g) => g.test(file))) continue;
        const key = `${e.source}#${e.n}${suffix}`;
        if (hits(e, file, spans) && !pathHit.has(`${file}\0${key}`)) {
          pathHit.set(`${file}\0${key}`, true);
          report(`(path withheld): file path matches ${e.source} entry #${e.n}${suffix}`);
        }
      }
    },
  };
}

// Git quotes unusual paths ("a\tb"); undo the C-style quoting.
function unquotePath(p) {
  if (!p.startsWith('"')) return p;
  const bytes = [];
  const s = p.slice(1, -1);
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') {
      bytes.push(...Buffer.from(s[i]));
      continue;
    }
    const c = s[++i];
    if (/[0-7]/.test(c)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push({ n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 }[c] ?? c.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

const COMMIT_MARK = '\u0001commit ';

// The path of a "diff --git a/<p> b/<p>" header (the same path twice under --no-renames, quoted alike), or of a
// "diff --cc <p>" header. Empty and binary files have no "+++" line, so their path comes only from here.
function headerPath(line) {
  const combined = /^diff --(?:cc|combined) (.*)$/.exec(line);
  if (combined) return unquotePath(combined[1]);
  const rest = line.slice('diff --git '.length);
  const half = (rest.length - 1) / 2;
  return Number.isInteger(half) ? unquotePath(rest.slice(half + 1)).replace(/^b\//, '') : null;
}

// Walks a unified diff (-U0) and checks every added line; "commit" markers come from `git log --format`.
// A merge commit comes as a combined diff (--cc): one prefix column per parent, "@@@" hunks for two parents. Only
// lines added against every parent ("++") are the merge's own; the others come from a parent and are checked there.
// The path of each file is checked once per file and commit, from its header, unless the file is deleted.
function checkDiff(diff, check) {
  let file = null;
  let lineNo = 0;
  let inHunk = false;
  let parents = 1;
  let suffix = '';
  let pendingPath = null; // header path, checked before the file's first line or at the next file
  const flushPath = () => {
    if (pendingPath !== null) check.path(pendingPath, suffix);
    pendingPath = null;
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith(COMMIT_MARK)) {
      flushPath();
      suffix = ` (commit ${line.slice(COMMIT_MARK.length).trim()})`;
      inHunk = false;
      file = null;
    } else if (/^diff --(?:git|cc|combined) /.test(line)) {
      flushPath();
      inHunk = false;
      file = null;
      pendingPath = headerPath(line); // null for an unexpected header: the "+++" line then gives the path
    } else if (!inHunk && line.startsWith('deleted file mode ')) {
      pendingPath = null; // removing a path is fine
    } else if (!inHunk && line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/\t$/, '');
      file = p === '/dev/null' ? null : unquotePath(p).replace(/^b\//, '');
      if (pendingPath === null && file) check.path(file, suffix);
      flushPath();
    } else if (/^@@+ /.test(line)) {
      flushPath();
      const m = /^(@@+) (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? \1/.exec(line);
      parents = m ? m[1].length - 1 : 1;
      lineNo = m ? Number(m[2]) : 0;
      inHunk = true;
    } else if (inHunk) {
      const columns = line.slice(0, parents);
      if (columns.length < parents || /[^ +-]/.test(columns) || columns.includes('-')) continue; // removed, or "\ No newline"
      if (file && columns === '+'.repeat(parents)) check.line(file, lineNo, line.slice(parents), suffix);
      lineNo++;
    }
  }
  flushPath();
}

const DIFF_OPTS = ['-c', 'core.quotePath=true', '-c', 'diff.noprefix=false'];
const DIFF_FLAGS = ['-U0', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'];

function checkAll(root, check) {
  const files = git(['ls-files', '-z'], root).split('\0').filter(Boolean);
  for (const file of files) {
    check.path(file, '');
    const full = join(root, file);
    let buf;
    try {
      if (!lstatSync(full).isFile()) continue;
      buf = readFileSync(full);
    } catch {
      continue;
    }
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    buf
      .toString('utf8')
      .split(/\r?\n/)
      .forEach((text, i) => check.line(file, i + 1, text, ''));
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  const { entries, notes } = loadEntries(root);
  for (const note of notes) process.stderr.write(`${note}\n`);
  const out = [];
  const check = checker(entries, (msg) => out.push(msg));

  if (opts.mode === 'range') {
    // Validate the range first: a bad revision must not look like "no hits".
    git(['rev-list', '--quiet', opts.range, '--'], root);
  }
  if (entries.length > 0) {
    if (opts.mode === 'staged') {
      checkDiff(git([...DIFF_OPTS, 'diff', '--cached', ...DIFF_FLAGS], root), check);
    } else if (opts.mode === 'range') {
      const log = git(
        [...DIFF_OPTS, 'log', '--reverse', '-p', '--cc', ...DIFF_FLAGS, `--format=${COMMIT_MARK}%h`, opts.range, '--'],
        root,
      );
      checkDiff(log, check);
    } else {
      checkAll(root, check);
    }
  }

  if (out.length > 0) {
    process.stdout.write(out.join('\n') + '\n');
    return 1;
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  // Never print an error message as such: it may quote a value.
  process.stderr.write(err instanceof UsageError ? `${err.message}\n` : `check-private: internal error (${err?.name})\n`);
  process.exitCode = 2;
}
