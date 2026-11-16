// Mongo Studio's shell: a custom editor for .mongodb.js files. The file is the script; its header
// comment names the connection and database. The worker runs statements (see src/worker/shell.ts),
// output appears under the editor, and results open in the Mongo Studio panel's Shell tab, which
// pages through them with the panel's Table, Tree and JSON views. The Code and SQL tabs turn the
// statement under the cursor into driver code, and SQL into a statement.
import type { ConnectionSummary, ShellEntry } from '../protocol'
import { CODE_LANGUAGES, generateCode, type CodeLanguage } from '../shared/codegen'
import { statementAt } from '../shared/js-scan'
import { ShellCallError, operationFromStatement } from '../shared/shell-call'
import { SqlError, sqlToMql } from '../shared/sql-to-mql'
import { cachedNames, shellCompletions, type NameSource } from './complete'
import { readHeader, startSync, writeHeader, type ScriptTarget } from './header'
import { editorTheme, PAGE_CSS } from './style'
import {
  autocompletion,
  bracketMatching,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  Compartment,
  crosshairCursor,
  defaultKeymap,
  drawSelection,
  dropCursor,
  EditorState,
  EditorView,
  foldGutter,
  foldKeymap,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSelectionMatches,
  highlightSpecialChars,
  history,
  historyKeymap,
  indentOnInput,
  indentWithTab,
  javascript,
  keymap,
  lineNumbers,
  lintGutter,
  Prec,
  rectangularSelection,
  search,
  searchKeymap,
  setDiagnostics,
  type Diagnostic
} from './vendor/codemirror.js'

// ---- Page ----

const style = document.createElement('style')
style.textContent = PAGE_CSS
document.head.append(style)

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  const { class: cls, ...rest } = props
  if (cls) node.className = cls
  Object.assign(node, rest)
  node.append(...children)
  return node
}

const connectionSelect = el('select', { class: 'field', title: 'Connection' })
const dbInput = el('input', { class: 'field', placeholder: 'database', title: 'Database: pick one or type a new name', spellcheck: false })
const dbList = el('datalist', { id: 'ms-dbs' })
dbInput.setAttribute('list', 'ms-dbs')
const runButton = el('button', { class: 'btn primary', title: 'Run the selection, or the statement under the cursor (Ctrl+Enter)' }, '▶ Run')
const runAllButton = el('button', { class: 'btn', title: 'Run the whole script (Ctrl+Shift+Enter)' }, 'Run script')
const stopButton = el('button', { class: 'btn danger', title: 'Stop the running script', disabled: true }, 'Stop')
const resetButton = el('button', { class: 'btn', title: 'Clear the variables the script defined' }, 'Clear variables')
const status = el('span', { class: 'status' })

const bar = el(
  'div',
  { class: 'bar' },
  el('label', {}, 'Connection', connectionSelect),
  el('label', {}, 'Database', dbInput),
  dbList,
  runButton,
  runAllButton,
  stopButton,
  resetButton,
  el('span', { class: 'grow' }),
  status
)
const editorHost = el('div', { id: 'editor' })
const splitter = el('div', { class: 'splitter', title: 'Drag to resize' })

const TABS = ['output', 'code', 'sql'] as const
type PaneTab = (typeof TABS)[number]
const tabButtons = new Map<PaneTab, HTMLButtonElement>()
const panels = new Map<PaneTab, HTMLDivElement>()
const tabLabels: Record<PaneTab, string> = { output: 'Output', code: 'Code', sql: 'SQL' }
const tabRow = el('div', { class: 'tabs' })
tabRow.setAttribute('role', 'tablist')
const pane = el('div', { class: 'pane' }, tabRow)
for (const id of TABS) {
  const b = el('button', { class: 'tab' }, tabLabels[id])
  b.setAttribute('role', 'tab')
  b.addEventListener('click', () => showTab(id))
  tabButtons.set(id, b)
  tabRow.append(b)
  const p = el('div', { class: 'tabpanel' })
  p.setAttribute('role', 'tabpanel')
  panels.set(id, p)
  pane.append(p)
}
document.body.append(bar, editorHost, splitter, pane)

let currentTab: PaneTab = 'output'
function showTab(id: PaneTab): void {
  currentTab = id
  for (const t of TABS) {
    tabButtons.get(t)!.setAttribute('aria-selected', String(t === id))
    panels.get(t)!.hidden = t !== id
  }
  if (id === 'code') refreshCode()
}
showTab('output')

// The pane's height follows the splitter.
splitter.addEventListener('pointerdown', (e) => {
  splitter.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent): void => {
    const h = Math.max(60, Math.min(window.innerHeight - 140, window.innerHeight - ev.clientY))
    pane.style.height = `${h}px`
  }
  const up = (): void => {
    splitter.removeEventListener('pointermove', move)
    splitter.removeEventListener('pointerup', up)
  }
  splitter.addEventListener('pointermove', move)
  splitter.addEventListener('pointerup', up)
})

function say(text: string, error = false): void {
  status.textContent = text
  status.title = text
  status.classList.toggle('error', error)
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}

// ---- Typography from Orca's editor ----

type Typography = { cssFontFamily: string; fontSize: number; lineHeight: number }
function applyTypography(t: Typography): void {
  const root = document.documentElement.style
  root.setProperty('--ms-font', t.cssFontFamily)
  root.setProperty('--ms-font-size', `${t.fontSize}px`)
  root.setProperty('--ms-line-height', String(t.lineHeight > 4 ? `${t.lineHeight}px` : t.lineHeight || 1.5))
}
if (orca.host.has('editor.readTypography')) {
  orca.host.call('editor.readTypography').then(applyTypography, () => undefined)
  orca.on('editor.typography.changed', (t) => applyTypography(t))
}

// ---- Connections and the script's target ----

let connections: ConnectionSummary[] = []
let target: ScriptTarget = { connection: '', db: '' }
let names: (NameSource & { clear(): void }) | undefined

function connectionId(): string | undefined {
  return connections.find((c) => c.name === target.connection)?.id
}

function renderConnections(): void {
  const chosen = target.connection
  connectionSelect.replaceChildren(el('option', { value: '' }, connections.length ? 'Choose a connection…' : 'No saved connections'))
  for (const c of connections) connectionSelect.append(el('option', { value: c.name }, `${c.name}${c.group ? ` (${c.group})` : ''}`))
  if (chosen && !connections.some((c) => c.name === chosen)) connectionSelect.append(el('option', { value: chosen }, `${chosen} (not found)`))
  connectionSelect.value = chosen
}

async function loadDatabases(): Promise<void> {
  const id = connectionId()
  dbList.replaceChildren()
  if (!id) return
  try {
    const { names: dbs } = await orca.plugin.request('shell.databases', { connectionId: id }, { timeoutMs: 60000 })
    dbList.replaceChildren(...dbs.map((n) => el('option', { value: n })))
  } catch (error) {
    say(`Could not list databases: ${errorText(error)}`, true)
  }
}

function resetNames(): void {
  const id = connectionId()
  const db = target.db
  names = id && db ? cachedNames((collection) => orca.plugin.request('shell.complete', { connectionId: id, db, ...(collection ? { collection } : {}) }, { timeoutMs: 30000 })) : undefined
}

function setTarget(next: ScriptTarget, fromFile: boolean): void {
  const connectionChanged = next.connection !== target.connection
  target = next
  if (connectionSelect.value !== next.connection) renderConnections()
  if (dbInput.value !== next.db && document.activeElement !== dbInput) dbInput.value = next.db
  resetNames()
  if (connectionChanged) void loadDatabases()
  if (!fromFile) writeTargetToFile()
  refreshCode()
}

async function loadConnections(): Promise<void> {
  try {
    const state = await orca.plugin.request('connections.state')
    connections = state.connections
    renderConnections()
    void loadDatabases()
    resetNames()
  } catch (error) {
    say(`Mongo Studio could not list connections: ${errorText(error)}`, true)
  }
}

connectionSelect.addEventListener('change', () => setTarget({ ...target, connection: connectionSelect.value }, false))
dbInput.addEventListener('change', () => setTarget({ ...target, db: dbInput.value.trim() }, false))
orca.plugin.on('connections.changed', (state) => {
  connections = state.connections
  renderConnections()
  resetNames()
})

// ---- The editor ----

const doc = await startSync()
const readOnly = new Compartment()
let applyingOutside = false

const view = new EditorView({
  parent: editorHost,
  state: EditorState.create({
    doc: doc.value,
    extensions: [
      lineNumbers(),
      foldGutter(),
      lintGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ override: [shellCompletions(() => names)], activateOnTyping: true }),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSelectionMatches(),
      search({ top: true }),
      javascript(),
      editorTheme(),
      readOnly.of(EditorState.readOnly.of(doc.readOnly)),
      Prec.highest(
        keymap.of([
          { key: 'Mod-Enter', run: () => (void runCurrent(), true) },
          { key: 'Shift-Mod-Enter', run: () => (void runAll(), true) }
        ])
      ),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !applyingOutside) {
          doc.change(u.state.doc.toString())
          followHeader()
        }
        if (u.selectionSet || u.docChanged) scheduleCode()
      })
    ]
  })
})

doc.onReplace((value) => {
  applyingOutside = true
  const head = Math.min(view.state.selection.main.head, value.length)
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: head } })
  applyingOutside = false
  followHeader()
})

function followHeader(): void {
  const h = readHeader(view.state.doc.toString())
  if (h.connection !== target.connection || h.db !== target.db) setTarget({ connection: h.connection, db: h.db }, true)
}

function writeTargetToFile(): void {
  if (doc.readOnly) return
  const text = view.state.doc.toString()
  const next = writeHeader(text, target)
  if (next === text) return
  // Change only the header line, so the cursor and undo history stay put.
  const h = readHeader(text)
  if (h.line < 0) {
    view.dispatch({ changes: { from: 0, insert: next.slice(0, next.length - text.length) } })
  } else {
    const line = view.state.doc.line(h.line + 1)
    const newLine = next.split('\n')[h.line]!
    view.dispatch({ changes: { from: line.from, to: line.to, insert: newLine } })
  }
}

// ---- Running ----

let running: string | undefined
let diagnostics: Diagnostic[] = []
const output = panels.get('output')!
output.append(el('div', { class: 'empty' }, 'Ctrl+Enter runs the selection or the statement under the cursor; Ctrl+Shift+Enter runs the whole script. Results open in the Mongo Studio panel’s Shell tab.'))

function setRunning(id: string | undefined): void {
  running = id
  runButton.disabled = runAllButton.disabled = id !== undefined
  stopButton.disabled = id === undefined
  resetButton.disabled = id !== undefined
}

function jumpTo(line: number): void {
  const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)))
  view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true })
  view.focus()
}

function gutter(line: number | undefined): HTMLElement {
  const g = el('div', { class: 'gutter' })
  if (line) {
    const a = el('a', { title: `Go to line ${line}` }, `L${line}`)
    a.addEventListener('click', () => jumpTo(line))
    g.append(a)
  }
  return g
}

function renderEntry(e: ShellEntry): HTMLElement {
  const body = el('div')
  if (e.kind === 'result') {
    if (e.summary) body.append(el('div', { class: 'summary' }, e.resultIndex !== undefined ? `${e.summary} · result ${e.resultIndex + 1} in the panel’s Shell tab` : e.summary))
    body.append(el('pre', {}, e.text))
    if (e.note) body.append(el('div', { class: 'note' }, e.note))
    return el('div', { class: 'entry result' }, gutter(e.line), body)
  }
  body.append(el('pre', {}, e.text))
  return el('div', { class: `entry ${e.kind}` }, gutter(e.kind === 'error' ? e.line : undefined), body)
}

function markError(e: Extract<ShellEntry, { kind: 'error' }>): void {
  if (!e.line || e.line > view.state.doc.lines) return
  const line = view.state.doc.line(e.line)
  const from = e.column ? Math.min(line.from + e.column - 1, line.to) : line.from
  diagnostics = [{ from, to: Math.max(line.to, from), severity: 'error', message: e.text }]
  view.dispatch(setDiagnostics(view.state, diagnostics))
}

let starting = false

async function run(code: string, line: number, column: number, what: string): Promise<void> {
  if (running || starting) return
  const id = connectionId()
  if (!target.connection || !id) {
    say(target.connection ? `There is no saved connection named “${target.connection}”.` : 'Choose a connection first.', true)
    connectionSelect.focus()
    return
  }
  if (!target.db) {
    say('Choose a database first.', true)
    dbInput.focus()
    return
  }
  showTab('output')
  diagnostics = []
  view.dispatch(setDiagnostics(view.state, []))
  const header = el('div', { class: 'runline' }, `${what} on ${target.connection} › ${target.db}…`)
  output.replaceChildren(header)
  say('Running…')
  let runId: string
  starting = true
  runButton.disabled = runAllButton.disabled = true
  try {
    runId = (await orca.plugin.request('shell.run', { connectionId: id, db: target.db, code, line, column }, { timeoutMs: 120000 })).runId
  } catch (error) {
    output.append(renderEntry({ kind: 'error', text: errorText(error) }))
    say('Did not run.', true)
    runButton.disabled = runAllButton.disabled = false
    return
  } finally {
    starting = false
  }
  setRunning(runId)
  let after = 0
  let errors = 0
  try {
    for (;;) {
      const p = await orca.plugin.request('shell.poll', { runId, after }, { timeoutMs: 60000 })
      let firstNew: HTMLElement | undefined
      const firstBatch = after === 0
      for (const e of p.entries) {
        const node = renderEntry(e)
        firstNew ??= node
        output.append(node)
        if (e.kind === 'error') {
          errors++
          markError(e)
        }
      }
      after += p.entries.length
      // The top of what just arrived (its summary, not the end of a long result); the first
      // batch shows from the run's own line.
      if (firstBatch) output.scrollTop = 0
      else firstNew?.scrollIntoView({ block: 'start' })
      if (p.done) {
        const secs = p.ms >= 1000 ? `${(p.ms / 1000).toFixed(1)} s` : `${p.ms} ms`
        header.textContent = `${what} on ${target.connection} › ${p.db} · ${secs}`
        if (after === 0) output.append(el('div', { class: 'empty' }, 'Done. Nothing to show: declarations and statements without a value print nothing.'))
        say(errors ? 'Stopped at an error.' : `Done in ${secs}.`, errors > 0)
        break
      }
    }
  } catch (error) {
    output.append(renderEntry({ kind: 'error', text: `Lost track of the run: ${errorText(error)}` }))
    say('Lost track of the run.', true)
  } finally {
    setRunning(undefined)
  }
}

function runCurrent(): Promise<void> {
  const state = view.state
  const sel = state.selection.main
  if (!sel.empty) {
    const line = state.doc.lineAt(sel.from)
    return run(state.sliceDoc(sel.from, sel.to), line.number, sel.from - line.from + 1, 'Ran the selection')
  }
  const text = state.doc.toString()
  const s = statementAt(text, sel.head)
  if (!s) {
    say('Put the cursor in a statement, or select code to run.', true)
    return Promise.resolve()
  }
  return run(s.text, s.line, s.column, `Ran line ${s.line}`)
}

function runAll(): Promise<void> {
  return run(view.state.doc.toString(), 1, 1, 'Ran the script')
}

runButton.addEventListener('click', () => void runCurrent())
runAllButton.addEventListener('click', () => void runAll())
stopButton.addEventListener('click', () => {
  if (running) void orca.plugin.request('shell.cancel', { runId: running }).catch((error) => say(errorText(error), true))
})
resetButton.addEventListener('click', () => {
  void orca.plugin.request('shell.reset').then(
    () => say('Variables cleared.'),
    (error) => say(errorText(error), true)
  )
})

// ---- Copy and save ----

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = el('textarea', { value: text })
    area.style.cssText = 'position:fixed;opacity:0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

const EXTENSIONS: Record<CodeLanguage, string> = { mongosh: 'mongodb.js', node: 'js', python: 'py', java: 'java', csharp: 'cs', php: 'php', ruby: 'rb' }

// ---- Code tab ----

const LANGUAGE_KEY = 'shell.codeLanguage'
const codePanel = panels.get('code')!
const languageSelect = el('select', { class: 'field', title: 'Language' })
for (const l of CODE_LANGUAGES) languageSelect.append(el('option', { value: l.value }, l.label))
languageSelect.value = 'node'
const copyCode = el('button', { class: 'btn' }, 'Copy')
const saveCode = el('button', { class: 'btn' }, 'Save as…')
const codeInfo = el('div')
const codeOut = el('pre', { class: 'code' })
codePanel.append(el('div', { class: 'row' }, el('label', {}, 'Language ', languageSelect), copyCode, saveCode), codeInfo, codeOut)
orca.storage.get(LANGUAGE_KEY).then(
  (v) => {
    if (typeof v === 'string' && CODE_LANGUAGES.some((l) => l.value === v)) {
      languageSelect.value = v
      refreshCode()
    }
  },
  () => undefined
)
languageSelect.addEventListener('change', () => {
  void orca.storage.set(LANGUAGE_KEY, languageSelect.value).catch(() => undefined)
  refreshCode()
})

let codeTimer: ReturnType<typeof setTimeout> | undefined
function scheduleCode(): void {
  if (currentTab !== 'code') return
  clearTimeout(codeTimer)
  codeTimer = setTimeout(refreshCode, 250)
}

function refreshCode(): void {
  if (currentTab !== 'code') return
  const state = view.state
  const sel = state.selection.main
  const text = sel.empty ? statementAt(state.doc.toString(), sel.head)?.text : state.sliceDoc(sel.from, sel.to)
  copyCode.disabled = saveCode.disabled = true
  if (!text) {
    codeInfo.replaceChildren(el('div', { class: 'empty' }, 'Put the cursor in a find or aggregate statement to see it as code.'))
    codeOut.textContent = ''
    return
  }
  try {
    const op = operationFromStatement(text, target.db || 'test')
    codeOut.textContent = generateCode(op, languageSelect.value as CodeLanguage)
    codeInfo.replaceChildren(el('div', { class: 'note' }, `${op.kind} on ${op.db}.${op.collection}`))
    copyCode.disabled = saveCode.disabled = false
  } catch (error) {
    codeOut.textContent = ''
    codeInfo.replaceChildren(el('div', { class: error instanceof ShellCallError ? 'empty' : 'callout error' }, errorText(error)))
  }
}

copyCode.addEventListener('click', () => {
  void copyText(codeOut.textContent ?? '').then((ok) => say(ok ? 'Code copied.' : 'Could not copy: select the code and copy it.', !ok))
})
saveCode.addEventListener('click', () => {
  const lang = languageSelect.value as CodeLanguage
  const save = orca.files?.saveAs
  if (!save) {
    say('Saving needs the Orca desktop app.', true)
    return
  }
  void save({ suggestedName: `query.${EXTENSIONS[lang]}`, mimeType: 'text/plain', data: codeOut.textContent ?? '' }).then(
    (r) => say(r.status === 'saved' ? 'Saved.' : 'Not saved.'),
    (error) => say(errorText(error), true)
  )
})

// ---- SQL tab ----

const sqlPanel = panels.get('sql')!
const sqlInput = el('textarea', { class: 'sql', spellcheck: false, placeholder: "SELECT status, COUNT(*) AS n FROM orders WHERE total > 100 GROUP BY status ORDER BY n DESC" })
const sqlInsert = el('button', { class: 'btn' }, 'Insert into script')
const sqlRun = el('button', { class: 'btn primary' }, '▶ Run')
const sqlOut = el('div')
const sqlActions = el('div', { class: 'row' }, sqlRun, sqlInsert)
sqlActions.style.marginTop = '6px'
sqlPanel.append(sqlInput, sqlActions, sqlOut)
let translated: string | undefined

function translate(): void {
  translated = undefined
  const sql = sqlInput.value
  sqlInsert.disabled = sqlRun.disabled = true
  if (!sql.trim()) {
    sqlOut.replaceChildren(el('div', { class: 'empty' }, 'Type a SELECT to translate it to MongoDB. Joins become $lookup, GROUP BY becomes $group.'))
    return
  }
  try {
    const r = sqlToMql(sql, target.db || 'test')
    translated = r.shell
    const parts: Node[] = [el('pre', { class: 'code' }, r.shell)]
    if (r.notes.length) parts.push(el('ul', { class: 'notes' }, ...r.notes.map((n) => el('li', {}, n))))
    sqlOut.replaceChildren(...parts)
    sqlInsert.disabled = sqlRun.disabled = false
  } catch (error) {
    sqlOut.replaceChildren(el('div', { class: 'callout error' }, error instanceof SqlError ? error.message : errorText(error)))
  }
}
sqlInput.addEventListener('input', translate)
translate()
sqlInsert.addEventListener('click', () => {
  if (!translated || doc.readOnly) return
  const state = view.state
  const line = state.doc.lineAt(state.selection.main.head)
  const at = line.text.trim() ? line.to : line.from
  const insert = `${line.text.trim() ? '\n' : ''}${translated}\n`
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length - 1 } })
  view.focus()
})
sqlRun.addEventListener('click', () => {
  if (translated) void run(translated, 1, 1, 'Ran the SQL translation')
})

// ---- Start ----

view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(doc.readOnly)) })
if (doc.readOnly) say('This file is read only.')
const first = readHeader(doc.value)
target = { connection: first.connection, db: first.db }
dbInput.value = target.db
void loadConnections()
view.focus()
