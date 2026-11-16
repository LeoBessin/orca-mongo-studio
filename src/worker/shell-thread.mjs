// The shell's script thread. It runs one editor's statements in a vm context with a mongo shell
// API (`db`, cursors, BSON constructors, print), synchronously, like the legacy mongo shell: each
// database call blocks this thread while the worker's main thread does the work with its pooled
// MongoClient (see src/worker/shell.ts). Blocking uses Atomics.wait and receiveMessageOnPort, so
// `db.c.findOne().name` and loops over cursors need no `await`, and the main thread can stop a
// runaway script by terminating this thread.
//
// Plain JavaScript on purpose: Orca transpiles TypeScript only on the worker's own thread.
import { createRequire } from 'node:module'
import { parentPort, receiveMessageOnPort, workerData } from 'node:worker_threads'
import vm from 'node:vm'

// Orca lets plugin files import only relative paths, so the worker resolves `bson` and passes its
// path.
const bson = createRequire(import.meta.url)(workerData.bsonPath)

const { BSON, EJSON } = bson
const syncPort = workerData.port
const signal = new Int32Array(workerData.signal)
const sleeper = new Int32Array(new SharedArrayBuffer(4))
const FILE = 'script.mongodb.js'
/** Values the thread reads keep Int64 as Long, as mongosh shows them. */
const READ = { promoteLongs: false, promoteValues: true, bsonRegExp: false }
const DOC_BATCH = 100
const MATERIALIZE_MAX = 1000
let current = { runId: '', cancelled: false }

// ---- Calls to the main thread ----

class ShellError extends Error {
  constructor(message, extra) {
    super(message)
    this.name = extra?.name ?? 'MongoServerError'
    if (extra) for (const [k, v] of Object.entries(extra)) if (k !== 'name' && k !== 'message') this[k] = v
  }
}

function encode(args) {
  return BSON.serialize({ a: args }, { ignoreUndefined: true })
}

function call(method, ...args) {
  Atomics.store(signal, 0, 0)
  syncPort.postMessage({ method, args: encode(args) })
  Atomics.wait(signal, 0, 0)
  const msg = receiveMessageOnPort(syncPort)
  if (!msg) throw new ShellError('The worker did not answer.', { name: 'ShellError' })
  const reply = msg.message
  if (reply.error) throw new ShellError(reply.error.message, reply.error)
  if (reply.docs) return reply.docs.map((d) => BSON.deserialize(d, READ))
  if (reply.value) return BSON.deserialize(reply.value, READ).v
  return undefined
}

function post(entry) {
  parentPort.postMessage({ type: 'entry', runId: current.runId, entry })
}

// ---- Values as canonical Extended JSON for the main thread ----

function canonical(value) {
  return EJSON.serialize({ v: value }, { relaxed: false }).v
}

function describe(value) {
  if (value === undefined) return { kind: 'undefined' }
  if (typeof value === 'function') return { kind: 'text', text: `[Function${value.name ? `: ${value.name}` : ''}]` }
  if (typeof value === 'symbol') return { kind: 'text', text: value.toString() }
  if (typeof value === 'bigint') return { kind: 'text', text: `${value}n` }
  if (value instanceof Database) return { kind: 'text', text: value._name }
  if (value instanceof Collection) return { kind: 'text', text: `${value._db._name}.${value._name}` }
  if (value instanceof Cursor) return value._describe()
  if (value instanceof Explainable) return { kind: 'text', text: value.toString() }
  if (value instanceof Error) return { kind: 'text', text: `${value.name}: ${value.message}` }
  if (value instanceof Map) value = Object.fromEntries(value)
  if (value instanceof Set) value = [...value]
  try {
    if (Array.isArray(value) && value.length > 50000) {
      return { kind: 'value', value: canonical(value.slice(0, 50000)), note: `Showing the first 50,000 of ${value.length.toLocaleString('en-US')} items.` }
    }
    return { kind: 'value', value: canonical(value) }
  } catch (error) {
    return { kind: 'text', text: safeString(value), note: `Shown as text: ${error.message}` }
  }
}

function safeString(value) {
  try {
    return String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

// ---- Cursors ----

const CURSOR_OPTIONS = ['sort', 'skip', 'limit', 'collation', 'hint', 'maxTimeMS', 'batchSize', 'comment', 'min', 'max', 'allowDiskUse', 'returnKey', 'showRecordId', 'noCursorTimeout', 'let']

class Cursor {
  constructor(kind, target, spec) {
    this._kind = kind // 'find' | 'aggregate'
    this._target = target // { db, collection } (collection null for db.aggregate)
    this._spec = spec // find: { filter, projection, options }; aggregate: { pipeline, options }
    this._handle = undefined
    this._buffer = []
    this._done = false
    this._maps = []
    this._consumed = 0
  }
  _option(name, value) {
    if (this._handle !== undefined) throw new ShellError(`Cursor already started: call .${name}() before reading results.`, { name: 'ShellError' })
    this._spec.options[name] = value
    return this
  }
  sort(v) { return this._option('sort', v) }
  skip(n) { return this._option('skip', n) }
  limit(n) { return this._option('limit', n) }
  collation(v) { return this._option('collation', v) }
  hint(v) { return this._option('hint', v) }
  maxTimeMS(n) { return this._option('maxTimeMS', n) }
  batchSize(n) { return this._option('batchSize', n) }
  comment(v) { return this._option('comment', v) }
  min(v) { return this._option('min', v) }
  max(v) { return this._option('max', v) }
  allowDiskUse(v = true) { return this._option('allowDiskUse', v) }
  returnKey(v = true) { return this._option('returnKey', v) }
  showRecordId(v = true) { return this._option('showRecordId', v) }
  noCursorTimeout() { return this._option('noCursorTimeout', true) }
  project(v) {
    if (this._kind !== 'find') throw new ShellError('project() works on find cursors.', { name: 'ShellError' })
    if (this._handle !== undefined) throw new ShellError('Cursor already started: call .project() before reading results.', { name: 'ShellError' })
    this._spec.projection = v
    return this
  }
  projection(v) { return this.project(v) }
  pretty() { return this }
  readPref() { return this }
  map(fn) {
    this._maps.push(fn)
    return this
  }
  _open() {
    if (this._handle !== undefined) return
    this._handle = this._kind === 'find'
      ? call('find.open', this._target, this._spec.filter ?? {}, this._spec.projection ?? null, this._spec.options)
      : call('aggregate.open', this._target, this._spec.pipeline, this._spec.options)
  }
  _fill() {
    if (this._buffer.length || this._done) return
    this._open()
    const docs = call('cursor.next', this._handle, this._spec.options.batchSize ?? DOC_BATCH)
    if (docs.length === 0) this._done = true
    this._buffer.push(...docs)
  }
  hasNext() {
    this._fill()
    return this._buffer.length > 0
  }
  next() {
    this._fill()
    if (!this._buffer.length) throw new ShellError('There are no more documents (check hasNext() first).', { name: 'ShellError' })
    this._consumed++
    let doc = this._buffer.shift()
    for (const fn of this._maps) doc = fn(doc)
    return doc
  }
  tryNext() { return this.hasNext() ? this.next() : null }
  toArray() {
    const out = []
    while (this.hasNext()) out.push(this.next())
    return out
  }
  forEach(fn) {
    while (this.hasNext()) if (fn(this.next()) === false) break
  }
  itcount() {
    let n = 0
    while (this.hasNext()) {
      this.next()
      n++
    }
    return n
  }
  count(applySkipLimit = false) {
    if (this._kind !== 'find') throw new ShellError('count() works on find cursors; add a $count stage to the pipeline.', { name: 'ShellError' })
    const o = this._spec.options
    const options = {}
    if (applySkipLimit && o.skip) options.skip = o.skip
    if (applySkipLimit && o.limit) options.limit = o.limit
    if (o.collation) options.collation = o.collation
    return call('collection', this._target, 'countDocuments', [this._spec.filter ?? {}, options])
  }
  size() { return this.count(true) }
  isExhausted() { return this._done && this._buffer.length === 0 }
  close() {
    if (this._handle !== undefined && !this._done) call('cursor.close', this._handle)
    this._done = true
    this._buffer = []
  }
  /** The plan: `explain()`, `explain('executionStats')`, `explain('allPlansExecution')`. */
  explain(verbosity) {
    const v = explainVerbosity(verbosity)
    const o = this._spec.options
    let command
    if (this._kind === 'find') {
      command = { find: this._target.collection, filter: this._spec.filter ?? {} }
      if (this._spec.projection) command.projection = this._spec.projection
      for (const k of FIND_EXPLAIN_OPTIONS) if (o[k] !== undefined) command[k] = o[k]
    } else {
      command = { aggregate: this._target.collection ?? 1, pipeline: this._spec.pipeline, cursor: {} }
      for (const k of AGGREGATE_EXPLAIN_OPTIONS) if (o[k] !== undefined) command[k] = o[k]
    }
    return runExplain(this._target.db, command, v)
  }
  /** On `db.c.explain().find(…)`: the plan, as mongosh's explainable cursor gives it. */
  finish() {
    if (this._explain === undefined) throw new ShellError('finish() works on db.collection.explain().find(…).', { name: 'ShellError' })
    return this.explain(this._explain)
  }
  *[Symbol.iterator]() {
    while (this.hasNext()) yield this.next()
  }
  toString() { return `[${this._kind === 'find' ? 'Find' : 'Aggregation'} cursor on ${this._target.db}${this._target.collection ? `.${this._target.collection}` : ''}]` }
  /** A statement's result: the main thread pages an unread cursor itself. */
  _describe() {
    if (this._explain !== undefined) return describe(this.explain(this._explain))
    if (this._handle === undefined && this._maps.length === 0) {
      const options = {}
      for (const k of CURSOR_OPTIONS) if (this._spec.options[k] !== undefined) options[k] = this._spec.options[k]
      return {
        kind: 'cursor',
        cursor: canonical({
          kind: this._kind,
          db: this._target.db,
          collection: this._target.collection,
          filter: this._spec.filter ?? {},
          projection: this._spec.projection ?? null,
          pipeline: this._spec.pipeline ?? null,
          options
        })
      }
    }
    // Partly read, or mapped by a function: read on here, up to a limit.
    const docs = []
    while (docs.length < MATERIALIZE_MAX && this.hasNext()) docs.push(this.next())
    const more = this.hasNext()
    this.close()
    return { kind: 'value', value: canonical(docs), docs: true, note: more ? `Showing the next ${MATERIALIZE_MAX.toLocaleString('en-US')} documents of a cursor that was already being read.` : undefined }
  }
}

// ---- Explain ----

const FIND_EXPLAIN_OPTIONS = ['sort', 'skip', 'limit', 'collation', 'hint', 'maxTimeMS', 'comment', 'min', 'max', 'returnKey', 'showRecordId', 'let', 'allowDiskUse']
const AGGREGATE_EXPLAIN_OPTIONS = ['allowDiskUse', 'collation', 'hint', 'maxTimeMS', 'comment', 'let']
const VERBOSITIES = ['queryPlanner', 'executionStats', 'allPlansExecution']

function explainVerbosity(v) {
  if (v === undefined || v === false) return 'queryPlanner'
  if (v === true) return 'allPlansExecution'
  if (!VERBOSITIES.includes(v)) throw new ShellError(`Explain verbosity is one of ${VERBOSITIES.join(', ')}.`, { name: 'ShellError' })
  return v
}

function runExplain(dbName, command, verbosity) {
  const answer = call('database', dbName, 'command', [{ explain: command, verbosity }, {}])
  if (answer && typeof answer === 'object') {
    delete answer.$clusterTime
    delete answer.operationTime
  }
  return answer
}

/** `db.c.explain(verbosity)`: find, aggregate, count and distinct, explained. */
class Explainable {
  constructor(coll, verbosity) {
    this._coll = coll
    this._verbosity = explainVerbosity(verbosity)
  }
  getVerbosity() { return this._verbosity }
  /** A cursor that shows its plan instead of its documents. */
  find(filter = {}, projection, options) {
    const cursor = this._coll.find(filter, projection, options)
    cursor._explain = this._verbosity
    return cursor
  }
  aggregate(...args) { return this._coll.aggregate(...args).explain(this._verbosity) }
  count(filter = {}, options) {
    return runExplain(this._coll._db._name, { count: this._coll._name, query: filter, ...opts(options) }, this._verbosity)
  }
  distinct(field, filter = {}, options) {
    return runExplain(this._coll._db._name, { distinct: this._coll._name, key: field, query: filter, ...opts(options) }, this._verbosity)
  }
  toString() { return `Explainable(${this._coll.getFullName()})` }
}

// ---- Collections and databases ----

function opts(o) {
  return o && typeof o === 'object' ? { ...o } : {}
}

class Collection {
  constructor(db, name) {
    this._db = db
    this._name = name
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || prop in target || prop.startsWith('_')) return Reflect.get(target, prop, receiver)
        return new Collection(db, `${name}.${prop}`)
      }
    })
  }
  get _t() { return { db: this._db._name, collection: this._name } }
  _call(method, args) { return call('collection', this._t, method, args) }
  getName() { return this._name }
  getFullName() { return `${this._db._name}.${this._name}` }
  getDB() { return this._db }
  toString() { return this.getFullName() }
  find(filter = {}, projection, options) {
    return new Cursor('find', this._t, { filter, projection: projection ?? undefined, options: opts(options) })
  }
  findOne(filter = {}, projection, options) {
    const o = opts(options)
    if (projection) o.projection = projection
    return this._call('findOne', [filter, o])
  }
  aggregate(pipeline = [], options, ...more) {
    if (!Array.isArray(pipeline)) {
      pipeline = [pipeline, ...(options && !('allowDiskUse' in options || 'maxTimeMS' in options || 'collation' in options) ? [options] : []), ...more]
      options = {}
    }
    return new Cursor('aggregate', this._t, { pipeline, options: opts(options) })
  }
  countDocuments(filter = {}, options) { return this._call('countDocuments', [filter, opts(options)]) }
  estimatedDocumentCount(options) { return this._call('estimatedDocumentCount', [opts(options)]) }
  count(filter = {}, options) { return this._call('countDocuments', [filter, opts(options)]) }
  distinct(field, filter = {}, options) { return this._call('distinct', [field, filter, opts(options)]) }
  insertOne(doc, options) { return this._call('insertOne', [doc, opts(options)]) }
  insertMany(docs, options) { return this._call('insertMany', [docs, opts(options)]) }
  insert(docs, options) { return Array.isArray(docs) ? this.insertMany(docs, options) : this.insertOne(docs, options) }
  updateOne(filter, update, options) { return this._call('updateOne', [filter, update, opts(options)]) }
  updateMany(filter, update, options) { return this._call('updateMany', [filter, update, opts(options)]) }
  update(filter, update, options) {
    const o = opts(options)
    const multi = o.multi
    delete o.multi
    return multi ? this.updateMany(filter, update, o) : this.updateOne(filter, update, o)
  }
  replaceOne(filter, doc, options) { return this._call('replaceOne', [filter, doc, opts(options)]) }
  deleteOne(filter, options) { return this._call('deleteOne', [filter, opts(options)]) }
  deleteMany(filter, options) { return this._call('deleteMany', [filter, opts(options)]) }
  remove(filter, justOne) {
    const one = justOne === true || (justOne && justOne.justOne)
    return one ? this.deleteOne(filter) : this.deleteMany(filter)
  }
  findOneAndUpdate(filter, update, options) { return this._call('findOneAndUpdate', [filter, update, opts(options)]) }
  findOneAndReplace(filter, doc, options) { return this._call('findOneAndReplace', [filter, doc, opts(options)]) }
  findOneAndDelete(filter, options) { return this._call('findOneAndDelete', [filter, opts(options)]) }
  bulkWrite(ops, options) { return this._call('bulkWrite', [ops, opts(options)]) }
  createIndex(keys, options) { return this._call('createIndex', [keys, opts(options)]) }
  createIndexes(specs, options) {
    const indexes = specs.map((s) => (s && s.key ? s : { key: s }))
    return this._call('createIndexes', [indexes, opts(options)])
  }
  ensureIndex(keys, options) { return this.createIndex(keys, options) }
  getIndexes() { return this._call('indexes', []) }
  getIndexKeys() { return this.getIndexes().map((i) => i.key) }
  dropIndex(index) { return this._call('dropIndex', [index]) }
  dropIndexes(indexes) { return this._call('dropIndexes', indexes === undefined ? [] : [indexes]) }
  drop(options) { return this._call('drop', [opts(options)]) }
  renameCollection(to, dropTarget) { return this._call('rename', [to, { dropTarget: dropTarget === true }]) }
  stats() { return this._call('stats', []) }
  exists() {
    const infos = this._db.getCollectionInfos({ name: this._name })
    return infos[0] ?? null
  }
  isCapped() { return this._call('isCapped', []) }
  explain(verbosity) { return new Explainable(this, verbosity) }
}

class Database {
  constructor(name) {
    this._name = name
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || prop in target || prop.startsWith('_')) return Reflect.get(target, prop, receiver)
        return new Collection(receiver, prop)
      }
    })
  }
  _call(method, args) { return call('database', this._name, method, args) }
  getName() { return this._name }
  toString() { return this._name }
  getCollection(name) {
    if (typeof name !== 'string' || !name) throw new ShellError('getCollection needs a collection name.', { name: 'ShellError' })
    return new Collection(this, name)
  }
  getSiblingDB(name) {
    if (typeof name !== 'string' || !name) throw new ShellError('getSiblingDB needs a database name.', { name: 'ShellError' })
    return new Database(name)
  }
  getCollectionNames() { return this._call('collectionNames', []) }
  getCollectionInfos(filter = {}, options) { return this._call('collectionInfos', [filter, opts(options)]) }
  createCollection(name, options) { return this._call('createCollection', [name, opts(options)]) }
  createView(name, source, pipeline, options) { return this._call('createCollection', [name, { ...opts(options), viewOn: source, pipeline }]) }
  dropDatabase() { return this._call('dropDatabase', []) }
  runCommand(command, options) {
    if (typeof command === 'string') command = { [command]: 1 }
    return this._call('command', [command, opts(options)])
  }
  adminCommand(command) {
    if (typeof command === 'string') command = { [command]: 1 }
    return call('database', 'admin', 'command', [command, {}])
  }
  aggregate(pipeline = [], options) {
    return new Cursor('aggregate', { db: this._name, collection: null }, { pipeline, options: opts(options) })
  }
  stats(scale) { return this.runCommand(scale ? { dbStats: 1, scale } : { dbStats: 1 }) }
  serverStatus() { return this.adminCommand({ serverStatus: 1 }) }
  hostInfo() { return this.adminCommand({ hostInfo: 1 }) }
  version() { return this.adminCommand({ buildInfo: 1 }).version }
  currentOp(filter = {}) { return this.adminCommand({ currentOp: 1, ...filter }) }
  killOp(opid) { return this.adminCommand({ killOp: 1, op: opid }) }
  getUsers(options) { return this.runCommand({ usersInfo: 1, ...opts(options) }).users }
  getUser(name) { return this.runCommand({ usersInfo: name }).users[0] ?? null }
  getRoles(options) { return this.runCommand({ rolesInfo: 1, ...opts(options) }).roles }
  getRole(name, options) { return this.runCommand({ rolesInfo: name, ...opts(options) }).roles[0] ?? null }
  listCommands() { return this.runCommand({ listCommands: 1 }).commands }
}

// ---- BSON constructors, callable with or without `new` ----

function callable(Class, build) {
  const fn = function (...args) {
    return build ? build(...args) : new Class(...args)
  }
  fn.prototype = Class.prototype
  Object.defineProperty(fn, 'name', { value: Class.name })
  for (const k of Object.getOwnPropertyNames(Class)) {
    if (!['length', 'name', 'prototype'].includes(k)) {
      try {
        fn[k] = typeof Class[k] === 'function' ? Class[k].bind(Class) : Class[k]
      } catch {
        // read-only statics stay on the class
      }
    }
  }
  return fn
}

function isoDate(text) {
  if (text === undefined) return new Date()
  const d = new Date(text)
  if (Number.isNaN(d.getTime())) throw new ShellError(`"${text}" is not a date ISODate can read.`, { name: 'ShellError' })
  return d
}

function hexToBase64(hex) {
  return Buffer.from(hex, 'hex').toString('base64')
}

function makeGlobals(run) {
  const printValues = (args) => {
    post({ kind: 'print', parts: args.map((a) => (typeof a === 'string' ? { text: a } : describe(a))) })
  }
  const g = {
    print: (...args) => printValues(args),
    printjson: (v) => printValues([v]),
    console: Object.freeze({ log: (...a) => printValues(a), info: (...a) => printValues(a), warn: (...a) => printValues(a), error: (...a) => printValues(a), debug: (...a) => printValues(a) }),
    sleep: (ms) => {
      Atomics.wait(sleeper, 0, 0, Math.max(0, Math.min(Number(ms) || 0, 60_000)))
    },
    use: (name) => {
      if (typeof name !== 'string' || !name) throw new ShellError('use needs a database name.', { name: 'ShellError' })
      run.db = new Database(name)
      run.context.db = run.db
      post({ kind: 'info', text: `switched to db ${name}`, db: name })
    },
    show: (what) => {
      const db = run.context.db
      switch (String(what)) {
        case 'dbs':
        case 'databases':
          return { __show: 'databases', value: call('database', 'admin', 'listDatabases', []) }
        case 'collections':
        case 'tables':
          return { __show: 'lines', value: db.getCollectionNames().sort() }
        case 'users':
          return db.getUsers()
        case 'roles':
          return db.getRoles({ showBuiltinRoles: true })
        case 'profile':
          return db.getCollection('system.profile').find().sort({ ts: -1 }).limit(5).toArray()
        default:
          throw new ShellError(`show ${what}: try show dbs, show collections, show users or show roles.`, { name: 'ShellError' })
      }
    },
    it: () => {
      throw new ShellError('it is not needed here: every result opens in the Mongo Studio panel, which pages through it.', { name: 'ShellError' })
    },
    ObjectId: callable(bson.ObjectId),
    ISODate: (text) => isoDate(text),
    NumberInt: (v = 0) => new bson.Int32(Number(v)),
    NumberLong: (v = 0) => (typeof v === 'string' ? bson.Long.fromString(v) : bson.Long.fromNumber(Number(v))),
    NumberDecimal: (v = '0') => bson.Decimal128.fromString(String(v)),
    Int32: callable(bson.Int32),
    Long: callable(bson.Long, (v, high, unsigned) => (high !== undefined ? new bson.Long(v, high, unsigned) : typeof v === 'string' ? bson.Long.fromString(v) : typeof v === 'bigint' ? bson.Long.fromBigInt(v) : bson.Long.fromNumber(Number(v ?? 0)))),
    Double: callable(bson.Double),
    Decimal128: callable(bson.Decimal128, (v) => (typeof v === 'string' ? bson.Decimal128.fromString(v) : new bson.Decimal128(v))),
    Timestamp: callable(bson.Timestamp, (a, b) => (typeof a === 'object' && a !== null && !(a instanceof bson.Long) ? new bson.Timestamp(a) : b !== undefined ? new bson.Timestamp({ t: Number(a), i: Number(b) }) : new bson.Timestamp(a))),
    MinKey: callable(bson.MinKey),
    MaxKey: callable(bson.MaxKey),
    BinData: (subType, base64) => new bson.Binary(Buffer.from(String(base64), 'base64'), Number(subType)),
    HexData: (subType, hex) => new bson.Binary(Buffer.from(hexToBase64(String(hex)), 'base64'), Number(subType)),
    UUID: (text) => (text === undefined ? new bson.UUID() : new bson.UUID(String(text))),
    MD5: (hex) => new bson.Binary(Buffer.from(String(hex), 'hex'), 5),
    Code: callable(bson.Code),
    DBRef: callable(bson.DBRef),
    BSONRegExp: callable(bson.BSONRegExp),
    Binary: callable(bson.Binary),
    EJSON: Object.freeze({ stringify: EJSON.stringify, parse: EJSON.parse, serialize: EJSON.serialize, deserialize: EJSON.deserialize }),
    tojson: (v) => JSON.stringify(EJSON.serialize(v, { relaxed: true }), null, 2),
    quit: () => {
      throw new ShellError('quit() does nothing here: close the tab instead.', { name: 'ShellError' })
    }
  }
  g.exit = g.quit
  return g
}

// ---- Runs ----

const sessions = { context: undefined, db: undefined }

function ensureContext(dbName) {
  if (!sessions.context) {
    const run = sessions
    const globals = makeGlobals(run)
    run.context = vm.createContext({ ...globals }, { name: 'Mongo Studio shell', codeGeneration: { strings: true, wasm: false } })
  }
  sessions.db = new Database(dbName)
  sessions.context.db = sessions.db
  return sessions.context
}

function lineOf(error) {
  const m = /script\.mongodb\.js:(\d+)(?::(\d+))?/.exec(String(error?.stack ?? ''))
  return m ? { line: Number(m[1]), column: m[2] ? Number(m[2]) : undefined } : undefined
}

function compile(code, line, column) {
  try {
    return new vm.Script(code, { filename: FILE, lineOffset: line - 1, columnOffset: column - 1 })
  } catch (error) {
    if (!(error instanceof SyntaxError) || !/\bawait\b/.test(code)) throw error
  }
  // Top-level await: run the statement inside an async function.
  try {
    return new vm.Script(`(async () => (\n${code}\n))()`, { filename: FILE, lineOffset: line - 2 })
  } catch {
    return new vm.Script(`(async () => {\n${code}\n})()`, { filename: FILE, lineOffset: line - 2 })
  }
}

async function runStatements({ runId, db, statements }) {
  current = { runId, cancelled: false }
  const context = ensureContext(db)
  for (const s of statements) {
    const started = Date.now()
    try {
      const script = compile(s.code, s.line, s.column)
      let value = script.runInContext(context, { displayErrors: false })
      if (value && typeof value.then === 'function' && !(value instanceof Cursor)) value = await value
      if (s.quiet) continue
      if (value && typeof value === 'object' && value.__show) {
        post({ kind: 'result', line: s.line, ms: Date.now() - started, show: value.__show, result: describe(value.value) })
        continue
      }
      const result = describe(value)
      if (result.kind === 'undefined') continue
      post({ kind: 'result', line: s.line, ms: Date.now() - started, result })
    } catch (error) {
      const where = lineOf(error) ?? { line: s.line }
      const e = error && typeof error === 'object' ? error : { message: String(error) }
      post({
        kind: 'error',
        line: where.line,
        column: where.column,
        name: e.name ?? 'Error',
        message: e.message ?? String(error),
        code: typeof e.code === 'number' || typeof e.code === 'string' ? e.code : undefined,
        codeName: typeof e.codeName === 'string' ? e.codeName : undefined
      })
      break
    }
  }
  parentPort.postMessage({ type: 'done', runId, db: sessions.db?._name })
}

parentPort.on('message', (msg) => {
  if (msg.type === 'run') void runStatements(msg)
  else if (msg.type === 'reset') {
    sessions.context = undefined
  }
})
