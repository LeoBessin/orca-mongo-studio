// Saved tasks and read-only connections over a stand-in worker: saving an export from its tab,
// running it from the Tasks tab, the confirmation before a run that drops, a task blocked by a
// read-only target, reopening a task in its tab and updating it, and read-only marks in the UI.
import { assert, describe, mockHost, mount, test, type MockRequests } from 'orca/testing'
import type { ConnectionsState, JobResult, JobState } from './protocol'
import { emptyConnection } from './shared/model'
import type { Task, TaskRequest } from './shared/tasks'
import * as panel from './panel'

const state: ConnectionsState = {
  connections: [
    { id: 'c1', name: 'Local dev', group: '', subtitle: 'localhost', topology: 'replicaSet', connected: true, readOnly: false },
    { id: 'c2', name: 'Prod', group: '', subtitle: 'prod', topology: 'replicaSet', connected: true, readOnly: true }
  ],
  favourites: [],
  secretsProtection: 'os-keyring'
}
const ns = { connectionId: 'c1', db: 'shop', collection: 'orders' }
const rules = { ignoreFields: [], ignoreOrder: false }

const done = (jobId: string, result: JobResult): JobState => ({ jobId, kind: 'export', status: 'done', version: 3, phase: 'Done', done: 2, total: 2, unit: 'documents', errors: [], errorCount: 0, result, started: 0, ms: 1200 })

function task(id: string, name: string, request: TaskRequest, extra: Partial<Task> = {}): Task {
  return { id, name, request, createdAt: 1, updatedAt: 1, ...extra }
}

const importDrop = task('t-import', 'Reload orders', { kind: 'import', source: { kind: 'path', path: '/data/orders.json' }, options: { format: 'json', mode: 'insert', drop: true, stopOnError: false, indexes: true }, ns })
const copyToProd = task('t-copy', 'Copy to prod', { kind: 'export', source: { kind: 'query', ns, spec: { filter: {}, skip: 0, limit: 0 } }, options: { format: 'collection', collection: { connectionId: 'c2', db: 'shop', collection: 'orders', mode: 'insert', indexes: true, options: true } }, destination: { kind: 'download' } })
const compareTask = task('t-compare', 'Check the archive', { kind: 'compare', a: ns, b: { ...ns, collection: 'archive' }, filter: { status: 'shipped' }, rules: { ignoreFields: ['updatedAt'], ignoreOrder: true } })

function setup(initial: Task[] = [], extra: MockRequests = {}) {
  const calls: Record<string, unknown[]> = {}
  const log = (name: string, input: unknown): void => {
    ;(calls[name] ??= []).push(input)
  }
  let tasks = [...initial]
  let n = 0
  const jobs = new Map<string, JobState>()
  const host = mockHost({
    requests: {
      'connections.state': state,
      'connections.get': ({ id }) => {
        const def = emptyConnection(id, 0)
        def.name = id === 'c2' ? 'Prod' : 'Local dev'
        def.readOnly = id === 'c2'
        return { def, secrets: {} }
      },
      'connections.save': (input) => {
        log('connectionsSave', input)
        return { ok: true, id: input.def.id }
      },
      'tree.children': ({ key }) =>
        /^conn:c\d$/.test(key)
          ? { nodes: [{ key: `${key}/db:shop`, kind: 'db', label: 'shop', hasChildren: true }] }
          : { nodes: [{ key: `${key}/coll:orders`, kind: 'coll', label: 'orders', hasChildren: true }] },
      'tree.details': { title: 'x', subtitle: 'Collection', items: [] },
      'query.run': { queryId: 'q1', offset: 0, docs: [], truncated: [], hasMore: false, stoppedForSize: false, ms: 1 },
      'query.count': { count: 0, approximate: false, ms: 1 },
      'history.list': { history: [], saved: [] },
      'data.count': (input) => {
        log('count', input)
        return { exists: true, count: 1234, kind: 'collection' }
      },
      'tasks.list': () => ({ tasks }),
      'tasks.save': (input) => {
        log('tasksSave', input)
        const id = input.id ?? `t${++n}`
        const t = task(id, input.name.trim(), input.request)
        tasks = input.id ? tasks.map((x) => (x.id === id ? t : x)) : [...tasks, t]
        return { tasks, id }
      },
      'tasks.run': (input) => {
        log('tasksRun', input)
        const jobId = `job${++n}`
        jobs.set(jobId, done(jobId, { kind: 'export', docs: 2, collections: 1, bytes: 30, written: ['/tmp/orders.json'] }))
        return { jobId }
      },
      'tasks.delete': (input) => {
        log('tasksDelete', input)
        tasks = tasks.filter((t) => t.id !== input.id)
        return { tasks }
      },
      'job.poll': ({ jobId }) => jobs.get(jobId)!,
      'job.close': null,
      ...extra
    }
  })
  return { host, calls }
}

const tree = { type: 'Tree', label: 'Connections' }
const taskTable = { type: 'Table', label: 'Saved tasks' }

async function at(host: ReturnType<typeof setup>['host'], key: string, conn = 'c1') {
  const view = await mount(panel, { host })
  await view.expand(tree, `conn:${conn}`)
  await view.expand(tree, `conn:${conn}/db:shop`)
  await view.selectItem(tree, key)
  return view
}

describe('saved tasks', () => {
  test('an export saved from its tab runs again from Saved tasks', async () => {
    const { host, calls } = setup()
    const view = await at(host, 'conn:c1/db:shop/coll:orders')
    await view.press({ label: 'Export: JSON, CSV, BSON or another collection' })
    await view.select({ type: 'RadioGroup', label: 'Save to' }, 'path')
    await view.type({ type: 'Input', label: 'Path' }, '/tmp/orders.json')
    await view.toggle({ type: 'Collapsible', label: 'Save as task' })
    await view.type({ type: 'Input', label: 'Task name' }, 'Nightly orders')
    await view.press({ text: 'Save the export as a task' })
    assert.deepEqual(calls.tasksSave, [{
      name: 'Nightly orders',
      request: {
        kind: 'export',
        source: { kind: 'query', ns, spec: { filter: {}, skip: 0, limit: 0 } },
        options: { format: 'json', json: { layout: 'lines', relaxed: true, pretty: false } },
        destination: { kind: 'path', path: '/tmp/orders.json', overwrite: false }
      }
    }])
    assert.ok(view.find({ text: 'Saved the task "Nightly orders". Run it again from Saved tasks.' }))
    assert.ok(view.find({ text: 'Update "Nightly orders"' }), 'the tab now updates the task it saved')

    await view.press({ type: 'Button', text: 'Saved tasks' })
    assert.equal(view.valueOf({ type: 'Tabs' }), 'tasks')
    assert.deepEqual(view.rowsOf(taskTable), ['t1'])
    assert.ok(view.find({ text: 'Not run yet.' }))
    await view.press({ type: 'Button', text: 'Run' })
    assert.deepEqual(calls.tasksRun, [{ id: 't1' }])
    assert.equal(calls.count, undefined, 'an export to a file drops nothing, so nothing is asked')
    assert.ok(view.find({ text: 'Nightly orders: Wrote 2 documents to /tmp/orders.json.' }))

    // The worker records the run and tells the panel.
    const saved = task('t1', 'Nightly orders', (calls.tasksSave![0] as { request: TaskRequest }).request)
    await view.post('tasks.changed', { tasks: [{ ...saved, lastRun: { at: Date.now(), status: 'done', ms: 1200, summary: 'Wrote 2 documents to /tmp/orders.json.', errorCount: 0 } }] })
    assert.ok(view.find({ type: 'Badge', text: 'Done' }))
    assert.ok(view.find({ text: 'Wrote 2 documents to /tmp/orders.json.' }))
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  })

  test('a run that drops asks first, with the document count', async () => {
    const { host, calls } = setup([importDrop])
    const view = await mount(panel, { host })
    await view.post('ui.navigate', { view: 'tasks' })
    await view.selectRows(taskTable, ['t-import'])
    await view.press({ type: 'Button', text: 'Run' })
    assert.deepEqual(calls.count, [{ ns }])
    assert.ok(view.find({ type: 'Callout', label: 'Drop Local dev · shop.orders?' }))
    assert.ok(view.find({ text: /dropped with its indexes, then the import writes into it\. It holds 1,234 documents now\./ }))
    assert.equal(calls.tasksRun, undefined)
    await view.press({ text: 'Run the task' })
    assert.deepEqual(calls.tasksRun, [{ id: 't-import' }])
  })

  test('a task that writes to a read-only connection can\'t run', async () => {
    const { host } = setup([copyToProd])
    const view = await mount(panel, { host })
    await view.post('ui.navigate', { view: 'tasks' })
    await view.selectRows(taskTable, ['t-copy'])
    assert.equal(view.find({ type: 'Button', text: 'Run' })!.disabled, true)
    assert.ok(view.find({ text: /It writes to Prod, which is read only/ }))
  })

  test('a task reopens in its tab, where it is changed and updated', async () => {
    const { host, calls } = setup([compareTask])
    const view = await mount(panel, { host })
    await view.post('ui.navigate', { view: 'tasks' })
    await view.selectRows(taskTable, ['t-compare'])
    await view.press({ text: 'Open in its tab' })
    assert.equal(view.valueOf({ type: 'Input', label: 'Filter (both sides)' }), "{ status: 'shipped' }")
    assert.equal(view.valueOf({ type: 'Input', label: 'Leave out fields' }), 'updatedAt')
    assert.equal(view.valueOf({ type: 'Checkbox', label: "Field order doesn't count" }), true)
    await view.type({ type: 'Input', label: 'Leave out fields' }, 'updatedAt, meta', { replace: true })
    await view.toggle({ type: 'Collapsible', label: 'Save as task' })
    await view.press({ text: 'Update "Check the archive"' })
    assert.deepEqual(calls.tasksSave, [{ id: 't-compare', name: 'Check the archive', request: { kind: 'compare', a: ns, b: { ...ns, collection: 'archive' }, filter: { status: 'shipped' }, rules: { ignoreFields: ['updatedAt', 'meta'], ignoreOrder: true } } }])
  })

  test('deleting a task asks first', async () => {
    const { host, calls } = setup([compareTask])
    const view = await mount(panel, { host })
    await view.post('ui.navigate', { view: 'tasks' })
    await view.selectRows(taskTable, ['t-compare'])
    await view.press({ label: 'Delete Check the archive' })
    assert.ok(view.find({ type: 'Callout', label: 'Delete the task "Check the archive"?' }))
    await view.press({ text: 'Delete task' })
    assert.deepEqual(calls.tasksDelete, [{ id: 't-compare' }])
    assert.ok(view.find({ type: 'EmptyState' }))
  })

  test('an import of pasted text can\'t be saved; one from a path can', async () => {
    const { host } = setup()
    const view = await at(host, 'conn:c1/db:shop/coll:orders')
    await view.press({ label: 'Import into this collection' })
    assert.ok(view.find({ text: /pasted text can't/ }))
    assert.equal(view.find({ type: 'Collapsible', label: 'Save as task' }), null)
    await view.select({ type: 'RadioGroup', label: 'Source' }, 'path')
    assert.ok(view.find({ type: 'Collapsible', label: 'Save as task' }))
  })
})

describe('read-only connections in the panel', () => {
  test('tabs of a read-only connection say so', async () => {
    const { host } = setup()
    const view = await at(host, 'conn:c2/db:shop/coll:orders', 'c2')
    await view.press({ text: 'Open' })
    assert.ok(view.find({ type: 'Badge', text: 'Read only' }))
    assert.ok(view.find({ type: 'Text', text: 'Prod' }))
    assert.equal(view.find({ type: 'Button', text: 'Insert document' }), null, 'no editing offered')
    assert.equal(view.find({ label: 'Import into this collection' }), null)
  })

  test('a compare or a copy marks only the read-only side it writes to', async () => {
    const { host } = setup()
    const view = await at(host, 'conn:c1/db:shop/coll:orders')
    await view.press({ label: 'Compare with another collection' })
    await view.select({ type: 'Select', label: 'Compare with, on' }, 'c2')
    assert.ok(view.find({ type: 'Badge', text: 'B read only' }))
    assert.equal(view.find({ type: 'Badge', text: 'A read only' }), null)
    await view.select({ type: 'Tabs' }, 'tree')
    await view.press({ label: 'Export: JSON, CSV, BSON or another collection' })
    assert.equal(view.find({ type: 'Badge', text: /read only/i }), null, 'an export to a file writes to no connection')
    await view.select({ type: 'RadioGroup', label: 'Format' }, 'collection')
    await view.select({ type: 'Select', label: 'Connection' }, 'c2')
    assert.ok(view.find({ type: 'Badge', text: 'Into read only' }))
    assert.ok(view.find({ text: 'From: Local dev › shop.orders · Into: Prod › shop.orders_copy' }))
  })

  test('the connection form sets the flag', async () => {
    const { host, calls } = setup()
    const view = await at(host, 'conn:c1')
    await view.press({ label: 'Edit connection' })
    assert.equal(view.valueOf({ type: 'Switch', label: 'Read only' }), false)
    await view.toggle({ type: 'Switch', label: 'Read only' })
    await view.press({ type: 'Button', text: 'Save' })
    assert.equal((calls.connectionsSave![0] as { def: { readOnly: boolean } }).def.readOnly, true)
  })
})
