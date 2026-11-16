// A script names its connection and database in a comment near the top, so the file carries
// them and opens ready to run:  // @mongo-studio connection="Local dev" db="shop"
export type ScriptTarget = { connection: string; db: string }

const HEADER = /^[ \t]*\/\/[ \t]*@mongo-studio\b(.*)$/
const FIELD = /(connection|db)\s*=\s*("(?:[^"\\]|\\.)*")/g
const SEARCH_LINES = 5

function quoted(text: string): string {
  return JSON.stringify(text)
}

function lines(text: string): string[] {
  return text.split('\n')
}

/** The target the header names, and its line (0-based); empty strings when it names none. */
export function readHeader(text: string): ScriptTarget & { line: number } {
  const all = lines(text)
  for (let i = 0; i < Math.min(all.length, SEARCH_LINES); i++) {
    const match = HEADER.exec(all[i]!)
    if (!match) continue
    const target: ScriptTarget & { line: number } = { connection: '', db: '', line: i }
    for (const [, key, value] of match[1]!.matchAll(FIELD)) {
      try {
        target[key as 'connection' | 'db'] = JSON.parse(value!) as string
      } catch {
        // a malformed value reads as empty
      }
    }
    return target
  }
  return { connection: '', db: '', line: -1 }
}

export function headerLine(target: ScriptTarget): string {
  return `// @mongo-studio connection=${quoted(target.connection)} db=${quoted(target.db)}`
}

/** The text with its header naming `target`, added as the first line when there is none. */
export function writeHeader(text: string, target: ScriptTarget): string {
  const current = readHeader(text)
  const all = lines(text)
  if (current.line < 0) return `${headerLine(target)}\n${text}`
  all[current.line] = headerLine(target)
  return all.join('\n')
}

/**
 * A three-way merge of whole lines, for an outside write (an agent, git) landing while the editor
 * has unsaved typing: changes to different parts of the file both survive; where both changed the
 * same lines, the outside lines come first, then yours.
 */
export function mergeLines(base: string, outside: string, mine: string): string {
  if (mine === base) return outside
  if (outside === base || outside === mine) return mine
  const b = lines(base)
  const o = lines(outside)
  const m = lines(mine)
  const changed = (x: string[]): { start: number; endBase: number; endX: number } => {
    let start = 0
    while (start < b.length && start < x.length && b[start] === x[start]) start++
    let eb = b.length
    let ex = x.length
    while (eb > start && ex > start && b[eb - 1] === x[ex - 1]) {
      eb--
      ex--
    }
    return { start, endBase: eb, endX: ex }
  }
  const co = changed(o)
  const cm = changed(m)
  // Separate regions of the base: apply the later one first so the earlier one's indexes hold.
  if (co.endBase <= cm.start || cm.endBase <= co.start) {
    const [first, firstLines, second, secondLines] = co.start <= cm.start ? [co, o, cm, m] : [cm, m, co, o]
    const out = [...b]
    out.splice(second.start, second.endBase - second.start, ...secondLines.slice(second.start, second.endX))
    out.splice(first.start, first.endBase - first.start, ...firstLines.slice(first.start, first.endX))
    return out.join('\n')
  }
  const start = Math.min(co.start, cm.start)
  const endBase = Math.max(co.endBase, cm.endBase)
  const oPart = o.slice(start, o.length - (b.length - endBase))
  const mPart = m.slice(start, m.length - (b.length - endBase))
  return [...b.slice(0, start), ...oPart, ...mPart, ...b.slice(endBase)].join('\n')
}

export function startSync() {
  const document = orca.document
  if (!document) throw new Error('This file runs as a custom editor.')
  return document.session<string>({ merge: mergeLines })
}
