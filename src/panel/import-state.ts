// The Import tab: into a collection (or a database, for a dump folder) from pasted text or a path
// the worker reads. A preview shows the first documents and, for CSV, the columns with the types
// inferred for them, which the person can change before importing.
import { plugin } from 'orca'
import type { DataSource, ImportFormat, ImportOptions, ImportPreview, Namespace, WriteMode } from '../protocol'
import type { CsvColumn } from '../shared/csv'
import { mappingProblems } from '../shared/csv'
import { adminTabId, changeAdmin, connectionName, numberText, refreshTree, sayAdmin, showOrAdd, tabOf } from './admin-state'
import { cancelJob, dropDownload, followJob, uploadText, type JobBox } from './data-state'
import { errorText } from './state'

export type ImportColumn = CsvColumn & { samples: string[] }
export type ImportTab = {
  id: string
  kind: 'import'
  connectionId: string
  title: string
  notice?: { tone: 'success' | 'danger' | 'neutral'; text: string }
  db: string
  collection: string
  sourceKind: 'paste' | 'path'
  text: string
  /** Rises with each edit of `text`, so an upload is only sent again when it changed. */
  textVersion: number
  upload?: { id: string; version: number }
  path: string
  format: ImportFormat | 'auto'
  csv: { delimiter: string; header: boolean; ignoreEmpty: boolean }
  /** The mapping, once a preview read the columns; edited by the person. */
  columns?: ImportColumn[]
  columnSelected?: string
  mode: WriteMode
  drop: boolean
  stopOnError: boolean
  indexes: boolean
  previewing: boolean
  preview?: ImportPreview
  previewError?: string
  /** Something changed since the preview. */
  stale: boolean
  confirmDrop?: { count: number | null; exists: boolean }
  job?: JobBox
  /** The saved task this tab was opened from, or last saved as. */
  task?: { id: string; name: string }
  taskName: string
}

export const DELIMITERS = [
  { value: ',', label: 'Comma (,)' },
  { value: ';', label: 'Semicolon (;)' },
  { value: 'tab', label: 'Tab' },
  { value: '|', label: 'Pipe (|)' }
]

export function importTabId(connectionId: string, db: string, collection: string): string {
  return adminTabId('import', [connectionId, db, collection])
}

/** Opens (or shows) an Import tab into a collection, or into a database (empty collection). */
export function openImport(target: { connectionId: string; db: string; collection?: string }): void {
  const collection = target.collection ?? ''
  showOrAdd({
    id: importTabId(target.connectionId, target.db, collection),
    kind: 'import',
    connectionId: target.connectionId,
    title: collection ? `Import: ${collection}` : `Import: ${target.db}`,
    db: target.db,
    collection,
    sourceKind: 'paste',
    text: '',
    textVersion: 0,
    path: '',
    format: 'auto',
    csv: { delimiter: ',', header: true, ignoreEmpty: true },
    mode: 'insert',
    drop: false,
    stopOnError: false,
    indexes: true,
    previewing: false,
    stale: false,
    taskName: ''
  })
}

export function setImport(id: string, change: Partial<ImportTab>, staleColumns = false): void {
  changeAdmin(id, 'import', (t) => ({
    ...change,
    stale: true,
    confirmDrop: undefined,
    ...(change.text !== undefined ? { textVersion: t.textVersion + 1 } : {}),
    // A new source, format or layout reads the columns again.
    ...(staleColumns ? { columns: undefined, columnSelected: undefined } : {})
  }))
}

export function setColumn(id: string, name: string, change: Partial<CsvColumn>): void {
  changeAdmin(id, 'import', (t) => ({ columns: t.columns?.map((c) => (c.name === name ? { ...c, ...change } : c)), stale: true }))
}

function delimiterOf(t: ImportTab): string {
  return t.csv.delimiter === 'tab' ? '\t' : t.csv.delimiter
}

function options(t: ImportTab): ImportOptions {
  const o: ImportOptions = { format: t.format, mode: t.mode, drop: t.drop, stopOnError: t.stopOnError, indexes: t.indexes }
  const csvLike = t.format === 'csv' || t.format === 'tsv' || (t.format === 'auto' && (t.preview?.format === 'csv' || t.preview?.format === 'tsv'))
  if (csvLike || t.format === 'auto') {
    o.csv = { delimiter: delimiterOf(t), header: t.csv.header, ignoreEmpty: t.csv.ignoreEmpty }
    if (csvLike && t.columns) o.csv.columns = t.columns.map(({ name, field, type }) => ({ name, field: field.trim(), type }))
  }
  return o
}

async function source(id: string): Promise<DataSource> {
  const t = tabOf(id, 'import')!
  if (t.sourceKind === 'path') {
    if (!t.path.trim()) throw new Error('Enter the path of a file, or of a folder mongodump wrote.')
    return { kind: 'path', path: t.path.trim() }
  }
  if (!t.text.trim()) throw new Error('Paste the documents to import first.')
  if (t.upload && t.upload.version === t.textVersion) return { kind: 'upload', uploadId: t.upload.id }
  const version = t.textVersion
  const uploadId = await uploadText(t.text)
  changeAdmin(id, 'import', () => ({ upload: { id: uploadId, version } }))
  return { kind: 'upload', uploadId }
}

/** Runs `fn` with the source, sending pasted text again once if the worker forgot it. */
async function withSource<T>(id: string, fn: (s: DataSource) => Promise<T>): Promise<T> {
  try {
    return await fn(await source(id))
  } catch (error) {
    if (!/upload has expired/.test(errorText(error))) throw error
    changeAdmin(id, 'import', () => ({ upload: undefined }))
    return fn(await source(id))
  }
}

export async function previewImport(id: string): Promise<void> {
  const t = tabOf(id, 'import')
  if (!t) return
  changeAdmin(id, 'import', () => ({ previewing: true, previewError: undefined }))
  try {
    const p = await withSource(id, (s) => plugin.request('import.preview', { source: s, options: options(tabOf(id, 'import')!), size: 5 }, { timeoutMs: 60000 }))
    changeAdmin(id, 'import', (x) => ({
      preview: p,
      stale: false,
      // Keep the person's mapping when the columns are the same.
      columns: p.columns ? (x.columns && sameColumns(x.columns, p.columns) ? x.columns.map((c, i) => ({ ...c, samples: p.columns![i]!.samples })) : p.columns) : undefined,
      ...(x.format === 'auto' && p.format === 'tsv' ? { csv: { ...x.csv, delimiter: 'tab' } } : {})
    }))
  } catch (error) {
    changeAdmin(id, 'import', () => ({ previewError: errorText(error), preview: undefined }))
  } finally {
    changeAdmin(id, 'import', () => ({ previewing: false }))
  }
}

function sameColumns(a: readonly CsvColumn[], b: readonly CsvColumn[]): boolean {
  return a.length === b.length && a.every((c, i) => c.name === b[i]!.name)
}

/** Problems that stop an import before it starts. */
export function importProblems(t: ImportTab): string[] {
  const out: string[] = []
  const folder = Boolean(t.preview?.folder)
  if (!t.db.trim()) out.push('Enter the database to import into.')
  if (!folder && !t.collection.trim()) out.push('Enter the collection to import into.')
  if (t.columns) out.push(...mappingProblems(t.columns))
  return out
}

/** Start, or ask first when the collection is dropped before. */
export async function startImport(id: string, confirmed = false): Promise<void> {
  // Without a preview, read the source first: it tells a dump folder from a file, and CSV columns.
  if (tabOf(id, 'import') && !tabOf(id, 'import')!.preview) {
    await previewImport(id)
    const error = tabOf(id, 'import')?.previewError
    if (error) throw new Error(error)
  }
  const t = tabOf(id, 'import')
  if (!t) return
  const problems = importProblems(t)
  if (problems.length) throw new Error(problems.join(' '))
  const folder = Boolean(t.preview?.folder)
  if (t.drop && !confirmed && !folder) {
    const c = await plugin.request('data.count', { ns: nsOf(t) })
    if (c.exists) {
      changeAdmin(id, 'import', () => ({ confirmDrop: { count: c.count, exists: c.exists } }))
      return
    }
  }
  changeAdmin(id, 'import', (x) => {
    dropDownload(x.job)
    return { confirmDrop: undefined, job: undefined }
  })
  const ns = nsOf(t)
  const { jobId } = await withSource(id, (s) => plugin.request('import.start', { source: s, options: options(tabOf(id, 'import')!), ns }))
  changeAdmin(id, 'import', () => ({ job: { jobId } }))
  const end = await followJob(jobId, () => tabOf(id, 'import')?.job, (job) => changeAdmin(id, 'import', () => ({ job })))
  const r = end?.result
  if (end?.status === 'done' && r?.kind === 'import') {
    sayAdmin(id, end.errorCount ? 'neutral' : 'success', `Read ${numberText(r.read)} document${r.read === 1 ? '' : 's'}: ${numberText(r.inserted)} inserted${r.updated ? `, ${numberText(r.updated)} updated` : ''}${r.failed ? `, ${numberText(r.failed)} failed` : ''}${r.collections.length > 1 ? ` into ${r.collections.length} collections` : ''}.`)
    await refreshTree(t.connectionId, t.db.trim())
  }
}

/** What the tab would start, for a saved task: only a path can be read again later. */
export function importTaskRequest(t: ImportTab): { source: { kind: 'path'; path: string }; options: ImportOptions; ns: Namespace } {
  if (t.sourceKind !== 'path' || !t.path.trim()) throw new Error('A saved import reads a file or folder by its path: pasted text can\'t be saved. Choose "A file or folder" and enter its path.')
  if (!t.db.trim()) throw new Error('Enter the database to import into.')
  if (!t.preview?.folder && !t.collection.trim()) throw new Error('Enter the collection to import into.')
  if (t.columns) {
    const problems = mappingProblems(t.columns)
    if (problems.length) throw new Error(problems.join(' '))
  }
  return { source: { kind: 'path', path: t.path.trim() }, options: options(t), ns: { connectionId: t.connectionId, db: t.db.trim(), collection: t.preview?.folder ? '' : t.collection.trim() } }
}

export function nsOf(t: ImportTab): Namespace {
  return { connectionId: t.connectionId, db: t.db.trim(), collection: t.collection.trim() }
}

export async function cancelImport(id: string): Promise<void> {
  await cancelJob(tabOf(id, 'import')?.job)
}

export function targetLabel(t: ImportTab): string {
  return `${connectionName(t.connectionId)} · ${t.db || '…'}${t.preview?.folder ? '' : `.${t.collection || '…'}`}`
}
