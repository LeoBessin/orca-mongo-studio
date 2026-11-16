// Administration and the Schema Explorer against the seeded dev replica set (dev/docker-compose.yml,
// default profile, after dev/seed.mongodb.js). Run with MONGO_STUDIO_IT=1 (npm run test:it).
// Everything that writes works in a scratch database, dropped at the end.
import '../src/worker'
import { MongoClient } from 'mongodb'
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import type { Namespace, ServerStatus } from '../src/protocol'
import { buildIndex, emptyIndexDraft } from '../src/shared/index-spec'
import { fitsHost } from '../src/shared/host-size'
import { emptyConnection } from '../src/shared/model'
import type { SchemaReport } from '../src/shared/schema'
import * as main from '../src/worker'

const ON = process.env.MONGO_STUDIO_IT === '1'
const URI = 'mongodb://localhost:27017/?directConnection=true'
const SCRATCH = 'mongo_studio_admin_test'

async function setup() {
  const worker = await mountWorker(main, { host: mockHost({ results: { 'secrets.protection': { status: 'os-keyring' } } }) })
  const def = emptyConnection('', 0)
  def.name = 'dev'
  def.hosts = [{ host: 'localhost', port: 27017 }]
  def.options.directConnection = true
  const saved = await worker.request('connections.save', { def, secrets: {} })
  if (!saved.ok) throw new Error('save failed')
  const ns = (db: string, collection: string): Namespace => ({ connectionId: saved.id, db, collection })
  return { worker, ns, connectionId: saved.id }
}

async function direct<T>(fn: (c: MongoClient) => Promise<T>): Promise<T> {
  const c = await new MongoClient(URI).connect()
  try {
    return await fn(c)
  } finally {
    await c.close()
  }
}

const err = (p: Promise<unknown>) => p.then(() => new Error('no error'), (e: Error) => e)

describe('administration', () => {
  test('indexes: list with kinds, sizes and use; create every kind; hide; change a TTL; drop', async () => {
    if (!ON) return
    const { worker, ns, connectionId } = await setup()
    try {
      const seeded = await worker.request('admin.indexes', { ns: ns('shop', 'sessions') })
      const ttl = seeded.indexes.find((i) => i.name === 'ttl_lastSeen')!
      assert.equal(ttl.ttl, 7 * 86400)
      assert.ok(ttl.kinds.some((k) => k.startsWith('TTL')))
      assert.equal(typeof ttl.size, 'number')
      assert.equal(typeof ttl.ops, 'number')

      await worker.request('admin.createCollection', { connectionId, db: SCRATCH, spec: { name: 'places', kind: 'plain' } })
      const places = ns(SCRATCH, 'places')
      await direct((c) => c.db(SCRATCH).collection('places').insertMany([{ name: 'a', loc: { type: 'Point', coordinates: [2.35, 48.85] }, xy: [1, 2], at: new Date(), attrs: { color: 'red' }, body: 'hello world' }]))
      const make = async (keys: { field: string; kind: '1' | '-1' | 'text' | '2dsphere' | '2d' | 'hashed' | 'wildcard' }[], extra = {}) => {
        const b = buildIndex({ ...emptyIndexDraft(), keys: keys.map((k, i) => ({ ...k, id: String(i) })), ...extra })
        assert.deepEqual(b.errors, {})
        return worker.request('admin.createIndex', { ns: places, key: b.key!, options: b.options! })
      }
      assert.deepEqual(await make([{ field: 'name', kind: '1' }, { field: 'at', kind: '-1' }], { unique: true, partial: "{ name: { $exists: true } }" }), { name: 'name_1_at_-1' })
      await make([{ field: 'loc', kind: '2dsphere' }])
      await make([{ field: 'xy', kind: '2d' }], { extra: '{ bits: 20 }' })
      await make([{ field: 'name', kind: 'hashed' }])
      await make([{ field: 'attrs', kind: 'wildcard' }])
      await make([{ field: 'body', kind: 'text' }], { weights: '{ body: 5 }', defaultLanguage: 'english' })
      await make([{ field: 'at', kind: '1' }], { ttl: '60', name: 'expire_at', collation: "{ locale: 'fr' }" })
      const list = await worker.request('admin.indexes', { ns: places })
      assert.deepEqual(list.indexes.map((i) => i.name).sort(), ['_id_', 'attrs.$**_1', 'body_text', 'expire_at', 'loc_2dsphere', 'name_1_at_-1', 'name_hashed', 'xy_2d'])
      assert.ok(list.indexes.find((i) => i.name === 'name_1_at_-1')!.kinds.includes('partial'))
      assert.ok(fitsHost(list))

      await worker.request('admin.modifyIndex', { ns: places, name: 'name_hashed', hidden: true })
      await worker.request('admin.modifyIndex', { ns: places, name: 'expire_at', expireAfterSeconds: 120 })
      const after = await worker.request('admin.indexes', { ns: places })
      assert.equal(after.indexes.find((i) => i.name === 'name_hashed')!.hidden, true)
      assert.equal(after.indexes.find((i) => i.name === 'expire_at')!.ttl, 120)
      await worker.request('admin.dropIndex', { ns: places, name: 'name_hashed' })
      assert.match((await err(worker.request('admin.dropIndex', { ns: places, name: '_id_' }))).message, /_id index/)
      assert.ok(!(await worker.request('admin.indexes', { ns: places })).indexes.some((i) => i.name === 'name_hashed'))
      // A server refusal comes back as the server's words.
      assert.match((await err(worker.request('admin.createIndex', { ns: places, key: { name: 'text' }, options: {} }))).message, /equivalent index/i)
    } finally {
      await direct((c) => c.db(SCRATCH).dropDatabase())
      await worker.deactivate()
    }
  })

  test('collections: create every kind, statistics, validation, rename, clear, drop', async () => {
    if (!ON) return
    const { worker, ns, connectionId } = await setup()
    const ref = { connectionId, db: SCRATCH }
    try {
      await worker.request('admin.createCollection', { ...ref, spec: { name: 'log', kind: 'capped', capped: { size: 65536, max: 100 } } })
      await worker.request('admin.createCollection', { ...ref, spec: { name: 'metrics', kind: 'timeseries', timeseries: { timeField: 'ts', metaField: 'host', granularity: 'minutes', expireAfterSeconds: 3600 } } })
      await worker.request('admin.createCollection', { ...ref, spec: { name: 'events', kind: 'clustered', clustered: { expireAfterSeconds: 600 } } })
      await worker.request('admin.createCollection', {
        ...ref,
        spec: { name: 'people', kind: 'plain', validator: { $jsonSchema: { bsonType: 'object', required: ['name'] } }, validationLevel: 'moderate', validationAction: 'warn', collation: { locale: 'en' } }
      })
      assert.match((await err(worker.request('admin.createCollection', { ...ref, spec: { name: 'people', kind: 'plain' } }))).message, /exists already/)
      assert.match((await err(worker.request('admin.createCollection', { ...ref, spec: { name: 'bad$name', kind: 'plain' } }))).message, /\$/)

      const db = await worker.request('admin.database', ref)
      assert.deepEqual(db.collections.map((c) => `${c.name}:${c.kind}`), ['events:collection', 'log:collection', 'metrics:timeseries', 'people:collection'])
      const log = await worker.request('admin.collection', { ns: ns(SCRATCH, 'log') })
      assert.equal(log.capped, true)
      assert.ok(log.stats.some((s) => s.label === 'Capped'))
      const metrics = await worker.request('admin.collection', { ns: ns(SCRATCH, 'metrics') })
      assert.equal(metrics.kind, 'timeseries')
      assert.ok(metrics.stats.some((s) => s.label === 'Time field' && s.value === 'ts'))
      const events = await worker.request('admin.collection', { ns: ns(SCRATCH, 'events') })
      assert.ok(events.stats.some((s) => s.label === 'Clustered'))

      const people = ns(SCRATCH, 'people')
      const p = await worker.request('admin.collection', { ns: people })
      assert.deepEqual(p.validator, { $jsonSchema: { bsonType: 'object', required: ['name'] } })
      assert.equal(p.validationLevel, 'moderate')
      assert.equal(p.validationAction, 'warn')
      // warn lets a bad document in; checking finds it.
      await direct((c) => c.db(SCRATCH).collection('people').insertMany([{ name: 'Ada' }, { nick: 'b' }, { nick: 'c' }]))
      const check = await worker.request('admin.checkValidation', { ns: people, validator: p.validator! })
      assert.equal(check.failing, 2)
      assert.equal(check.checked, 3)
      assert.ok(check.firstId)
      await worker.request('admin.setValidation', { ns: people, validator: { nick: { $exists: true } }, level: 'strict', action: 'error' })
      const changed = await worker.request('admin.collection', { ns: people })
      assert.deepEqual(changed.validator, { nick: { $exists: true } })
      assert.equal(changed.validationAction, 'error')
      await worker.request('admin.setValidation', { ns: people, validator: null, level: 'strict', action: 'error' })
      assert.equal((await worker.request('admin.collection', { ns: people })).validator, null)

      await worker.request('admin.renameCollection', { ns: people, to: 'humans', dropTarget: false })
      const humans = ns(SCRATCH, 'humans')
      assert.equal((await worker.request('admin.collection', { ns: humans })).count, 3)
      assert.deepEqual(await worker.request('admin.clearCollection', { ns: humans }), { deleted: 3 })
      assert.equal((await worker.request('admin.indexes', { ns: humans })).indexes.length, 1)
      assert.match((await err(worker.request('admin.clearCollection', { ns: ns(SCRATCH, 'log') }))).message, /capped/)
      await worker.request('admin.convertToCapped', { ns: humans, size: 8192 })
      assert.equal((await worker.request('admin.collection', { ns: humans })).capped, true)
      await worker.request('admin.dropCollection', { ns: humans })
      assert.match((await err(worker.request('admin.collection', { ns: humans }))).message, /no longer exists/)

      assert.match((await err(worker.request('admin.dropDatabase', { connectionId, db: 'admin' }))).message, /does not drop/)
      await worker.request('admin.dropDatabase', ref)
      assert.equal((await worker.request('admin.database', ref)).collections.length, 0)
    } finally {
      await direct((c) => c.db(SCRATCH).dropDatabase())
      await worker.deactivate()
    }
  })

  test('profiler: level, slow threshold and entries', async () => {
    if (!ON) return
    const { worker, connectionId } = await setup()
    const ref = { connectionId, db: SCRATCH }
    try {
      await direct((c) => c.db(SCRATCH).collection('p').insertOne({ a: 1 }))
      const set = await worker.request('profiler.set', { ...ref, level: 2, slowms: 50, sampleRate: 1 })
      assert.deepEqual([set.level, set.slowms, set.sampleRate], [2, 50, 1])
      await direct((c) => c.db(SCRATCH).collection('p').find({ a: 1 }).toArray())
      const { entries } = await worker.request('profiler.entries', { ...ref, filter: { op: 'query' }, limit: 20 })
      assert.ok(entries.length >= 1)
      const e = entries[0]!
      assert.equal(e.op, 'query')
      assert.equal(e.ns, `${SCRATCH}.p`)
      assert.match(e.command, /"find":"p"/)
      assert.match(e.raw, /"millis"/)
      assert.match((await err(worker.request('profiler.set', { ...ref, level: 3, slowms: 1, sampleRate: 1 }))).message, /level/)
      const off = await worker.request('profiler.set', { ...ref, level: 0, slowms: 100, sampleRate: 1 })
      assert.equal(off.level, 0)
    } finally {
      await direct((c) => c.db(SCRATCH).dropDatabase())
      await worker.deactivate()
    }
  })

  test('users and roles: list, create, change, drop', async () => {
    if (!ON) return
    const { worker, connectionId } = await setup()
    const ref = { connectionId, db: SCRATCH }
    try {
      const shop = await worker.request('users.list', { connectionId, db: 'shop' })
      assert.deepEqual(shop.users.map((u) => u.user), ['app', 'reporter'])
      assert.deepEqual(shop.users[1]!.roles, [{ role: 'shopReporter', db: 'admin' }])
      assert.ok(shop.builtinRoles.includes('readWrite'))
      const admin = await worker.request('users.list', { connectionId, db: 'admin' })
      assert.equal(admin.roles.find((r) => r.role === 'shopReporter')!.privileges.length, 2)

      await worker.request('roles.save', { ...ref, isNew: true, draft: { role: 'reader', privileges: [{ resource: { db: SCRATCH, collection: '' }, actions: ['find'] }], roles: [] } })
      await worker.request('users.save', { ...ref, isNew: true, draft: { user: 'u1', password: 'pw-1-dev-only', roles: [{ role: 'reader', db: SCRATCH }], customData: { team: 'ops' }, mechanisms: ['SCRAM-SHA-256'] } })
      let state = await worker.request('users.list', ref)
      assert.deepEqual(state.users[0], { user: 'u1', db: SCRATCH, roles: [{ role: 'reader', db: SCRATCH }], mechanisms: ['SCRAM-SHA-256'], customData: '{"team":"ops"}' })
      // The new user signs in with the password.
      await new MongoClient(`mongodb://u1:pw-1-dev-only@localhost:27017/?directConnection=true&authSource=${SCRATCH}`).connect().then((c) => c.close())

      await worker.request('roles.save', { ...ref, isNew: false, draft: { role: 'reader', privileges: [{ resource: { db: SCRATCH, collection: '' }, actions: ['find', 'listCollections'] }], roles: [{ role: 'read', db: SCRATCH }] } })
      await worker.request('users.save', { ...ref, isNew: false, draft: { user: 'u1', roles: [{ role: 'read', db: SCRATCH }], customData: null } })
      state = await worker.request('users.list', ref)
      assert.deepEqual(state.users[0]!.roles, [{ role: 'read', db: SCRATCH }])
      assert.equal(state.users[0]!.customData, undefined)
      assert.deepEqual(state.roles[0]!.roles, [{ role: 'read', db: SCRATCH }])
      assert.match((await err(worker.request('users.save', { ...ref, isNew: true, draft: { user: 'u2', roles: [] } }))).message, /password/)
      assert.match((await err(worker.request('roles.save', { ...ref, isNew: true, draft: { role: 'bad', privileges: [{ actions: ['find'] }], roles: [] } }))).message, /resource/)

      await worker.request('users.drop', { ...ref, user: 'u1' })
      await worker.request('roles.drop', { ...ref, role: 'reader' })
      state = await worker.request('users.list', ref)
      assert.deepEqual([state.users.length, state.roles.length], [0, 0])
    } finally {
      await direct(async (c) => {
        await c.db(SCRATCH).command({ dropAllUsersFromDatabase: 1 })
        await c.db(SCRATCH).command({ dropAllRolesFromDatabase: 1 })
        await c.db(SCRATCH).dropDatabase()
      })
      await worker.deactivate()
    }
  })

  test('server status, current operations and stopping one', async () => {
    if (!ON) return
    const { worker, connectionId } = await setup()
    try {
      const s: ServerStatus = await worker.request('server.status', { connectionId })
      assert.deepEqual(s.sections.map((x) => x.title).slice(0, 3), ['Server', 'Connections', 'Operations since start'])
      assert.ok(s.sections.some((x) => x.title === 'Replication'))
      assert.equal(s.members?.length, 1)
      assert.equal(s.members![0]!.state, 'PRIMARY')
      assert.equal(typeof s.counters['op.query'], 'number')
      const waited = Date.now()
      await worker.request('server.status', { connectionId, waitMs: 300 })
      assert.ok(Date.now() - waited >= 280)

      // A slow operation to find and stop.
      const slow = direct((c) => c.db('shop').collection('orders').find({ $where: 'sleep(100) || true' }).toArray()).catch((e: Error) => e)
      let found
      for (let i = 0; i < 40 && !found; i++) {
        await new Promise((r) => setTimeout(r, 100))
        const { ops } = await worker.request('server.ops', { connectionId, filter: { idle: false, system: false, ns: 'shop.orders' } })
        found = ops.find((o) => o.command.includes('$where'))
      }
      assert.ok(found, 'the slow find shows in current operations')
      assert.equal(found.op, 'query')
      assert.ok(found.active)
      await worker.request('server.killOp', { connectionId, opid: found.opidValue })
      const result = await slow
      assert.ok(result instanceof Error && /interrupted|killed/i.test(result.message))
      const all = await worker.request('server.ops', { connectionId, filter: { idle: true, system: true } })
      assert.ok(all.ops.length > 0 && fitsHost(all))
    } finally {
      await worker.deactivate()
    }
  })
})

describe('schema explorer', () => {
  test('samples a collection and reports its fields', async () => {
    if (!ON) return
    const { worker, ns } = await setup()
    try {
      const { report } = await worker.request('schema.analyze', { ns: ns('shop', 'orders'), size: 1000 })
      const r = JSON.parse(report) as SchemaReport
      assert.equal(r.sampled, 1000)
      const f = (p: string) => r.fields.find((x) => x.path === p)!
      assert.equal(f('_id').count, 1000)
      assert.ok(f('status').strings!.top.length > 1)
      assert.ok(f('items[]').count > 1000)
      assert.ok(f('total').numbers!.buckets.length > 1)
      const filtered = JSON.parse((await worker.request('schema.analyze', { ns: ns('shop', 'orders'), size: 50, filter: { status: 'shipped' } })).report) as SchemaReport
      assert.deepEqual(filtered.fields.find((x) => x.path === 'status')!.strings!.top.map((t) => t.value), ['shipped'])
      const zoo = JSON.parse((await worker.request('schema.analyze', { ns: ns('types_zoo', 'everything'), size: 100 })).report) as SchemaReport
      assert.ok(zoo.fields.length > 10)
      assert.match((await err(worker.request('schema.analyze', { ns: ns('shop', 'orders'), size: 0 }))).message, /Sample 1/)
    } finally {
      await worker.deactivate()
    }
  })
})
