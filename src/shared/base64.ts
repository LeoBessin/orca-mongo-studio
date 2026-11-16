// Base64 to bytes, for the panel: downloads come from the worker in base64 pieces (one string is
// cheap in Orca's size measure) and are joined into the ArrayBuffer `files.saveAs` takes. Written
// out here because a components panel has no Buffer and may not have atob.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Int16Array(128).fill(-1)
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i

export function base64Bytes(b64: string): Uint8Array {
  const clean = b64.replace(/[\s=]+/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  let acc = 0
  let bits = 0
  for (let i = 0; i < clean.length; i++) {
    const v = LOOKUP[clean.charCodeAt(i)] ?? -1
    if (v < 0) throw new Error('Not base64 text.')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return o === out.length ? out : out.slice(0, o)
}

/** Joins pieces into one ArrayBuffer of exactly their length. */
export function joinBytes(parts: readonly Uint8Array[]): ArrayBuffer {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out.buffer
}
