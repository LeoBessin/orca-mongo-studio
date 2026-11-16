// Turns script text into the statements the shell thread runs, one by one, so each statement's
// value and errors can be reported with its line. Shell commands become calls (`use shop` →
// `use("shop")`), and top-level declarations become assignments to the session's globals, so a
// variable survives into the next run and running a statement twice never fails with "already
// declared". Columns are kept: `const x = 1` becomes `      x = 1`.
import { splitStatements, tokenize, type Token } from './js-scan'

export type PreparedStatement = {
  code: string
  /** 1-based, in the editor. */
  line: number
  column: number
  /** Declarations: run for their effect, their value not shown. */
  quiet: boolean
}

function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ')
}

function hasTopLevelComma(tokens: Token[], from: number): boolean {
  let depth = 0
  for (let j = from; j < tokens.length; j++) {
    const v = tokens[j]!
    if (v.type !== 'punct') continue
    if (v.value === '(' || v.value === '[' || v.value === '{') depth++
    else if (v.value === ')' || v.value === ']' || v.value === '}') depth--
    else if (v.value === ',' && depth === 0) return true
  }
  return false
}

function prepareOne(text: string): { code: string; quiet: boolean } {
  const tokens = tokenize(text)
  const [a, b, c] = tokens
  if (!a) return { code: text, quiet: true }
  const significant = tokens.filter((t) => !(t.type === 'punct' && t.value === ';'))
  // Shell commands: `use shop`, `show collections`, `it`.
  if (a.type === 'ident' && (a.value === 'use' || a.value === 'show') && significant.length === 2 && b && !b.nl && (b.type === 'ident' || b.type === 'string')) {
    const arg = b.type === 'string' ? b.value : JSON.stringify(b.value)
    return { code: `${a.value}(${arg})`, quiet: false }
  }
  if (a.type === 'ident' && (a.value === 'it' || a.value === 'exit' || a.value === 'quit') && significant.length === 1) {
    return { code: `${a.value}()`, quiet: false }
  }
  if (a.type === 'ident' && (a.value === 'const' || a.value === 'let' || a.value === 'var')) {
    // `const x = value`: an assignment, which keeps working when run again.
    if (b?.type === 'ident' && c?.type === 'punct' && c.value === '=' && !hasTopLevelComma(tokens, 3)) {
      return { code: blank(text.slice(0, b.start)) + text.slice(b.start), quiet: true }
    }
    // Patterns and lists: `var` can be declared again.
    return { code: 'var' + ' '.repeat(a.value.length - 3) + text.slice(a.end), quiet: true }
  }
  if (a.type === 'ident' && a.value === 'class' && b?.type === 'ident') {
    return { code: `${b.value} = ${text}`, quiet: true }
  }
  if (a.type === 'ident' && (a.value === 'function' || (a.value === 'async' && b?.value === 'function'))) {
    return { code: text, quiet: true }
  }
  return { code: text, quiet: false }
}

/** `code` starts at `line`/`column` in the editor. */
export function prepareStatements(code: string, line = 1, column = 1): PreparedStatement[] {
  return splitStatements(code).map((s) => {
    const p = prepareOne(s.text)
    return { code: p.code, quiet: p.quiet, line: s.line + line - 1, column: s.line === 1 ? s.column + column - 1 : s.column }
  })
}
