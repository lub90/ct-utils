/** Walks the whole object graph (own enumerable and hidden properties, cycles safe) looking for `needle` in any string. */
export function containsDeep(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
    if (typeof value === 'string') return value.includes(needle);
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    return Reflect.ownKeys(value).some((key) => {
        if (typeof key === 'string' && key.includes(needle)) return true;
        let inner: unknown;
        try {
            inner = (value as Record<PropertyKey, unknown>)[key];
        } catch {
            return false;
        }
        return containsDeep(inner, needle, seen);
    });
}
