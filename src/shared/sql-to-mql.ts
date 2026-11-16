// A deterministic SQL → MQL translator for one SELECT statement: never `eval`, no clock. It reads
// the common subset (columns, WHERE, JOIN, GROUP BY, HAVING, ORDER BY, LIMIT/OFFSET) and returns
// a find or an aggregation in canonical Extended JSON, with its mongosh text and notes on where
// MongoDB's meaning differs from SQL's. Anything outside the subset is an error with a position,
// never a guess.
import { dateValue, doubleText, numberValue, parseDateText } from './shell-parse'
import { operationToShell, type Operation } from './operation'
import type { JsonObject, JsonValue } from './ejson-view'

export class SqlError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number
  ) {
    super(`${message} (line ${line}, column ${column})`)
    this.name = 'SqlError'
  }
  /** The message without the position. */
  get reason(): string {
    return this.message.replace(/ \(line \d+, column \d+\)$/, '')
  }
}

type Fail = (message: string, at: number) => never

function failer(src: string): Fail {
  return (message, at) => {
    let line = 1
    let column = 1
    for (let i = 0; i < at && i < src.length; i++) {
      if (src[i] === '\n') {
        line++
        column = 1
      } else column++
    }
    throw new SqlError(message, line, column)
  }
}

// ---- Tokens ----

/** `word`: a bare identifier or keyword. `name`: a quoted identifier (never a keyword). */
type Tok = { type: 'word' | 'name' | 'string' | 'number' | 'op' | 'eof'; text: string; value: string; pos: number }

const OPS2 = ['<>', '<=', '>=', '!=', '||', '::']
const OPS1 = '=<>(),.*;+-/%'

function lex(src: string, fail: Fail): Tok[] {
  const toks: Tok[] = []
  let i = 0
  for (;;) {
    // Whitespace and comments.
    for (;;) {
      const c = src[i]
      if (c !== undefined && /\s/.test(c)) i++
      else if (c === '-' && src[i + 1] === '-') {
        while (i < src.length && src[i] !== '\n') i++
      } else if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2)
        if (end < 0) fail('This comment is never closed with */', i)
        i = end + 2
      } else break
    }
    if (i >= src.length) {
      toks.push({ type: 'eof', text: '', value: '', pos: src.length })
      return toks
    }
    const start = i
    const c = src[i]!
    const prev = toks[toks.length - 1]
    const rest = src.slice(i)
    if (prev && prev.type === 'op' && prev.text === '.' && /\d/.test(c)) {
      // An array index in a path: items.0.price
      const m = /^\d+/.exec(rest)!
      i += m[0].length
      toks.push({ type: 'name', text: m[0], value: m[0], pos: start })
    } else if (/[\p{L}_]/u.test(c)) {
      const m = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(rest)!
      i += m[0].length
      toks.push({ type: 'word', text: m[0], value: m[0], pos: start })
    } else if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? '') && !(prev && (prev.type === 'word' || prev.type === 'name')))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest)!
      i += m[0].length
      if (/[\p{L}_$]/u.test(src[i] ?? '')) fail(`Unexpected "${src[i]}" after the number`, i)
      toks.push({ type: 'number', text: m[0], value: m[0], pos: start })
    } else if (c === "'" || c === '"' || c === '`') {
      i++
      let value = ''
      for (;;) {
        const d = src[i]
        if (d === undefined) fail(c === "'" ? 'This string is never closed' : 'This quoted name is never closed', start)
        i++
        if (d === c) {
          if (src[i] === c) {
            value += c
            i++
            continue
          }
          break
        }
        value += d
      }
      if (c !== "'" && value === '') fail('A quoted name cannot be empty', start)
      toks.push({ type: c === "'" ? 'string' : 'name', text: src.slice(start, i), value, pos: start })
    } else {
      const two = src.slice(i, i + 2)
      if (OPS2.includes(two)) {
        i += 2
        toks.push({ type: 'op', text: two, value: two, pos: start })
      } else if (OPS1.includes(c)) {
        i++
        toks.push({ type: 'op', text: c, value: c, pos: start })
      } else fail(`Unexpected "${c}"`, start)
    }
  }
}

// ---- Syntax tree ----

type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max'
type CmpOp = '=' | '<>' | '<' | '<=' | '>' | '>='

type Col = { k: 'col'; parts: string[]; text: string; pos: number }
type Lit = { k: 'lit'; value: JsonValue; int?: number; pos: number }
type Agg = { k: 'agg'; fn: AggFn; arg: Col | null; distinct: boolean; pos: number }
type Expr =
  | Col
  | Lit
  | Agg
  | { k: 'cmp'; op: CmpOp; left: Expr; right: Expr; pos: number }
  | { k: 'and' | 'or'; items: Expr[]; pos: number }
  | { k: 'not'; expr: Expr; pos: number }
  | { k: 'in'; expr: Expr; list: Expr[]; negated: boolean; pos: number }
  | { k: 'between'; expr: Expr; low: Expr; high: Expr; negated: boolean; pos: number }
  | { k: 'like'; expr: Expr; pattern: string; escape: string | null; ci: boolean; negated: boolean; pos: number }
  | { k: 'isnull'; expr: Expr; negated: boolean; pos: number }

type Item = { expr: Col | Agg; alias: string | null; pos: number }
type TableRef = { collection: string; alias: string | null; pos: number }
type Join = { left: boolean; table: TableRef; on: Expr; pos: number }
type OrderItem = { expr: Expr; desc: boolean; pos: number }
type Select = {
  distinct: boolean
  star: number | null
  items: Item[]
  from: TableRef
  joins: Join[]
  where: Expr | null
  groupBy: Expr[]
  having: Expr | null
  orderBy: OrderItem[]
  limit: number | null
  offset: number | null
}

const RESERVED = new Set(
  (
    'SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET JOIN INNER LEFT RIGHT FULL CROSS NATURAL OUTER ON USING AS AND OR NOT IN IS NULL ' +
    'LIKE ILIKE BETWEEN DISTINCT ALL ASC DESC TRUE FALSE UNION INTERSECT EXCEPT CASE WHEN THEN ELSE END WITH ESCAPE FETCH WINDOW EXISTS ' +
    'INSERT UPDATE DELETE INTO VALUES SET'
  ).split(' ')
)
const AGGS: Record<string, AggFn> = { COUNT: 'count', SUM: 'sum', AVG: 'avg', MIN: 'min', MAX: 'max' }
const MIRROR: Record<CmpOp, CmpOp> = { '=': '=', '<>': '<>', '<': '>', '<=': '>=', '>': '<', '>=': '<=' }
const INVERSE: Record<CmpOp, CmpOp> = { '=': '<>', '<>': '=', '<': '>=', '<=': '>', '>': '<=', '>=': '<' }
const MQL_OP: Record<CmpOp, string> = { '=': '$eq', '<>': '$ne', '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' }

class Parser {
  private i = 0
  usedDate = false
  constructor(
    private readonly toks: Tok[],
    private readonly fail: Fail
  ) {}

  private peek(n = 0): Tok {
    return this.toks[Math.min(this.i + n, this.toks.length - 1)]!
  }
  private next(): Tok {
    const t = this.peek()
    if (t.type !== 'eof') this.i++
    return t
  }
  private isKw(t: Tok, ...kws: string[]): boolean {
    return t.type === 'word' && kws.includes(t.text.toUpperCase())
  }
  private acceptKw(kw: string): Tok | null {
    return this.isKw(this.peek(), kw) ? this.next() : null
  }
  private isOp(t: Tok, ...ops: string[]): boolean {
    return t.type === 'op' && ops.includes(t.text)
  }
  private acceptOp(op: string): Tok | null {
    return this.isOp(this.peek(), op) ? this.next() : null
  }
  private found(t: Tok): string {
    return t.type === 'eof' ? 'the text ended' : t.type === 'string' ? `found ${t.text}` : `found "${t.text}"`
  }
  private expectKw(kw: string, what = kw): Tok {
    const t = this.peek()
    if (!this.isKw(t, kw)) this.fail(`Expected ${what} but ${this.found(t)}`, t.pos)
    return this.next()
  }
  private expectOp(op: string): Tok {
    const t = this.peek()
    if (!this.isOp(t, op)) this.fail(`Expected "${op}" but ${this.found(t)}`, t.pos)
    return this.next()
  }

  statement(): Select {
    const t = this.peek()
    if (this.isKw(t, 'WITH')) this.fail('WITH (common table expressions) is not supported', t.pos)
    if (this.isKw(t, 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'UPSERT', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE'))
      this.fail(`Only SELECT statements can be translated, not ${t.text.toUpperCase()}`, t.pos)
    if (t.type === 'eof') this.fail('Expected a SELECT statement but the text is empty', t.pos)
    const select = this.select()
    const after = this.peek()
    if (this.isKw(after, 'UNION', 'INTERSECT', 'EXCEPT', 'MINUS')) this.fail(`${after.text.toUpperCase()} is not supported`, after.pos)
    if (this.acceptOp(';')) {
      const extra = this.peek()
      if (extra.type !== 'eof') this.fail('Only one statement can be translated at a time', extra.pos)
    }
    const end = this.peek()
    if (end.type !== 'eof') {
      if (this.isKw(end, 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET'))
        this.fail(`${end.text.toUpperCase()} is out of place: clauses go in the order WHERE, GROUP BY, HAVING, ORDER BY, LIMIT`, end.pos)
      if (this.isKw(end, 'FETCH')) this.fail('FETCH is not supported; use LIMIT', end.pos)
      if (this.isKw(end, 'FOR')) this.fail('FOR UPDATE and locking clauses are not supported', end.pos)
      if (this.isKw(end, 'WINDOW')) this.fail('Window functions are not supported', end.pos)
      this.fail(`Unexpected ${end.type === 'string' ? end.text : `"${end.text}"`}`, end.pos)
    }
    return select
  }

  private select(): Select {
    this.expectKw('SELECT')
    const distinct = !!this.acceptKw('DISTINCT')
    if (!distinct) this.acceptKw('ALL')
    const top = this.peek()
    if (this.isKw(top, 'TOP')) this.fail('TOP is not supported; use LIMIT', top.pos)
    let star: number | null = null
    const items: Item[] = []
    do {
      const t = this.peek()
      if (this.isOp(t, '*')) {
        this.next()
        star = t.pos
      } else items.push(this.selectItem())
      if (star !== null && items.length) this.fail('* cannot be combined with other columns; list the columns instead', star)
    } while (this.acceptOp(','))
    this.expectKw('FROM')
    const from = this.tableRef()
    const comma = this.peek()
    if (this.isOp(comma, ',')) this.fail('Comma joins are not supported; use JOIN ... ON', comma.pos)
    const joins: Join[] = []
    for (;;) {
      const t = this.peek()
      if (this.isKw(t, 'RIGHT', 'FULL', 'CROSS', 'NATURAL')) this.fail(`${t.text.toUpperCase()} JOIN is not supported; use JOIN or LEFT JOIN`, t.pos)
      let left = false
      if (this.isKw(t, 'LEFT')) {
        this.next()
        this.acceptKw('OUTER')
        left = true
        this.expectKw('JOIN')
      } else if (this.isKw(t, 'INNER')) {
        this.next()
        this.expectKw('JOIN')
      } else if (this.isKw(t, 'JOIN')) this.next()
      else break
      const table = this.tableRef()
      const u = this.peek()
      if (this.isKw(u, 'USING')) this.fail('JOIN ... USING is not supported; use ON a.x = b.y', u.pos)
      this.expectKw('ON', 'ON after the joined collection')
      const on = this.expr()
      joins.push({ left, table, on, pos: t.pos })
    }
    const where = this.acceptKw('WHERE') ? this.expr() : null
    const groupBy: Expr[] = []
    if (this.acceptKw('GROUP')) {
      this.expectKw('BY')
      do groupBy.push(this.operand())
      while (this.acceptOp(','))
    }
    const having = this.acceptKw('HAVING') ? this.expr() : null
    const orderBy: OrderItem[] = []
    if (this.acceptKw('ORDER')) {
      this.expectKw('BY')
      do {
        const pos = this.peek().pos
        const expr = this.operand()
        let desc = false
        if (this.acceptKw('DESC')) desc = true
        else this.acceptKw('ASC')
        const n = this.peek()
        if (this.isKw(n, 'NULLS')) this.fail('NULLS FIRST / NULLS LAST is not supported; MongoDB sorts null and missing values first', n.pos)
        orderBy.push({ expr, desc, pos })
      } while (this.acceptOp(','))
    }
    let limit: number | null = null
    let offset: number | null = null
    for (;;) {
      const t = this.peek()
      if (this.isKw(t, 'LIMIT') && limit === null) {
        this.next()
        const a = this.count('LIMIT')
        if (this.acceptOp(',')) {
          // MySQL: LIMIT offset, count
          if (offset !== null) this.fail('OFFSET is given twice', t.pos)
          offset = a
          limit = this.count('LIMIT')
        } else limit = a
      } else if (this.isKw(t, 'OFFSET') && offset === null) {
        this.next()
        offset = this.count('OFFSET')
        if (!this.acceptKw('ROWS')) this.acceptKw('ROW')
      } else break
    }
    if (limit === 0) this.fail('LIMIT 0 returns no rows; MongoDB treats a limit of 0 as no limit', this.toks.find((x) => this.isKw(x, 'LIMIT'))!.pos)
    return { distinct, star, items, from, joins, where, groupBy, having, orderBy, limit, offset }
  }

  private count(what: string): number {
    const t = this.peek()
    if (t.type !== 'number' || !/^\d+$/.test(t.text)) this.fail(`${what} takes a whole number`, t.pos)
    const n = Number(t.text)
    if (!Number.isSafeInteger(n)) this.fail(`${what} is too large`, t.pos)
    this.next()
    return n
  }

  private selectItem(): Item {
    const t = this.peek()
    const expr = this.expr()
    if (expr.k !== 'col' && expr.k !== 'agg') this.fail('Only columns and COUNT, SUM, AVG, MIN and MAX can be selected', t.pos)
    let alias: string | null = null
    const a = this.peek()
    if (this.acceptKw('AS')) {
      const n = this.peek()
      if (n.type === 'string' || n.type === 'name' || (n.type === 'word' && !RESERVED.has(n.text.toUpperCase()))) alias = this.next().value
      else this.fail(`Expected a name after AS but ${this.found(n)}`, n.pos)
    } else if (a.type === 'name' || (a.type === 'word' && !RESERVED.has(a.text.toUpperCase()))) alias = this.next().value
    if (alias !== null && (alias.includes('.') || alias.startsWith('$'))) this.fail('An output name cannot contain "." or start with "$"', a.pos)
    return { expr, alias, pos: t.pos }
  }

  private name(what: string): string {
    const t = this.peek()
    if (t.type === 'name') return this.next().value
    if (t.type === 'word') {
      if (RESERVED.has(t.text.toUpperCase())) this.fail(`Expected ${what} but found the keyword ${t.text.toUpperCase()}; quote it as "${t.text}" to use it as a name`, t.pos)
      return this.next().value
    }
    this.fail(`Expected ${what} but ${this.found(t)}`, t.pos)
  }

  private tableRef(): TableRef {
    const t = this.peek()
    if (this.isOp(t, '(')) this.fail(this.isKw(this.peek(1), 'SELECT') ? 'Subqueries are not supported' : 'Expected a collection name', t.pos)
    const parts = [this.name('a collection name')]
    while (this.isOp(this.peek(), '.')) {
      this.next()
      parts.push(this.name('a collection name'))
    }
    let alias: string | null = null
    if (this.acceptKw('AS')) alias = this.name('an alias')
    else {
      const a = this.peek()
      if (a.type === 'name' || (a.type === 'word' && !RESERVED.has(a.text.toUpperCase()))) alias = this.next().value
    }
    return { collection: parts.join('.'), alias, pos: t.pos }
  }

  expr(): Expr {
    const first = this.and()
    if (!this.isKw(this.peek(), 'OR')) return first
    const items = [first]
    while (this.acceptKw('OR')) items.push(this.and())
    return { k: 'or', items, pos: first.pos }
  }

  private and(): Expr {
    const first = this.not()
    if (!this.isKw(this.peek(), 'AND')) return first
    const items = [first]
    while (this.acceptKw('AND')) items.push(this.not())
    return { k: 'and', items, pos: first.pos }
  }

  private not(): Expr {
    const t = this.peek()
    if (this.acceptKw('NOT')) {
      if (this.isKw(this.peek(), 'EXISTS')) this.fail('EXISTS (subqueries) is not supported', this.peek().pos)
      return { k: 'not', expr: this.not(), pos: t.pos }
    }
    return this.predicate()
  }

  private predicate(): Expr {
    const left = this.operand()
    const t = this.peek()
    if (t.type === 'op' && ['=', '<>', '!=', '<', '<=', '>', '>='].includes(t.text)) {
      this.next()
      const n = this.peek()
      if (this.isKw(n, 'ANY', 'ALL', 'SOME')) this.fail(`${n.text.toUpperCase()} (subqueries) is not supported`, n.pos)
      const right = this.operand()
      const op = (t.text === '!=' ? '<>' : t.text) as CmpOp
      return { k: 'cmp', op, left, right, pos: t.pos }
    }
    if (this.acceptKw('IS')) {
      const negated = !!this.acceptKw('NOT')
      const n = this.peek()
      if (!this.isKw(n, 'NULL')) this.fail(`Only IS NULL and IS NOT NULL are supported, but ${this.found(n)}`, n.pos)
      this.next()
      return { k: 'isnull', expr: left, negated, pos: t.pos }
    }
    let negated = false
    if (this.isKw(t, 'NOT')) {
      const n = this.peek(1)
      if (!this.isKw(n, 'IN', 'BETWEEN', 'LIKE', 'ILIKE')) this.fail(`Expected IN, BETWEEN or LIKE after NOT but ${this.found(n)}`, n.pos)
      this.next()
      negated = true
    }
    const kw = this.peek()
    if (this.acceptKw('IN')) {
      this.expectOp('(')
      if (this.isKw(this.peek(), 'SELECT')) this.fail('Subqueries are not supported', this.peek().pos)
      const list: Expr[] = []
      if (this.isOp(this.peek(), ')')) this.fail('IN needs at least one value', this.peek().pos)
      do list.push(this.operand())
      while (this.acceptOp(','))
      if (!this.isOp(this.peek(), ')')) this.fail(`Expected "," or ")" in the IN list but ${this.found(this.peek())}`, this.peek().pos)
      this.next()
      return { k: 'in', expr: left, list, negated, pos: kw.pos }
    }
    if (this.acceptKw('BETWEEN')) {
      if (this.isKw(this.peek(), 'SYMMETRIC', 'ASYMMETRIC')) this.fail('BETWEEN SYMMETRIC is not supported', this.peek().pos)
      const low = this.operand()
      this.expectKw('AND', 'AND in BETWEEN ... AND ...')
      const high = this.operand()
      return { k: 'between', expr: left, low, high, negated, pos: kw.pos }
    }
    if (this.isKw(kw, 'LIKE', 'ILIKE')) {
      this.next()
      const p = this.peek()
      if (p.type !== 'string') this.fail(`${kw.text.toUpperCase()} takes a pattern in single quotes`, p.pos)
      this.next()
      let escape: string | null = null
      if (this.acceptKw('ESCAPE')) {
        const e = this.peek()
        if (e.type !== 'string' || [...e.value].length !== 1) this.fail('ESCAPE takes one character in single quotes', e.pos)
        escape = this.next().value
      }
      return { k: 'like', expr: left, pattern: p.value, escape, ci: kw.text.toUpperCase() === 'ILIKE', negated, pos: kw.pos }
    }
    return left
  }

  /** A column, value, aggregate call or parenthesised condition. */
  operand(): Expr {
    const e = this.primary()
    const t = this.peek()
    if (t.type === 'op' && ['+', '-', '*', '/', '%', '||'].includes(t.text)) this.fail(`Arithmetic and string operators ("${t.text}") are not supported`, t.pos)
    if (this.isOp(t, '::')) this.fail('Casts ("::") are not supported', t.pos)
    return e
  }

  private primary(): Expr {
    const t = this.peek()
    if (this.isOp(t, '(')) {
      if (this.isKw(this.peek(1), 'SELECT')) this.fail('Subqueries are not supported', this.peek(1).pos)
      this.next()
      const e = this.expr()
      const close = this.peek()
      if (!this.isOp(close, ')')) this.fail(close.type === 'eof' ? 'This parenthesis is never closed' : `Expected ")" but ${this.found(close)}`, close.type === 'eof' ? t.pos : close.pos)
      this.next()
      return e
    }
    if (this.isOp(t, '-', '+')) {
      const n = this.peek(1)
      if (n.type !== 'number') this.fail(`Arithmetic and string operators ("${t.text}") are not supported`, t.pos)
      this.next()
      this.next()
      return numberLit(n.text, t.text === '-', t.pos)
    }
    if (t.type === 'number') {
      this.next()
      return numberLit(t.text, false, t.pos)
    }
    if (t.type === 'string') {
      this.next()
      return { k: 'lit', value: t.value, pos: t.pos }
    }
    if (t.type === 'word') {
      const upper = t.text.toUpperCase()
      const n = this.peek(1)
      if (upper === 'TRUE' || upper === 'FALSE') {
        this.next()
        return { k: 'lit', value: upper === 'TRUE', pos: t.pos }
      }
      if (upper === 'NULL') {
        this.next()
        return { k: 'lit', value: null, pos: t.pos }
      }
      if ((upper === 'DATE' || upper === 'TIMESTAMP') && n.type === 'string') {
        this.next()
        this.next()
        const ok = upper === 'DATE' ? /^\d{4}-\d{2}-\d{2}$/.test(n.value.trim()) : true
        const ms = ok ? parseDateText(n.value) : undefined
        this.usedDate = true
        if (ms === undefined) this.fail(upper === 'DATE' ? `DATE takes 'YYYY-MM-DD', not '${n.value}'` : `'${n.value}' is not a timestamp such as '2024-01-15 10:30:00'`, n.pos)
        return { k: 'lit', value: dateValue(ms), pos: t.pos }
      }
      if (upper === 'CASE') this.fail('CASE is not supported', t.pos)
      if (upper === 'EXISTS') this.fail('EXISTS (subqueries) is not supported', t.pos)
      if (upper === 'INTERVAL') this.fail('INTERVAL is not supported', t.pos)
      if (this.isOp(n, '(')) return this.call()
    }
    if (t.type === 'word' || t.type === 'name') return this.column()
    if (this.isOp(t, '*')) this.fail('* can only be used as SELECT * or COUNT(*)', t.pos)
    this.fail(`Expected a column or a value but ${this.found(t)}`, t.pos)
  }

  private column(): Col {
    const t = this.peek()
    const parts = [this.name('a column')]
    while (this.isOp(this.peek(), '.')) {
      this.next()
      const n = this.peek()
      if (this.isOp(n, '*')) this.fail(`${parts.join('.')}.* is not supported; list the columns`, t.pos)
      if (n.type !== 'word' && n.type !== 'name') this.fail(`Expected a field name after "." but ${this.found(n)}`, n.pos)
      parts.push(this.next().value)
    }
    return { k: 'col', parts, text: parts.join('.'), pos: t.pos }
  }

  private call(): Agg {
    const t = this.next()
    const upper = t.text.toUpperCase()
    const fn = AGGS[upper]
    if (!fn) this.fail(`The function ${upper}() is not supported; only COUNT, SUM, AVG, MIN and MAX are`, t.pos)
    this.expectOp('(')
    let distinct = false
    let arg: Col | null = null
    const a = this.peek()
    if (this.isOp(a, '*')) {
      if (fn !== 'count') this.fail(`${upper}(*) is not valid; only COUNT(*) is`, a.pos)
      this.next()
    } else {
      if (this.acceptKw('DISTINCT')) {
        if (fn !== 'count') this.fail(`${upper}(DISTINCT ...) is not supported; only COUNT(DISTINCT ...) is`, a.pos)
        distinct = true
      } else this.acceptKw('ALL')
      const at = this.peek()
      if (this.isOp(at, '*')) this.fail('COUNT(DISTINCT *) is not valid', at.pos)
      const inner = this.operand()
      if (inner.k === 'agg') this.fail('Aggregate functions cannot be nested', inner.pos)
      if (inner.k !== 'col') this.fail(`${upper}() takes a column`, at.pos)
      arg = inner
    }
    const close = this.peek()
    if (!this.isOp(close, ')')) this.fail(`Expected ")" but ${this.found(close)}`, close.pos)
    this.next()
    const after = this.peek()
    if (this.isKw(after, 'OVER')) this.fail('Window functions (OVER) are not supported', after.pos)
    if (this.isKw(after, 'FILTER')) this.fail('FILTER on aggregates is not supported', after.pos)
    return { k: 'agg', fn, arg, distinct, pos: t.pos }
  }
}

function numberLit(text: string, negative: boolean, pos: number): Lit {
  const n = Number(text) * (negative ? -1 : 1)
  // As in shell-parse: a decimal point or exponent keeps the number a double.
  const value = /[.eE]/.test(text) ? { $numberDouble: doubleText(n) } : numberValue(n)
  return { k: 'lit', value, int: /^\d+$/.test(text) && !negative ? n : undefined, pos }
}

// ---- Filters ----

const isPlainObject = (v: JsonValue | undefined): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v)

/** ANDs filters into one document, merging operators on one field; clashes fall back to $and. */
function mergeAnd(filters: JsonObject[]): JsonObject {
  const flat: JsonObject[] = []
  for (const f of filters) {
    const keys = Object.keys(f)
    if (keys.length === 1 && keys[0] === '$and') flat.push(...(f.$and as JsonObject[]))
    else flat.push(f)
  }
  if (flat.length === 1) return flat[0]!
  const out: JsonObject = {}
  for (const f of flat) {
    for (const [k, v] of Object.entries(f)) {
      if (!(k in out)) {
        out[k] = isPlainObject(v) ? { ...v } : v
        continue
      }
      const prev = out[k]
      if (!k.startsWith('$') && isPlainObject(prev) && isPlainObject(v) && Object.keys(v).every((op) => !(op in prev))) Object.assign(prev, v)
      else return { $and: flat }
    }
  }
  return out
}

function orOf(filters: JsonObject[]): JsonObject {
  const flat: JsonObject[] = []
  for (const f of filters) {
    const keys = Object.keys(f)
    if (keys.length === 1 && keys[0] === '$or') flat.push(...(f.$or as JsonObject[]))
    else flat.push(f)
  }
  return { $or: flat }
}

/** `{ a: { $eq: v } }` → `{ a: v }` and `{ a: { $regex: /x/ } }` → `{ a: /x/ }`. */
function simplify(filter: JsonObject): JsonObject {
  const out: JsonObject = {}
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and' || k === '$or' || k === '$nor') out[k] = (v as JsonObject[]).map(simplify)
    else if (!k.startsWith('$') && isPlainObject(v)) {
      const keys = Object.keys(v)
      out[k] = keys.length === 1 && (keys[0] === '$eq' || keys[0] === '$regex') ? v[keys[0]]! : v
    } else out[k] = v
  }
  return out
}

function likeRegex(pattern: string, escape: string | null, ci: boolean): { regex: JsonValue; literal: string | null } {
  type Piece = { wild: '%' | '_' } | { text: string }
  const pieces: Piece[] = []
  const chars = [...pattern]
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!
    if (escape !== null && c === escape && i + 1 < chars.length) pieces.push({ text: chars[++i]! })
    else if (c === '%' || c === '_') pieces.push({ wild: c })
    else pieces.push({ text: c })
  }
  const hasWild = pieces.some((p) => 'wild' in p)
  const literal = hasWild ? null : pieces.map((p) => ('text' in p ? p.text : '')).join('')
  let start = 0
  let end = pieces.length
  const isPct = (p: Piece | undefined) => !!p && 'wild' in p && p.wild === '%'
  while (start < end && isPct(pieces[start])) start++
  while (end > start && isPct(pieces[end - 1])) end--
  let body = ''
  let dot = false
  let lastPct = false
  for (const p of pieces.slice(start, end)) {
    if ('text' in p) {
      body += p.text.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')
      lastPct = false
    } else if (p.wild === '_') {
      body += '.'
      dot = true
      lastPct = false
    } else if (!lastPct) {
      body += '.*'
      dot = true
      lastPct = true
    }
  }
  // Only % left: any string matches.
  const source = start === pieces.length ? '^' : (start === 0 ? '^' : '') + body + (end === pieces.length ? '$' : '')
  const options = (ci ? 'i' : '') + (dot ? 's' : '')
  return { regex: { $regularExpression: { pattern: source, options } }, literal }
}

type Operand = { kind: 'path'; path: string } | { kind: 'value'; value: JsonValue }

// ---- Translation ----

type Source = { collection: string; alias: string; names: string[]; prefix: string }
type Resolved = { path: string; field: string; source: number }
type Acc = { key: string; name: string; spec: JsonObject; countDistinct: boolean }
type GroupKey = { path: string; name: string }

const sanitize = (s: string): string => s.replace(/[.\s]+/g, '_').replace(/^\$+/, '_') || 'f'
function unique(name: string, used: Set<string>): string {
  let n = name
  for (let i = 2; used.has(n); i++) n = `${name}_${i}`
  used.add(n)
  return n
}
function overlap(a: string, b: string): boolean {
  return a !== b && (a.startsWith(`${b}.`) || b.startsWith(`${a}.`))
}

class Translator {
  readonly notes: string[] = []
  private readonly sources: Source[] = []
  private usedExpr = false

  constructor(
    private readonly q: Select,
    private readonly db: string,
    private readonly fail: Fail
  ) {
    const from = q.from
    this.sources.push({ collection: from.collection, alias: from.alias ?? from.collection, names: from.alias ? [from.alias, from.collection] : [from.collection], prefix: '' })
    for (const j of q.joins) {
      const t = j.table
      const alias = t.alias ?? t.collection
      if (alias.includes('.') || alias.startsWith('$')) this.fail(`Give the joined collection ${t.collection} an alias, as in JOIN ${t.collection} AS x`, t.pos)
      if (alias === '_id') this.fail('A joined collection cannot be named _id', t.pos)
      if (this.sources.some((s) => s.alias === alias || s.names.includes(alias))) this.fail(`The name ${alias} is used for two collections; give one an alias`, t.pos)
      this.sources.push({ collection: t.collection, alias, names: t.alias && !t.collection.includes('.') ? [alias, t.collection] : [alias], prefix: `${alias}.` })
    }
  }

  private note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text)
  }

  private resolve(col: Col, visible = this.sources.length): Resolved {
    for (const p of col.parts) if (p.startsWith('$')) this.fail(`Field names that start with "$" cannot be used: ${col.text}`, col.pos)
    if (col.parts.length > 1) {
      const head = col.parts[0]!
      let idx = this.sources.findIndex((s) => s.names.includes(head))
      if (idx < 0) {
        const ci = this.sources.map((s, i) => (s.names.some((n) => n.toLowerCase() === head.toLowerCase()) ? i : -1)).filter((i) => i >= 0)
        if (ci.length === 1) idx = ci[0]!
      }
      if (idx >= 0) {
        if (idx >= visible) this.fail(`${head} is not joined yet at this point`, col.pos)
        const field = col.parts.slice(1).join('.')
        return { path: this.sources[idx]!.prefix + field, field, source: idx }
      }
    }
    if (this.sources.length > 1) this.note(`Unqualified columns are read from ${this.sources[0]!.collection}; qualify the columns of joined collections with their alias.`)
    const field = col.parts.join('.')
    return { path: field, field, source: 0 }
  }

  /** A condition as a filter document. `neg` pushes a NOT down to the leaves. */
  private cond(e: Expr, neg: boolean, operand: (e: Expr) => Operand): JsonObject {
    switch (e.k) {
      case 'and':
      case 'or': {
        const parts = e.items.map((x) => this.cond(x, neg, operand))
        return (e.k === 'and') !== neg ? mergeAnd(parts) : orOf(parts)
      }
      case 'not':
        return this.cond(e.expr, !neg, operand)
      case 'cmp': {
        let l = operand(e.left)
        let r = operand(e.right)
        let op = neg ? INVERSE[e.op] : e.op
        if (l.kind === 'value' && r.kind === 'value') this.fail('Compare a column with a value; comparing two values is not supported', e.pos)
        if (l.kind === 'value') {
          ;[l, r] = [r, l]
          op = MIRROR[op]
        }
        if (r.kind === 'value' && r.value === null) this.fail('Comparing with NULL is never true in SQL; use IS NULL or IS NOT NULL', e.pos)
        const lp = (l as { path: string }).path
        if (r.kind === 'path') {
          this.usedExpr = true
          this.note('Comparisons between two columns use $expr.')
          return { $expr: { [MQL_OP[op]]: [`$${lp}`, `$${r.path}`] } }
        }
        if (op === '<>') this.noteNegation()
        return { [lp]: { [MQL_OP[op]]: r.value } }
      }
      case 'in': {
        const path = this.pathOf(operand(e.expr), e.expr.pos, 'IN')
        const values = e.list.map((x) => {
          const v = operand(x)
          if (v.kind !== 'value') this.fail('IN lists take values, not columns', x.pos)
          if (v.value === null) this.fail('NULL in an IN list never matches in SQL; use IS NULL', x.pos)
          return v.value
        })
        const not = e.negated !== neg
        if (not) this.noteNegation()
        return { [path]: { [not ? '$nin' : '$in']: values } }
      }
      case 'between': {
        const path = this.pathOf(operand(e.expr), e.expr.pos, 'BETWEEN')
        const bound = (x: Expr): JsonValue => {
          const v = operand(x)
          if (v.kind !== 'value') this.fail('BETWEEN takes values, not columns', x.pos)
          if (v.value === null) this.fail('BETWEEN with NULL is never true in SQL', x.pos)
          return v.value
        }
        const low = bound(e.low)
        const high = bound(e.high)
        if (e.negated !== neg) return { $or: [{ [path]: { $lt: low } }, { [path]: { $gt: high } }] }
        return { [path]: { $gte: low, $lte: high } }
      }
      case 'like': {
        const path = this.pathOf(operand(e.expr), e.expr.pos, 'LIKE')
        const not = e.negated !== neg
        const { regex, literal } = likeRegex(e.pattern, e.escape, e.ci)
        if (not) this.noteNegation()
        if (literal !== null && !e.ci) return { [path]: { [not ? '$ne' : '$eq']: literal } }
        if (!e.ci) this.note('LIKE is case-sensitive, as in SQL; use ILIKE for a case-insensitive match. Patterns become anchored regular expressions.')
        return { [path]: not ? { $not: regex } : { $regex: regex } }
      }
      case 'isnull': {
        const path = this.pathOf(operand(e.expr), e.expr.pos, 'IS NULL')
        const notNull = e.negated !== neg
        if (!notNull) this.note('IS NULL also matches documents where the field is missing.')
        return { [path]: notNull ? { $ne: null } : { $eq: null } }
      }
      case 'col':
      case 'lit':
      case 'agg':
        this.fail('Expected a condition, such as a = 1', e.pos)
    }
  }

  private noteNegation(): void {
    this.note('<>, NOT IN and NOT LIKE also match documents where the field is missing or null, which SQL leaves out.')
  }

  private pathOf(o: Operand, pos: number, what: string): string {
    if (o.kind !== 'path') this.fail(`${what} needs a column on its left`, pos)
    return o.path
  }

  private whereOperand(sources?: Set<number>): (e: Expr) => Operand {
    return (e) => {
      if (e.k === 'lit') return { kind: 'value', value: e.value }
      if (e.k === 'agg') this.fail('Aggregate functions are not allowed in WHERE; use HAVING', e.pos)
      if (e.k !== 'col') this.fail('Expected a column or a value', e.pos)
      const r = this.resolve(e)
      sources?.add(r.source)
      return { kind: 'path', path: r.path }
    }
  }

  private filter(e: Expr, operand: (e: Expr) => Operand): JsonObject {
    return simplify(this.cond(e, false, operand))
  }

  private lookup(j: Join, k: number): JsonObject[] {
    const source = this.sources[k]!
    const equalities: Expr[] = []
    const walk = (e: Expr): void => {
      if (e.k === 'and') e.items.forEach(walk)
      else equalities.push(e)
    }
    walk(j.on)
    const pairs = equalities.map((e) => {
      if (e.k !== 'cmp' || e.op !== '=' || e.left.k !== 'col' || e.right.k !== 'col')
        this.fail('JOIN ... ON supports only equalities between two columns, joined with AND', e.pos)
      const a = this.resolve(e.left, k + 1)
      const b = this.resolve(e.right, k + 1)
      if (a.source === k && b.source < k) return { local: b.path, foreign: a.field }
      if (b.source === k && a.source < k) return { local: a.path, foreign: b.field }
      this.fail(`ON must compare a column of ${source.alias} with a column of an earlier collection`, e.pos)
    })
    let stage: JsonObject
    if (pairs.length === 1) {
      const p = pairs[0]!
      stage = { $lookup: { from: source.collection, localField: p.local, foreignField: p.foreign, as: source.alias } }
      this.note('A $lookup on localField/foreignField also pairs documents whose join fields are both missing or null, which SQL never does.')
    } else {
      const used = new Set<string>()
      const vars = pairs.map((p) => {
        let n = p.local.replace(/[^A-Za-z0-9_]/g, '_')
        if (!/^[a-z]/.test(n)) n = `v_${n}`
        return unique(n, used)
      })
      const letDoc: JsonObject = {}
      pairs.forEach((p, i) => (letDoc[vars[i]!] = `$${p.local}`))
      stage = {
        $lookup: {
          from: source.collection,
          let: letDoc,
          pipeline: [{ $match: { $expr: { $and: pairs.map((p, i) => ({ $eq: [`$${p.foreign}`, `$$${vars[i]}`] })) } } }],
          as: source.alias
        }
      }
    }
    this.note(`${j.left ? 'LEFT JOIN' : 'JOIN'} ${source.collection} becomes $lookup + $unwind; its document is stored in the field "${source.alias}", replacing any field of that name.`)
    const unwind: JsonObject = j.left ? { $unwind: { path: `$${source.alias}`, preserveNullAndEmptyArrays: true } } : { $unwind: `$${source.alias}` }
    return [stage, unwind]
  }

  translate(): Operation {
    const q = this.q
    const base = this.sources[0]!
    const pipeline: JsonObject[] = []

    // WHERE: conditions on the FROM collection alone run before the joins.
    let pre: JsonObject | null = null
    let post: JsonObject | null = null
    if (q.where) {
      const conjuncts = q.where.k === 'and' ? q.where.items : [q.where]
      const before: JsonObject[] = []
      const after: JsonObject[] = []
      for (const c of conjuncts) {
        const used = new Set<number>()
        const f = this.cond(c, false, this.whereOperand(used))
        if ([...used].every((s) => s === 0)) before.push(f)
        else after.push(f)
      }
      if (before.length) pre = simplify(mergeAnd(before))
      if (after.length) post = simplify(mergeAnd(after))
    }
    const lookups = q.joins.flatMap((j, k) => this.lookup(j, k + 1))

    const hasAgg = (e: Expr | null): boolean => {
      if (!e) return false
      switch (e.k) {
        case 'agg':
          return true
        case 'and':
        case 'or':
          return e.items.some(hasAgg)
        case 'not':
          return hasAgg(e.expr)
        case 'cmp':
          return hasAgg(e.left) || hasAgg(e.right)
        case 'in':
          return hasAgg(e.expr) || e.list.some(hasAgg)
        case 'between':
          return hasAgg(e.expr) || hasAgg(e.low) || hasAgg(e.high)
        case 'like':
        case 'isnull':
          return hasAgg(e.expr)
        default:
          return false
      }
    }
    const grouped = q.groupBy.length > 0 || q.items.some((i) => i.expr.k === 'agg') || q.having !== null || q.orderBy.some((o) => hasAgg(o.expr))
    if (q.having && q.groupBy.length === 0 && !hasAgg(q.having)) this.fail('HAVING needs GROUP BY or an aggregate function', q.having.pos)
    if (q.star !== null && (grouped || q.distinct)) this.fail(q.distinct ? 'SELECT DISTINCT * is not supported; list the columns' : 'SELECT * cannot be used with GROUP BY or aggregates; list the columns', q.star)
    if (q.distinct && grouped) this.fail('DISTINCT together with GROUP BY or aggregate functions is not supported', q.items[0]?.pos ?? 0)

    const itemPaths = q.items.map((i) => (i.expr.k === 'col' ? this.resolve(i.expr).path : null))
    const ordinal = (e: Expr, what: string): number | null => {
      if (e.k !== 'lit') return null
      if (!q.items.length) this.fail(`${what} by position needs a column list, not SELECT *`, e.pos)
      if (e.int === undefined || e.int < 1 || e.int > q.items.length) this.fail(`${what} by position takes a number from 1 to ${q.items.length}`, e.pos)
      return e.int - 1
    }
    const aliasItem = (e: Expr): number => (e.k === 'col' && e.parts.length === 1 ? q.items.findIndex((i) => i.alias === e.parts[0]) : -1)

    let op: Operation
    if (grouped || q.distinct) {
      // ---- $group ----
      const keys: GroupKey[] = []
      const keyNames = new Set<string>()
      const keyFor = (path: string): GroupKey | undefined => keys.find((k) => k.path === path)
      const addKey = (path: string): void => {
        if (keyFor(path)) return
        const named = q.items.find((it, n) => itemPaths[n] === path && it.alias)
        keys.push({ path, name: unique(sanitize(named?.alias ?? path), keyNames) })
      }
      if (q.distinct) itemPaths.forEach((p) => addKey(p!))
      for (const g of q.groupBy) {
        const n = ordinal(g, 'GROUP BY') ?? aliasItem(g)
        if (n !== null && n >= 0) {
          if (q.items[n]!.expr.k === 'agg') this.fail('GROUP BY cannot refer to an aggregate function', g.pos)
          addKey(itemPaths[n]!)
        } else if (g.k === 'col') addKey(this.resolve(g).path)
        else this.fail('GROUP BY takes columns', g.pos)
      }

      const accs: Acc[] = []
      const accNames = new Set<string>(['_id'])
      const defaultName = (a: Agg): string => (a.arg ? `${a.fn}_${a.distinct ? 'distinct_' : ''}${sanitize(this.resolve(a.arg).path)}` : 'count')
      const accFor = (a: Agg, preferred: string | null): Acc => {
        const path = a.arg ? this.resolve(a.arg).path : null
        const key = `${a.fn}|${a.distinct}|${path ?? '*'}`
        const found = accs.find((x) => x.key === key)
        if (found) return found
        const name = unique(sanitize(preferred ?? defaultName(a)), accNames)
        const field = `$${path}`
        let spec: JsonObject
        if (a.fn === 'count') {
          if (path === null) spec = { $sum: numberValue(1) }
          else if (a.distinct) spec = { $addToSet: field }
          else spec = { $sum: { $cond: [{ $gt: [field, null] }, numberValue(1), numberValue(0)] } }
        } else {
          spec = { [`$${a.fn}`]: field }
          if (a.fn === 'sum') this.note('SUM ignores values that are not numbers, and gives 0 rather than NULL when there are none.')
        }
        const acc = { key, name, spec, countDistinct: a.fn === 'count' && a.distinct }
        accs.push(acc)
        return acc
      }

      const internal = q.items.map((it, n) => {
        if (it.expr.k === 'agg') return accFor(it.expr, it.alias).name
        const k = keyFor(itemPaths[n]!)
        if (!k) this.fail(`${it.expr.text} must be in GROUP BY or inside an aggregate function`, it.pos)
        return `_id.${k.name}`
      })
      const groupedOperand = (e: Expr): Operand => {
        if (e.k === 'lit') return { kind: 'value', value: e.value }
        const n = aliasItem(e)
        if (n >= 0) return { kind: 'path', path: internal[n]! }
        if (e.k === 'agg') return { kind: 'path', path: accFor(e, null).name }
        if (e.k !== 'col') this.fail('Expected a column or a value', e.pos)
        const k = keyFor(this.resolve(e).path)
        if (!k) this.fail(`${e.text} must be in GROUP BY or inside an aggregate function`, e.pos)
        return { kind: 'path', path: `_id.${k.name}` }
      }
      const having = q.having ? this.filter(q.having, groupedOperand) : null
      const sort: JsonObject = {}
      for (const o of q.orderBy) {
        const n = ordinal(o.expr, 'ORDER BY')
        const path = n !== null ? internal[n]! : (groupedOperand(o.expr) as { kind: 'path'; path: string }).path
        if (o.expr.k !== 'col' && o.expr.k !== 'agg' && n === null) this.fail('ORDER BY takes a column, an output name or an aggregate function', o.pos)
        if (!(path in sort)) sort[path] = numberValue(o.desc ? -1 : 1)
      }

      const project: JsonObject = {}
      const outs = q.items.map((it, n) => it.alias ?? (it.expr.k === 'agg' ? defaultName(it.expr) : itemPaths[n]!))
      this.checkOutputs(outs)
      if (!outs.includes('_id')) project._id = numberValue(0)
      outs.forEach((out, n) => (project[out] = internal[n] === out ? numberValue(1) : `$${internal[n]}`))

      const group: JsonObject = { _id: keys.length ? Object.fromEntries(keys.map((k) => [k.name, `$${k.path}`])) : null }
      for (const a of accs) group[a.name] = a.spec

      if (pre) pipeline.push({ $match: pre })
      pipeline.push(...lookups)
      if (post) pipeline.push({ $match: post })
      pipeline.push({ $group: group })
      const sizes = accs.filter((a) => a.countDistinct)
      if (sizes.length)
        pipeline.push({ $set: Object.fromEntries(sizes.map((a) => [a.name, { $size: { $filter: { input: `$${a.name}`, cond: { $ne: ['$$this', null] } } } }])) })
      if (having) pipeline.push({ $match: having })
      this.tail(pipeline, sort)
      pipeline.push({ $project: project })
      if (!q.orderBy.length) this.note(`${q.distinct ? 'DISTINCT' : 'GROUP BY'} becomes $group, whose results come in no particular order; add ORDER BY to sort them.`)
      if (keys.length === 0) this.note('With no matching documents the aggregation returns no row, where SQL returns one row (COUNT 0, other aggregates NULL).')
      op = { kind: 'aggregate', db: this.db, collection: base.collection, pipeline }
    } else {
      const sort: JsonObject = {}
      for (const o of q.orderBy) {
        const n = ordinal(o.expr, 'ORDER BY') ?? aliasItem(o.expr)
        let path: string
        if (n !== null && n >= 0) path = itemPaths[n]!
        else if (o.expr.k === 'col') path = this.resolve(o.expr).path
        else this.fail('ORDER BY takes a column or an output name', o.pos)
        if (!(path in sort)) sort[path] = numberValue(o.desc ? -1 : 1)
      }
      const aliased = q.items.some((i) => i.alias !== null)
      const outs = q.items.map((it, n) => it.alias ?? itemPaths[n]!)
      this.checkOutputs(outs)
      const project: JsonObject = {}
      if (q.items.length) {
        if (!outs.includes('_id')) project._id = numberValue(0)
        q.items.forEach((it, n) => (project[outs[n]!] = it.alias === null || it.alias === itemPaths[n] ? numberValue(1) : `$${itemPaths[n]}`))
      }
      if (q.joins.length === 0 && !aliased && !this.usedExpr) {
        const find: Operation = { kind: 'find', db: this.db, collection: base.collection, filter: pre ?? {} }
        if (q.items.length) find.projection = project
        if (Object.keys(sort).length) find.sort = sort
        if (q.offset) find.skip = q.offset
        if (q.limit !== null) find.limit = q.limit
        op = find
      } else {
        if (pre) pipeline.push({ $match: pre })
        pipeline.push(...lookups)
        if (post) pipeline.push({ $match: post })
        this.tail(pipeline, sort)
        if (q.items.length) pipeline.push({ $project: project })
        op = { kind: 'aggregate', db: this.db, collection: base.collection, pipeline }
      }
    }
    return op
  }

  private tail(pipeline: JsonObject[], sort: JsonObject): void {
    if (Object.keys(sort).length) pipeline.push({ $sort: sort })
    if (this.q.offset) pipeline.push({ $skip: numberValue(this.q.offset) })
    if (this.q.limit !== null) pipeline.push({ $limit: numberValue(this.q.limit) })
  }

  private checkOutputs(outs: string[]): void {
    outs.forEach((a, n) => {
      outs.slice(0, n).forEach((b) => {
        if (a === b && this.q.items[n]!.alias !== null) this.fail(`Two columns are named ${a}; give one another alias`, this.q.items[n]!.pos)
        if (a === b) this.fail(`${a} is selected twice; give one an alias`, this.q.items[n]!.pos)
        if (overlap(a, b)) this.fail(`The output fields ${b} and ${a} overlap; MongoDB cannot return both, so give one an alias`, this.q.items[n]!.pos)
      })
    })
  }
}

/** Translates one SQL SELECT into a MongoDB find or aggregation, or throws `SqlError`. */
export function sqlToMql(sql: string, db: string): { op: Operation; shell: string; notes: string[] } {
  const fail = failer(sql)
  const parser = new Parser(lex(sql, fail), fail)
  const select = parser.statement()
  const t = new Translator(select, db, fail)
  const op = t.translate()
  if (parser.usedDate) t.notes.push('DATE and TIMESTAMP literals are read as UTC.')
  return { op, shell: operationToShell(op), notes: t.notes }
}
