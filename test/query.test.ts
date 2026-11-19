// Querying and editing against the seeded dev replica set (dev/docker-compose.yml, default profile,
// after dev/seed.mongodb.js). Run with MONGO_STUDIO_IT=1 (npm run test:it). Edits go to a scratch
// copy of types_zoo.everything, dropped at the end, so the seed stays as it was.
import '../src/worker'
import { MongoClient } from 'mongodb'
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import type { Namespace, QuerySpec } from '../src/protocol'
import { bsonType, idKey, type JsonObject, type JsonValue } from '../src/shared/ejson-view'
import { draftFromValue, valueFromDraft, type EditType } from '../src/shared/field-edit'
import { fitsHost, hostSize } from '../src/shared/host-size'
import { emptyConnection } from '../src/shared/model'
import { parseShell } from '../src/shared/shell-parse'
import * as main from '../src/worker'

const ON = process.env.MONGO_STUDIO_IT === '1'
const URI = 'mongodb://localhost:27017/?directConnection=true'

async function setup() {
  const worker = await mountWorker(main, { host: mockHost({ results: { 'secrets.protection': { status: 'os-keyring' } } }) })
  const def = emptyConnection('', 0)
  def.name = 'dev'
  def.hosts = [{ host: 'localhost', port: 27017 }]
  def.options.directConnection = true
  const saved = await worker.request('connections.save', { def, secrets: {} })
  assert.ok(saved.ok)
  if (!saved.ok) throw new Error('save failed')
  const ns = (db: string, collection: string): Namespace => ({ connectionId: saved.id, db, collection })
  return { worker, ns }
}

const spec = (text: Partial<Record<'filter' | 'sort' | 'projection' | 'collation', string>> = {}, skip = 0, limit = 0): QuerySpec => {
  const s: QuerySpec = { filter: parseShell(text.filter ?? '{}') as JsonObject, skip, limit }
  if (text.sort) s.sort = parseShell(text.sort) as JsonObject
  if (text.projection) s.projection = parseShell(text.projection) as JsonObject
  if (text.collation) s.collation = parseShell(text.collation) as JsonObject
  return s
}

describe('querying the seeded shop', () => {
  test('pages through 20,000 orders, reading on from the cursor', async () => {
    if (!ON) return
    const { worker, ns } = await setup()
    try {
      const orders = ns('shop', 'orders')
      const s = spec({ sort: '{ orderNo: 1 }', projection: '{ orderNo: 1, status: 1 }' })
      const first = await worker.request('query.run', { ns: orders, spec: s, pageSize: 500 })
      assert.equal(first.docs.length, 500)
      assert.equal(first.hasMore, true)
      assert.deepEqual(first.docs[0]!.orderNo, { $numberLong: '1000000' })
      let page = first
      let seen = first.docs.length
      while (page.hasMore) {
        page = await worker.request('query.page', { queryId: first.queryId, ns: orders, spec: s, offset: page.offset + page.docs.length, pageSize: 500 })
        seen += page.docs.length
      }
      assert.equal(seen, 20000)
      assert.deepEqual(page.docs.at(-1)!.orderNo, { $numberLong: '1019999' })
      // An earlier page re-runs with skip.
      const back = await worker.request('query.page', { queryId: first.queryId, ns: orders, spec: s, offset: 1000, pageSize: 20 })
      assert.deepEqual(back.docs[0]!.orderNo, { $numberLong: '1001000' })
      assert.equal(back.offset, 1000)
    } finally {
      await worker.deactivate()
    }
  })

  test('a page of 500 whole orders stays inside what Orca lets an answer carry', async () => {
    if (!ON) return
    const { worker, ns } = await setup()
    try {
      const orders = ns('shop', 'orders')
      const s = spec({ sort: '{ orderNo: 1 }' })
      const first = await worker.request('query.run', { ns: orders, spec: s, pageSize: 500 })
      assert.ok(fitsHost(first, 1), JSON.stringify(hostSize(first)))
      assert.equal(first.stoppedForSize, true, 'the object limit stops the page early')
      assert.ok(first.docs.length > 100 && first.docs.length < 500, String(first.docs.length))
      const next = await worker.request('query.page', { queryId: first.queryId, ns: orders, spec: s, offset: first.docs.length, pageSize: 500 })
      assert.deepEqual(next.docs[0]!.orderNo, { $numberLong: String(1000000 + first.docs.length) }, 'the next page goes on from the held-back document')
    } finally {
      await worker.deactivate()
    }
  })

  test('counts separately: estimated with no filter, exact with one, within skip and limit', async () => {
    if (!ON) return
    const { worker, ns } = await setup()
    try {
      const orders = ns('shop', 'orders')
      const all = await worker.request('query.count', { ns: orders, spec: spec() })
      assert.deepEqual([all.count, all.approximate], [20000, true])
      const shipped = await worker.request('query.count', { ns: orders, spec: spec({ filter: "{ status: 'shipped' }" }) })
      assert.equal(shipped.approximate, false)
      assert.ok(shipped.count! > 1000 && shipped.count! < 20000)
      const capped = await worker.request('query.count', { ns: orders, spec: spec({}, 19990, 50) })
      assert.equal(capped.count, 10)
    } finally {
      await worker.deactivate()
    }
  })

  test('filters, sorts and collation reach the server', async () => {
    if (!ON) return
    const { worker, ns } = await setup()
    try {
      const r = await worker.request('query.run', {
        ns: ns('shop', 'orders'),
        spec: spec({ filter: "{ status: 'shipped', total: { $gte: NumberDecimal('1000') } }", sort: '{ total: -1 }', projection: '{ total: 1 }' }, 0, 5),
        pageSize: 20
      })
      assert.equal(r.docs.length, 5)
      assert.equal(r.hasMore, false)
      assert.equal(bsonType(r.docs[0]!.total!), 'decimal')
      const totals = r.docs.map((d) => Number((d.total as JsonObject).$numberDecimal))
      assert.deepEqual(totals, [...totals].sort((a, b) => b - a))
    } finally {
      await worker.deactivate()
    }
  })

  test('views read like collections, and refuse writes', async () => {
    if (!ON) return
    const { worker, ns } = await setup()
    try {
      const view = ns('shop', 'order_totals_by_month')
      const r = await worker.request('query.run', { ns: view, spec: spec(), pageSize: 50 })
      assert.ok(r.docs.length > 0)
      const n = await worker.request('query.count', { ns: view, spec: spec() })
      assert.equal(n.count, r.docs.length)
      await assert.rejects(worker.request('doc.insert', { ns: view, docs: [{ a: 1 }] }), /view/i)
    } finally {
      await worker.deactivate()
    }
  })

  test('a bad query answers the server error', async () => {
    if (!ON) return
    const { worker, ns } = await setup()
    try {
      await assert.rejects(worker.request('query.run', { ns: ns('shop', 'orders'), spec: spec({ filter: '{ $bogus: 1 }' }), pageSize: 20 }), /bogus/)
    } finally {
      await worker.deactivate()
    }
  })

  test('history records each run once, newest first; saved queries are named', async () => {
    if (!ON) return
    const { worker, ns } = await setup()
    try {
      const orders = ns('shop', 'orders')
      const text = (filter: string) => ({ filter, projection: '', sort: '', collation: '', skip: '', limit: '' })
      for (const f of ["{ status: 'a' }", "{ status: 'b' }", "{ status: 'a' }"]) {
        await worker.request('query.run', { ns: orders, spec: spec({ filter: f }), pageSize: 1, text: text(f) })
      }
      const lib = await worker.request('history.list', { ns: orders })
      assert.deepEqual(lib.history.map((h) => h.query.filter), ["{ status: 'a' }", "{ status: 'b' }"])
      const saved = await worker.request('saved.save', { ns: orders, name: 'Shipped', query: text("{ status: 'shipped' }") })
      assert.deepEqual(saved.saved.map((s) => s.name), ['Shipped'])
      assert.deepEqual((await worker.request('history.list', { ns: ns('shop', 'customers') })).history, [], 'per namespace')
    } finally {
      await worker.deactivate()
    }
  })
})

describe('editing every BSON type (a scratch copy of types_zoo.everything)', () => {
  test('field edits, replace, insert, clone and bulk delete', async () => {
    if (!ON) return
    const direct = await MongoClient.connect(URI)
    const scratch = `it_scratch_${process.pid}`
    const zoo = direct.db('types_zoo')
    await zoo.collection(scratch).insertMany(await zoo.collection('everything').find().toArray())
    const { worker, ns } = await setup()
    const target = ns('types_zoo', scratch)
    try {
      const { doc } = await worker.request('doc.get', { ns: target, id: 'all-types' })
      assert.ok(doc)
      const fields = Object.entries(doc).filter(([k]) => k !== '_id')
      assert.ok(fields.length >= 20)
      // Each value goes through its editor's draft and is saved back with $set unchanged.
      for (const [key, value] of fields) {
        const draft = draftFromValue(value)
        const back = valueFromDraft(draft)
        assert.ok(back.ok, key)
        if (!back.ok) continue
        const r = await worker.request('doc.updateField', { ns: target, id: 'all-types', path: [key], value: back.value })
        assert.equal(r.matched, 1, key)
        assert.equal(r.modified, 0, `${key} (${draft.type}) saved unchanged`)
      }
      // Then each type is changed to a new value.
      const edits: [string, EditType, string][] = [
        ['double', 'double', '2.5'],
        ['int32', 'int', '-7'],
        ['int64', 'long', '-9223372036854775808'],
        ['decimal128', 'decimal', '1.10'],
        ['date', 'date', '2030-01-02T03:04:05.006Z'],
        ['objectId', 'objectId', '0123456789abcdef01234567'],
        ['uuid', 'uuid', '00112233-4455-6677-8899-aabbccddeeff'],
        ['regex', 'regex', '^x'],
        ['bool', 'bool', 'false'],
        ['object', 'object', "{ a: ISODate('2026-01-01'), b: [NumberInt(1)] }"]
      ]
      for (const [key, type, text] of edits) {
        const result = valueFromDraft({ ...draftFromValue(doc[key]!), type, text })
        assert.ok(result.ok, key)
        if (!result.ok) continue
        await worker.request('doc.updateField', { ns: target, id: 'all-types', path: [key], value: result.value })
      }
      const ts = valueFromDraft({ ...draftFromValue(doc.timestamp!), t: '10', i: '2' })
      assert.ok(ts.ok)
      if (ts.ok) await worker.request('doc.updateField', { ns: target, id: 'all-types', path: ['timestamp'], value: ts.value })
      const raw = await direct.db('types_zoo').collection(scratch).findOne({ _id: 'all-types' as never })
      assert.equal(raw!.int32, -7)
      assert.equal(raw!.int64.toString(), '-9223372036854775808')
      assert.equal(raw!.decimal128.toString(), '1.10')
      assert.equal(raw!.date.toISOString(), '2030-01-02T03:04:05.006Z')
      assert.equal(raw!.objectId.toHexString(), '0123456789abcdef01234567')
      assert.equal(raw!.uuid.toUUID().toString(), '00112233-4455-6677-8899-aabbccddeeff')
      assert.equal(raw!.regex.source ?? raw!.regex.pattern, '^x')
      assert.equal(raw!.timestamp.toString(), '42949672962')
      assert.equal(raw!.object.b[0], 1)

      // Nested paths, array items, keys with dots, and removing fields.
      await worker.request('doc.updateField', { ns: target, id: 'all-types', path: ['array', 1], value: 'TWO' })
      await worker.request('doc.updateField', { ns: target, id: 'all-types', path: ['dotted.key'], value: 'changed' })
      await worker.request('doc.updateField', { ns: target, id: 'all-types', path: ['emptyObject'], remove: true })
      await worker.request('doc.updateField', { ns: target, id: 'all-types', path: ['array', 0], remove: true })
      const after = (await worker.request('doc.get', { ns: target, id: 'all-types' })).doc!
      assert.deepEqual(after.array, ['TWO', { $numberInt: '3' }, null, [{ $numberInt: '4' }]])
      assert.equal(after['dotted.key'], 'changed')
      assert.equal('emptyObject' in after, false)
      await assert.rejects(worker.request('doc.updateField', { ns: target, id: 'all-types', path: ['_id'], value: 'x' }), /_id can't change/)
      await assert.rejects(worker.request('doc.updateField', { ns: target, id: 'gone', path: ['a'], value: 1 }), /no longer there/)

      // Replace keeps the _id; clone is an insert without one.
      const replaced = parseShell("{ _id: 'edge-numbers', only: NumberLong('1') }") as JsonObject
      assert.deepEqual(await worker.request('doc.replace', { ns: target, id: 'edge-numbers', doc: replaced }), { matched: 1, modified: 1 })
      await assert.rejects(worker.request('doc.replace', { ns: target, id: 'edge-numbers', doc: { _id: 'other' } }), /_id can't change/)
      const { _id: _drop, ...copy } = after
      void _drop
      const inserted = await worker.request('doc.insert', { ns: target, docs: [copy, { n: 1 }] })
      assert.equal(inserted.insertedIds.length, 2)
      assert.equal(bsonType(inserted.insertedIds[0]!), 'objectId')

      // Bulk delete by _id, with the count back.
      const page = await worker.request('query.run', { ns: target, spec: spec(), pageSize: 50 })
      assert.equal(page.docs.length, 5)
      assert.deepEqual(page.truncated, [page.docs.findIndex((d) => d._id === 'big-array')], 'the 2,000-item array is truncated')
      const ids: JsonValue[] = page.docs.filter((d) => d._id !== 'all-types').map((d) => d._id!)
      assert.equal(new Set(ids.map(idKey)).size, 4)
      assert.deepEqual(await worker.request('doc.deleteMany', { ns: target, ids }), { deleted: 4 })
      assert.equal((await worker.request('query.count', { ns: target, spec: spec({ filter: '{ _id: { $exists: true } }' }) })).count, 1)
    } finally {
      await worker.deactivate()
      await zoo.collection(scratch).drop().catch(() => undefined)
      await direct.close()
    }
  })
})

describe('update many (a scratch collection)', () => {
  test('previews count and one document before and after without writing, then updates each scope', async () => {
    if (!ON) return
    const direct = await MongoClient.connect(URI)
    const scratch = `it_update_${process.pid}`
    const db = direct.db('types_zoo')
    const coll = db.collection(scratch)
    await coll.insertMany([
      { _id: 1 as never, status: 'pending', n: 1, name: 'Ann' },
      { _id: 2 as never, status: 'pending', n: 2, name: 'bob' },
      { _id: 3 as never, status: 'shipped', n: 3, name: 'BOB' },
      { _id: 4 as never, status: 'shipped', n: 'x', name: 'cy' }
    ])
    const { worker, ns } = await setup()
    const target = ns('types_zoo', scratch)
    const update = parseShell("{ $set: { status: 'archived' }, $inc: { n: 10 } }") as JsonObject
    try {
      // Operators run on the first document in an aborted transaction: the after is the server's own.
      const byIds = await worker.request('doc.updatePreview', { ns: target, scope: { kind: 'ids', ids: [{ $numberInt: '2' }, { $numberInt: '3' }] }, update })
      assert.equal(byIds.count, 2)
      assert.deepEqual(byIds.sample!.before._id, { $numberInt: '2' })
      assert.deepEqual(byIds.sample!.after!.status, 'archived')
      assert.deepEqual(byIds.sample!.after!.n, { $numberInt: '12' })
      assert.deepEqual(byIds.sample!.diffs.map((d) => d.path).sort(), ['n', 'status'])
      assert.equal(byIds.sample!.error, undefined)
      assert.equal(await coll.countDocuments({ status: 'archived' }), 0, 'the preview saved nothing')

      // A filter with a collation matches as the query does; the server's refusal shows in the preview.
      const filter = { kind: 'filter' as const, filter: { name: 'bob' }, collation: { locale: 'en', strength: { $numberInt: '2' } } }
      const byFilter = await worker.request('doc.updatePreview', { ns: target, scope: filter, update })
      assert.equal(byFilter.count, 2)
      const bad = await worker.request('doc.updatePreview', { ns: target, scope: { kind: 'filter', filter: { _id: { $numberInt: '4' } } }, update })
      assert.match(bad.sample!.error!, /non-numeric/)

      // A pipeline runs as an aggregation on the sample.
      const pipeline = parseShell("[{ $set: { label: { $concat: ['$status', '-', '$name'] } } }]") as JsonObject[]
      const piped = await worker.request('doc.updatePreview', { ns: target, scope: { kind: 'all' }, update: pipeline })
      assert.equal(piped.count, 4)
      assert.equal(piped.approximate, true)
      assert.equal(piped.sample!.after!.label, 'pending-Ann')

      const none = await worker.request('doc.updatePreview', { ns: target, scope: { kind: 'filter', filter: { status: 'nope' } }, update })
      assert.equal(none.count, 0)
      assert.equal(none.sample, undefined)

      // The updates themselves.
      assert.deepEqual(await worker.request('doc.updateMany', { ns: target, scope: filter, update }), { matched: 2, modified: 2 })
      assert.deepEqual(await coll.find({ status: 'archived' }).map((d) => d._id).toArray(), [2, 3])
      assert.deepEqual(await worker.request('doc.updateMany', { ns: target, scope: { kind: 'ids', ids: [{ $numberInt: '1' }] }, update: { $set: { status: 'archived' } } }), { matched: 1, modified: 1 })
      assert.deepEqual(await worker.request('doc.updateMany', { ns: target, scope: { kind: 'all' }, update: pipeline }), { matched: 4, modified: 4 })
      assert.equal((await coll.findOne({ _id: 4 as never }))!.label, 'shipped-cy')
      await assert.rejects(worker.request('doc.updateMany', { ns: target, scope: { kind: 'all' }, update: { status: 'x' } }), /not an update operator/)
      await assert.rejects(worker.request('doc.updateMany', { ns: target, scope: { kind: 'ids', ids: [] }, update }), /Select the documents/)
    } finally {
      await worker.deactivate()
      await coll.drop().catch(() => undefined)
      await direct.close()
    }
  })
})
