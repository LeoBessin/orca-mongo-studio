// The panel's Shell tab over a stand-in worker: a run's results arrive, page, switch, open as a
// query, and show as code.
import { assert, describe, mockHost, mount, test } from 'orca/testing'
import type { ConnectionsState, QueryPage, QuerySpec, ShellRunSummary } from './protocol'
import type { JsonObject } from './shared/ejson-view'
import * as panel from './panel'
import { tabIdFor } from './panel/collection-state'

const state: ConnectionsState = {
  connections: [{ id: 'c1', name: 'Local dev', group: '', subtitle: 'localhost', topology: 'replicaSet', connected: true }],
  favourites: [],
  secretsProtection: 'os-keyring'
}

const run: ShellRunSummary = {
  runId: 'r1',
  connectionId: 'c1',
  connectionName: 'Local dev',
  db: 'shop',
  at: 1_794_832_496_789,
  results: [
    { index: 0, title: '', line: 2, kind: 'docs', count: 2 },
    { index: 1, title: '', line: 4, kind: 'cursor', op: { kind: 'find', db: 'shop', collection: 'orders', filter: { status: 'A' }, sort: { at: { $numberInt: '-1' } }, limit: 5 } }
  ]
}

const docs = (n: number, from = 0): JsonObject[] => Array.from({ length: n }, (_, i) => ({ _id: { $numberInt: String(from + i) }, name: `item ${from + i}` }))

function setup(latest: ShellRunSummary | null = null) {
  const pages: { runId: string; index: number; offset: number }[] = []
  const runs: QuerySpec[] = []
  const host = mockHost({
    requests: {
      'connections.state': state,
      'shell.latest': { run: latest },
      'shell.page': (input): QueryPage => {
        pages.push(input)
        const all = input.index === 0 ? docs(2) : docs(30)
        const slice = all.slice(input.offset, input.offset + input.pageSize)
        return { queryId: `r1:${input.index}`, offset: input.offset, docs: slice, truncated: [], hasMore: input.offset + slice.length < all.length, stoppedForSize: false, ms: 1 }
      },
      'query.run': (input) => {
        runs.push(input.spec)
        return { queryId: 'q1', offset: 0, docs: docs(1), truncated: [], hasMore: false, stoppedForSize: false, ms: 1 }
      },
      'query.count': { count: 1, approximate: false, ms: 1 },
      'history.list': { history: [], saved: [] }
    }
  })
  return { host, pages, runs }
}

describe('the Shell tab', () => {
  test('a run with results opens the tab on its last result, which pages from the worker', async () => {
    const { host, pages } = setup()
    const view = await mount(panel, { host })
    await view.post('shell.results', run)
    assert.equal(view.valueOf({ type: 'Tabs' }), 'shell')
    assert.deepEqual(pages.at(-1), { runId: 'r1', index: 1, offset: 0, pageSize: 50 })
    assert.equal(view.rowsOf({ type: 'Table', label: 'Documents' }).length, 30)
    assert.ok(view.find({ text: /Local dev › shop/ }))
    await view.select({ label: 'Result' }, '0')
    assert.deepEqual(pages.at(-1), { runId: 'r1', index: 0, offset: 0, pageSize: 50 })
    assert.ok(view.find({ text: '1–2 of 2' }))
    assert.equal(view.find({ text: 'Open as query' }), null, 'documents a script built have no query')
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  })

  test('a find opens as a query in its collection tab, and shows as code', async () => {
    const { host, runs } = setup()
    const view = await mount(panel, { host })
    await view.post('shell.results', run)
    await view.toggle({ type: 'Collapsible', label: 'Code' })
    await view.select({ label: 'Language' }, 'python')
    const code = String(view.find({ type: 'CodeView' })!.props.code)
    assert.match(code, /find\(/)
    assert.match(code, /from pymongo import MongoClient/)
    await view.press({ text: 'Open as query' })
    assert.equal(view.valueOf({ type: 'Tabs' }), tabIdFor({ connectionId: 'c1', db: 'shop', collection: 'orders' }))
    assert.deepEqual(runs.at(-1), { filter: { status: 'A' }, sort: { at: { $numberInt: '-1' } }, skip: 0, limit: 5 })
    assert.equal(view.valueOf({ label: 'Filter' }), "{ status: 'A' }")
  })

  test('a panel opened after the run shows it without switching to it', async () => {
    const { host } = setup(run)
    const view = await mount(panel, { host })
    assert.equal(view.valueOf({ type: 'Tabs' }), 'tree')
    assert.ok(view.find({ type: 'Tab', label: 'Shell' }))
    await view.select({ type: 'Tabs' }, 'shell')
    assert.equal(view.rowsOf({ type: 'Table', label: 'Documents' }).length, 30)
    await view.press({ label: 'Close the shell results' })
    assert.equal(view.find({ type: 'Tab', label: 'Shell' }), null)
  })
})
