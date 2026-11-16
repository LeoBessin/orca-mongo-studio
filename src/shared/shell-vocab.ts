// What the shell editor offers as you type: shell globals, database, collection and cursor
// methods with their signatures, and MongoDB operators grouped by where they fit. Plain data,
// shared by the editor's autocomplete and its tests.
import type { KeyFlavor } from './js-scan'

export type VocabItem = { label: string; detail?: string; info?: string; apply?: string }

const m = (label: string, detail: string, info?: string): VocabItem => ({ label, detail, ...(info ? { info } : {}) })

export const GLOBALS: VocabItem[] = [
  m('db', 'the current database'),
  m('use', 'use <database>', 'Switches db for the rest of the script.'),
  m('show', 'show dbs | collections | users | roles | profile'),
  m('print', 'print(...values)'),
  m('printjson', 'printjson(value)'),
  m('console', 'console.log(...values)'),
  m('sleep', 'sleep(ms)', 'Waits, at most 60 s.'),
  m('ObjectId', "ObjectId('hex')"),
  m('ISODate', "ISODate('2024-01-31T12:00:00Z')"),
  m('NumberInt', 'NumberInt(n)', '32-bit integer'),
  m('NumberLong', "NumberLong('n')", '64-bit integer'),
  m('NumberDecimal', "NumberDecimal('1.10')", '128-bit decimal'),
  m('Long', 'Long(n)'),
  m('Int32', 'Int32(n)'),
  m('Double', 'Double(n)'),
  m('Decimal128', "Decimal128('1.10')"),
  m('Timestamp', 'Timestamp({ t, i })'),
  m('UUID', "UUID('…')"),
  m('BinData', "BinData(subtype, 'base64')"),
  m('HexData', "HexData(subtype, 'hex')"),
  m('MinKey', 'MinKey()'),
  m('MaxKey', 'MaxKey()'),
  m('Code', "Code('function () {}')"),
  m('DBRef', "DBRef('collection', id)"),
  m('EJSON', 'EJSON.stringify / parse'),
  m('tojson', 'tojson(value)')
]

export const DB_METHODS: VocabItem[] = [
  m('getCollection', "getCollection('name')"),
  m('getCollectionNames', 'getCollectionNames()'),
  m('getCollectionInfos', 'getCollectionInfos(filter?)'),
  m('getSiblingDB', "getSiblingDB('name')"),
  m('getName', 'getName()'),
  m('createCollection', "createCollection('name', options?)"),
  m('createView', "createView('name', 'source', pipeline)"),
  m('dropDatabase', 'dropDatabase()'),
  m('runCommand', 'runCommand({ … })'),
  m('adminCommand', 'adminCommand({ … })'),
  m('aggregate', 'aggregate(pipeline)', 'A database-level pipeline, such as $currentOp.'),
  m('stats', 'stats(scale?)'),
  m('serverStatus', 'serverStatus()'),
  m('hostInfo', 'hostInfo()'),
  m('version', 'version()'),
  m('currentOp', 'currentOp(filter?)'),
  m('killOp', 'killOp(opid)'),
  m('getUsers', 'getUsers()'),
  m('getUser', "getUser('name')"),
  m('getRoles', 'getRoles({ showBuiltinRoles })'),
  m('getRole', "getRole('name')"),
  m('listCommands', 'listCommands()')
]

export const COLLECTION_METHODS: VocabItem[] = [
  m('find', 'find(filter?, projection?)'),
  m('findOne', 'findOne(filter?, projection?)'),
  m('aggregate', 'aggregate([ stages ])'),
  m('countDocuments', 'countDocuments(filter?)'),
  m('estimatedDocumentCount', 'estimatedDocumentCount()'),
  m('distinct', "distinct('field', filter?)"),
  m('insertOne', 'insertOne(doc)'),
  m('insertMany', 'insertMany([ docs ])'),
  m('updateOne', 'updateOne(filter, update, options?)'),
  m('updateMany', 'updateMany(filter, update, options?)'),
  m('replaceOne', 'replaceOne(filter, doc, options?)'),
  m('deleteOne', 'deleteOne(filter)'),
  m('deleteMany', 'deleteMany(filter)'),
  m('findOneAndUpdate', 'findOneAndUpdate(filter, update, options?)'),
  m('findOneAndReplace', 'findOneAndReplace(filter, doc, options?)'),
  m('findOneAndDelete', 'findOneAndDelete(filter, options?)'),
  m('bulkWrite', 'bulkWrite([ operations ])'),
  m('createIndex', 'createIndex({ field: 1 }, options?)'),
  m('createIndexes', 'createIndexes([ { key, … } ])'),
  m('getIndexes', 'getIndexes()'),
  m('dropIndex', "dropIndex('name')"),
  m('dropIndexes', 'dropIndexes()'),
  m('drop', 'drop()'),
  m('renameCollection', "renameCollection('newName', dropTarget?)"),
  m('stats', 'stats()'),
  m('isCapped', 'isCapped()'),
  m('explain', "explain('executionStats').find(…)", 'Explains a find, aggregate, count or distinct instead of running it.'),
  m('getName', 'getName()'),
  m('getFullName', 'getFullName()')
]

const CURSOR_COMMON: VocabItem[] = [
  m('toArray', 'toArray()'),
  m('forEach', 'forEach(doc => …)'),
  m('map', 'map(doc => …)'),
  m('hasNext', 'hasNext()'),
  m('next', 'next()'),
  m('tryNext', 'tryNext()'),
  m('itcount', 'itcount()'),
  m('close', 'close()'),
  m('maxTimeMS', 'maxTimeMS(ms)'),
  m('batchSize', 'batchSize(n)'),
  m('comment', "comment('text')"),
  m('explain', "explain('executionStats')", 'The plan: queryPlanner (default), executionStats or allPlansExecution.'),
  m('pretty', 'pretty()')
]

export const FIND_CURSOR_METHODS: VocabItem[] = [
  m('sort', 'sort({ field: 1 })'),
  m('limit', 'limit(n)'),
  m('skip', 'skip(n)'),
  m('project', 'project({ field: 1 })'),
  m('collation', "collation({ locale: 'en' })"),
  m('hint', 'hint({ field: 1 } | name)'),
  m('count', 'count()'),
  m('size', 'size()'),
  m('min', 'min({ … })'),
  m('max', 'max({ … })'),
  m('allowDiskUse', 'allowDiskUse()'),
  m('returnKey', 'returnKey()'),
  m('showRecordId', 'showRecordId()'),
  ...CURSOR_COMMON
]

export const AGGREGATE_CURSOR_METHODS: VocabItem[] = [...CURSOR_COMMON]

const ops = (...names: string[]): VocabItem[] => names.map((label) => ({ label }))

export const QUERY_OPERATORS = ops(
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$and', '$or', '$nor', '$not', '$exists', '$type',
  '$regex', '$options', '$expr', '$elemMatch', '$all', '$size', '$mod', '$text', '$search', '$jsonSchema', '$where',
  '$geoWithin', '$geoIntersects', '$near', '$nearSphere', '$bitsAllSet', '$bitsAnySet', '$bitsAllClear', '$bitsAnyClear', '$comment'
)

export const UPDATE_OPERATORS = ops(
  '$set', '$unset', '$inc', '$mul', '$rename', '$setOnInsert', '$min', '$max', '$currentDate', '$push', '$addToSet',
  '$pop', '$pull', '$pullAll', '$each', '$position', '$slice', '$sort', '$bit'
)

export const STAGES = ops(
  '$match', '$project', '$addFields', '$set', '$unset', '$group', '$sort', '$limit', '$skip', '$count', '$lookup',
  '$unwind', '$facet', '$bucket', '$bucketAuto', '$sortByCount', '$replaceRoot', '$replaceWith', '$sample', '$out',
  '$merge', '$unionWith', '$graphLookup', '$geoNear', '$redact', '$setWindowFields', '$fill', '$densify',
  '$documents', '$indexStats', '$collStats', '$currentOp', '$listSessions', '$search', '$searchMeta', '$vectorSearch', '$changeStream'
)

export const ACCUMULATORS = ops(
  '$sum', '$avg', '$min', '$max', '$first', '$last', '$push', '$addToSet', '$count', '$stdDevPop', '$stdDevSamp',
  '$mergeObjects', '$top', '$bottom', '$topN', '$bottomN', '$firstN', '$lastN', '$maxN', '$minN', '$median', '$percentile', '$accumulator'
)

export const EXPRESSION_OPERATORS = ops(
  '$add', '$subtract', '$multiply', '$divide', '$mod', '$abs', '$ceil', '$floor', '$round', '$trunc', '$pow', '$sqrt', '$exp', '$ln', '$log', '$log10',
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$cmp', '$and', '$or', '$not', '$cond', '$ifNull', '$switch',
  '$concat', '$substr', '$substrCP', '$toLower', '$toUpper', '$trim', '$ltrim', '$rtrim', '$split', '$strLenCP', '$regexMatch', '$regexFind', '$replaceAll', '$indexOfCP',
  '$arrayElemAt', '$concatArrays', '$filter', '$map', '$reduce', '$size', '$slice', '$in', '$first', '$last', '$reverseArray', '$sortArray', '$zip', '$range', '$isArray', '$arrayToObject', '$objectToArray',
  '$dateToString', '$dateFromString', '$dateAdd', '$dateSubtract', '$dateDiff', '$dateTrunc', '$year', '$month', '$dayOfMonth', '$dayOfWeek', '$hour', '$minute', '$second', '$week',
  '$toString', '$toInt', '$toLong', '$toDouble', '$toDecimal', '$toDate', '$toObjectId', '$toBool', '$convert', '$type',
  '$literal', '$let', '$mergeObjects', '$getField', '$setField', '$sum', '$avg', '$min', '$max'
)

export const PROJECTION_OPERATORS = ops('$slice', '$elemMatch', '$meta')

/** Operators that fit a document key, by where the document sits. */
export function operatorsFor(flavor: KeyFlavor): VocabItem[] {
  switch (flavor) {
    case 'query':
      return QUERY_OPERATORS
    case 'update':
      return UPDATE_OPERATORS
    case 'stage':
      return STAGES
    case 'accumulator':
      return ACCUMULATORS
    case 'expression':
      return EXPRESSION_OPERATORS
    case 'projection':
      return PROJECTION_OPERATORS
    default:
      return []
  }
}

/** Whether field names fit a document key at this flavor. */
export function fieldsFit(flavor: KeyFlavor): boolean {
  return flavor === 'query' || flavor === 'fields' || flavor === 'projection'
}
