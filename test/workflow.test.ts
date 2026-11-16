// Read-only connections and saved tasks against the seeded dev replica set (dev/docker-compose.yml,
// default profile, after dev/seed.mongodb.js). Run with MONGO_STUDIO_IT=1 (npm run test:it).
// Writes go to a scratch database and a temporary folder, removed at the end.
import '../src/worker'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import type { JobState, ShellEntry } from '../src/protocol'
import { emptyConnection, type ConnectionDef } from '../src/shared/model'
import type { Task } from '../src/shared/tasks'
import * as main from '../src/worker'

const ON = process.env.MONGO_STUDIO_IT === '1'
const URI = 'mongodb://localhost:27017/?directConnection=true'
const SCRATCH = 'mongo_studio_workflow_test'

type Worker = Awaited<ReturnType<typeof mountWorker>>

function devDef(name: string, readOnly: boolean): ConnectionDef {
  const def = emptyConnection('', 0)
  def.name = name
  def.hosts = [{ host: 'localhost', port: 27017 }]
  def.options.directConnection = true
  def.readOnly = readOnly
  return def
}

async function setup() {
  const worker = await mountWorker(main, { host: mockHost({ results: { 'secrets.protection': { status: 'os-keyring' } } }) })
  const save = async (def: ConnectionDef): Promise<string> => {
    const saved = await worker.request('connections.save', { def, secrets: {} })
    if (!saved.ok) throw new Error('save failed')
    return saved.id
  }
  const ro = await save(devDef('dev (read only)', true))
  const rw = await save(devDef('dev', false))
  const run = async (connectionId: string, code: string, db = SCRATCH): Promise<ShellEntry[]> => {
    const { runId } = await worker.request('shell.run', { connectionId, db, code, line: 1, column: 1 })
    const entries: ShellEntry[] = []
    for (let polls = 0; ; polls++) {
      if (polls > 20) throw new Error(`The run did not finish: ${JSON.stringify(entries)}`)
      const p = await worker.request('shell.poll', { runId, after: entries.length })
      entries.push(...p.entries)
      if (p.done) return entries
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'mongo-studio-workflow-'))
  return { worker, ro, rw, run, dir, save }
}

async function direct<T>(fn: (c: MongoClient) => Promise<T>): Promise<T> {
  const c = await new MongoClient(URI).connect()
  try {
    return await fn(c)
  } finally {
    await c.close()
  }
}

async function cleanup(worker: Worker, dir: string): Promise<void> {
  await worker.deactivate()
  await direct((c) => c.db(SCRATCH).dropDatabase())
  await rm(dir, { recursive: true, force: true })
}

async function finish(worker: Worker, jobId: string): Promise<JobState> {
  let version = 0
  const until = Date.now() + 90_000
  for (;;) {
    const s = await worker.request('job.poll', { jobId, version, waitMs: 2000 })
    version = s.version
    if (s.status !== 'running') return s
    if (Date.now() > until) throw new Error(`Job still running after 90 s: ${JSON.stringify(s)}`)
  }
}

/** The task once its last run is recorded (the worker records it just after the job ends). */
async function lastRun(worker: Worker, id: string): Promise<NonNullable<Task['lastRun']>> {
  for (let i = 0; i < 50; i++) {
    const t = (await worker.request('tasks.list')).tasks.find((x) => x.id === id)
    if (t?.lastRun) return t.lastRun
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('The run was not recorded.')
}

const errors = (entries: ShellEntry[]): string[] => entries.filter((e) => e.kind === 'error').map((e) => e.text)
const results = (entries: ShellEntry[]): string[] => entries.filter((e) => e.kind === 'result').map((e) => e.text)

describe('read-only connections', () => {
  test('the shell reads, and every kind of write is refused before it reaches the server', async () => {
    if (!ON) return
    const { worker, ro, rw, run, dir } = await setup()
    try {
      await direct((c) => c.db(SCRATCH).collection('items').insertMany([{ _id: 1 as never, n: 1 }, { _id: 2 as never, n: 2 }]))
      const reads = await run(ro, `db.items.countDocuments({})
db.items.find({ n: { $gt: 1 } }).toArray().length
db.items.aggregate([{ $group: { _id: null, total: { $sum: '$n' } } }]).toArray()[0].total
db.runCommand({ ping: 1 }).ok
db.items.find({ n: 1 }).explain('executionStats').executionStats.nReturned
db.getSiblingDB('admin').runCommand({ listDatabases: 1, nameOnly: true }).ok
db.getCollectionNames().length`)
      assert.deepEqual(errors(reads), [])
      assert.deepEqual(results(reads), ['2', '1', '3', '1', '1', '1', '1'])

      const writes: [string, RegExp][] = [
        ["db.items.insertOne({ _id: 3 })", /refuses insertOne from the shell/],
        ['db.items.updateMany({}, { $set: { n: 0 } })', /refuses updateMany from the shell/],
        ['db.items.deleteMany({})', /refuses deleteMany from the shell/],
        ['db.items.drop()', /refuses drop from the shell/],
        ["db.items.createIndex({ n: 1 })", /refuses createIndex from the shell/],
        ["db.runCommand({ drop: 'items' })", /refuses drop from the shell/],
        ["db.runCommand({ insert: 'items', documents: [{ _id: 4 }] })", /refuses insert from the shell/],
        ["db.items.aggregate([{ $out: 'copy' }]).toArray()", /refuses \$out from the shell/],
        ["db.createCollection('other')", /refuses createCollection from the shell/],
        ['db.dropDatabase()', /refuses dropDatabase from the shell/]
      ]
      for (const [code, why] of writes) {
        const out = await run(ro, code)
        assert.equal(errors(out).length, 1, code)
        assert.match(errors(out)[0]!, /"dev \(read only\)" is read only/, code)
        assert.match(errors(out)[0]!, why, code)
      }
      const left = await direct(async (c) => ({
        docs: await c.db(SCRATCH).collection('items').find().sort({ _id: 1 }).toArray(),
        names: (await c.db(SCRATCH).listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name).sort(),
        indexes: (await c.db(SCRATCH).collection('items').indexes()).length
      }))
      assert.deepEqual(left, { docs: [{ _id: 1, n: 1 }, { _id: 2, n: 2 }], names: ['items'], indexes: 1 })

      // The same writes go through on a writable connection.
      assert.deepEqual(errors(await run(rw, 'db.items.insertOne({ _id: 3, n: 3 })')), [])
      assert.equal(await direct((c) => c.db(SCRATCH).collection('items').countDocuments()), 3)
    } finally {
      await cleanup(worker, dir)
    }
  })

  test('panel requests read and export, but refuse to change anything', async () => {
    if (!ON) return
    const { worker, ro, dir } = await setup()
    try {
      const orders = { connectionId: ro, db: 'shop', collection: 'orders' }
      const page = await worker.request('query.run', { ns: orders, spec: { filter: {}, skip: 0, limit: 5 }, pageSize: 5 })
      assert.equal(page.docs.length, 5)
      await assert.rejects(worker.request('doc.insert', { ns: orders, docs: [{ a: 1 }] }), /read only, so Mongo Studio refuses inserting documents/)
      await assert.rejects(worker.request('admin.dropCollection', { ns: orders }), /refuses dropping a collection/)
      const path = join(dir, 'five.json')
      const { jobId } = await worker.request('export.start', { source: { kind: 'query', ns: orders, spec: { filter: {}, skip: 0, limit: 5 } }, options: { format: 'json', json: { layout: 'lines', relaxed: true, pretty: false } }, destination: { kind: 'path', path, overwrite: false } })
      assert.equal((await finish(worker, jobId)).status, 'done')
      assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 5)
    } finally {
      await cleanup(worker, dir)
    }
  })
})

describe('saved tasks', () => {
  test('an export, a copy and a sync saved and run on demand, each run recorded', async () => {
    if (!ON) return
    const { worker, rw, dir } = await setup()
    try {
      const orders = { connectionId: rw, db: 'shop', collection: 'orders' }
      const spec = { filter: { status: 'shipped' }, skip: 0, limit: 0 }
      const shipped = await direct((c) => c.db('shop').collection('orders').countDocuments({ status: 'shipped' }))
      const path = join(dir, 'shipped.json')

      const exp = await worker.request('tasks.save', { name: 'Shipped orders to a file', request: { kind: 'export', source: { kind: 'query', ns: orders, spec }, options: { format: 'json', json: { layout: 'lines', relaxed: true, pretty: false } }, destination: { kind: 'path', path, overwrite: true } } })
      for (let round = 0; round < 2; round++) {
        const s = await finish(worker, (await worker.request('tasks.run', { id: exp.id })).jobId)
        assert.equal(s.status, 'done', s.message)
      }
      assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, shipped)
      const r1 = await lastRun(worker, exp.id)
      assert.equal(r1.status, 'done')
      assert.equal(r1.summary, `Wrote ${shipped.toLocaleString('en-US')} documents to ${path}.`)

      const copy = await worker.request('tasks.save', { name: 'Shipped orders to scratch', request: { kind: 'export', source: { kind: 'query', ns: orders, spec }, options: { format: 'collection', collection: { connectionId: rw, db: SCRATCH, collection: 'shipped', mode: 'upsert', indexes: true, options: true } }, destination: { kind: 'download' } } })
      assert.equal((await finish(worker, (await worker.request('tasks.run', { id: copy.id })).jobId)).status, 'done')
      assert.equal(await direct((c) => c.db(SCRATCH).collection('shipped').countDocuments()), shipped)
      assert.match((await lastRun(worker, copy.id)).summary, /^Copied .* documents: .* inserted\.$/)

      // Drift the copy, then a saved sync puts it back.
      await direct(async (c) => {
        const col = c.db(SCRATCH).collection('shipped')
        const first = await col.findOne({}, { sort: { _id: 1 } })
        await col.deleteOne({ _id: first!._id })
        await col.insertOne({ stray: true, status: 'shipped' })
      })
      const sync = await worker.request('tasks.save', { name: 'Keep scratch in step', request: { kind: 'sync', from: orders, to: { connectionId: rw, db: SCRATCH, collection: 'shipped' }, filter: { status: 'shipped' }, rules: { ignoreFields: [], ignoreOrder: false }, insert: true, replace: true, remove: true } })
      assert.equal((await finish(worker, (await worker.request('tasks.run', { id: sync.id })).jobId)).status, 'done')
      assert.equal((await lastRun(worker, sync.id)).summary, '1 inserted, 0 replaced, 1 deleted.')
      assert.equal(await direct((c) => c.db(SCRATCH).collection('shipped').countDocuments()), shipped)

      assert.ok(worker.posts.filter((p) => p.event === 'tasks.changed').length >= 7, 'saves and recorded runs reach open panels')
    } finally {
      await cleanup(worker, dir)
    }
  })

  test('a failed run is recorded with its reason', async () => {
    if (!ON) return
    const { worker, rw, dir } = await setup()
    try {
      const t = await worker.request('tasks.save', { name: 'Missing file', request: { kind: 'import', source: { kind: 'path', path: join(dir, 'nope.json') }, options: { format: 'json', mode: 'insert', drop: false, stopOnError: false, indexes: false }, ns: { connectionId: rw, db: SCRATCH, collection: 'x' } } })
      const s = await finish(worker, (await worker.request('tasks.run', { id: t.id })).jobId)
      assert.equal(s.status, 'failed')
      const run = await lastRun(worker, t.id)
      assert.equal(run.status, 'failed')
      assert.match(run.summary, /nope\.json/)
    } finally {
      await cleanup(worker, dir)
    }
  })
})
