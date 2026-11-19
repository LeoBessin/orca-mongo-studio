// Reformats what is typed in a query bar field (shell syntax: unquoted keys, single quotes, regex
// literals, BSON constructors, comments) without parsing it into values: it works on the tokens
// from js-scan, so literals keep their spelling, comments survive, and `new Date()` stays as typed
// instead of turning into the time it was formatted. Text it cannot rearrange without changing
// what it means (an unclosed bracket, string or comment, an empty slot between commas, two values
// at the top) is refused with the reason, so a malformed query never comes out as a valid one.
import { tokenize, type Token } from './js-scan'

/** A run of tokens with the bracket groups in it nested. */
type Node = Token | Group
type Group = { open: string; close: string; children: Node[]; start: number; end: number }
/** One comma-separated item of a group, with the comments around it. */
type Item = {
  nodes: Node[]
  /** Comments on their own lines before the item. */
  leading: Token[]
  /** Comments on the item's last line, after its code or its comma. */
  trailing: Token[]
  /** Comments on their own lines after the item's code. */
  after: Token[]
  comma?: Token
}

export type FormatResult = { ok: true; text: string } | { ok: false; problem: string }

const PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')' }
const CLOSERS = new Set(['}', ']', ')'])
/** Lines wider than this break their objects and arrays onto one item per line. */
export const FORMAT_WIDTH = 60

function isGroup(n: Node | undefined): n is Group {
  return n !== undefined && 'children' in n
}

function isComment(n: Node | undefined): boolean {
  return n !== undefined && !isGroup(n) && n.type === 'comment'
}

function isPunct(n: Node | undefined, ...values: string[]): boolean {
  return n !== undefined && !isGroup(n) && n.type === 'punct' && values.includes(n.value)
}

class Refused {
  constructor(
    readonly problem: string,
    readonly at: number
  ) {}
}

/** The token tree; refuses unbalanced brackets and open strings, regexes and comments. */
function tree(text: string): Node[] {
  const root: Node[] = []
  const stack: { group: Group | null; nodes: Node[] }[] = [{ group: null, nodes: root }]
  for (const t of tokenize(text, { comments: true })) {
    if (t.open) {
      const what = t.type === 'comment' ? 'This comment is never closed with */' : t.type === 'regex' ? 'This regular expression is never closed with /' : 'This string is never closed'
      throw new Refused(what, t.start)
    }
    const top = stack[stack.length - 1]!
    if (t.type === 'punct' && PAIRS[t.value]) {
      const group: Group = { open: t.value, close: PAIRS[t.value]!, children: [], start: t.start, end: t.end }
      top.nodes.push(group)
      stack.push({ group, nodes: group.children })
    } else if (t.type === 'punct' && CLOSERS.has(t.value)) {
      if (top.group?.close !== t.value) throw new Refused(top.group ? `Expected "${top.group.close}" but found "${t.value}"` : `Unexpected "${t.value}"`, t.start)
      top.group.end = t.end
      stack.pop()
    } else top.nodes.push(t)
  }
  const open = stack[stack.length - 1]!.group
  if (open) throw new Refused(`This ${open.open} is never closed with ${open.close}`, open.start)
  return root
}

const itemCache = new WeakMap<Node[], Item[]>()

function newItem(): Item {
  return { nodes: [], leading: [], trailing: [], after: [] }
}

/** Splits a group's children at its top-level commas. A comment goes with the item whose line it
 *  ends, or after the item it follows on its own line, or before the next one. */
function items(children: Node[]): Item[] {
  const cached = itemCache.get(children)
  if (cached) return cached
  const out: Item[] = []
  let cur = newItem()
  let afterComma: Item | undefined
  for (const n of children) {
    if (isComment(n)) {
      const c = n as Token
      if (afterComma && !c.nl) afterComma.trailing.push(c)
      else if (cur.nodes.length) (c.nl || cur.after.length ? cur.after : cur.trailing).push(c)
      else cur.leading.push(c)
      continue
    }
    afterComma = undefined
    if (isPunct(n, ',')) {
      cur.comma = n as Token
      out.push(cur)
      afterComma = cur
      cur = newItem()
      continue
    }
    // Code after comments in the same item (`a: /* x */ 1`): they stay where they are, inside it.
    cur.nodes.push(...cur.trailing, ...cur.after, n)
    cur.trailing = []
    cur.after = []
  }
  if (cur.nodes.length || cur.leading.length || cur.trailing.length || cur.after.length) out.push(cur)
  // Comments after the last item, alone in a trailing slot, follow that item.
  const last = out[out.length - 1]
  const before = out[out.length - 2]
  if (last && before && !last.nodes.length && !last.comma) {
    before.after.push(...last.leading, ...last.trailing, ...last.after)
    out.pop()
  }
  itemCache.set(children, out)
  return out
}

/** Refuses empty slots between commas, which the parser rejects and dropping them would hide. */
function check(nodes: Node[], top: boolean): void {
  const list = items(nodes)
  for (const it of list) {
    if (top && it.comma) throw new Refused('Only one document fits here; remove the ","', it.comma.start)
    // A trailing comma follows an item; a comma with nothing before it is a hole.
    if (!it.nodes.length && it.comma) throw new Refused('Nothing before this ","', it.comma.start)
    for (const n of it.nodes) if (isGroup(n)) check(n.children, false)
  }
}

/** Whether `-`, `+`, `!` or `~` at `i` applies to what follows instead of what comes before. */
function isUnary(nodes: Node[], i: number): boolean {
  if (!isPunct(nodes[i], '-', '+', '!', '~')) return false
  let j = i - 1
  while (j >= 0 && isComment(nodes[j])) j--
  const prev = nodes[j]
  return prev === undefined || (!isGroup(prev) && prev.type === 'punct')
}

/** Whether a space goes between the nodes at `i - 1` and `i` on one line. */
function spaceBefore(nodes: Node[], i: number): boolean {
  const a = nodes[i - 1]!
  const b = nodes[i]!
  if (isPunct(b, ',', ':', '.', '?.', ';')) return false
  if (isPunct(a, '.', '?.')) return false
  if (isPunct(a, ':', ',')) return true
  // Tokens typed together stay together: `items.0.price` scans as `items` and `.0`, and a space
  // between them would change the key.
  if (a.end === b.start) return false
  if (isUnary(nodes, i - 1)) return false
  // A call or an index: `ObjectId(…)`, `a[0]`.
  if (isGroup(b) && (b.open === '(' || b.open === '[') && (isGroup(a) ? a.open !== '{' : a.type === 'ident')) return false
  return true
}

/** A comment as it can sit inside one line. */
function blockComment(value: string): string {
  if (value.startsWith('//')) return `/* ${value.slice(2).trim().replace(/\*\//g, '* /')} */`
  return value.replace(/\s*[\r\n]\s*/g, ' ')
}

function inline(nodes: Node[]): string {
  let out = ''
  nodes.forEach((n, i) => {
    if (i > 0 && spaceBefore(nodes, i)) out += ' '
    out += isGroup(n) ? inlineGroup(n) : n.type === 'comment' ? blockComment(n.value) : n.value
  })
  return out
}

const inlineCache = new WeakMap<Group, string>()

/** A group on one line, comments as block comments. */
function inlineGroup(g: Group): string {
  const cached = inlineCache.get(g)
  if (cached !== undefined) return cached
  const body = items(g.children)
    .map((it) => inline([...it.leading, ...it.nodes, ...it.trailing, ...it.after]))
    .join(', ')
  const out = !body ? g.open + g.close : g.open === '{' ? `{ ${body} }` : g.open + body + g.close
  inlineCache.set(g, out)
  return out
}

const commentCache = new WeakMap<Node[], boolean>()

function hasComment(nodes: Node[]): boolean {
  let v = commentCache.get(nodes)
  if (v === undefined) {
    v = nodes.some((n) => (isGroup(n) ? hasComment(n.children) : n.type === 'comment'))
    commentCache.set(nodes, v)
  }
  return v
}

class Writer {
  text = ''
  private lineStart = 0
  constructor(readonly indent: string) {}
  col(): number {
    return this.text.length - this.lineStart
  }
  line(depth: number): void {
    let end = this.text.length
    while (end > this.lineStart && (this.text[end - 1] === ' ' || this.text[end - 1] === '\t')) end--
    this.text = this.text.slice(0, end) + '\n'
    this.lineStart = this.text.length
    this.text += this.indent.repeat(depth)
  }
}

function writeNodes(w: Writer, nodes: Node[], depth: number, top = false): void {
  nodes.forEach((n, i) => {
    if (i > 0 && spaceBefore(nodes, i)) w.text += ' '
    if (isGroup(n)) writeGroup(w, n, depth, top)
    else {
      w.text += n.value
      // A line comment inside an item ends its line; the item goes on below it.
      if (isComment(n) && n.value.startsWith('//') && i < nodes.length - 1) w.line(depth)
    }
  })
}

function writeItem(w: Writer, it: Item, depth: number, comma: boolean, top = false): void {
  it.leading.forEach((c, i) => {
    w.text += c.value
    if (it.nodes.length || i < it.leading.length - 1) w.line(depth)
  })
  writeNodes(w, it.nodes, depth, top)
  if (comma) w.text += ','
  for (const c of it.trailing) w.text += ' ' + c.value
  for (const c of it.after) {
    w.line(depth)
    w.text += c.value
  }
}

function writeGroup(w: Writer, g: Group, depth: number, top: boolean): void {
  const list = items(g.children)
  const breakable = g.open !== '(' && list.length > 0
  if (!hasComment(g.children)) {
    const one = inlineGroup(g)
    // At the top, a document with more than one key goes one key per line: that is what Format is for.
    const wantBreak = top && g.open === '{' && list.length > 1
    if (!breakable || (!wantBreak && w.col() + one.length <= FORMAT_WIDTH)) {
      w.text += one
      return
    }
  }
  if (!breakable) {
    // A call's arguments stay on its line; objects inside them still break on their own.
    w.text += g.open
    list.forEach((it, i) => {
      if (i > 0) w.text += ', '
      w.text += [...it.leading.map((c) => blockComment(c.value)), ''].join(' ')
      writeNodes(w, it.nodes, depth)
      for (const c of [...it.trailing, ...it.after]) w.text += ' ' + blockComment(c.value)
    })
    w.text += g.close
    return
  }
  let lastCode = -1
  list.forEach((it, i) => {
    if (it.nodes.length) lastCode = i
  })
  w.text += g.open
  list.forEach((it, i) => {
    w.line(depth + 1)
    writeItem(w, it, depth + 1, i < lastCode)
  })
  w.line(depth)
  w.text += g.close
}

function position(text: string, at: number): string {
  const before = text.slice(0, at)
  const line = before.split('\n').length
  const column = at - before.lastIndexOf('\n')
  return `(line ${line}, column ${column})`
}

function run(text: string, fn: (nodes: Node[]) => string): FormatResult {
  try {
    const nodes = tree(text)
    check(nodes, true)
    return { ok: true, text: fn(nodes) }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, problem: `${error.problem} ${position(text, error.at)}` }
    throw error
  }
}

/** The text with one key per line and nested documents broken when they don't fit. */
export function formatQuery(text: string, indent = '  '): FormatResult {
  if (!text.trim()) return { ok: true, text }
  return run(text, (nodes) => {
    const w = new Writer(indent)
    const list = items(nodes)
    list.forEach((it) => writeItem(w, it, 0, false, true))
    return w.text.replace(/[ \t]+$/gm, '')
  })
}

/** The text on one line, comments turned into block comments. */
export function compactQuery(text: string): FormatResult {
  if (!text.trim()) return { ok: true, text: '' }
  return run(text, (nodes) =>
    items(nodes)
      .map((it) => inline([...it.leading, ...it.nodes, ...it.trailing, ...it.after]))
      .join(', ')
  )
}
