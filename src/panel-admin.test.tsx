// Administration tabs over a stand-in worker: managing a collection (indexes, validation, rename,
// clear, drop), a database (create collections, profiler, drop), users and roles, the server
// (status, live refresh, current operations) and the Schema Explorer.
import { assert, describe, hostError, mockHost, mount, test, type MockRequests } from 'orca/testing'
import type { CollectionInfo, ConnectionsState, CurrentOp, IndexList, ServerStatus, UsersState } from './protocol'
import type { JsonObject } from './shared/ejson-view'
import { analyzeDocuments } from './shared/schema'
import * as panel from './panel'
import { adminTabId } from './panel/admin-state'
import { manageTabId } from './panel/manage-state'

const state: ConnectionsState = {
  connections: [{ id: 'c1', name: 'Local dev', group: '', subtitle: 'localhost', topology: 'replicaSet', connected: true, readOnly: false }],
  favourites: [],
  secretsProtection: 'os-keyring'
}
const ns = { connectionId: 'c1', db: 'shop', collection: 'orders' }
const int = (n: number) => ({ $numberInt: String(n) })

const indexes = (): IndexList => ({
  indexes: [
    { name: '_id_', key: { _id: int(1) }, kinds: ['unique'], hidden: false, unique: true, size: 4096, ops: 10, spec: { v: int(2), key: { _id: int(1) }, name: '_id_' } },
    { name: 'status_1', key: { status: int(1) }, kinds: [], hidden: false, unique: false, size: 2048, ops: 0, spec: { v: int(2), key: { status: int(1) }, name: 'status_1' } },
    { name: 'ttl_at', key: { at: int(1) }, kinds: ['TTL 3600s'], hidden: false, unique: false, ttl: 3600, size: 1024, spec: { v: int(2), key: { at: int(1) }, name: 'ttl_at', expireAfterSeconds: int(3600) } }
  ],
  building: [],
  ms: 3
})

const collection = (validator: JsonObject | null = { status: { $in: ['shipped', 'pending'] } }): CollectionInfo => ({
  kind: 'collection',
  stats: [{ label: 'Documents', value: '20,000' }, { label: 'Data size', value: '5.1 MB' }],
  count: 20000,
  options: {},
  validator,
  validationLevel: 'strict',
  validationAction: 'error',
  capped: false
})

const users = (): UsersState => ({
  users: [{ user: 'app', db: 'shop', roles: [{ role: 'readWrite', db: 'shop' }], mechanisms: ['SCRAM-SHA-1', 'SCRAM-SHA-256'] }],
  roles: [{ role: 'reporter', db: 'shop', roles: [], privileges: [{ resource: { db: 'shop', collection: 'orders' }, actions: ['find'] }], builtin: false }],
  builtinRoles: ['read', 'readWrite', 'dbAdmin']
})

const status = (at: number, query: number): ServerStatus => ({
  at,
  sections: [
    { title: 'Server', items: [{ label: 'Host', value: 'localhost:27017', code: true }, { label: 'Version', value: '8.0.4' }] },
    { title: 'Connections', items: [{ label: 'Open', value: '7' }] }
  ],
  counters: { 'op.query': query, 'op.insert': 0, 'net.in': 1000, 'net.out': 2000 },
  members: [{ name: 'localhost:27017', state: 'PRIMARY', health: 1, self: true }],
  ms: 2
})

const op = (opid: number, secs: number): CurrentOp => ({ opid: String(opid), opidValue: opid, op: 'query', ns: 'shop.orders', secs, active: true, client: '127.0.0.1:5000', app: 'reports', command: '{"find":"orders","filter":{"$where":"sleep(100)"}}', raw: '{}' })

const sample: JsonObject[] = Array.from({ length: 20 }, (_, i) => ({ _id: int(i), status: i % 4 ? 'shipped' : 'pending', total: { $numberDouble: String(10 + i * 2.5) }, items: [{ sku: `s${i % 3}` }] }))

type Calls = Record<string, unknown[]>

function setup(extra: MockRequests = {}) {
  const calls: Calls = {}
  const log = (name: string) => (input: unknown) => {
    ;(calls[name] ??= []).push(input)
  }
  let list = indexes()
  let coll = collection()
  let userState = users()
  let reads = 0
  const host = mockHost({
    requests: {
      'connections.state': state,
      'data.count': ({ ns }) => ({ exists: ns.collection === 'archive', count: ns.collection === 'archive' ? 77 : null, kind: 'collection' }),
      'tree.children': ({ key }) =>
        key === 'conn:c1'
          ? { nodes: [{ key: 'conn:c1/db:shop', kind: 'db', label: 'shop', hasChildren: true }] }
          : key === 'conn:c1/db:shop'
            ? {
                nodes: [
                  { key: 'conn:c1/db:shop/coll:orders', kind: 'coll', label: 'orders', hasChildren: true },
                  { key: 'conn:c1/db:shop/users', kind: 'users', label: 'Users', hasChildren: true }
                ]
              }
            : key === 'conn:c1/db:shop/coll:orders'
              ? { nodes: [{ key: 'conn:c1/db:shop/coll:orders/indexes', kind: 'indexes', label: 'Indexes', hasChildren: true }] }
              : { nodes: [{ key: 'conn:c1/db:shop/coll:orders/indexes/index:ttl_at', kind: 'index', label: 'ttl_at', hasChildren: false }] },
      'tree.details': { title: 'x', subtitle: 'Collection', items: [] },
      'connections.delete': null,
      'admin.collection': () => coll,
      'admin.indexes': () => list,
      'admin.createIndex': (input) => {
        log('createIndex')(input)
        const name = (input.options.name as string | undefined) ?? 'total_-1'
        list = { ...list, indexes: [...list.indexes, { name, key: input.key, kinds: [], hidden: false, unique: false, spec: { key: input.key, name } }] }
        return { name }
      },
      'admin.modifyIndex': (input) => {
        log('modifyIndex')(input)
        list = { ...list, indexes: list.indexes.map((i) => (i.name === input.name ? { ...i, ...(input.hidden !== undefined ? { hidden: input.hidden } : {}), ...(input.expireAfterSeconds !== undefined ? { ttl: input.expireAfterSeconds } : {}) } : i)) }
        return null
      },
      'admin.dropIndex': (input) => {
        log('dropIndex')(input)
        list = { ...list, indexes: list.indexes.filter((i) => i.name !== input.name) }
        return null
      },
      'admin.setValidation': (input) => {
        log('setValidation')(input)
        coll = { ...coll, validator: input.validator, validationLevel: input.level, validationAction: input.action }
        return null
      },
      'admin.checkValidation': (input) => {
        log('checkValidation')(input)
        return { failing: 12, checked: 20000, ms: 4, firstId: int(7) }
      },
      'admin.renameCollection': (input) => {
        log('renameCollection')(input)
        return null
      },
      'admin.clearCollection': (input) => {
        log('clearCollection')(input)
        return { deleted: 20000 }
      },
      'admin.dropCollection': (input) => {
        log('dropCollection')(input)
        return null
      },
      'admin.convertToCapped': null,
      'admin.database': {
        stats: [{ label: 'Collections', value: 2 }],
        documents: 20000,
        collections: [
          { name: 'orders', kind: 'collection' },
          { name: 'shipped', kind: 'view' }
        ]
      },
      'admin.createCollection': (input) => {
        log('createCollection')(input)
        return null
      },
      'admin.dropDatabase': (input) => {
        log('dropDatabase')(input)
        return null
      },
      'profiler.status': { level: 0, slowms: 100, sampleRate: 1 },
      'profiler.set': (input) => {
        log('profilerSet')(input)
        return { level: input.level, slowms: input.slowms, sampleRate: input.sampleRate }
      },
      'profiler.entries': (input) => {
        log('profilerEntries')(input)
        return { entries: [{ key: 'p0', at: 1_794_832_496_789, op: 'query', ns: 'shop.orders', ms: 230, plan: 'COLLSCAN', docsExamined: 20000, returned: 3, command: '{"find":"orders"}', raw: '{\n  "op": "query"\n}' }], ms: 2 }
      },
      'users.list': () => userState,
      'users.save': (input) => {
        log('usersSave')(input)
        if (input.isNew) userState = { ...userState, users: [...userState.users, { user: input.draft.user, db: 'shop', roles: input.draft.roles, mechanisms: ['SCRAM-SHA-256'] }] }
        return null
      },
      'users.drop': (input) => {
        log('usersDrop')(input)
        userState = { ...userState, users: userState.users.filter((u) => u.user !== input.user) }
        return null
      },
      'roles.save': (input) => {
        log('rolesSave')(input)
        return null
      },
      'roles.drop': null,
      'server.status': (input) => {
        log('status')(input)
        reads++
        return status(1000 * reads, 100 * reads * reads)
      },
      'server.ops': (input) => {
        log('ops')(input)
        return { ops: [op(4242, 12), op(17, 1)], capped: false, ms: 1 }
      },
      'server.killOp': (input) => {
        log('killOp')(input)
        return null
      },
      'schema.analyze': (input) => {
        log('analyze')(input)
        return { report: JSON.stringify(analyzeDocuments(sample, {}, input.size, 5)) }
      },
      ...extra
    }
  })
  return { host, calls }
}

const tree = { type: 'Tree', label: 'Connections' }

async function atCollection(host: ReturnType<typeof setup>['host']) {
  const view = await mount(panel, { host })
  await view.expand(tree, 'conn:c1')
  await view.expand(tree, 'conn:c1/db:shop')
  await view.selectItem(tree, 'conn:c1/db:shop/coll:orders')
  return view
}

const MANAGE = manageTabId(ns)

describe('managing a collection', () => {
  test('the tree opens the Manage tab with statistics and indexes', async () => {
    const { host } = setup()
    const view = await atCollection(host)
    await view.press({ label: 'Manage the collection: indexes, validation, rename, drop' })
    assert.equal(view.valueOf({ type: 'Tabs' }), MANAGE)
    assert.ok(view.find({ text: 'shop.orders' }))
    assert.equal(view.rowsOf({ type: 'Table', label: 'Indexes' }).length, 3)
    assert.ok(view.find({ type: 'KeyValue', label: 'Statistics' }))
    assert.deepEqual(view.columnsOf({ type: 'Table', label: 'Indexes' }, { width: 420 }), ['name', 'key', 'size'])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  })

  test('an index node opens the Manage tab with that index selected', async () => {
    const { host } = setup()
    const view = await atCollection(host)
    await view.expand(tree, 'conn:c1/db:shop/coll:orders')
    await view.expand(tree, 'conn:c1/db:shop/coll:orders/indexes')
    await view.selectItem(tree, 'conn:c1/db:shop/coll:orders/indexes/index:ttl_at')
    await view.press({ text: 'Manage indexes' })
    assert.deepEqual(view.find({ type: 'Table', label: 'Indexes' })!.props.selected, ['i:ttl_at'])
    assert.equal(view.valueOf({ type: 'Input', label: 'Expire after (seconds)' }), '3600')
  })

  test('New index builds the key and options from the form, and shows mistakes first', async () => {
    const { host, calls } = setup()
    const view = await atCollection(host)
    await view.press({ label: 'Manage the collection: indexes, validation, rename, drop' })
    await view.press({ text: 'New index' })
    await view.press({ text: 'Create index' })
    assert.ok(view.find({ text: 'Add at least one field.' }))
    assert.equal(calls.createIndex, undefined)
    await view.type({ type: 'Input', label: 'Field 1' }, 'total')
    await view.select({ type: 'Select', label: 'Field 1 kind' }, '-1')
    await view.press({ text: 'Add a field' })
    await view.type({ type: 'Input', label: 'Field 2' }, 'status')
    await view.toggle({ type: 'Checkbox', label: 'Unique' })
    await view.type({ type: 'Textarea', label: 'Partial filter' }, '{ total: { $gt: 0 } }')
    assert.equal(view.find({ type: 'CodeView', label: 'mongosh' })!.props.code, 'db.orders.createIndex({ total: -1, status: 1 }, { unique: true, partialFilterExpression: { total: { $gt: 0 } } })')
    await view.press({ text: 'Create index' })
    assert.deepEqual(calls.createIndex, [{ ns, key: { total: int(-1), status: int(1) }, options: { unique: true, partialFilterExpression: { total: { $gt: int(0) } } } }])
    assert.ok(view.find({ text: 'Index total_-1 created.' }))
    assert.equal(view.find({ text: 'Create index' }), null, 'the form closes')
    assert.deepEqual(view.find({ type: 'Table', label: 'Indexes' })!.props.selected, ['i:total_-1'])
  })

  test('hide, change a TTL, and drop with a confirmation', async () => {
    const { host, calls } = setup()
    const view = await atCollection(host)
    await view.press({ label: 'Manage the collection: indexes, validation, rename, drop' })
    const table = { type: 'Table', label: 'Indexes' }
    await view.selectRows(table, ['i:_id_'])
    assert.equal(view.find({ text: 'Drop' }), null, 'the _id index has no drop')
    await view.selectRows(table, ['i:status_1'])
    await view.press({ text: 'Hide' })
    assert.deepEqual(calls.modifyIndex, [{ ns, name: 'status_1', hidden: true }])
    assert.ok(view.find({ text: /status_1 is hidden/ }))
    await view.selectRows(table, ['i:ttl_at'])
    await view.type({ type: 'Input', label: 'Expire after (seconds)' }, '7200', { replace: true })
    await view.press({ text: 'Change TTL' })
    assert.deepEqual(calls.modifyIndex![1], { ns, name: 'ttl_at', expireAfterSeconds: 7200 })
    await view.press({ text: 'Drop' })
    assert.ok(view.find({ type: 'Callout', label: 'Drop ttl_at from shop.orders?' }))
    await view.press({ text: 'Drop index' })
    assert.deepEqual(calls.dropIndex, [{ ns, name: 'ttl_at' }])
    assert.equal(view.rowsOf(table).length, 2)
  })

  test('validation: loads the rules, checks documents, saves and reports parse errors', async () => {
    const { host, calls } = setup()
    const view = await atCollection(host)
    await view.press({ label: 'Manage the collection: indexes, validation, rename, drop' })
    await view.toggle({ type: 'Collapsible', label: 'Validation' })
    const editor = { type: 'Textarea', label: 'Validator' }
    assert.equal(view.valueOf(editor), "{\n  status: {\n    $in: [\n      'shipped',\n      'pending'\n    ]\n  }\n}")
    await view.press({ text: 'Check documents' })
    assert.deepEqual(calls.checkValidation, [{ ns, validator: { status: { $in: ['shipped', 'pending'] } } }])
    assert.ok(view.find({ text: /12 of 20,000 documents break these rules, the first with _id 7/ }))
    await view.type(editor, '{ status: ', { replace: true })
    await view.press({ text: 'Save rules' })
    assert.ok(view.find({ text: /text ended/ }))
    assert.equal(calls.setValidation, undefined)
    await view.type(editor, "{ status: { $exists: true } }", { replace: true })
    await view.select({ type: 'Select', label: 'Action' }, 'warn')
    await view.press({ text: 'Save rules' })
    assert.deepEqual(calls.setValidation, [{ ns, validator: { status: { $exists: true } }, level: 'strict', action: 'warn' }])
    await view.type(editor, '', { replace: true })
    await view.press({ text: 'Save rules' })
    assert.deepEqual((calls.setValidation![1] as { validator: unknown }).validator, null)
    assert.ok(view.find({ text: 'Validation rules removed.' }))
  })

  test('clear and drop name the namespace and count; drop closes its tabs', async () => {
    const { host, calls } = setup()
    const view = await atCollection(host)
    await view.press({ text: 'Open' })
    await view.select({ type: 'Tabs' }, 'tree')
    await view.press({ label: 'Manage the collection: indexes, validation, rename, drop' })
    await view.toggle({ type: 'Collapsible', label: 'Rename, clear and drop' })
    await view.press({ text: 'Delete all documents' })
    assert.ok(view.find({ type: 'Callout', label: 'Delete every document in shop.orders?' }))
    assert.ok(view.find({ text: /20,000 documents are deleted/ }))
    await view.press({ text: 'Delete documents' })
    assert.deepEqual(calls.clearCollection, [{ ns }])
    await view.press({ text: 'Drop collection' })
    assert.ok(view.find({ text: /removed with 20,000 documents and its 3 indexes/ }))
    const drops = view.findAll({ type: 'Button', text: 'Drop collection' })
    await view.press(drops[drops.length - 1]!)
    assert.deepEqual(calls.dropCollection, [{ ns }])
    assert.equal(view.valueOf({ type: 'Tabs' }), 'tree')
    assert.ok(view.find({ text: 'shop.orders was dropped, with its documents and indexes.' }))
    assert.equal(view.find({ type: 'Tab', label: 'orders' }), null, 'the collection tab closed too')
  })

  test('rename moves the tab to the new name', async () => {
    const { host, calls } = setup()
    const view = await atCollection(host)
    await view.press({ label: 'Manage the collection: indexes, validation, rename, drop' })
    await view.toggle({ type: 'Collapsible', label: 'Rename, clear and drop' })
    await view.type({ type: 'Input', label: 'New name' }, 'orders_2025')
    await view.press({ text: 'Rename' })
    assert.deepEqual(calls.renameCollection, [{ ns, to: 'orders_2025', dropTarget: false }])
    assert.equal(view.valueOf({ type: 'Tabs' }), manageTabId({ ...ns, collection: 'orders_2025' }))
    assert.ok(view.find({ text: 'shop.orders is now shop.orders_2025.' }))
  })

  test('renaming over a collection that exists asks first, with its count', async () => {
    const { host, calls } = setup()
    const view = await atCollection(host)
    await view.press({ label: 'Manage the collection: indexes, validation, rename, drop' })
    await view.toggle({ type: 'Collapsible', label: 'Rename, clear and drop' })
    await view.type({ type: 'Input', label: 'New name' }, 'archive')
    await view.toggle({ type: 'Checkbox', label: 'Replace a collection that has the name' })
    await view.press({ text: 'Rename' })
    assert.equal(calls.renameCollection, undefined, 'nothing renamed yet')
    assert.ok(view.find({ type: 'Callout', label: 'Replace shop.archive?' }))
    assert.ok(view.find({ text: /shop\.archive on Local dev is dropped with its 77 documents and its indexes, then shop\.orders takes its name/ }))
    await view.press({ text: 'Replace and rename' })
    assert.deepEqual(calls.renameCollection, [{ ns, to: 'archive', dropTarget: true }])
  })
})

describe('managing a database', () => {
  const DB = adminTabId('database', ['c1', 'shop'])

  async function atDatabase(host: ReturnType<typeof setup>['host']) {
    const view = await mount(panel, { host })
    await view.expand(tree, 'conn:c1')
    await view.selectItem(tree, 'conn:c1/db:shop')
    await view.press({ text: 'Manage' })
    return view
  }

  test('creates capped and time-series collections from the form', async () => {
    const { host, calls } = setup()
    const view = await atDatabase(host)
    assert.equal(view.valueOf({ type: 'Tabs' }), DB)
    assert.equal(view.rowsOf({ type: 'Table', label: 'Collections' }).length, 2)
    await view.toggle({ type: 'Collapsible', label: 'Create a collection' })
    await view.press({ text: 'Create collection' })
    assert.ok(view.find({ text: 'Give the collection a name.' }))
    await view.type({ type: 'Input', label: 'Name' }, 'log')
    await view.select({ type: 'RadioGroup', label: 'Kind' }, 'capped')
    await view.type({ type: 'Input', label: 'Size (bytes)' }, '65536')
    await view.type({ type: 'Input', label: 'Most documents' }, '100')
    assert.equal(view.find({ type: 'CodeView', label: 'mongosh' })!.props.code, "db.getSiblingDB('shop').createCollection('log', { capped: true, size: 65536, max: 100 })")
    await view.press({ text: 'Create collection' })
    assert.deepEqual(calls.createCollection, [{ connectionId: 'c1', db: 'shop', spec: { name: 'log', kind: 'capped', capped: { size: 65536, max: 100 } } }])
    assert.ok(view.find({ text: 'shop.log created.' }))
    await view.type({ type: 'Input', label: 'Name' }, 'metrics')
    await view.select({ type: 'RadioGroup', label: 'Kind' }, 'timeseries')
    await view.type({ type: 'Input', label: 'Time field' }, 'ts')
    await view.type({ type: 'Input', label: 'Meta field' }, 'host')
    await view.select({ type: 'Select', label: 'Granularity' }, 'minutes')
    await view.type({ type: 'Input', label: 'Delete documents after (seconds)' }, '3600')
    await view.press({ text: 'Create collection' })
    assert.deepEqual((calls.createCollection![1] as { spec: unknown }).spec, { name: 'metrics', kind: 'timeseries', timeseries: { timeField: 'ts', metaField: 'host', granularity: 'minutes', expireAfterSeconds: 3600 } })
  })

  test('profiler: apply a level and read entries', async () => {
    const { host, calls } = setup()
    const view = await atDatabase(host)
    await view.toggle({ type: 'Collapsible', label: 'Profiler' })
    await view.select({ type: 'RadioGroup', label: 'Record' }, '1')
    await view.type({ type: 'Input', label: 'Slow means over (ms)' }, '50', { replace: true })
    await view.press({ text: 'Apply' })
    assert.deepEqual(calls.profilerSet, [{ connectionId: 'c1', db: 'shop', level: 1, slowms: 50, sampleRate: 1 }])
    assert.ok(view.find({ text: 'The profiler records operations slower than 50 ms.' }))
    await view.select({ type: 'Select', label: 'Operation' }, 'query')
    await view.type({ type: 'Input', label: 'Slower than (ms)' }, '100')
    await view.press({ text: 'Read entries' })
    assert.deepEqual(calls.profilerEntries, [{ connectionId: 'c1', db: 'shop', filter: { op: 'query', minMs: 100 }, limit: 100 }])
    await view.selectRows({ type: 'Table', label: 'Profiler entries' }, ['p0'])
    assert.ok(view.find({ type: 'CodeView', label: 'Profiler entry' }))
  })

  test('dropping the database asks for its name', async () => {
    const { host, calls } = setup()
    const view = await atDatabase(host)
    await view.toggle({ type: 'Collapsible', label: 'Drop the database' })
    assert.ok(view.find({ text: /Every collection \(2\), document \(20,000\), index and user of shop on Local dev is deleted/ }))
    const drop = { type: 'Button', text: 'Drop database' }
    assert.equal(view.find(drop)!.disabled, true)
    await view.type({ type: 'Input', label: 'Database name' }, 'shop')
    await view.press(drop)
    assert.deepEqual(calls.dropDatabase, [{ connectionId: 'c1', db: 'shop' }])
    assert.equal(view.valueOf({ type: 'Tabs' }), 'tree')
    assert.ok(view.find({ text: 'The database shop was dropped, with every collection in it.' }))
  })

  test('a new database is made with its first collection', async () => {
    const { host, calls } = setup()
    const view = await mount(panel, { host })
    await view.selectItem(tree, 'conn:c1')
    await view.press({ label: 'New database' })
    await view.type({ type: 'Input', label: 'Database name' }, 'inventory')
    assert.ok(view.find({ text: 'Local dev › inventory' }), 'a new database names the one it creates')
    await view.type({ type: 'Input', label: 'Name' }, 'items')
    await view.press({ text: 'Create database' })
    assert.deepEqual(calls.createCollection, [{ connectionId: 'c1', db: 'inventory', spec: { name: 'items', kind: 'plain' } }])
    assert.equal(view.valueOf({ type: 'Tabs' }), adminTabId('database', ['c1', 'inventory']))
    assert.ok(view.find({ text: 'Database inventory created with items.' }))
  })
})

describe('users and roles', () => {
  test('creates a user with roles, then drops it; the password is not kept', async () => {
    const { host, calls } = setup()
    const view = await mount(panel, { host })
    await view.expand(tree, 'conn:c1')
    await view.selectItem(tree, 'conn:c1/db:shop')
    await view.press({ text: 'Users' })
    assert.equal(view.rowsOf({ type: 'Table', label: 'Users' }).length, 1)
    await view.press({ text: 'New user' })
    await view.type({ type: 'Input', label: 'Name' }, 'ana')
    await view.type({ type: 'Input', label: 'Password' }, 'secret-pw')
    await view.select({ type: 'Select', label: 'Role' }, 'read')
    await view.press({ text: 'Add role' })
    await view.type({ type: 'Input', label: 'Role name' }, 'reporter')
    await view.press({ text: 'Add role' })
    await view.type({ type: 'Textarea', label: 'Custom data' }, "{ team: 'ops' }")
    await view.press({ text: 'Create user' })
    assert.deepEqual(calls.usersSave, [{ connectionId: 'c1', db: 'shop', isNew: true, draft: { user: 'ana', password: 'secret-pw', roles: [{ role: 'read', db: 'shop' }, { role: 'reporter', db: 'shop' }], customData: { team: 'ops' } } }])
    assert.ok(view.find({ text: 'User ana created.' }))
    assert.equal(view.find({ type: 'Input', label: 'Password' }), null, 'the form and its password are gone')
    assert.ok(!JSON.stringify(view.persisted).includes('secret-pw'))
    await view.selectRows({ type: 'Table', label: 'Users' }, ['u:ana'])
    await view.press({ text: 'Drop' })
    assert.ok(view.find({ type: 'Callout', label: 'Drop user ana from shop?' }))
    await view.press({ text: 'Drop user' })
    assert.deepEqual(calls.usersDrop, [{ connectionId: 'c1', db: 'shop', user: 'ana' }])
  })

  test('edits a role\'s privileges, and a bad list is refused in the form', async () => {
    const { host, calls } = setup()
    const view = await mount(panel, { host })
    await view.expand(tree, 'conn:c1')
    await view.expand(tree, 'conn:c1/db:shop')
    await view.selectItem(tree, 'conn:c1/db:shop/users')
    await view.press({ text: 'Manage users and roles' })
    await view.activateRow({ type: 'Table', label: 'Custom roles' }, 'r:reporter')
    const privileges = { type: 'Textarea', label: 'Privileges' }
    await view.type(privileges, '{ resource: 1 }', { replace: true })
    await view.press({ text: 'Save role' })
    assert.ok(view.find({ text: /Privileges are a list/ }))
    await view.type(privileges, "[{ resource: { db: 'shop', collection: '' }, actions: ['find', 'insert'] }]", { replace: true })
    await view.press({ text: 'Save role' })
    assert.deepEqual(calls.rolesSave, [{ connectionId: 'c1', db: 'shop', isNew: false, draft: { role: 'reporter', privileges: [{ resource: { db: 'shop', collection: '' }, actions: ['find', 'insert'] }], roles: [] } }])
  })
})

describe('server', () => {
  async function atServer(host: ReturnType<typeof setup>['host']) {
    const view = await mount(panel, { host })
    await view.selectItem(tree, 'conn:c1')
    await view.press({ label: 'Server status and operations' })
    return view
  }

  test('status sections, rates after a second reading, members and current operations', async () => {
    const { host } = setup()
    const view = await atServer(host)
    assert.ok(view.find({ type: 'KeyValue', label: 'Server' }))
    assert.ok(view.find({ text: /Rates show after a second reading/ }))
    await view.press({ text: 'Refresh' })
    assert.ok(view.find({ text: /Per second: insert 0 · query 300/ }))
    assert.equal(view.rowsOf({ type: 'Table', label: 'Replica set members' }).length, 1)
    assert.deepEqual(view.rowsOf({ type: 'Table', label: 'Current operations' }), ['4242', '17'])
  })

  test('stopping an operation asks first, then sends its opid', async () => {
    const { host, calls } = setup()
    const view = await atServer(host)
    await view.selectRows({ type: 'Table', label: 'Current operations' }, ['4242'])
    await view.press({ text: 'Stop operation' })
    assert.ok(view.find({ type: 'Callout', label: 'Stop operation 4242?' }))
    assert.ok(view.find({ text: /query on shop.orders, running for 12 s, from 127.0.0.1:5000/ }))
    await view.press({ text: 'Stop it' })
    assert.deepEqual(calls.killOp, [{ connectionId: 'c1', opid: 4242 }])
    assert.ok(view.find({ text: /Asked the server to stop operation 4242/ }))
  })

  test('live refresh asks the worker to wait between readings, and stops on a failure', async () => {
    let n = 0
    const { host, calls } = setup({
      'server.status': async (input: { waitMs?: number }) => {
        n++
        if (input.waitMs) {
          await new Promise((r) => setTimeout(r, 5))
          if (n > 3) throw hostError('unavailable', 'connection closed')
        }
        return status(1000 * n, 10 * n)
      }
    })
    const view = await atServer(host)
    await view.toggle({ type: 'Switch', label: 'Live, every 5 s' })
    for (let i = 0; i < 50 && view.valueOf({ type: 'Switch', label: 'Live, every 5 s' }); i++) await new Promise((r) => setTimeout(r, 5))
    assert.equal(view.valueOf({ type: 'Switch', label: 'Live, every 5 s' }), false)
    assert.ok(view.find({ text: 'Live refresh stopped: connection closed' }))
    assert.ok((calls.ops?.length ?? 0) >= 2, 'operations refresh with each reading')
  })
})

describe('schema explorer', () => {
  test('samples, shows fields with types and a histogram, and exports a validator', async () => {
    const { host, calls } = setup()
    const view = await atCollection(host)
    await view.press({ label: 'Schema: sample the fields and their types' })
    assert.deepEqual(calls.analyze, [{ ns, size: 1000 }])
    assert.ok(view.find({ text: '20 documents · 6 fields · 5 ms' }))
    const fields = { type: 'Tree', label: 'Fields' }
    await view.selectItem(fields, 'f:total')
    assert.ok(view.find({ type: 'Table', label: 'Values' }))
    assert.ok(view.find({ type: 'Progress', label: 'Double: 20 (100%)' }))
    await view.selectItem(fields, 'f:status')
    assert.deepEqual(view.rowsOf({ type: 'Table', label: 'Most common' }), ['s0', 's1'])
    await view.type({ type: 'Input', label: 'Filter' }, '{ status: ', { submit: true })
    assert.ok(view.find({ text: /text ended/ }))
    await view.type({ type: 'Input', label: 'Filter' }, "{ status: 'shipped' }", { replace: true })
    await view.select({ type: 'Select', label: 'Sample' }, '100')
    await view.press({ text: 'Sample again' })
    assert.deepEqual(calls.analyze![1], { ns, size: 100, filter: { status: 'shipped' } })
    await view.toggle({ type: 'Collapsible', label: 'Export the schema' })
    const code = view.find({ type: 'CodeView', label: 'Schema' })!.props.code as string
    assert.match(code, /^\{\n {2}\$jsonSchema: \{\n {4}bsonType: 'object',\n {4}required: \[/)
    await view.press({ text: 'Save as file' })
    assert.equal(host.callsOf('files.saveAs').length, 1)
    await view.press({ text: 'Use as validator' })
    assert.equal(view.valueOf({ type: 'Tabs' }), MANAGE)
    assert.equal(view.valueOf({ type: 'Textarea', label: 'Validator' }), code)
    assert.deepEqual(view.refusals, [])
  })
})

describe('every tab', () => {
  test('draws with every section open, without errors or props Orca would drop', async () => {
    const { host } = setup()
    const view = await atCollection(host)
    await view.press({ label: 'Manage the collection: indexes, validation, rename, drop' })
    await view.toggle({ type: 'Collapsible', label: 'Validation' })
    await view.toggle({ type: 'Collapsible', label: 'Rename, clear and drop' })
    await view.press({ text: 'New index' })
    await view.select({ type: 'Select', label: 'Field 1 kind' }, 'text')
    await view.toggle({ type: 'Collapsible', label: 'More options' })
    await view.selectRows({ type: 'Table', label: 'Indexes' }, ['i:ttl_at'])
    await view.press({ text: 'Schema' })
    await view.selectItem({ type: 'Tree', label: 'Fields' }, 'f:status')
    await view.toggle({ type: 'Collapsible', label: 'Export the schema' })
    await view.select({ type: 'Tabs' }, 'tree')
    await view.selectItem(tree, 'conn:c1/db:shop')
    await view.press({ text: 'Manage' })
    for (const label of ['Create a collection', 'Profiler', 'Drop the database']) await view.toggle({ type: 'Collapsible', label })
    await view.select({ type: 'RadioGroup', label: 'Kind' }, 'timeseries')
    await view.press({ text: 'Read entries' })
    await view.selectRows({ type: 'Table', label: 'Profiler entries' }, ['p0'])
    await view.press({ text: 'Users and roles' })
    await view.press({ text: 'New role' })
    await view.select({ type: 'Tabs' }, 'tree')
    await view.selectItem(tree, 'conn:c1')
    await view.press({ label: 'Server status and operations' })
    await view.selectRows({ type: 'Table', label: 'Current operations' }, ['17'])
    const tabs = view.findAll({ type: 'Tab' }).map((t) => t.label)
    assert.deepEqual(tabs, ['Connections', 'orders', 'Schema: orders', 'shop', 'Users: shop', 'Server'])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  })
})

describe('a read-only connection', () => {
  const readOnly = { 'connections.state': { ...state, connections: [{ ...state.connections[0]!, readOnly: true }] } }

  test('Manage shows the collection and checks rules, but offers no changes', async () => {
    const { host } = setup(readOnly)
    const view = await atCollection(host)
    await view.press({ label: 'Manage the collection: indexes, validation, rename, drop' })
    assert.ok(view.find({ type: 'Badge', text: 'Read only' }))
    assert.equal(view.rowsOf({ type: 'Table', label: 'Indexes' }).length, 3)
    assert.equal(view.find({ text: 'New index' }), null)
    await view.selectRows({ type: 'Table', label: 'Indexes' }, ['i:ttl_at'])
    assert.equal(view.find({ text: 'Hide' }), null)
    assert.equal(view.find({ text: 'Drop' }), null)
    assert.equal(view.find({ type: 'Input', label: 'Expire after (seconds)' }), null)
    assert.ok((view.find({ type: 'KeyValue', label: 'ttl_at details' })!.props.items as { label: string }[]).some((i) => i.label === 'Expires after'))
    await view.toggle({ type: 'Collapsible', label: 'Validation' })
    assert.ok(view.find({ text: 'Check documents' }))
    assert.equal(view.find({ text: 'Save rules' }), null)
    assert.equal(view.find({ type: 'Select', label: 'Level' }), null)
    assert.equal(view.find({ type: 'Collapsible', label: 'Rename, clear and drop' }), null)
    assert.deepEqual(view.errors, [])
  })

  test('the database tab reads the profiler; users and server tabs only look', async () => {
    const { host } = setup(readOnly)
    const view = await mount(panel, { host })
    await view.expand(tree, 'conn:c1')
    await view.selectItem(tree, 'conn:c1/db:shop')
    await view.press({ text: 'Manage' })
    assert.equal(view.find({ type: 'Collapsible', label: 'Create a collection' }), null)
    assert.equal(view.find({ type: 'Collapsible', label: 'Drop the database' }), null)
    await view.toggle({ type: 'Collapsible', label: 'Profiler' })
    assert.ok(view.find({ text: 'Read entries' }))
    assert.equal(view.find({ text: 'Apply' }), null)
    await view.press({ text: 'Users and roles' })
    assert.equal(view.rowsOf({ type: 'Table', label: 'Users' }).length, 1)
    assert.equal(view.find({ text: 'New user' }), null)
    assert.equal(view.find({ text: 'New role' }), null)
    await view.selectRows({ type: 'Table', label: 'Users' }, [view.rowsOf({ type: 'Table', label: 'Users' })[0]!])
    assert.equal(view.find({ text: 'Edit' }), null)
    await view.select({ type: 'Tabs' }, 'tree')
    await view.selectItem(tree, 'conn:c1')
    await view.press({ label: 'Server status and operations' })
    await view.selectRows({ type: 'Table', label: 'Current operations' }, ['4242'])
    assert.ok(view.find({ type: 'KeyValue', label: 'Operation 4242' }))
    assert.ok(view.find({ type: 'Text', text: 'Local dev' }), 'a server tab names its connection, without a database')
    assert.ok(view.find({ type: 'Badge', text: 'Read only' }))
    assert.equal(view.find({ text: 'Stop operation' }), null)
    assert.deepEqual(view.errors, [])
  })
})

describe('closing', () => {
  test('deleting a connection closes its administration tabs', async () => {
    const { host } = setup()
    const view = await atCollection(host)
    await view.press({ label: 'Manage the collection: indexes, validation, rename, drop' })
    await view.select({ type: 'Tabs' }, 'tree')
    await view.selectItem(tree, 'conn:c1')
    await view.press({ label: 'Delete connection' })
    await view.press({ text: 'Delete connection' })
    assert.equal(view.find({ type: 'Tab', label: 'orders' }), null)
  })
})
