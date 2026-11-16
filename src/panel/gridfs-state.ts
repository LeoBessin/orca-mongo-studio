// The GridFS tab: a bucket's files, newest first, filtered by name and read a page at a time; a
// selected file's details and text preview; download (save dialog or a path), upload (a path or
// pasted text), rename and delete (asked first).
import { plugin } from 'orca'
import type { GridFile, GridPreview, GridRef } from '../protocol'
import { idKey, isObject, type JsonObject } from '../shared/ejson-view'
import { parseShellDocument, ShellParseError } from '../shared/shell-parse'
import { adminTabId, changeAdmin, refreshTree, sayAdmin, showOrAdd, tabOf } from './admin-state'
import { bytesText, cancelJob, dropDownload, followJob, saveDownload, uploadText, type JobBox } from './data-state'
import { errorText } from './state'

export const GRID_PAGE = 100

export type GridfsTab = {
  id: string
  kind: 'gridfs'
  connectionId: string
  title: string
  notice?: { tone: 'success' | 'danger' | 'neutral'; text: string }
  db: string
  bucket: string
  filter: string
  files?: GridFile[]
  total: number
  loading: boolean
  error?: string
  token: number
  selected?: string
  preview?: { key: string; loading: boolean; data?: GridPreview; error?: string }
  rename: string
  confirmDelete?: string
  download: { destination: 'download' | 'path'; path: string; overwrite: boolean; job?: JobBox }
  upload: { open: boolean; sourceKind: 'path' | 'paste'; path: string; text: string; filename: string; contentType: string; metadata: string; error?: string; job?: JobBox }
}

export function gridfsTabId(connectionId: string, db: string, bucket: string): string {
  return adminTabId('gridfs', [connectionId, db, bucket])
}

export async function openGridfs(connectionId: string, db: string, bucket: string): Promise<void> {
  const id = gridfsTabId(connectionId, db, bucket)
  const fresh = showOrAdd({
    id,
    kind: 'gridfs',
    connectionId,
    title: `Files: ${bucket}`,
    db,
    bucket,
    filter: '',
    total: 0,
    loading: false,
    token: 0,
    rename: '',
    download: { destination: 'download', path: '', overwrite: false },
    upload: { open: false, sourceKind: 'path', path: '', text: '', filename: '', contentType: '', metadata: '' }
  })
  if (fresh) await loadFiles(id)
}

function ref(t: GridfsTab): GridRef {
  return { connectionId: t.connectionId, db: t.db, bucket: t.bucket }
}

/** The first page (or, with `more`, the next one). */
export async function loadFiles(id: string, more = false): Promise<void> {
  const t = tabOf(id, 'gridfs')
  if (!t) return
  const token = t.token + (more ? 0 : 1)
  const skip = more ? (t.files?.length ?? 0) : 0
  changeAdmin(id, 'gridfs', () => ({ loading: true, error: undefined, token }))
  try {
    const r = await plugin.request('gridfs.list', { ...ref(t), ...(t.filter.trim() ? { filename: t.filter.trim() } : {}), skip, limit: GRID_PAGE }, { timeoutMs: 60000 })
    if (tabOf(id, 'gridfs')?.token !== token) return
    changeAdmin(id, 'gridfs', (x) => {
      const files = more ? [...(x.files ?? []), ...r.files] : r.files
      const still = files.some((f) => idKey(f.id) === x.selected)
      return { files, total: r.total, loading: false, ...(still ? {} : { selected: undefined, preview: undefined, confirmDelete: undefined }) }
    })
  } catch (error) {
    if (tabOf(id, 'gridfs')?.token === token) changeAdmin(id, 'gridfs', () => ({ loading: false, error: errorText(error) }))
  }
}

export function selectedFile(t: GridfsTab): GridFile | undefined {
  return t.files?.find((f) => idKey(f.id) === t.selected)
}

export async function selectFile(id: string, key: string | undefined): Promise<void> {
  const t = tabOf(id, 'gridfs')
  const f = t?.files?.find((x) => idKey(x.id) === key)
  changeAdmin(id, 'gridfs', (x) => {
    dropDownload(x.download.job)
    return { selected: key, rename: f?.filename ?? '', confirmDelete: undefined, preview: f ? { key: key!, loading: true } : undefined, download: { ...x.download, job: undefined } }
  })
  if (!t || !f || !key) return
  try {
    const data = await plugin.request('gridfs.preview', { ...ref(t), id: f.id })
    changeAdmin(id, 'gridfs', (x) => (x.selected === key ? { preview: { key, loading: false, data } } : {}))
  } catch (error) {
    changeAdmin(id, 'gridfs', (x) => (x.selected === key ? { preview: { key, loading: false, error: errorText(error) } } : {}))
  }
}

export async function downloadFile(id: string): Promise<void> {
  const t = tabOf(id, 'gridfs')
  const f = t && selectedFile(t)
  if (!t || !f) return
  const d = t.download
  if (d.destination === 'path' && !d.path.trim()) throw new Error('Enter a path, or a folder to save the file into.')
  if (d.destination === 'download' && f.length > 64 * 1024 * 1024) throw new Error(`${f.filename} is ${bytesText(f.length)}, more than the 64 MiB Orca's save dialog takes. Write it to a path.`)
  dropDownload(d.job)
  const { jobId } = await plugin.request('gridfs.download', { ...ref(t), id: f.id, destination: d.destination === 'path' ? { kind: 'path', path: d.path.trim(), overwrite: d.overwrite } : { kind: 'download' } })
  changeAdmin(id, 'gridfs', (x) => ({ download: { ...x.download, job: { jobId } } }))
  const end = await followJob(jobId, () => tabOf(id, 'gridfs')?.download.job, (job) => changeAdmin(id, 'gridfs', (x) => ({ download: { ...x.download, job } })))
  const r = end?.result
  if (end?.status === 'done' && r?.kind === 'export' && r.written) sayAdmin(id, 'success', `Saved ${f.filename} to ${r.written[0]}.`)
}

export async function saveFile(id: string): Promise<void> {
  const t = tabOf(id, 'gridfs')
  if (await saveDownload(t?.download.job)) sayAdmin(id, 'success', `Saved ${t?.download.job?.download?.name ?? 'the file'}.`)
}

export async function renameSelected(id: string): Promise<void> {
  const t = tabOf(id, 'gridfs')
  const f = t && selectedFile(t)
  if (!t || !f) return
  const name = t.rename.trim()
  if (!name) throw new Error('Enter the new name.')
  if (name === f.filename) return
  await plugin.request('gridfs.rename', { ...ref(t), id: f.id, filename: name })
  sayAdmin(id, 'success', `Renamed ${f.filename} to ${name}.`)
  await loadFiles(id)
}

export async function deleteSelected(id: string): Promise<void> {
  const t = tabOf(id, 'gridfs')
  const f = t && selectedFile(t)
  if (!t || !f || t.confirmDelete !== t.selected) return
  await plugin.request('gridfs.delete', { ...ref(t), id: f.id })
  changeAdmin(id, 'gridfs', () => ({ confirmDelete: undefined, selected: undefined, preview: undefined }))
  sayAdmin(id, 'success', `Deleted ${f.filename} and its chunks from ${t.bucket}.`)
  await loadFiles(id)
  await refreshTree(t.connectionId, t.db)
}

export async function uploadFile(id: string): Promise<void> {
  const t = tabOf(id, 'gridfs')
  if (!t) return
  const u = t.upload
  let metadata: JsonObject | undefined
  if (u.metadata.trim()) {
    try {
      const m = parseShellDocument(u.metadata, 'metadata')
      metadata = isObject(m) ? m : undefined
    } catch (error) {
      changeAdmin(id, 'gridfs', (x) => ({ upload: { ...x.upload, error: error instanceof ShellParseError ? error.message : errorText(error) } }))
      return
    }
  }
  const filename = u.filename.trim() || (u.sourceKind === 'path' ? u.path.trim().split('/').pop() ?? '' : '')
  if (!filename) throw new Error('Name the file.')
  if (u.sourceKind === 'path' && !u.path.trim()) throw new Error('Enter the path of the file to upload.')
  if (u.sourceKind === 'paste' && !u.text) throw new Error('Paste the text to upload.')
  changeAdmin(id, 'gridfs', (x) => ({ upload: { ...x.upload, error: undefined, job: undefined } }))
  const source = u.sourceKind === 'path' ? { kind: 'path' as const, path: u.path.trim() } : { kind: 'upload' as const, uploadId: await uploadText(u.text) }
  const { jobId } = await plugin.request('gridfs.upload', { ...ref(t), source, filename, ...(u.contentType.trim() ? { contentType: u.contentType.trim() } : {}), ...(metadata ? { metadata } : {}) })
  changeAdmin(id, 'gridfs', (x) => ({ upload: { ...x.upload, job: { jobId } } }))
  const end = await followJob(jobId, () => tabOf(id, 'gridfs')?.upload.job, (job) => changeAdmin(id, 'gridfs', (x) => ({ upload: { ...x.upload, job } })))
  if (end?.status === 'done' && end.result?.kind === 'gridfs-upload') {
    sayAdmin(id, 'success', `Uploaded ${filename} (${bytesText(end.result.bytes)}).`)
    changeAdmin(id, 'gridfs', (x) => ({ filter: '', upload: { ...x.upload, text: '', filename: '' } }))
    await loadFiles(id)
    await selectFile(id, idKey(end.result.id))
    await refreshTree(t.connectionId, t.db)
  }
}

export async function cancelGridJob(id: string, which: 'download' | 'upload'): Promise<void> {
  const t = tabOf(id, 'gridfs')
  await cancelJob(t?.[which].job)
}
