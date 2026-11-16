// Splits JSON text, given in pieces, into its top-level documents without parsing them: a JSON
// array of documents, one document per line (mongoexport), or documents one after another (pretty
// printed, or with commas between them). Each record is then parsed on its own as Extended JSON,
// so one bad document is one error, and a big file never has to be held whole.

export type JsonRecord = { text: string; line: number }

const isSpace = (c: string): boolean => c === ' ' || c === '\n' || c === '\r' || c === '\t'

export class JsonRecordReader {
  /** The part of the current record that came in earlier pieces. */
  private buf = ''
  private depth = 0
  private inString = false
  private escaped = false
  /** The text is one top-level array; its items are the records. */
  private inArray: boolean | undefined
  private arrayClosed = false
  private started = false
  private line = 1
  private recordLine = 1
  private recording = false

  feed(text: string): JsonRecord[] {
    const out: JsonRecord[] = []
    let i = 0
    if (!this.started && text.length) {
      this.started = true
      if (text.charCodeAt(0) === 0xfeff) i = 1
    }
    /** Where the current record starts in this piece. */
    let start = 0
    const emit = (endExclusive: number): void => {
      out.push({ text: this.buf + text.slice(start, endExclusive), line: this.recordLine })
      this.buf = ''
      this.recording = false
    }
    for (; i < text.length; i++) {
      const c = text[i]!
      if (c === '\n') this.line++
      if (this.recording) {
        if (this.inString) {
          if (this.escaped) this.escaped = false
          else if (c === '\\') this.escaped = true
          else if (c === '"') this.inString = false
          continue
        }
        if (this.depth === 0 && (c === ',' || c === ']' || c === '}' || isSpace(c))) {
          // A bare value (number, true, null, a string) ends at a separator.
          emit(i)
          if (c === ']' && this.inArray) this.arrayClosed = true
        } else if (c === '"') this.inString = true
        else if (c === '{' || c === '[') this.depth++
        else if (c === '}' || c === ']') {
          this.depth--
          if (this.depth === 0) emit(i + 1)
        }
        continue
      }
      if (isSpace(c) || c === ',') continue
      if (this.inArray === undefined) {
        this.inArray = c === '['
        if (this.inArray) continue
      }
      if (c === ']' && this.inArray && !this.arrayClosed) {
        this.arrayClosed = true
        continue
      }
      if (this.arrayClosed) throw new Error(`Line ${this.line}: text after the end of the array.`)
      this.recording = true
      this.recordLine = this.line
      this.buf = ''
      start = i
      this.depth = c === '{' || c === '[' ? 1 : 0
      if (c === '"') this.inString = true
    }
    if (this.recording) this.buf += text.slice(start)
    return out
  }

  end(): JsonRecord[] {
    const out: JsonRecord[] = []
    if (this.recording) {
      if (this.depth > 0 || this.inString) throw new Error(`Line ${this.recordLine}: the document starting here is never closed.`)
      out.push({ text: this.buf, line: this.recordLine })
      this.recording = false
      this.buf = ''
    }
    if (this.inArray && !this.arrayClosed) throw new Error('The array is never closed with ].')
    return out
  }
}

/** Splits a whole text at once. */
export function splitJsonRecords(text: string): JsonRecord[] {
  const r = new JsonRecordReader()
  return [...r.feed(text), ...r.end()]
}
