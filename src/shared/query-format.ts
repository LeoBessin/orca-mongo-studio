// Reformats what is typed in a query bar field (shell syntax: unquoted keys, single quotes, regex
// literals, BSON constructors, comments) without parsing it into values: it works on the tokens
// from js-scan, so literals keep their spelling, comments survive, and `new Date()` stays a
// relative date instead of turning into the time it was formatted. Only the brackets have to
// balance; the text does not have to be a valid query.
import { tokenize, type Token } from './js-scan'

/** A run of tokens with the bracket groups in it nested. */
type Node = Token | Group
type Group = { open: string; close: string; children: Node[] }

const PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')' }
const CLOSERS = new Set(['}', ']', ')'])
/** Lines wider than this break their objects and arrays onto one item per line. */
export const FORMAT_WIDTH = 60

function isGroup(n: Node | undefined): n is Group {
  return n !== undefined && 'children' in n
}

/** The token tree, or undefined when brackets don't balance or a string, regex or comment is open. */
function tree(text: string): Node[] | undefined {
  const root: Node[] = []
  const stack: { group: Group | null; nodes: Node[] }[] = [{ group: null, nodes: root }]
  for (const t of tokenize(text, { comments: true })) {
    if (t.open) return undefined
    const top = stack[stack.length - 1]!
    if (t.type === 'punct' && PAIRS[t.value]) {
      const group: Group = { open: t.value, close: PAIRS[t.value]!, children: [] }
      top.nodes.push(group)
      stack.push({ group, nodes: group.children })
    } else if (t.type === 'punct' && CLOSERS.has(t.value)) {
      if (top.group?.close !== t.value) return undefined
      stack.pop()
    } else top.nodes.push(t)
  }
  return stack.length === 1 ? root : undefined
}

function hasComment(nodes: Node[]): boolean {
  return nodes.some((n) => (isGroup(n) ? hasComment(n.children) : n.type === 'comment'))
}

function isPunct(n: Node | undefined, ...values: string[]): boolean {
  return n !== undefined && !isGroup(n) && n.type === 'punct' && values.includes(n.value)
}

/** Whether `-`, `+`, `!` or `~` at `i` applies to what follows instead of what comes before. */
function isUnary(nodes: Node[], i: number): boolean {
  if (!isPunct(nodes[i], '-', '+', '!', '~')) return false
  let j = i - 1
  while (j >= 0 && !isGroup(nodes[j]) && (nodes[j] as Token).type === 'comment') j--
  const prev = nodes[j]
  return prev === undefined || (!isGroup(prev) && prev.type === 'punct')
}

/** Whether a space goes between the nodes at `i - 1` and `i` on one line. */
function spaceBefore(nodes: Node[], i: number): boolean {
  const a = nodes[i - 1]!
  const b = nodes[i]!
  if (isPunct(b, ',', ':', '.', '?.', ';')) return false
  if (isPunct(a, '.', '?.')) return false
  if (isUnary(nodes, i - 1)) return false
  // A call or an index: `ObjectId(…)`, `a[0]`.
  if (isGroup(b) && (b.open === '(' || b.open === '[') && (isGroup(a) ? a.open !== '{' : a.type === 'ident')) return false
  return true
}

/** Splits a group's children at its top-level commas; comments stay with the item they follow on
 *  the same line, or start the next one. */
type Item = { nodes: Node[]; leading: Token[]; trailing: Token[] }

function items(children: Node[]): Item[] {
  const out: Item[] = []
  let cur: Item = { nodes: [], leading: [], trailing: [] }
  let afterComma: Item | undefined
  for (const n of children) {
    if (!isGroup(n) && n.type === 'comment') {
      if (afterComma && !n.nl) afterComma.trailing.push(n)
      else if (cur.nodes.length && !n.nl) cur.trailing.push(n)
      else cur.leading.push(n)
      continue
    }
    afterComma = undefined
    if (isPunct(n, ',')) {
      out.push(cur)
      afterComma = cur
      cur = { nodes: [], leading: [], trailing: [] }
      continue
    }
    if (cur.trailing.length) {
      // Code after a same-line comment: that comment belongs before it.
      cur.leading.push(...cur.trailing)
      cur.trailing = []
    }
    cur.nodes.push(n)
  }
  if (cur.nodes.length || cur.leading.length || cur.trailing.length) out.push(cur)
  return out
}

/** One line, comments as block comments. */
function inline(nodes: Node[]): string {
  let out = ''
  nodes.forEach((n, i) => {
    if (i > 0 && spaceBefore(nodes, i)) out += ' '
    out += isGroup(n) ? inlineGroup(n) : n.type === 'comment' ? blockComment(n.value) : n.value
  })
  return out
}

function inlineGroup(g: Group): string {
  const parts = items(g.children).filter((it) => it.nodes.length || it.leading.length || it.trailing.length)
  const body = parts.map((it) => inline([...it.leading, ...it.nodes, ...it.trailing])).join(', ')
  if (!body) return g.open + g.close
  return g.open === '{' ? `{ ${body} }` : g.open + body + g.close
}

function blockComment(value: string): string {
  return value.startsWith('//') ? `/* ${value.slice(2).trim().replace(/\*\//g, '* /')} */` : value
}

class Writer {
  text = ''
  constructor(readonly indent: string) {}
  col(): number {
    return this.text.length - this.text.lastIndexOf('\n') - 1
  }
  line(depth: number): void {
    this.text = this.text.replace(/[ \t]+$/, '') + '\n' + this.indent.repeat(depth)
  }
}

function writeNodes(w: Writer, nodes: Node[], depth: number): void {
  nodes.forEach((n, i) => {
    if (i > 0 && spaceBefore(nodes, i)) w.text += ' '
    if (isGroup(n)) writeGroup(w, n, depth, false)
    else w.text += n.value
  })
}

function writeComments(w: Writer, comments: Token[], depth: number): void {
  for (const c of comments) {
    w.text += c.value
    w.line(depth)
  }
}

function writeGroup(w: Writer, g: Group, depth: number, top: boolean): void {
  const list = items(g.children)
  const one = inlineGroup(g)
  const breakable = g.open !== '(' && list.length > 0
  const comments = hasComment(g.children)
  // At the top, a document with more than one key goes one key per line: that is what Format is for.
  const wantBreak = top && g.open === '{' && list.length > 1
  if (!comments && (!breakable || (!wantBreak && w.col() + one.length <= FORMAT_WIDTH))) {
    w.text += one
    return
  }
  if (!breakable) {
    // A call's arguments stay on its line; objects inside them still break on their own.
    w.text += g.open
    list.forEach((it, i) => {
      if (i > 0) w.text += ', '
      if (it.leading.length) w.text += it.leading.map((c) => blockComment(c.value)).join(' ') + ' '
      writeNodes(w, it.nodes, depth)
      if (it.trailing.length) w.text += ' ' + it.trailing.map((c) => blockComment(c.value)).join(' ')
    })
    w.text += g.close
    return
  }
  w.text += g.open
  list.forEach((it, i) => {
    w.line(depth + 1)
    writeComments(w, it.leading, depth + 1)
    if (!it.nodes.length) {
      // Comments after the last item: drop the indent the last comment left.
      w.text = w.text.replace(/\n[ \t]*$/, '')
      return
    }
    writeNodes(w, it.nodes, depth + 1)
    if (i < list.length - 1 && list.slice(i + 1).some((x) => x.nodes.length)) w.text += ','
    for (const c of it.trailing) w.text += ' ' + c.value
  })
  w.line(depth)
  w.text += g.close
}

/** The text with one key per line and nested documents broken when they don't fit, or undefined
 *  when its brackets, strings or comments are not closed. */
export function formatQuery(text: string, indent = '  '): string | undefined {
  if (!text.trim()) return text
  const nodes = tree(text)
  if (!nodes) return undefined
  const w = new Writer(indent)
  const parts = items(nodes)
  // Top-level commas are rare (two values typed); keep them as written.
  parts.forEach((it, i) => {
    if (i > 0) w.text += ', '
    writeComments(w, it.leading, 0)
    it.nodes.forEach((n, j) => {
      if (j > 0 && spaceBefore(it.nodes, j)) w.text += ' '
      if (isGroup(n)) writeGroup(w, n, 0, true)
      else w.text += n.value
    })
    for (const c of it.trailing) w.text += ' ' + c.value
  })
  return w.text.replace(/[ \t]+$/gm, '')
}

/** The text on one line, line comments turned into block comments, or undefined when its
 *  brackets, strings or comments are not closed. */
export function compactQuery(text: string): string | undefined {
  if (!text.trim()) return ''
  const nodes = tree(text)
  if (!nodes) return undefined
  return items(nodes)
    .map((it) => inline([...it.leading, ...it.nodes, ...it.trailing]))
    .join(', ')
}
