// The fake ChurchTools for dev and demo code (`ct-utils/fake`). Nothing here imports vitest; tests use `ct-utils/testing`,
// which re-exports the same names next to the contract cases.
export { createFakeChurchTools, type FakeCtSeed } from './fake-churchtools.js';
export { FAKE_MARKER } from './marker.js';
