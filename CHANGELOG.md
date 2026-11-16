# Changelog

Sections: Added / Changed / Fixed / Removed. Breaking changes are marked. Versions follow semver; in 0.x a minor bump
is breaking and a patch is not.

## 0.1.0 (2026-11-16)

### Added

- Package skeleton with the entries `ct-utils` (`.`), `ct-utils/testing` (`./testing`) and `ct-utils/fake`
  (`./fake`), CI, and the pre-commit privacy check. The `.` entry never imports `./testing` or `./fake`.
- `.`: `createClient(options)` with the options `baseUrl` (default: the instance the page runs on), `loginToken`
  (Node; never part of an error) and `timeoutMs`; the ChurchTools errors (`CtHttpError`, `CtForbiddenError`, …).
- `.`: `createCtApi(client, moduleKey)`, the typed ChurchTools API. **The module key is a required parameter**; there
  is no default key.
- `.`: `CtPerson` (`{ id, name, detail? }`), the person type of `groupMembers`, `person` and `searchPersons`.
- `.`: the generic KV store `KvBackend` with `ChurchToolsKv` (custom module categories) and `MemoryKv`, and
  `CategoryMissingError`.
- `vitest` (>= 5.1.0) as an optional peer dependency: only `./testing` imports it.
- `./testing`: `createFakeChurchTools(seed)`, an in-memory ChurchTools for tests and demos, with `FakeCtSeed`.
- `./fake`: the same fake (`createFakeChurchTools`, `FakeCtSeed`, `FAKE_MARKER`) without the contract cases, so it
  never imports `vitest`. Dev and demo code import `ct-utils/fake`; tests import `ct-utils/testing`, which re-exports
  the same names.
- `./testing`: `FAKE_MARKER` (`'__CT_UTILS_FAKE__'`): every object the fake creates carries it in its code, so a
  consumer's dist check can refuse a production build that contains the fake.
- `./testing`: the contract cases `defineKvContract(name, make)` for any `KvBackend` and `defineCtContract(name, make)`
  for any `CtApi` (the fake or a real instance). The subject names a required `tempName` (first name of the persons
  the cases create) and an optional `rights.statusCategoryIds` (the categories the status case may grant a view right
  on).
- `./testing`: the contract helpers for a consumer's own contract cases: `eventuallyCt` (retries a check while
  ChurchTools' rights cache catches up), `throwawayPerson`, `requireUnassigned`, `secondCategory`, `expectSaveAdds`, and
  `tempLabel(moduleKey)` (`'<moduleKey> extension contract test'`, the name of every person, group and category the
  cases create, so leftovers can be found).

### Removed

- The earlier `lib/` and `types/` directories.
