# ct-utils

Framework-free helpers for ChurchTools extensions: ChurchTools API access and the extension KV store, written to run
in the browser and in Node.

## Boundary

- This library holds framework-free ChurchTools and KV code for browser and Node. It has no UI and no Vue.
- Vue code (components, composables, styles) belongs in the sibling library `ct-extension-utils`.
- Neither library depends on the other. An extension uses either or both.
- Nothing here names a consumer: no consumer name, no consumer-specific default, no consumer config import. Texts come
  from the caller.

## Install

Depend on an exact tag, never on a branch:

```sh
npm install github:lub90/ct-utils#v0.1.0
```

`@churchtools/churchtools-client` (>= 1.7.1) is a peer dependency; install it in your project. `ct-utils/testing`
also needs `vitest` (>= 5.1.0, an optional peer dependency: the contract cases import it). npm builds the package when
it installs it from Git (`prepare`).

## Entries

| Import | Contents |
| --- | --- |
| `ct-utils` | the library itself |
| `ct-utils/testing` | test helpers (fakes, fixtures) for consumers' tests; never imported by the main entry |

The package is ESM only (`"type": "module"`), with type declarations.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).
