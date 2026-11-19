// Splits documents shown as code into several CodeViews, so Orca highlights all of them.
// Orca's highlighter gives up on a line longer than 1,000 characters, and every line after it in
// the same CodeView stays plain; it also leaves anything past the first 50,000 characters plain.
// Each chunk stays under that size, and a document with a long line ends its chunk, so only that
// document loses colour after its long line and the documents after it start fresh.
// shortenLongStrings keeps such lines from happening in the first place, for display.
import { setOwn } from './ejson-view'

/** Orca's highlighter: the longest line it tokenizes, and how much of a CodeView it highlights. */
export const HIGHLIGHT_LINE_MAX = 1000
export const HIGHLIGHT_CHARS_MAX = 50_000

export type CodeChunk = {
  /** The index of the chunk's first document. */
  from: number
  /** The code of each document in the chunk. */
  texts: string[]
}

/** Whether a line of the document, once indented into the array, is too long to highlight. */
function hasLongLine(text: string): boolean {
  const max = HIGHLIGHT_LINE_MAX - 2
  let start = 0
  for (;;) {
    const end = text.indexOf('\n', start)
    if ((end < 0 ? text.length : end) - start > max) return true
    if (end < 0) return false
    start = end + 1
  }
}

/** What a document takes in `arrayText`: its text, two spaces per line, a comma and a newline. */
function arrayCost(text: string): number {
  let lines = 1
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++
  return text.length + 2 * lines + 2
}

/** Groups the documents' code into chunks, in order, each one fitting in `arrayText` under the
 *  size Orca highlights (the brackets count too). */
export function chunkForHighlight(texts: readonly string[]): CodeChunk[] {
  const chunks: CodeChunk[] = []
  let current: CodeChunk | undefined
  let size = 0
  texts.forEach((text, i) => {
    const cost = arrayCost(text)
    if (current && size + cost > HIGHLIGHT_CHARS_MAX) current = undefined
    if (!current) {
      current = { from: i, texts: [] }
      chunks.push(current)
      size = 4 // the brackets and their newlines
    }
    current.texts.push(text)
    size += cost
    // The lines after a long one lose their colour: start the next document in a new view.
    if (hasLongLine(text)) current = undefined
  })
  return chunks
}

/** Indents every line after the first, to place a document's code inside an array. */
function indent(text: string, by: string): string {
  return text.replace(/\n/g, `\n${by}`)
}

/** The documents of a chunk as an array, laid out like `JSON.stringify(docs, null, 2)` or the
 *  shell's own printing: one document per item, indented by two spaces. */
export function arrayText(texts: readonly string[]): string {
  if (!texts.length) return '[]'
  return `[\n${texts.map((t) => `  ${indent(t, '  ')}`).join(',\n')}\n]`
}

/** A chunk's label: which documents it holds, counted from 1 and from `offset` (the page's). */
export function chunkLabel(what: string, chunk: CodeChunk, offset: number, count: number): string {
  if (count === 1) return what
  const first = offset + chunk.from + 1
  const last = first + chunk.texts.length - 1
  return first === last ? `${what}: document ${first.toLocaleString('en-US')}` : `${what}: documents ${first.toLocaleString('en-US')}–${last.toLocaleString('en-US')}`
}

/** The longest string shown whole in a code view, and how much of a longer one is kept. Well under
 *  the line Orca highlights, with room for the key and indentation. */
export const LONG_STRING = 300
const KEEP = 120

/** A copy of the value for display, each string past LONG_STRING characters cut to its start
 *  followed by how much was left out, inside the string so the code stays valid. One long line
 *  (a base64 polyline, an encoded blob) would otherwise leave the rest of the view unhighlighted.
 *  `count` is how many strings were shortened. */
export function shortenLongStrings<T>(v: T): { value: T; count: number } {
  let count = 0
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') {
      if (x.length <= LONG_STRING) return x
      // Counted in characters, not UTF-16 units, so a cut never splits an emoji.
      const left = [...x]
      if (left.length <= LONG_STRING) return x
      count++
      return `${left.slice(0, KEEP).join('')}… [${(left.length - KEEP).toLocaleString('en-US')} more characters]`
    }
    if (Array.isArray(x)) return x.map(walk)
    if (x !== null && typeof x === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(x)) setOwn(out, k, walk(val))
      return out
    }
    return x
  }
  const value = walk(v) as T
  return { value, count }
}
