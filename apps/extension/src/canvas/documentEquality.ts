/** Compare immutable document data without allocating serialized geometry.
 * Shared assets short-circuit by identity. Metadata keeps structured-clone
 * semantics, including cycles, typed arrays, dates, maps and sets.
 */
export function documentEquals(a: unknown, b: unknown): boolean {
  const seen = new WeakMap<object, object>()
  const equal = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
    if (Array.isArray(a) && a.length === 2 && typeof a[0] === 'number' && typeof a[1] === 'number') return Array.isArray(b) && b.length === 2 && Object.is(a[0], b[0]) && Object.is(a[1], b[1])
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
    if (seen.has(a)) return seen.get(a) === b
    seen.set(a, b)
    if (a instanceof Date) return Object.is(a.getTime(), (b as Date).getTime())
    if (a instanceof RegExp) return a.source === (b as RegExp).source && a.flags === (b as RegExp).flags
    if (ArrayBuffer.isView(a) || a instanceof ArrayBuffer) {
      const bytes = (value: ArrayBufferView | ArrayBuffer) => value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      const left = bytes(a), right = bytes(b as ArrayBufferView | ArrayBuffer)
      return left.length === right.length && left.every((value, i) => value === right[i])
    }
    if (a instanceof Map || a instanceof Set) {
      const right = b as Map<unknown, unknown> | Set<unknown>
      return a.size === right.size && equal([...a], [...right])
    }
    // Opaque objects (for example Blob) cannot be compared synchronously.
    // Conservatively preserve a possible edit rather than silently discard it.
    if (!Array.isArray(a) && Object.getPrototypeOf(a) !== Object.prototype && Object.getPrototypeOf(a) !== null) return false
    if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left)
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]))
  }
  return equal(a, b)
}
