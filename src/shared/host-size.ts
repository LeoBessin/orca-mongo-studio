// How Orca sizes a plugin.request answer (and input): measured from its host code (main/index.js,
// the `too_large` check on `plugin.request`). Strings count their UTF-8 bytes, numbers 8, null and
// booleans 1, each array 8 plus 4 per item, each object key 4 plus its bytes. An answer is refused
// past 1 MiB, past 10,000 objects and arrays, or deeper than 100 levels. Canonical Extended JSON
// wraps every number and date in an object, so the object count is usually what runs out first.

export const HOST_MAX_BYTES = 1024 * 1024
export const HOST_MAX_OBJECTS = 10_000
export const HOST_MAX_DEPTH = 100

export type HostSize = { bytes: number; objects: number; depth: number }

const encoder = new TextEncoder()

export function hostSize(value: unknown): HostSize {
  const size: HostSize = { bytes: 0, objects: 0, depth: 0 }
  const walk = (v: unknown, depth: number): void => {
    if (depth > size.depth) size.depth = depth
    if (v === null || v === undefined || typeof v === 'boolean') {
      size.bytes += 1
      return
    }
    if (typeof v === 'number') {
      size.bytes += 8
      return
    }
    if (typeof v === 'string') {
      size.bytes += encoder.encode(v).byteLength
      return
    }
    if (typeof v !== 'object') return
    size.objects += 1
    if (Array.isArray(v)) {
      size.bytes += 8
      for (const item of v) {
        size.bytes += 4
        walk(item, depth + 1)
      }
      return
    }
    for (const [k, item] of Object.entries(v)) {
      size.bytes += 4 + encoder.encode(k).byteLength
      walk(item, depth + 1)
    }
  }
  walk(value, 0)
  return size
}

/** Whether `value` fits in one request or answer, with `share` of each limit as headroom. */
export function fitsHost(value: unknown, share = 0.9): boolean {
  const s = hostSize(value)
  return s.bytes <= HOST_MAX_BYTES * share && s.objects <= HOST_MAX_OBJECTS * share && s.depth < HOST_MAX_DEPTH - 5
}
