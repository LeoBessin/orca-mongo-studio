// What the data tabs (import, export and copy, compare, GridFS) share: following a worker job until
// it ends, fetching a finished download in pieces for the save dialog, sending pasted text up in
// pieces, and the clipboard for copy and paste between connections.
import { atom, files, plugin, read, set } from 'orca'
import type { JobState, Namespace } from '../protocol'
import { base64Bytes, joinBytes } from '../shared/base64'
import type { JsonValue } from '../shared/ejson-view'
import type { NodeKind } from '../shared/nodes'
import { errorText } from './state'

/** A job a tab started: its last state, and its download once fetched. */
export type JobBox = {
  jobId: string
  state?: JobState
  /** Polling failed (the worker restarted, say). */
  error?: string
  download?: { name: string; mimeType: string; size: number; fetched: number; ready: boolean; error?: string }
}

/** Downloads fetched from the worker, by job id: kept out of atoms, which hold plain data. */
const fetched = new Map<string, ArrayBuffer>()

export const PIECE_BYTES = 600 * 1024
/** Characters per upload piece: UTF-8 takes at most 3 bytes for each, under the 1 MiB input. */
export const UPLOAD_CHARS = 200_000

/**
 * Follows a job until it ends. `get` answers the tab's current box (the loop stops when the tab
 * closes or starts another job), `put` stores a new one. A finished download is fetched at once,
 * so the save button can offer it on the next press.
 */
export async function followJob(jobId: string, get: () => JobBox | undefined, put: (box: JobBox) => void): Promise<JobState | undefined> {
  let version = 0
  for (;;) {
    if (get()?.jobId !== jobId) return undefined
    let s: JobState
    try {
      s = await plugin.request('job.poll', { jobId, version, waitMs: 15000 }, { timeoutMs: 30000 })
    } catch (error) {
      const box = get()
      if (box?.jobId === jobId) put({ ...box, error: errorText(error) })
      return undefined
    }
    const box = get()
    if (box?.jobId !== jobId) return undefined
    version = s.version
    put({ ...box, state: s })
    if (s.status === 'running') continue
    const d = s.result && 'download' in s.result ? s.result.download : undefined
    if (s.status === 'done' && d) await fetchDownload(jobId, d, get, put)
    return s
  }
}

async function fetchDownload(jobId: string, d: { name: string; mimeType: string; size: number }, get: () => JobBox | undefined, put: (box: JobBox) => void): Promise<void> {
  const update = (download: JobBox['download']): void => {
    const box = get()
    if (box?.jobId === jobId) put({ ...box, download })
  }
  const parts: Uint8Array[] = []
  let offset = 0
  update({ ...d, fetched: 0, ready: false })
  try {
    while (offset < d.size) {
      if (get()?.jobId !== jobId) return
      const r = await plugin.request('job.read', { jobId, offset, size: PIECE_BYTES }, { timeoutMs: 60000 })
      const bytes = base64Bytes(r.base64)
      if (bytes.length === 0) break
      parts.push(bytes)
      offset += bytes.length
      update({ ...d, fetched: offset, ready: false })
    }
    fetched.set(jobId, joinBytes(parts))
    update({ ...d, fetched: offset, ready: true })
  } catch (error) {
    update({ ...d, fetched: offset, ready: false, error: errorText(error) })
  } finally {
    void plugin.request('job.close', { jobId }).catch(() => undefined)
  }
}

/** Offers a fetched download in Orca's save dialog (needs the press that calls it). */
export async function saveDownload(box: JobBox | undefined): Promise<boolean> {
  const d = box?.download
  const data = box ? fetched.get(box.jobId) : undefined
  if (!box || !d?.ready || !data) return false
  const r = await files.saveAs({ suggestedName: d.name, mimeType: d.mimeType, data })
  return r.status === 'saved'
}

/** Forgets a job's download (the tab closed or started over). */
export function dropDownload(box: JobBox | undefined): void {
  if (box) fetched.delete(box.jobId)
}

export async function cancelJob(box: JobBox | undefined): Promise<void> {
  if (box?.state?.status === 'running' || (box && !box.state)) await plugin.request('job.cancel', { jobId: box.jobId })
}

export function jobRunning(box: JobBox | undefined): boolean {
  return Boolean(box && !box.error && (!box.state || box.state.status === 'running' || (box.download && !box.download.ready && !box.download.error)))
}

/** Sends text to the worker in pieces; answers the upload's id. */
export async function uploadText(text: string): Promise<string> {
  let uploadId: string | undefined
  for (let at = 0; at < text.length || at === 0; at += UPLOAD_CHARS) {
    const r = await plugin.request('import.upload', { chunk: text.slice(at, at + UPLOAD_CHARS), ...(uploadId ? { uploadId } : {}) }, { timeoutMs: 60000 })
    uploadId = r.uploadId
  }
  return uploadId!
}

// ---- Clipboard ----

export type Clip =
  | { kind: 'collection'; ns: Namespace; collKind: NodeKind }
  | { kind: 'database'; connectionId: string; db: string }
  | { kind: 'documents'; ns: Namespace; ids: JsonValue[] }

export const clipboard = atom<Clip | null>(null)

export function copyToClipboard(clip: Clip): void {
  set(clipboard, clip)
}

export function clipText(clip: Clip): string {
  if (clip.kind === 'database') return `the ${clip.db} database`
  if (clip.kind === 'collection') return `${clip.ns.db}.${clip.ns.collection}`
  return `${clip.ids.length.toLocaleString('en-US')} document${clip.ids.length === 1 ? '' : 's'} of ${clip.ns.db}.${clip.ns.collection}`
}

export function readClipboard(): Clip | null {
  return read(clipboard)
}

// ---- Words ----

export function bytesText(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function countText(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

/** A job's progress in words: "12,000 of 20,000 documents" or "3.1 MB of 9 MB". */
export function progressText(s: JobState): string {
  const fmt = (n: number): string => (s.unit === 'bytes' ? bytesText(n) : n.toLocaleString('en-US'))
  const unit = s.unit === 'bytes' ? '' : ' documents'
  return s.total !== null ? `${fmt(s.done)} of ${fmt(s.total)}${unit}` : `${fmt(s.done)}${unit}`
}

export function progressPercent(s: JobState): number | undefined {
  if (s.total === null || s.total === 0) return s.status === 'done' ? 100 : undefined
  return Math.max(0, Math.min(100, Math.round((s.done / s.total) * 100)))
}
