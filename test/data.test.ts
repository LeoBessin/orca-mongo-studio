// Data movement against the seeded dev replica set (dev/docker-compose.yml, default profile, after
// dev/seed.mongodb.js). Run with MONGO_STUDIO_IT=1 (npm run test:it). Writes go to scratch
// databases and a temporary folder, removed at the end.
import '../src/worker'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient, type Document } from 'mongodb'
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import type { ExportDestination, ExportOptions, ExportSource, ImportOptions, JobState, Namespace } from '../src/protocol'
import { emptyConnection } from '../src/shared/model'
import * as main from '../src/worker'

const ON = process.env.MONGO_STUDIO_IT === '1'
const URI = 'mongodb://localhost:27017/?directConnection=true'
const SCRATCH = 'mongo_studio_data_test'
const SCRATCH2 = 'mongo_studio_data_test2'

type Worker = Awaited<ReturnType<typeof mountWorker>>

async function setup() {
  const worker = await mountWorker(main, { host: mockHost({ results: { 'secrets.protection': { status: 'os-keyring' } } }) })
  const save = async (name: string): Promise<string> => {
    const def = emptyConnection('', 0)
    def.name = name
    def.hosts = [{ host: 'localhost', port: 27017 }]
    def.options.directConnection = true
    const saved = await worker.request('connections.save', { def, secrets: {} })
    if (!saved.ok) throw new Error('save failed')
    return saved.id
  }
  const connectionId = await save('dev')
  const otherId = await save('dev (other)')
  const ns = (db: string, collection: string, id = connectionId): Namespace => ({ connectionId: id, db, collection })
  const dir = await mkdtemp(join(tmpdir(), 'mongo-studio-data-'))
  return { worker, ns, connectionId, otherId, dir }
}

async function direct<T>(fn: (c: MongoClient) => Promise<T>): Promise<T> {
  const c = await new MongoClient(URI).connect()
  try {
    return await fn(c)
  } finally {
    await c.close()
  }
}

async function cleanup(dir: string, worker?: Worker): Promise<void> {
  await worker?.deactivate()
  await direct(async (c) => {
    await c.db(SCRATCH).dropDatabase()
    await c.db(SCRATCH2).dropDatabase()
  })
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

async function done(worker: Worker, start: Promise<{ jobId: string }>): Promise<JobState> {
  const s = await finish(worker, (await start).jobId)
  assert.equal(s.status, 'done', s.message ?? JSON.stringify(s.errors))
  return s
}

async function download(worker: Worker, jobId: string): Promise<Buffer> {
  const parts: Buffer[] = []
  let offset = 0
  for (;;) {
    const r = await worker.request('job.read', { jobId, offset, size: 600 * 1024 })
    const b = Buffer.from(r.base64, 'base64')
    parts.push(b)
    offset += b.length
    if (offset >= r.total || b.length === 0) break
  }
  await worker.request('job.close', { jobId })
  return Buffer.concat(parts)
}

const exportJob = (worker: Worker, source: ExportSource, options: ExportOptions, destination: ExportDestination = { kind: 'download' }) => worker.request('export.start', { source, options, destination })
const importJob = (worker: Worker, path: string, ns: Namespace, options: Partial<ImportOptions> = {}) =>
  worker.request('import.start', { source: { kind: 'path', path }, ns, options: { format: 'auto', mode: 'insert', drop: false, stopOnError: false, indexes: true, ...options } })

async function upload(worker: Worker, text: string): Promise<string> {
  let uploadId: string | undefined
  for (let at = 0; at < text.length || at === 0; at += 100_000) {
    const r = await worker.request('import.upload', { chunk: text.slice(at, at + 100_000), ...(uploadId ? { uploadId } : {}) })
    uploadId = r.uploadId
  }
  return uploadId!
}

const all = (c: MongoClient, db: string, coll: string) => c.db(db).collection(coll).find({}, { promoteValues: false, promoteLongs: false, bsonRegExp: true, sort: { _id: 1 } }).toArray()

describe('data movement', () => {
  test('JSON export to the save dialog: lines and arrays, relaxed and canonical, with a query', async () => {
    if (!ON) return
    const { worker, ns, dir } = await setup()
    try {
      const orders = ns('shop', 'orders')
      const spec = { filter: { status: 'shipped' }, projection: { orderNo: { $numberInt: '1' }, total: { $numberInt: '1' } }, sort: { orderNo: { $numberInt: '1' } }, skip: 0, limit: 500 }
      const lines = await done(worker, exportJob(worker, { kind: 'query', ns: orders, spec }, { format: 'json', json: { layout: 'lines', relaxed: false, pretty: false } }))
      assert.equal(lines.result?.kind, 'export')
      const r = lines.result as Extract<JobState['result'], { kind: 'export' }>
      assert.equal(r.docs, 500)
      assert.equal(lines.total, 500)
      assert.equal(r.download?.name, 'orders.json')
      const text = (await download(worker, lines.jobId)).toString('utf8')
      const rows = text.trim().split('\n').map((l) => JSON.parse(l) as Document)
      assert.equal(rows.length, 500)
      assert.ok(rows[0]!.orderNo.$numberLong, 'canonical keeps Int64')
      assert.ok(rows[0]!.total.$numberDecimal)
      const arr = await done(worker, exportJob(worker, { kind: 'query', ns: orders, spec: { ...spec, limit: 3 } }, { format: 'json', json: { layout: 'array', relaxed: true, pretty: true } }))
      const parsed = JSON.parse((await download(worker, arr.jobId)).toString('utf8')) as Document[]
      assert.equal(parsed.length, 3)
      assert.equal(typeof parsed[0]!.orderNo, 'number')
      // A pipeline that writes is refused.
      const refused = await finish(worker, (await exportJob(worker, { kind: 'pipeline', ns: orders, pipeline: [{ $out: 'x' }], options: {} }, { format: 'json' })).jobId)
      assert.equal(refused.status, 'failed')
      assert.match(refused.message ?? '', /\$out or \$merge/)
    } finally {
      await cleanup(dir, worker)
    }
  })

  test('every BSON type survives BSON and canonical JSON round trips through files', async () => {
    if (!ON) return
    const { worker, ns, dir } = await setup()
    try {
      const zoo = ns('types_zoo', 'everything')
      const source: ExportSource = { kind: 'query', ns: zoo, spec: { filter: {}, skip: 0, limit: 0 } }
      const bsonPath = join(dir, 'everything.bson')
      const b = await done(worker, exportJob(worker, source, { format: 'bson', bson: { metadata: true } }, { kind: 'path', path: bsonPath, overwrite: false }))
      assert.deepEqual((b.result as { written: string[] }).written, [bsonPath, join(dir, 'everything.metadata.json')])
      // Writing again needs "overwrite".
      const again = await finish(worker, (await exportJob(worker, source, { format: 'bson' }, { kind: 'path', path: bsonPath, overwrite: false })).jobId)
      assert.match(again.message ?? '', /already exists/)
      const jsonPath = join(dir, 'everything.json')
      await done(worker, exportJob(worker, source, { format: 'json', json: { layout: 'array', relaxed: false, pretty: true } }, { kind: 'path', path: jsonPath, overwrite: false }))

      const preview = await worker.request('import.preview', { source: { kind: 'path', path: bsonPath }, options: { format: 'auto', mode: 'insert', drop: false, stopOnError: false, indexes: true }, size: 5 })
      assert.equal(preview.format, 'bson')
      assert.equal(preview.docs.length, 3)
      await done(worker, importJob(worker, bsonPath, ns(SCRATCH, 'from_bson')))
      await done(worker, importJob(worker, jsonPath, ns(SCRATCH, 'from_json')))
      await direct(async (c) => {
        const want = await all(c, 'types_zoo', 'everything')
        for (const name of ['from_bson', 'from_json']) {
          const got = await all(c, SCRATCH, name)
          assert.equal(got.length, want.length, name)
          assert.deepEqual(got.map((d) => JSON.stringify(d)), want.map((d) => JSON.stringify(d)), name)
        }
      })
      // And the compare job agrees.
      const cmp = await done(worker, worker.request('compare.start', { a: zoo, b: ns(SCRATCH, 'from_json'), rules: { ignoreFields: [], ignoreOrder: false } }))
      assert.deepEqual({ ...(cmp.result as object), ids: undefined }, { kind: 'compare', same: 3, differ: 0, onlyA: 0, onlyB: 0, ids: undefined, capped: false })
    } finally {
      await cleanup(dir, worker)
    }
  })

  test('CSV: export chosen fields, import with inferred types, typed headers and errors', async () => {
    if (!ON) return
    const { worker, ns, dir } = await setup()
    try {
      const path = join(dir, 'orders.csv')
      const spec = { filter: {}, sort: { orderNo: { $numberInt: '1' } }, skip: 0, limit: 1000 }
      await done(worker, exportJob(worker, { kind: 'query', ns: ns('shop', 'orders'), spec }, { format: 'csv', csv: { fields: ['orderNo', 'status', 'total', 'createdAt', 'shipping.city', 'items'], delimiter: ',', header: true } }, { kind: 'path', path, overwrite: false }))
      const text = await readFile(path, 'utf8')
      const lines = text.trim().split('\r\n')
      assert.equal(lines.length, 1001)
      assert.equal(lines[0], 'orderNo,status,total,createdAt,shipping.city,items')

      const preview = await worker.request('import.preview', { source: { kind: 'path', path }, options: { format: 'auto', mode: 'insert', drop: false, stopOnError: false, indexes: false, csv: { delimiter: ',', header: true, ignoreEmpty: true } }, size: 3 })
      assert.equal(preview.format, 'csv')
      assert.deepEqual(preview.columns?.map((c) => [c.field, c.type]), [['orderNo', 'int'], ['status', 'string'], ['total', 'double'], ['createdAt', 'date'], ['shipping.city', 'string'], ['items', 'json']])
      const columns = preview.columns!.map(({ samples: _s, ...c }) => (c.field === 'total' ? { ...c, type: 'decimal' as const } : c.field === 'orderNo' ? { ...c, type: 'long' as const } : c))
      await done(worker, importJob(worker, path, ns(SCRATCH, 'orders_csv'), { csv: { delimiter: ',', header: true, ignoreEmpty: true, columns } }))
      await direct(async (c) => {
        const d = (await c.db(SCRATCH).collection('orders_csv').find({}, { promoteValues: false, promoteLongs: false, sort: { orderNo: 1 } }).limit(1).toArray())[0]!
        const src = (await c.db('shop').collection('orders').find({}, { promoteValues: false, promoteLongs: false, sort: { orderNo: 1 } }).limit(1).toArray())[0]!
        assert.equal(d.orderNo._bsontype, 'Long')
        assert.equal(d.total._bsontype, 'Decimal128')
        assert.equal(String(d.total), String(src.total))
        assert.ok(d.createdAt instanceof Date)
        assert.equal(d.createdAt.getTime(), src.createdAt.getTime())
        assert.equal(d.shipping?.city, src.shipping?.city)
        assert.equal(Array.isArray(d.items), true)
        assert.equal(d.items.length, src.items.length)
        assert.equal(await c.db(SCRATCH).collection('orders_csv').countDocuments(), 1000)
      })

      // Pasted TSV with mongoimport-style typed headers, and a bad cell.
      const tsv = 'name.string()\tage.int32()\tjoined.date_iso8601()\tzip\n"Ada"\t36\t2026-01-02T03:04:05Z\t01234\nGrace\tforty\t2026-01-02\t75001\n'
      const uploadId = await upload(worker, tsv)
      const s = await finish(worker, (await worker.request('import.start', { source: { kind: 'upload', uploadId }, ns: ns(SCRATCH, 'people'), options: { format: 'tsv', mode: 'insert', drop: false, stopOnError: false, indexes: false, csv: { delimiter: '\t', header: true, ignoreEmpty: false } } })).jobId)
      assert.equal(s.status, 'done')
      assert.equal(s.errorCount, 1)
      assert.match(s.errors[0]!.message, /Line 3: age\.int32\(\): "forty" is not a whole number/)
      assert.deepEqual({ ...s.result, collections: undefined }, { kind: 'import', read: 2, inserted: 1, updated: 0, failed: 1, collections: undefined })
      await direct(async (c) => {
        const ada = (await c.db(SCRATCH).collection('people').findOne({ name: 'Ada' }, { promoteValues: false }))!
        assert.equal(ada.age._bsontype, 'Int32')
        assert.equal(ada.zip, '01234')
        assert.equal((ada.joined as Date).toISOString(), '2026-01-02T03:04:05.000Z')
      })
    } finally {
      await cleanup(dir, worker)
    }
  })

  test('import modes: insert counts taken ids, upsert replaces, merge sets fields, stop on error', async () => {
    if (!ON) return
    const { worker, ns, dir } = await setup()
    try {
      const target = ns(SCRATCH, 'modes')
      const opts = (mode: ImportOptions['mode'], extra: Partial<ImportOptions> = {}): ImportOptions => ({ format: 'json', mode, drop: false, stopOnError: false, indexes: false, ...extra })
      const run = async (text: string, options: ImportOptions) => finish(worker, (await worker.request('import.start', { source: { kind: 'upload', uploadId: await upload(worker, text) }, ns: target, options })).jobId)
      await run('[{"_id":1,"a":1,"b":1},{"_id":2,"a":2,"b":2}]', opts('insert'))
      const dup = await run('{"_id":2,"a":20}\n{"_id":3,"a":3}\n{bad json}\n', opts('insert'))
      assert.equal(dup.errorCount, 2)
      assert.ok(dup.errors.some((e) => e.record === 1 && /duplicate key/.test(e.message)))
      assert.ok(dup.errors.some((e) => e.record === 3 && /Line 3/.test(e.message)))
      const up = await run('{"_id":2,"a":22}', opts('upsert'))
      assert.deepEqual([up.result && 'updated' in up.result ? up.result.updated : -1], [1])
      await run('{"_id":1,"c":{"$numberLong":"5"}}\n{"_id":9,"c":9}', opts('merge'))
      const stop = await run('{"_id":1}\n{"_id":10}\n{"_id":11}', opts('insert', { stopOnError: true }))
      assert.equal(stop.errorCount, 1)
      await direct(async (c) => {
        const docs = await c.db(SCRATCH).collection('modes').find({}, { sort: { _id: 1 }, promoteLongs: false }).toArray()
        assert.equal(docs[0]!.c._bsontype, 'Long', 'merge keeps the type')
        assert.deepEqual(docs.map((d) => JSON.stringify({ ...d, ...(d.c?._bsontype ? { c: String(d.c) } : {}) })), [
          '{"_id":1,"a":1,"b":1,"c":"5"}',
          '{"_id":2,"a":22}',
          '{"_id":3,"a":3}',
          '{"_id":9,"c":9}'
        ])
      })
      // Drop first.
      await run('{"_id":"only"}', opts('insert', { drop: true }))
      assert.equal(await direct((c) => c.db(SCRATCH).collection('modes').countDocuments()), 1)
    } finally {
      await cleanup(dir, worker)
    }
  })

  test('a database to a dump folder and back: data, indexes, options and views', async () => {
    if (!ON) return
    const { worker, ns, connectionId, dir } = await setup()
    try {
      const folder = join(dir, 'shop')
      const dump = await done(worker, exportJob(worker, { kind: 'database', connectionId, db: 'shop', collections: ['customers', 'gold_customers', 'sessions'] }, { format: 'bson', bson: { metadata: true } }, { kind: 'path', path: folder, overwrite: false }))
      assert.deepEqual((await readdir(folder)).sort(), ['customers.bson', 'customers.metadata.json', 'gold_customers.metadata.json', 'sessions.bson', 'sessions.metadata.json'])
      assert.ok((dump.result as { docs: number }).docs > 0)
      const preview = await worker.request('import.preview', { source: { kind: 'path', path: folder }, options: { format: 'auto', mode: 'insert', drop: false, stopOnError: false, indexes: true }, size: 5 })
      assert.deepEqual(preview.folder?.map((f) => f.name), ['customers', 'gold_customers', 'sessions'])
      const restored = await done(worker, importJob(worker, folder, ns(SCRATCH, ''), { drop: true }))
      assert.deepEqual((restored.result as { collections: string[] }).collections, ['customers', 'gold_customers', 'sessions'])
      await direct(async (c) => {
        for (const name of ['customers', 'sessions']) {
          assert.equal(await c.db(SCRATCH).collection(name).countDocuments(), await c.db('shop').collection(name).countDocuments(), name)
          const names = (x: Document[]) => x.map((i) => i.name).sort()
          assert.deepEqual(names(await c.db(SCRATCH).collection(name).listIndexes().toArray()), names(await c.db('shop').collection(name).listIndexes().toArray()), name)
        }
        const infos = await c.db(SCRATCH).listCollections().toArray()
        const customers = infos.find((i) => i.name === 'customers') as { options: Document }
        assert.ok(customers.options.validator, 'the validator came back')
        const view = infos.find((i) => i.name === 'gold_customers') as { type: string; options: Document }
        assert.equal(view.type, 'view')
        assert.equal(view.options.viewOn, 'customers')
      })
    } finally {
      await cleanup(dir, worker)
    }
  })

  test('reads what mongodump and mongoexport write', async () => {
    if (!ON) return
    const { worker, ns, dir } = await setup()
    try {
      const sh = (cmd: string) => execFileSync('docker', ['exec', 'mongo-studio-dev', 'sh', '-c', cmd], { encoding: 'utf8' })
      try {
        sh('rm -rf /tmp/ms-dump && mongodump --quiet --db blog --gzip --out /tmp/ms-dump && mongoexport --quiet --db shop --collection products --out /tmp/ms-products.json && mongoexport --quiet --db shop --collection products --type csv --fields sku,name,price,stock --out /tmp/ms-products.csv')
      } catch {
        console.log('skipped: no docker access to mongo-studio-dev')
        return
      }
      execFileSync('docker', ['cp', 'mongo-studio-dev:/tmp/ms-dump/blog', join(dir, 'blog')])
      execFileSync('docker', ['cp', 'mongo-studio-dev:/tmp/ms-products.json', join(dir, 'products.json')])
      execFileSync('docker', ['cp', 'mongo-studio-dev:/tmp/ms-products.csv', join(dir, 'products.csv')])
      const r = await done(worker, importJob(worker, join(dir, 'blog'), ns(SCRATCH, '')))
      assert.deepEqual((r.result as { collections: string[] }).collections, ['authors', 'comments', 'posts'])
      await done(worker, importJob(worker, join(dir, 'products.json'), ns(SCRATCH, 'products')))
      await done(worker, importJob(worker, join(dir, 'products.csv'), ns(SCRATCH, 'products_csv'), { csv: { delimiter: ',', header: true, ignoreEmpty: true } }))
      await direct(async (c) => {
        assert.equal(await c.db(SCRATCH).collection('comments').countDocuments(), 6000)
        assert.ok((await c.db(SCRATCH).collection('posts').listIndexes().toArray()).some((i) => i.name === 'slug_1'))
        const a = await all(c, 'shop', 'products')
        const b = await all(c, SCRATCH, 'products')
        assert.deepEqual(b.map((d) => JSON.stringify(d)), a.map((d) => JSON.stringify(d)))
        assert.equal(await c.db(SCRATCH).collection('products_csv').countDocuments(), a.length)
      })
    } finally {
      await cleanup(dir, worker)
    }
  })

  test('copies a collection to another connection with its indexes and options, and a whole database', async () => {
    if (!ON) return
    const { worker, ns, connectionId, otherId, dir } = await setup()
    try {
      const copy = await done(worker, exportJob(worker, { kind: 'query', ns: ns('shop', 'sessions'), spec: { filter: {}, skip: 0, limit: 0 } }, { format: 'collection', collection: { connectionId: otherId, db: SCRATCH, collection: 'sessions_copy', mode: 'insert', indexes: true, options: true } }))
      const r = copy.result as { inserted: number; indexes: number }
      assert.equal(copy.kind, 'copy')
      assert.ok(r.inserted > 0)
      assert.ok(r.indexes > 0)
      const onto = await finish(worker, (await exportJob(worker, { kind: 'query', ns: ns('shop', 'sessions'), spec: { filter: {}, skip: 0, limit: 0 } }, { format: 'collection', collection: { connectionId, db: 'shop', collection: 'sessions', mode: 'insert', indexes: false, options: false } })).jobId)
      assert.match(onto.message ?? '', /onto itself/)
      // Pasting documents by _id, merging into existing ones.
      const ids = await direct((c) => c.db('shop').collection('customers').find({}, { projection: { _id: 1 }, limit: 5 }).toArray())
      const pasted = await done(worker, exportJob(worker, { kind: 'query', ns: ns('shop', 'customers'), spec: { filter: { _id: { $in: ids.map((d) => ({ $oid: String(d._id) })) } }, skip: 0, limit: 0 } }, { format: 'collection', collection: { connectionId: otherId, db: SCRATCH, collection: 'picked', mode: 'upsert', indexes: false, options: false } }))
      assert.equal((pasted.result as { inserted: number }).inserted, 5)
      const db = await done(worker, exportJob(worker, { kind: 'database', connectionId, db: 'analytics' }, { format: 'collection', collection: { connectionId: otherId, db: SCRATCH2, mode: 'replace', indexes: true, options: true } }))
      assert.equal((db.result as { collections: number }).collections, 1)
      await direct(async (c) => {
        const s = (await c.db(SCRATCH).listCollections({ name: 'sessions_copy' }).toArray())[0] as { options: Document }
        const src = (await c.db('shop').listCollections({ name: 'sessions' }).toArray())[0] as { options: Document }
        assert.deepEqual(Object.keys(s.options).sort(), Object.keys(src.options).sort())
        const ts = (await c.db(SCRATCH2).listCollections({ name: 'pageviews' }).toArray())[0] as { type: string }
        assert.equal(ts.type, 'timeseries')
        assert.equal(await c.db(SCRATCH2).collection('pageviews').countDocuments(), await c.db('analytics').collection('pageviews').countDocuments())
      })
    } finally {
      await cleanup(dir, worker)
    }
  })

  test('compares two collections, shows a pair\'s differences and syncs them', async () => {
    if (!ON) return
    const { worker, ns, dir } = await setup()
    try {
      await direct(async (c) => {
        const docs = Array.from({ length: 1200 }, (_, i) => ({ _id: i, n: i, tag: 't', meta: { a: 1, b: 2 } }))
        await c.db(SCRATCH).collection('a').insertMany(docs as never)
        await c.db(SCRATCH).collection('b').insertMany(docs.filter((d) => d._id % 100 !== 7).map((d) => (d._id % 250 === 3 ? { ...d, n: -1, extra: true } : d._id === 10 ? { _id: 10, n: 10, tag: 't', meta: { b: 2, a: 1 } } : d)) as never)
        await c.db(SCRATCH).collection('b').insertMany([{ _id: 'b-only-1' }, { _id: 'b-only-2' }] as never)
      })
      const a = ns(SCRATCH, 'a')
      const b = ns(SCRATCH, 'b')
      const strict = await done(worker, worker.request('compare.start', { a, b, rules: { ignoreFields: [], ignoreOrder: false } }))
      const r = strict.result as { same: number; differ: number; onlyA: number; onlyB: number; ids: { differ: unknown[]; onlyA: unknown[]; onlyB: unknown[] } }
      // 5 changed, and _id 10 with its sub-document's fields in another order.
      assert.deepEqual([r.same, r.differ, r.onlyA, r.onlyB], [1200 - 12 - 6, 6, 12, 2])
      assert.deepEqual(r.ids.onlyB, ['b-only-1', 'b-only-2'])
      const loose = await done(worker, worker.request('compare.start', { a, b, rules: { ignoreFields: ['n', 'extra'], ignoreOrder: true } }))
      assert.equal((loose.result as { differ: number }).differ, 0)
      const diff = await worker.request('compare.diff', { a, b, id: { $numberInt: '3' }, rules: { ignoreFields: [], ignoreOrder: false } })
      assert.deepEqual(diff.diffs.map((d) => [d.path, d.kind]), [['n', 'changed'], ['extra', 'added']])
      const order = await worker.request('compare.diff', { a, b, id: { $numberInt: '10' }, rules: { ignoreFields: [], ignoreOrder: false } })
      assert.deepEqual(order.diffs.map((d) => d.path), ['meta'])
      const filtered = await done(worker, worker.request('compare.start', { a, b, filter: { n: { $lt: { $numberInt: '100' } } }, rules: { ignoreFields: [], ignoreOrder: false } }))
      assert.equal((filtered.result as { onlyA: number }).onlyA, 1)

      const sync = await done(worker, worker.request('compare.sync', { from: a, to: b, rules: { ignoreFields: [], ignoreOrder: false }, insert: true, replace: true, remove: true }))
      assert.deepEqual(sync.result, { kind: 'sync', inserted: 12, replaced: 6, deleted: 2, failed: 0 })
      const after = await done(worker, worker.request('compare.start', { a, b, rules: { ignoreFields: [], ignoreOrder: false } }))
      assert.deepEqual([(after.result as { same: number }).same, (after.result as { differ: number }).differ], [1200, 0])
    } finally {
      await cleanup(dir, worker)
    }
  })

  test('GridFS: list, preview, download, upload, rename and delete', async () => {
    if (!ON) return
    const { worker, connectionId, dir } = await setup()
    try {
      const shop = { connectionId, db: 'shop', bucket: 'attachments' }
      const list = await worker.request('gridfs.list', { ...shop, skip: 0, limit: 50 })
      assert.equal(list.total, 3)
      const big = list.files.find((f) => f.filename === 'big.csv')!
      assert.equal(big.contentType, 'text/csv')
      const filtered = await worker.request('gridfs.list', { ...shop, filename: 'INVOICE', skip: 0, limit: 50 })
      assert.deepEqual(filtered.files.map((f) => f.filename), ['invoice-2026-001.txt'])
      const p = await worker.request('gridfs.preview', { ...shop, id: big.id })
      assert.equal(p.binary, false)
      assert.equal(p.cut, true)
      assert.ok(p.text!.startsWith('id,value\n0,'))
      assert.equal(p.chunks, p.expectedChunks)
      const dl = await done(worker, worker.request('gridfs.download', { ...shop, id: big.id, destination: { kind: 'download' } }))
      const bytes = await download(worker, dl.jobId)
      assert.equal(bytes.length, big.length)
      assert.equal(bytes.toString('utf8').split('\n').length, 30001)
      await done(worker, worker.request('gridfs.download', { ...shop, id: big.id, destination: { kind: 'path', path: dir, overwrite: false } }))
      assert.equal((await readFile(join(dir, 'big.csv'))).length, big.length)

      const scratch = { connectionId, db: SCRATCH, bucket: 'files' }
      const pathFile = join(dir, 'blob.bin')
      await writeFile(pathFile, Buffer.from(Array.from({ length: 600_000 }, (_, i) => i % 251)))
      const up = await done(worker, worker.request('gridfs.upload', { ...scratch, source: { kind: 'path', path: pathFile }, filename: 'blob.bin', contentType: 'application/octet-stream', metadata: { owner: 'test' } }))
      const id = (up.result as { id: unknown }).id
      const textUp = await done(worker, worker.request('gridfs.upload', { ...scratch, source: { kind: 'upload', uploadId: await upload(worker, 'héllo') }, filename: 'hello.txt' }))
      const files = await worker.request('gridfs.list', { ...scratch, skip: 0, limit: 10 })
      assert.deepEqual(files.files.map((f) => [f.filename, f.length]).sort(), [['blob.bin', 600000], ['hello.txt', 6]])
      assert.equal((await worker.request('gridfs.preview', { ...scratch, id: (textUp.result as unknown as { id: never }).id })).text, 'héllo')
      assert.equal((await worker.request('gridfs.preview', { ...scratch, id: id as never })).binary, true)
      await worker.request('gridfs.rename', { ...scratch, id: id as never, filename: 'renamed.bin' })
      await worker.request('gridfs.delete', { ...scratch, id: (textUp.result as unknown as { id: never }).id })
      const left = await worker.request('gridfs.list', { ...scratch, skip: 0, limit: 10 })
      assert.deepEqual(left.files.map((f) => f.filename), ['renamed.bin'])
      assert.match(left.files[0]!.metadata ?? '', /owner/)
      await direct(async (c) => assert.equal(await c.db(SCRATCH).collection('files.chunks').countDocuments(), 3))
    } finally {
      await cleanup(dir, worker)
    }
  })

  test('cancelling a job stops it and leaves no half file', async () => {
    if (!ON) return
    const { worker, ns, dir } = await setup()
    try {
      const path = join(dir, 'pageviews.json')
      const { jobId } = await exportJob(worker, { kind: 'query', ns: ns('analytics', 'pageviews'), spec: { filter: {}, skip: 0, limit: 0 } }, { format: 'json', json: { layout: 'lines', relaxed: true, pretty: false } }, { kind: 'path', path, overwrite: false })
      await worker.request('job.cancel', { jobId })
      const s = await finish(worker, jobId)
      assert.equal(s.status, 'cancelled')
      assert.deepEqual(await readdir(dir), [])
    } finally {
      await cleanup(dir, worker)
    }
  })
})
