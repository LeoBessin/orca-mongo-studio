// The shell against the seeded dev replica set (dev/docker-compose.yml, default profile, after
// dev/seed.mongodb.js). Run with MONGO_STUDIO_IT=1 (npm run test:it). Writes go to a scratch
// database, dropped at the end.
import '../src/worker'
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import type { ShellEntry, ShellRunSummary } from '../src/protocol'
import { emptyConnection } from '../src/shared/model'
import * as main from '../src/worker'

const ON = process.env.MONGO_STUDIO_IT === '1'
const SCRATCH = 'mongo_studio_shell_test'

async function setup() {
  const worker = await mountWorker(main, { host: mockHost({ results: { 'secrets.protection': { status: 'os-keyring' } } }) })
  const def = emptyConnection('', 0)
  def.name = 'dev'
  def.hosts = [{ host: 'localhost', port: 27017 }]
  def.options.directConnection = true
  const saved = await worker.request('connections.save', { def, secrets: {} })
  if (!saved.ok) throw new Error('save failed')
  const run = async (code: string, db = 'shop'): Promise<{ entries: ShellEntry[]; db: string; runId: string }> => {
    const { runId } = await worker.request('shell.run', { connectionId: saved.id, db, code, line: 1, column: 1 })
    const entries: ShellEntry[] = []
    for (let polls = 0; ; polls++) {
      if (polls > 20) throw new Error(`The run did not finish: ${JSON.stringify(entries)}`)
      const p = await worker.request('shell.poll', { runId, after: entries.length })
      entries.push(...p.entries)
      if (p.done) return { entries, db: p.db, runId }
    }
  }
  return { worker, run, connectionId: saved.id }
}

const texts = (entries: ShellEntry[]): string[] => entries.map((e) => `${e.kind}: ${e.text}`)

describe('the shell', () => {
  test('runs statements in order, synchronously, with prints, values and declarations', async () => {
    if (!ON) return
    const { worker, run } = await setup()
    try {
      const { entries } = await run(`// a script
const n = db.orders.countDocuments({ status: 'shipped' })
print('shipped:', n > 0)
const first = db.orders.find().sort({ orderNo: 1 }).limit(1).toArray()[0]
first.orderNo
let total = 0
db.orders.find({}, { orderNo: 1 }).sort({ orderNo: 1 }).limit(10).forEach((o) => { total += 1 })
total
1 + 1; 'done'`)
      assert.deepEqual(texts(entries), ['print: shipped: true', "result: NumberLong('1000000')", 'result: 10', 'result: 2', "result: 'done'"])
    } finally {
      await worker.deactivate()
    }
  })

  test('variables last between runs of one editor, and await works', async () => {
    if (!ON) return
    const { worker, run } = await setup()
    try {
      await run('const x = 41')
      const { entries } = await run('x + 1\nconst doc = await db.orders.findOne({}, { _id: 0, orderNo: 1 })\ndoc.orderNo !== undefined\nconst x = 5\nx')
      assert.deepEqual(texts(entries), ['result: 42', 'result: true', 'result: 5'])
    } finally {
      await worker.deactivate()
    }
  })

  test('a cursor result is paged by the panel, and its find becomes an operation', async () => {
    if (!ON) return
    const { worker, run } = await setup()
    try {
      const { entries, runId } = await run("db.orders.find({ status: 'shipped' }, { orderNo: 1 }).sort({ orderNo: -1 }).skip(2)")
      assert.equal(entries.length, 1)
      const e = entries[0]!
      assert.equal(e.kind, 'result')
      if (e.kind !== 'result') return
      assert.equal(e.resultIndex, 0)
      assert.match(e.summary ?? '', /^find on shop\.orders: first 20 documents$/)
      const announced = worker.posts.filter((p) => p.event === 'shell.results').map((p) => p.payload as ShellRunSummary)
      assert.equal(announced.at(-1)?.runId, runId)
      const latest = await worker.request('shell.latest')
      assert.equal(latest.run?.runId, runId)
      const info = latest.run!.results[0]!
      assert.equal(info.kind, 'cursor')
      assert.deepEqual(info.op, { kind: 'find', db: 'shop', collection: 'orders', filter: { status: 'shipped' }, projection: { orderNo: { $numberInt: '1' } }, sort: { orderNo: { $numberInt: '-1' } }, skip: 2 })
      const p1 = await worker.request('shell.page', { runId, index: 0, offset: 0, pageSize: 50 })
      assert.equal(p1.docs.length, 50)
      assert.equal(p1.hasMore, true)
      const p2 = await worker.request('shell.page', { runId, index: 0, offset: 50, pageSize: 50 })
      assert.equal(p2.offset, 50)
      assert.ok(BigInt(String((p1.docs[49]!.orderNo as { $numberLong: string }).$numberLong)) > BigInt(String((p2.docs[0]!.orderNo as { $numberLong: string }).$numberLong)))
    } finally {
      await worker.deactivate()
    }
  })

  test('writes, shell commands and BSON constructors', async () => {
    if (!ON) return
    const { worker, run } = await setup()
    try {
      const { entries, db } = await run(`use ${SCRATCH}
db.dropDatabase()
db.things.insertOne({ _id: 1, n: NumberLong('9007199254740993'), d: NumberDecimal('1.10'), at: ISODate('2024-01-02T03:04:05Z'), id: ObjectId('6542f1a2b3c4d5e6f7a8b9c0'), u: UUID('0f8fad5b-d9cb-469f-a165-70867728950e'), i: NumberInt(3), f: 2.5 })
db.things.findOne({ _id: 1 })
show collections
db.things.updateOne({ _id: 1 }, { $inc: { i: 1 } }).modifiedCount
db.things.findOne().i
db.getSiblingDB('shop').getName()
db.getName()`)
      const t = texts(entries)
      assert.equal(t[0], `info: switched to db ${SCRATCH}`)
      assert.match(t[2]!, /insertedId: 1/)
      assert.equal(
        t[3],
        "result: {\n  _id: 1,\n  n: NumberLong('9007199254740993'),\n  d: NumberDecimal('1.10'),\n  at: ISODate('2024-01-02T03:04:05Z'),\n  id: ObjectId('6542f1a2b3c4d5e6f7a8b9c0'),\n  u: UUID('0f8fad5b-d9cb-469f-a165-70867728950e'),\n  i: 3,\n  f: 2.5\n}"
      )
      assert.equal(t[4], 'result: things')
      assert.deepEqual(t.slice(5), ['result: 1', 'result: 4', "result: 'shop'", `result: '${SCRATCH}'`])
      assert.equal(db, SCRATCH)
      await run('db.dropDatabase()', SCRATCH)
    } finally {
      await worker.deactivate()
    }
  })

  test('errors stop the script and name the line; a server error keeps its code', async () => {
    if (!ON) return
    const { worker, run } = await setup()
    try {
      const a = await run('print(1)\n\nnope.call()\nprint(2)')
      assert.deepEqual(texts(a.entries), ['print: 1', 'error: Line 3, column 1: ReferenceError: nope is not defined'])
      const b = await run("db.orders.aggregate([{ $bogus: 1 }]).toArray()")
      assert.equal(b.entries[0]!.kind, 'error')
      assert.match(b.entries[0]!.text, /^Line 1, column 38: MongoServerError: .*\$bogus.*\(Location40324\)$/)
      const c = await run('db.orders.find({').catch((e: Error) => e)
      assert.ok(!(c instanceof Error))
      if (!(c instanceof Error)) assert.match(c.entries[0]!.text, /^Line 1.*SyntaxError/)
    } finally {
      await worker.deactivate()
    }
  })

  test('a runaway loop can be stopped', async () => {
    if (!ON) return
    const { worker, connectionId } = await setup()
    try {
      const { runId } = await worker.request('shell.run', { connectionId, db: 'shop', code: 'while (true) {}', line: 1, column: 1 })
      const first = await Promise.race([worker.request('shell.poll', { runId, after: 0 }), new Promise((r) => setTimeout(() => r('waiting'), 300))])
      assert.equal(first, 'waiting')
      await worker.request('shell.cancel', { runId })
      const p = await worker.request('shell.poll', { runId, after: 0 })
      assert.equal(p.done, true)
      assert.match(p.entries[0]!.text, /Stopped/)
      // The next run starts a fresh session.
      const { runId: next } = await worker.request('shell.run', { connectionId, db: 'shop', code: "typeof x + ' ' + 7", line: 1, column: 1 })
      const got: string[] = []
      for (;;) {
        const out = await worker.request('shell.poll', { runId: next, after: got.length })
        got.push(...out.entries.map((e) => e.text))
        if (out.done) break
      }
      assert.deepEqual(got, ["'undefined 7'"])
    } finally {
      await worker.deactivate()
    }
  })

  test('autocomplete names collections and sampled fields', async () => {
    if (!ON) return
    const { worker, connectionId } = await setup()
    try {
      const r = await worker.request('shell.complete', { connectionId, db: 'shop', collection: 'orders' })
      assert.ok(r.collections.includes('orders'))
      assert.equal(r.fields[0], '_id')
      assert.ok(r.fields.includes('status'))
      const dbs = await worker.request('shell.databases', { connectionId })
      assert.ok(dbs.names.includes('shop'))
    } finally {
      await worker.deactivate()
    }
  })
})
