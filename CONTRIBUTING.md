# Contributing

## Setup

```sh
npm ci
git config core.hooksPath .githooks   # runs the privacy check before every commit
npm run check                         # lint, typecheck, tests, privacy-check tests
```

Node 24 is what CI uses.

## Pre-commit check

`.githooks/pre-commit` runs `scripts/check-private.mjs --staged` (and gitleaks, if it is on your PATH). The check
refuses a commit that adds a line or a file path containing a term from a local block list, and never prints the
term. The list is the file named by `$CT_PRIVATE_TERMS`, else `../ct-pass-store/.private-terms`, else this
repository's own `.private-terms` (gitignored; format: `.private-terms.example`). Other modes: `--range A..B`,
`--all`. Emergency bypass, rare and deliberate: `git commit --no-verify`.

## Working on the library together with a consumer

While shaping a change, point the consumer at your local checkout, and never commit that:

```sh
# in ct-utils
npm link
# in the consumer
npm link ct-utils
# or, without linking:
npm install ../ct-utils
```

`npm run build` in `ct-utils` after each change (the consumer reads `dist/`). Before committing in the consumer,
restore its `package.json` and lockfile (`git checkout package.json package-lock.json`) so no local path is committed.
A release is tagged before a consumer's `package.json` points at it.

## Versioning and the non-breaking rule

- Semantic versions, starting at `0.1.0`. In `0.x` a minor bump (`0.2.0`) is breaking and a patch (`0.1.1`) isn't;
  this matches npm's caret range for `0.x`. `1.0.0` once ct-radius uses the libraries in production.
- **Non-breaking** means: no export removed or renamed; no required parameter, prop or event payload field added; no
  behavior change for existing inputs. New things are added beside the old ones.
- **Generic** means: no consumer name, no consumer-specific default, no consumer config import. Texts come from the
  caller (no i18n inside the library).
- Consumers depend on an exact tag (`#v0.1.0`), never on a branch. Their `package-lock.json` records the commit.

## Releases

1. Update `CHANGELOG.md`: a section `## X.Y.Z (date)` with Added / Changed / Fixed / Removed, breaking changes marked.
2. Update `version` in `package.json`.
3. Merge to `main` and wait for green CI.
4. Ask the maintainer before tagging or pushing. Then tag `vX.Y.Z` on `main` and push the tag.
5. Tags are never moved or deleted. A mistake is fixed by the next patch version.
