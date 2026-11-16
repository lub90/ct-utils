/**
 * The fake marker: every fake module of the testing entry puts it into its code, so a consumer's dist check can fail
 * a production build that contains it. `marker.test.ts` proves it survives minification.
 */
export const FAKE_MARKER = '__CT_UTILS_FAKE__';

/** Tags a fake object with the marker (a hidden property), so the marker is in the code wherever the object is made. */
export function tagFake<T extends object>(value: T): T {
    Object.defineProperty(value, FAKE_MARKER, { value: true });
    return value;
}
