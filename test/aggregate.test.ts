// Aggregation and explain against the seeded dev replica set (dev/docker-compose.yml, default
// profile, after dev/seed.mongodb.js). Run with MONGO_STUDIO_IT=1 (npm run test:it). Views and
// $out targets go to a scratch database, dropped at the end.
import '../src/worker'
import { MongoClient } from 'mongodb'
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import type { Namespace, ShellEntry } from '../src/protocol'
import type { JsonObject } from '../src/shared/ejson-view'
import { fitsHost } from '../src/shared/host-size'
import { emptyConnection } from '../src/shared/model'
import { parseShell } from '../src/shared/shell-parse'
import * as main from '../src/worker'

const ON = process.env.MONGO_STUDIO_IT === '1'
const URI = 'mongodb://localhost:27017/?directConnection=true'
const SCRATCH = 'mongo_studio_agg_test'

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

const p = (text: string): JsonObject[] => parseShell(text) as JsonObject[]

describe('aggregation', () => {
  test('a stage preview shows its input and output, a few documents each', async () => {
    if (!ON) return
    const { worker, ns } = await setup()
    try {
      const orders = ns('shop', 'orders')
      const r = await worker.request('agg.preview', { ns: orders, before: p("[{ $match: { status: 'shipped' } }]"), stage: p("[{ $group: { _id: '$payment.method', n: { $sum: 1 } } }]")[0]!, size: 5, options: {} })
      assert.equal(r.input.docs.length, 5)
      assert.equal(r.input.more, true)
      assert.ok(r.input.docs.every((d) => d.status === 'shipped'))
      assert.ok(r.output!.docs.length > 0 && r.output!.docs.length <= 5)
      assert.deepEqual(Object.keys(r.output!.docs[0]!).sort(), ['_id', 'n'])
      // No stage: only the input, here the collection itself.
      const first = await worker.request('agg.preview', { ns: orders, before: [], size: 3, options: {} })
      assert.equal(first.output, undefined)
      assert.equal(first.input.docs.length, 3)
      // Writes never run in a preview.
      const refused = await worker.request('agg.preview', { ns: orders, before: [], stage: { $out: 'x' }, size: 3, options: {} }).catch((e: Error) => e)
      assert.ok(refused instanceof Error && /never runs \$out/.test(refused.message))
      // 100 whole orders fit what a panel may receive.
      const big = await worker.request('agg.preview', { ns: orders, before: [], stage: { $match: {} }, size: 100, options: {} })
      assert.ok(fitsHost(big, 1))
    } finally {
      await worker.deactivate()
    }
  })

  test('runs a pipeline and pages it, reading on from the cursor or re-running with $skip', async () => {
    if (!ON) return
    const { worker, ns } = await setup()
    try {
      const orders = ns('shop', 'orders')
      const pipeline = p("[{ $match: { status: 'shipped' } }, { $sort: { orderNo: 1 } }, { $project: { orderNo: 1, _id: 0 } }]")
      const first = await worker.request('agg.run', { ns: orders, pipeline, options: {}, pageSize: 100 })
      assert.equal(first.docs.length, 100)
      assert.equal(first.hasMore, true)
      const next = await worker.request('agg.page', { queryId: first.queryId, ns: orders, pipeline, options: {}, offset: 100, pageSize: 100 })
      assert.ok(BigInt((next.docs[0]!.orderNo as { $numberLong: string }).$numberLong) > BigInt((first.docs[99]!.orderNo as { $numberLong: string }).$numberLong))
      const back = await worker.request('agg.page', { queryId: first.queryId, ns: orders, pipeline, options: {}, offset: 50, pageSize: 10 })
      assert.deepEqual(back.docs[0], first.docs[50])
      const count = await worker.request('agg.count', { ns: orders, pipeline, options: {} })
      const direct = await new MongoClient(URI).connect().then(async (c) => {
        try {
          return await c.db('shop').collection('orders').countDocuments({ status: 'shipped' })
        } finally {
          await c.close()
        }
      })
      assert.equal(count.count, direct)
      const bad = await worker.request('agg.run', { ns: orders, pipeline: [{ $bogus: {} }], options: {}, pageSize: 10 }).catch((e: Error) => e)
      assert.ok(bad instanceof Error && /\$bogus/.test(bad.message))
      await worker.request('query.close', { queryId: first.queryId })
    } finally {
      await worker.deactivate()
    }
  })

  test('$out runs once on Run, and is never re-run for a page or a count', async () => {
    if (!ON) return
    const { worker, ns } = await setup()
    const client = await new MongoClient(URI).connect()
    try {
      const orders = ns('shop', 'orders')
      const pipeline = p(`[{ $match: { status: 'shipped' } }, { $limit: 7 }, { $out: { db: '${SCRATCH}', coll: 'shipped' } }]`)
      const r = await worker.request('agg.run', { ns: orders, pipeline, options: {}, pageSize: 20 })
      assert.equal(r.docs.length, 0)
      assert.equal(r.hasMore, false)
      assert.equal(await client.db(SCRATCH).collection('shipped').countDocuments(), 7)
      const again = await worker.request('agg.page', { queryId: r.queryId, ns: orders, pipeline, options: {}, offset: 0, pageSize: 20 }).catch((e: Error) => e)
      assert.ok(again instanceof Error && /not run again/.test(again.message))
      const count = await worker.request('agg.count', { ns: orders, pipeline, options: {} })
      assert.equal(count.count, null)
    } finally {
      await client.db(SCRATCH).dropDatabase()
      await client.close()
      await worker.deactivate()
    }
  })

  test('creates a view from a pipeline, refusing a taken name and $out', async () => {
    if (!ON) return
    const { worker, ns } = await setup()
    const client = await new MongoClient(URI).connect()
    try {
      await client.db(SCRATCH).collection('src').insertMany([{ a: 1 }, { a: 2 }, { a: 3 }])
      const src = ns(SCRATCH, 'src')
      const r = await worker.request('view.create', { ns: src, name: ' big ', pipeline: p('[{ $match: { a: { $gte: 2 } } }]') })
      assert.equal(r.name, 'big')
      const info = await client.db(SCRATCH).listCollections({ name: 'big' }).toArray()
      assert.equal(info[0]?.type, 'view')
      assert.equal(await client.db(SCRATCH).collection('big').countDocuments(), 2)
      const taken = await worker.request('view.create', { ns: src, name: 'big', pipeline: [] }).catch((e: Error) => e)
      assert.ok(taken instanceof Error && /already exists/.test(taken.message))
      const out = await worker.request('view.create', { ns: src, name: 'other', pipeline: [{ $out: 'x' }] }).catch((e: Error) => e)
      assert.ok(out instanceof Error && /cannot hold a \$out/.test(out.message))
      const dollar = await worker.request('view.create', { ns: src, name: 'a$b', pipeline: [] }).catch((e: Error) => e)
      assert.ok(dollar instanceof Error && /\$/.test(dollar.message))
    } finally {
      await client.db(SCRATCH).dropDatabase()
      await client.close()
      await worker.deactivate()
    }
  })

  test('saved pipelines are kept per collection and removed with the connection', async () => {
    if (!ON) return
    const { worker, ns, connectionId } = await setup()
    try {
      const orders = ns('shop', 'orders')
      const stages = [{ op: '$match', body: "{ status: 'shipped' }", enabled: true }, { op: '$limit', body: '5', enabled: false }]
      const r = await worker.request('pipelines.save', { ns: orders, name: 'Shipped', stages })
      assert.deepEqual(r.saved.map((s) => s.name), ['Shipped'])
      assert.deepEqual(r.saved[0]!.stages, stages)
      assert.deepEqual((await worker.request('pipelines.list', { ns: ns('shop', 'customers') })).saved, [])
      await worker.request('connections.delete', { id: connectionId })
      assert.ok(!Object.keys(worker.host.data().storage).some((k) => k.startsWith('pipelines.v1.')))
    } finally {
      await worker.deactivate()
    }
  })
})

describe('explain', () => {
  test('a find on an indexed field shows the index; an unindexed one a collection scan', async () => {
    if (!ON) return
    const { worker, ns } = await setup()
    try {
      const orders = ns('shop', 'orders')
      const indexed = await worker.request('query.explain', { ns: orders, spec: { filter: { status: 'shipped' }, sort: { total: { $numberInt: '-1' } }, skip: 0, limit: 5 }, verbosity: 'executionStats' })
      const s = indexed.summary
      assert.deepEqual(s.indexes, ['status'])
      assert.equal(s.collectionScan, false)
      assert.equal(s.inMemorySort, true)
      assert.equal(s.nReturned, 5)
      assert.ok((s.docsExamined ?? 0) > 1000)
      assert.equal(s.namespace, 'shop.orders')
      assert.equal(s.stages[0]!.stage, 'SORT')
      assert.equal(s.stages[0]!.children[0]!.stage, 'FETCH')
      assert.equal(s.stages[0]!.children[0]!.children[0]!.stage, 'IXSCAN')
      assert.equal(s.stages[0]!.children[0]!.children[0]!.keysExamined, s.keysExamined)
      assert.ok(s.warnings.some((w) => /sorted in memory/.test(w)))
      assert.match(indexed.raw, /"winningPlan"/)
      assert.ok(!/\$clusterTime/.test(indexed.raw))

      const scan = await worker.request('query.explain', { ns: orders, spec: { filter: { 'payment.method': 'card' }, skip: 0, limit: 0 }, verbosity: 'queryPlanner' })
      assert.equal(scan.summary.collectionScan, true)
      assert.equal(scan.summary.hasStats, false)
      assert.equal(scan.summary.nReturned, undefined)
      assert.ok(scan.summary.warnings.some((w) => /collection scan/.test(w)))
    } finally {
      await worker.deactivate()
    }
  })

  test('a pipeline explains its stages, pushed down or not', async () => {
    if (!ON) return
    const { worker, ns } = await setup()
    try {
      const orders = ns('shop', 'orders')
      const grouped = await worker.request('agg.explain', { ns: orders, pipeline: p("[{ $match: { status: 'shipped' } }, { $group: { _id: '$customerId', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 3 }]"), options: {}, verbosity: 'executionStats' })
      const g = grouped.summary
      assert.equal(g.kind, 'aggregate')
      assert.deepEqual(g.indexes, ['status'])
      assert.equal(g.nReturned, 3)
      assert.ok(g.hasStats)
      const names: string[] = []
      const walk = (n: { stage: string; children: { stage: string; children: never[] }[] }): void => {
        names.push(n.stage)
        n.children.forEach(walk)
      }
      g.stages.forEach((n) => walk(n as never))
      assert.ok(names.includes('IXSCAN'), names.join())
      assert.ok(names.includes('GROUP') || names.includes('$group'), names.join())

      const facet = await worker.request('agg.explain', { ns: orders, pipeline: p("[{ $match: { status: 'shipped' } }, { $facet: { n: [{ $count: 'n' }] } }]"), options: {}, verbosity: 'executionStats' })
      assert.equal(facet.summary.stages[0]!.stage, '$cursor')
      assert.equal(facet.summary.stages.at(-1)!.stage, '$facet')
      assert.equal(facet.summary.nReturned, 1)

      const writes = await worker.request('agg.explain', { ns: orders, pipeline: p(`[{ $limit: 1 }, { $out: { db: '${SCRATCH}', coll: 'never' } }]`), options: {}, verbosity: 'executionStats' })
      assert.equal(writes.verbosity, 'queryPlanner')
      assert.match(writes.note ?? '', /without running it/)
      const client = await new MongoClient(URI).connect()
      try {
        assert.deepEqual(await client.db(SCRATCH).listCollections({ name: 'never' }).toArray(), [])
      } finally {
        await client.close()
      }
    } finally {
      await worker.deactivate()
    }
  })

  test('the shell explains cursors and collections', async () => {
    if (!ON) return
    const { worker, connectionId } = await setup()
    const run = async (code: string): Promise<ShellEntry[]> => {
      const { runId } = await worker.request('shell.run', { connectionId, db: 'shop', code, line: 1, column: 1 })
      const entries: ShellEntry[] = []
      for (;;) {
        const r = await worker.request('shell.poll', { runId, after: entries.length })
        entries.push(...r.entries)
        if (r.done) return entries
      }
    }
    try {
      const e = await run(`db.orders.find({ status: 'shipped' }).sort({ total: -1 }).limit(2).explain('executionStats').executionStats.nReturned
db.orders.explain().find({ status: 'shipped' }).finish().queryPlanner.winningPlan.inputStage.stage
db.orders.explain('executionStats').find({ status: 'shipped' }).limit(1)
db.orders.aggregate([{ $match: { status: 'shipped' } }]).explain().queryPlanner.winningPlan.stage
db.orders.explain().count({ status: 'shipped' }).queryPlanner.winningPlan.stage
db.orders.find().explain('everything')`)
      assert.equal(e[0]!.text, '2')
      assert.equal(e[1]!.text, "'IXSCAN'")
      assert.equal(e[2]!.kind, 'result')
      assert.match(e[2]!.text, /executionStats/)
      assert.equal(e[3]!.text, "'FETCH'")
      assert.equal(e[4]!.text, "'COUNT'")
      assert.equal(e[5]!.kind, 'error')
      assert.match(e[5]!.text, /verbosity is one of queryPlanner/)
    } finally {
      await worker.deactivate()
    }
  })
})
