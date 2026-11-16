// The Server tab: serverStatus in sections with rates between two readings, replica set members,
// current operations and stopping one. Live refresh is a loop of requests that each wait in the
// worker (`waitMs`), since the panel has no timers; a token ends an old loop.
import { plugin } from 'orca'
import type { ServerStatus } from '../protocol'
import { adminTabId, changeAdmin, sayAdmin, showOrAdd, tabOf, type ServerTab } from './admin-state'
import { errorText } from './state'

export const LIVE_MS = 5000

export function serverTabId(connectionId: string): string {
  return adminTabId('server', [connectionId])
}

export async function openServer(connectionId: string): Promise<void> {
  const tab: ServerTab = {
    id: serverTabId(connectionId),
    kind: 'server',
    connectionId,
    title: 'Server',
    loading: false,
    live: false,
    liveToken: 0,
    opsOpen: true,
    opsCapped: false,
    opsLoading: false,
    opsFilter: { idle: false, system: false, nsText: '', minText: '' }
  }
  if (showOrAdd(tab)) await Promise.all([loadStatus(tab.id), loadOps(tab.id)])
}

function setStatus(id: string, status: ServerStatus): void {
  changeAdmin(id, 'server', (t) => ({ previous: t.status, status, statusError: undefined }))
}

export async function loadStatus(id: string): Promise<void> {
  const t = tabOf(id, 'server')
  if (!t) return
  changeAdmin(id, 'server', () => ({ loading: true }))
  try {
    setStatus(id, await plugin.request('server.status', { connectionId: t.connectionId }, { timeoutMs: 30000 }))
  } catch (error) {
    changeAdmin(id, 'server', () => ({ statusError: errorText(error) }))
  } finally {
    changeAdmin(id, 'server', () => ({ loading: false }))
  }
}

export async function loadOps(id: string): Promise<void> {
  const t = tabOf(id, 'server')
  if (!t) return
  const f = t.opsFilter
  const minSecs = f.minText.trim() ? Number(f.minText.trim()) : undefined
  if (minSecs !== undefined && !(minSecs >= 0)) throw new Error('Running for at least: a number of seconds.')
  changeAdmin(id, 'server', () => ({ opsLoading: true }))
  try {
    const r = await plugin.request('server.ops', { connectionId: t.connectionId, filter: { idle: f.idle, system: f.system, ...(f.nsText.trim() ? { ns: f.nsText.trim() } : {}), ...(minSecs ? { minSecs } : {}) } }, { timeoutMs: 30000 })
    changeAdmin(id, 'server', (x) => ({ ops: r.ops, opsCapped: r.capped, opsError: undefined, opSelected: r.ops.some((o) => o.opid === x.opSelected) ? x.opSelected : undefined, confirmKill: r.ops.some((o) => o.opid === x.confirmKill) ? x.confirmKill : undefined }))
  } catch (error) {
    changeAdmin(id, 'server', () => ({ opsError: errorText(error) }))
  } finally {
    changeAdmin(id, 'server', () => ({ opsLoading: false }))
  }
}

/** Turns live refresh on or off. On, it reads the status every LIVE_MS until turned off, the tab
 *  closes, or a reading fails. */
export async function setLive(id: string, live: boolean): Promise<void> {
  const t = tabOf(id, 'server')
  if (!t) return
  const token = t.liveToken + 1
  changeAdmin(id, 'server', () => ({ live, liveToken: token }))
  if (!live) return
  for (;;) {
    const now = tabOf(id, 'server')
    if (!now || !now.live || now.liveToken !== token) return
    try {
      const status = await plugin.request('server.status', { connectionId: now.connectionId, waitMs: LIVE_MS }, { timeoutMs: LIVE_MS + 30000 })
      const after = tabOf(id, 'server')
      if (!after || after.liveToken !== token) return
      setStatus(id, status)
      if (after.opsOpen) await loadOps(id)
    } catch (error) {
      if (tabOf(id, 'server')?.liveToken !== token) return
      changeAdmin(id, 'server', (x) => ({ live: false, liveToken: x.liveToken + 1 }))
      sayAdmin(id, 'danger', `Live refresh stopped: ${errorText(error)}`)
      return
    }
  }
}

/** Per-second rates of the counters between the last two readings. */
export function rates(t: ServerTab): Record<string, number> | undefined {
  const a = t.previous
  const b = t.status
  if (!a || !b || b.at <= a.at) return undefined
  const secs = (b.at - a.at) / 1000
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(b.counters)) {
    const before = a.counters[k]
    if (typeof before === 'number' && v >= before) out[k] = (v - before) / secs
  }
  return out
}

export async function killConfirmed(id: string): Promise<void> {
  const t = tabOf(id, 'server')
  const op = t?.ops?.find((o) => o.opid === t.confirmKill)
  if (!t || !op) return
  await plugin.request('server.killOp', { connectionId: t.connectionId, opid: op.opidValue })
  changeAdmin(id, 'server', () => ({ confirmKill: undefined }))
  sayAdmin(id, 'success', `Asked the server to stop operation ${op.opid}. It stops at its next check, usually within a moment.`)
  await loadOps(id)
}
