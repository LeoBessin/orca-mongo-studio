// Panel behaviour over a stand-in worker: what the person sees and what reaches the worker.
import { assert, describe, mockHost, mount, test } from 'orca/testing'
import type { ConnectionsState, TestReport } from './protocol'
import { emptyConnection, type ConnectionDef, type SecretDraft } from './shared/model'
import * as panel from './panel'

const emptyState: ConnectionsState = { connections: [], favourites: [], secretsProtection: 'os-keyring' }
const oneConn: ConnectionsState = {
  connections: [{ id: 'c1', name: 'Local dev', group: '', subtitle: 'localhost', topology: 'replicaSet', connected: false, readOnly: false }],
  favourites: [],
  secretsProtection: 'os-keyring'
}

const grouped = (id: string, group: string) => ({ ...oneConn.connections[0]!, id, name: id, group })
/** The group suggestions under the connection form's Group field. */
const offered = (view: { findAll: (q: { type: string }) => { props: Record<string, unknown>; text: string }[] }) =>
  view.findAll({ type: 'Button' }).filter((b) => b.props.icon === 'folder').map((b) => b.text)

describe('connection form', () => {
  test('new connection: shows field errors from the worker, then saves', async () => {
    const saves: { def: ConnectionDef; secrets: SecretDraft }[] = []
    let state = emptyState
    const host = mockHost({
      requests: {
        'connections.state': () => state,
        'connections.save': (input) => {
          saves.push(input)
          if (!input.def.name) return { ok: false, errors: [{ field: 'name', message: 'Give the connection a name.' }] }
          state = { ...oneConn, connections: [{ ...oneConn.connections[0]!, id: 'new', name: input.def.name }] }
          return { ok: true, id: 'new' }
        },
        'tree.details': { title: 'Prod', subtitle: 'Connection', items: [] }
      }
    })
    const view = await mount(panel, { host })
    assert.ok(view.find({ type: 'EmptyState', label: 'No connections yet' }))
    await view.press({ text: 'New connection' })
    assert.equal(view.valueOf({ type: 'Tabs' }), 'form')

    await view.press({ text: 'Save' })
    assert.ok(view.find({ text: 'Give the connection a name.' }))

    await view.type({ label: 'Name' }, 'Prod')
    // Authentication starts closed while the method is None.
    await view.toggle({ type: 'Collapsible', label: 'Authentication' })
    await view.select({ label: 'Method' }, 'SCRAM-SHA-256')
    await view.type({ label: 'User name' }, 'app')
    await view.type({ label: 'Password' }, 's3cret')
    await view.press({ text: 'Save' })
    const last = saves.at(-1)!
    assert.equal(last.def.name, 'Prod')
    assert.equal(last.def.auth.username, 'app')
    assert.equal(last.secrets.password, 's3cret')
    assert.equal(JSON.stringify(last.def).includes('s3cret'), false, 'the password never sits in the definition')
    assert.equal(view.valueOf({ type: 'Tabs' }), 'tree')
    assert.ok(view.find({ text: 'Connection saved.' }))
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  })

  test('the Group field suggests existing groups, filtered as you type', async () => {
    let saved: ConnectionDef | undefined
    const host = mockHost({
      requests: {
        'connections.state': { ...oneConn, connections: [grouped('a', 'Clients'), grouped('b', 'Staging'), grouped('c', 'Clients'), grouped('d', '')] },
        'connections.save': (input) => {
          saved = input.def
          return { ok: true, id: 'x' }
        },
        'tree.details': { title: 'x', subtitle: 'Connection', items: [] }
      }
    })
    const view = await mount(panel, { host })
    await view.post('ui.navigate', { view: 'new' })
    assert.ok(view.find({ text: 'Existing groups:' }))
    assert.deepEqual(offered(view), ['Clients', 'Staging'])

    await view.type({ label: 'Group' }, 'client')
    assert.ok(view.find({ text: 'Matching groups:' }))
    assert.deepEqual(offered(view), ['Clients'])
    await view.press({ type: 'Button', text: 'Clients' })
    assert.equal(view.valueOf({ label: 'Group' }), 'Clients')
    // With an existing group chosen, the others stay one press away.
    assert.ok(view.find({ text: 'Other groups:' }))
    assert.deepEqual(offered(view), ['Staging'])

    // A new name still makes a new group.
    await view.type({ label: 'Group' }, 'Archive', { replace: true })
    assert.deepEqual(offered(view), [])
    await view.type({ label: 'Name' }, 'Old')
    await view.press({ text: 'Save' })
    assert.equal(saved!.group, 'Archive')
    assert.deepEqual(view.errors, [])
  })

  test('the Group field says how many groups it left out', async () => {
    const many = Array.from({ length: 11 }, (_, i) => grouped(`c${i}`, `G${String(i).padStart(2, '0')}`))
    const view = await mount(panel, { host: mockHost({ requests: { 'connections.state': { ...oneConn, connections: many } } }) })
    await view.post('ui.navigate', { view: 'new' })
    assert.equal(offered(view).length, 8)
    assert.ok(view.find({ text: 'and 3 more; type to narrow them down' }))
  })

  test('editing a connection leaves out a group only it is in', async () => {
    const def = { ...emptyConnection('a', 0), name: 'a', group: 'Clinets' }
    const host = mockHost({
      requests: {
        'connections.state': { ...oneConn, connections: [grouped('a', 'Clinets'), grouped('b', 'Clients'), grouped('c', 'Clients')] },
        'connections.get': { def, secrets: {} },
        'tree.details': { title: 'a', subtitle: 'Connection', items: [] },
        'tree.children': { nodes: [] }
      }
    })
    const view = await mount(panel, { host })
    await view.selectItem({ type: 'Tree' }, 'conn:a')
    await view.press({ label: 'Edit connection' })
    await view.type({ label: 'Group' }, 'Cli', { replace: true })
    assert.deepEqual(offered(view), ['Clients'])
  })

  test('picking a group in Connection string mode keeps a half-typed string', async () => {
    const view = await mount(panel, { host: mockHost({ requests: { 'connections.state': { ...oneConn, connections: [grouped('a', 'Clients')] } } }) })
    await view.post('ui.navigate', { view: 'new' })
    await view.select({ label: 'Edit as' }, 'uri')
    await view.type({ label: 'Connection string' }, 'mongodb://db1:27017/?replicaSet=', { replace: true })
    const typed = view.valueOf({ label: 'Connection string' })
    await view.press({ type: 'Button', text: 'Clients' })
    assert.equal(view.valueOf({ label: 'Group' }), 'Clients')
    assert.equal(view.valueOf({ label: 'Connection string' }), typed)
  })

  test('connection string mode fills the form and moves the password to secrets', async () => {
    let saved: { def: ConnectionDef; secrets: SecretDraft } | undefined
    const host = mockHost({
      requests: {
        'connections.state': emptyState,
        'connections.save': (input) => {
          saved = input
          return { ok: true, id: 'x' }
        },
        'tree.details': { title: 'x', subtitle: 'Connection', items: [] }
      }
    })
    const view = await mount(panel, { host })
    await view.press({ text: 'New connection' })
    await view.type({ label: 'Name' }, 'Cluster')
    await view.select({ label: 'Edit as' }, 'uri')
    await view.type({ label: 'Connection string' }, 'mongodb://bob:pa%24s@a:1,b:2/shop?replicaSet=rs9&tls=true', { replace: true })
    await view.select({ label: 'Edit as' }, 'form')
    assert.equal(view.valueOf({ label: 'Replica set name' }), 'rs9')
    assert.equal(view.valueOf({ label: 'Use TLS' }), true)
    await view.press({ text: 'Save' })
    assert.equal(saved!.def.topology, 'replicaSet')
    assert.deepEqual(saved!.def.hosts, [{ host: 'a', port: 1 }, { host: 'b', port: 2 }])
    assert.equal(saved!.def.options.defaultDatabase, 'shop')
    assert.equal(saved!.secrets.password, 'pa$s')
  })

  test('a bad connection string says why', async () => {
    const view = await mount(panel, { host: mockHost({ requests: { 'connections.state': emptyState } }) })
    await view.press({ text: 'New connection' })
    await view.select({ label: 'Edit as' }, 'uri')
    await view.type({ label: 'Connection string' }, 'mysql://nope', { replace: true })
    assert.ok(view.find({ text: /starts with mongodb:\/\// }))
  })

  test('test connection shows each step and its hint', async () => {
    const report: TestReport = {
      ok: false,
      steps: [
        { id: 'dns', title: 'Resolve host names', status: 'ok', ms: 2, detail: 'localhost → 127.0.0.1' },
        { id: 'tcp', title: 'Reach each host', status: 'failed', ms: 1, detail: 'connect ECONNREFUSED', hint: 'Nothing is listening there.' }
      ]
    }
    const host = mockHost({ requests: { 'connections.state': emptyState, 'connections.test': report } })
    const view = await mount(panel, { host })
    await view.press({ text: 'New connection' })
    await view.press({ text: 'Test connection' })
    assert.ok(view.find({ type: 'Callout', label: 'Failed at "Reach each host"' }))
    assert.ok(view.find({ text: /Nothing is listening there/ }))
  })

  test('saved secrets are write-only and can be forgotten', async () => {
    const def = { ...emptyConnection('c1', 0), name: 'Local dev' }
    def.auth = { ...def.auth, mechanism: 'DEFAULT', username: 'u' }
    let sent: SecretDraft | undefined
    const host = mockHost({
      requests: {
        'connections.state': oneConn,
        'connections.get': { def, secrets: { password: true } },
        'connections.save': (input) => {
          sent = input.secrets
          return { ok: true, id: 'c1' }
        },
        'tree.details': { title: 'Local dev', subtitle: 'Connection', items: [] },
        'tree.children': { nodes: [] }
      }
    })
    const view = await mount(panel, { host })
    await view.selectItem({ type: 'Tree' }, 'conn:c1')
    await view.press({ label: 'Edit connection' })
    assert.equal(view.valueOf({ label: 'Password' }), '')
    assert.equal(view.find({ label: 'Password' })?.props.placeholder, 'Saved. Type to replace it.')
    await view.press({ text: 'Forget saved password' })
    await view.press({ text: 'Save' })
    assert.deepEqual(sent, { password: null })
  })
})

describe('connections tree', () => {
  test('expands lazily, shows details, and deletes after confirming', async () => {
    let deleted = ''
    let state = oneConn
    const host = mockHost({
      requests: {
        'connections.state': () => state,
        'tree.children': ({ key }) =>
          key === 'conn:c1'
            ? { nodes: [{ key: 'conn:c1/db:shop', kind: 'db', label: 'shop', description: '3 MB', hasChildren: true }] }
            : { nodes: [{ key: 'conn:c1/db:shop/coll:orders', kind: 'coll', label: 'orders', description: '20,000 docs', hasChildren: true }] },
        'tree.details': ({ key }) =>
          key === 'conn:c1/db:shop'
            ? { title: 'shop', subtitle: 'Database', items: [{ label: 'Collections', value: 11 }] }
            : { title: 'Local dev', subtitle: 'Connection', items: [{ label: 'Status', value: 'not connected' }] },
        'connections.delete': ({ id }) => {
          deleted = id
          state = emptyState
          return null
        }
      }
    })
    const view = await mount(panel, { host })
    const tree = { type: 'Tree' }
    await view.expand(tree, 'conn:c1')
    await view.expand(tree, 'conn:c1/db:shop')
    assert.deepEqual(view.expandedOf(tree).filter((k) => k.startsWith('conn')), ['conn:c1', 'conn:c1/db:shop'])
    await view.selectItem(tree, 'conn:c1/db:shop')
    assert.ok(view.find({ type: 'KeyValue', label: 'shop details' }))
    assert.ok(view.find({ label: 'Add to favourites' }))

    await view.selectItem(tree, 'conn:c1')
    assert.ok(view.find({ text: 'Connect' }))
    await view.press({ label: 'Delete connection' })
    assert.ok(view.find({ type: 'Callout', label: 'Delete "Local dev"?' }))
    assert.equal(deleted, '', 'nothing is deleted before confirming')
    await view.press({ text: 'Delete connection' })
    assert.equal(deleted, 'c1')
    assert.ok(view.find({ type: 'EmptyState' }))
  })

  test('a failed load shows the reason in the tree', async () => {
    const host = mockHost({
      requests: {
        'connections.state': oneConn,
        'tree.children': () => {
          throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:27017'), { code: 'action_failed' })
        }
      }
    })
    const view = await mount(panel, { host })
    await view.expand({ type: 'Tree' }, 'conn:c1')
    const items = JSON.stringify(view.find({ type: 'Tree' })?.props.items)
    assert.match(items, /ECONNREFUSED/)
  })

  test('the filter keeps matches and their parents', async () => {
    const host = mockHost({
      requests: {
        'connections.state': { ...oneConn, connections: [...oneConn.connections, { id: 'c2', name: 'Atlas', group: 'Clients', subtitle: 'x', topology: 'srv', connected: false, readOnly: false }] }
      }
    })
    const view = await mount(panel, { host })
    await view.type({ label: 'Filter' }, 'atl')
    const items = view.find({ type: 'Tree' })?.props.items as { label: string; children?: { label: string }[] }[]
    assert.deepEqual(items.map((i) => i.label), ['Clients'])
    assert.deepEqual(items[0]!.children!.map((c) => c.label), ['Atlas'])
  })

  test('palette navigation opens the new connection form', async () => {
    const view = await mount(panel, { host: mockHost({ requests: { 'connections.state': oneConn } }) })
    await view.post('ui.navigate', { view: 'new' })
    assert.equal(view.valueOf({ type: 'Tabs' }), 'form')
  })

  test('OIDC sign-in shows a link to open', async () => {
    const view = await mount(panel, { host: mockHost({ requests: { 'connections.state': oneConn } }) })
    await view.post('oidc.signIn', { connectionId: 'c1', name: 'Atlas', url: 'https://idp.example.com/authorize?x=1' })
    assert.ok(view.find({ type: 'Callout', label: 'Sign in to Atlas' }))
    assert.equal(view.find({ type: 'Link' })?.props.href, 'https://idp.example.com/authorize?x=1')
  })
})

describe('import and export', () => {
  test('imports pasted strings and saves the export through the save dialog', async () => {
    let state = emptyState
    const host = mockHost({
      requests: {
        'connections.state': () => state,
        'connections.import': () => {
          state = oneConn
          return { imported: [{ id: 'c1', name: 'Local dev', warnings: [] }], errors: ['Line 2: nope'] }
        },
        'connections.export': { json: '{"format":"mongo-studio.connections"}', count: 1, tasks: 0 }
      },
      results: { 'files.saveAs': { status: 'saved' } }
    })
    const view = await mount(panel, { host })
    await view.press({ label: 'Import connections' })
    await view.type({ label: "Connection strings or an export file's JSON" }, 'mongodb://localhost\nnope')
    await view.press({ type: 'Button', text: 'Import' })
    assert.ok(view.find({ type: 'Callout', label: 'Imported 1 connection' }))
    assert.ok(view.find({ text: 'Line 2: nope' }))
    await view.press({ text: 'Save 1 as JSON…' })
    const [call] = host.callsOf('files.saveAs') as { data: string; suggestedName: string }[]
    assert.equal(call!.suggestedName, 'mongo-studio-connections.json')
    assert.deepEqual(view.refusals, [])
  })

  test('saved tasks go into the export unless left out, and the import names the tasks it brought', async () => {
    const exports: unknown[] = []
    const host = mockHost({
      requests: {
        'connections.state': oneConn,
        'connections.import': { imported: [{ id: 'c1', name: 'Local dev', warnings: [] }], errors: ['The task "B only" was not imported: no connection is named "B".'], tasks: ['Nightly export'] },
        'connections.export': (input) => {
          exports.push(input)
          return { json: '{}', count: 1, tasks: (input as { tasks?: boolean }).tasks === false ? 0 : 2 }
        }
      }
    })
    const view = await mount(panel, { host })
    await view.press({ label: 'Import connections' })
    await view.type({ label: "Connection strings or an export file's JSON" }, '{}')
    await view.press({ type: 'Button', text: 'Import' })
    assert.ok(view.find({ text: 'With 1 saved task: Nightly export.' }))
    assert.ok(view.find({ text: /"B only" was not imported/ }))
    assert.deepEqual(exports.at(-1), { tasks: true })
    assert.ok(view.find({ text: 'Save 1 with 2 tasks as JSON…' }))
    await view.toggle({ type: 'Checkbox', label: 'Include saved tasks' })
    assert.deepEqual(exports.at(-1), { tasks: false })
    assert.ok(view.find({ text: 'Save 1 as JSON…' }))
    assert.deepEqual(view.refusals, [])
  })
})
