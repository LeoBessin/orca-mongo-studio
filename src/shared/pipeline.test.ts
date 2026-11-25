// The aggregation editor's model: stages ↔ pipeline ↔ text, previews, and writes.
import { assert, describe, test } from 'orca/testing'
import {
  bodyText,
  hasWriteStage,
  newStage,
  parsePipelineText,
  parseStage,
  pipelineOf,
  pipelineText,
  previewPipelines,
  stagesFromFind,
  stagesFromPipeline,
  stageSummary,
  STAGE_TEMPLATES,
  templateFor,
  writeTarget,
  type StageDraft
} from './pipeline'
import { parseShell } from './shell-parse'

const int = (n: number) => ({ $numberInt: String(n) })
const st = (op: string, body: string, enabled = true): StageDraft => ({ ...newStage(op, body), enabled })

describe('pipeline: stages', () => {
  test('every template parses as its stage', () => {
    for (const s of STAGE_TEMPLATES) {
      const r = parseStage(st(s.op, s.body))
      assert.equal(r.error, undefined, `${s.op}: ${r.error}`)
      assert.deepEqual(Object.keys(r.stage!), [s.op])
    }
    assert.equal(templateFor('$limit'), '10')
    assert.equal(templateFor('$nope'), '{ }')
  })

  test('a stage parses its body in shell syntax, any value type', () => {
    assert.deepEqual(parseStage(st('$match', "{ status: 'A', n: { $gt: 2 } }")).stage, { $match: { status: 'A', n: { $gt: int(2) } } })
    assert.deepEqual(parseStage(st('$limit', '10')).stage, { $limit: int(10) })
    assert.deepEqual(parseStage(st('$unwind', "'$items'")).stage, { $unwind: '$items' })
    assert.deepEqual(parseStage(st('$match', "{ at: ISODate('2024-01-01') }")).stage, { $match: { at: { $date: { $numberLong: '1704067200000' } } } })
  })

  test('errors name the problem, with line and column', () => {
    assert.match(parseStage(st('$match', '{ a: }')).error!, /line 1, column 6/i)
    assert.match(parseStage(st('match', '{}')).error!, /not a stage name/)
    assert.match(parseStage(st('$limit', '  ')).error!, /Give \$limit a value/)
  })

  test('the pipeline holds the enabled stages; errors are by stage id', () => {
    const a = st('$match', '{ a: 1 }')
    const b = st('$limit', '5', false)
    const c = st('$project', '{ a: 1 }')
    assert.deepEqual(pipelineOf([a, b, c]).pipeline, [{ $match: { a: int(1) } }, { $project: { a: int(1) } }])
    const bad = st('$sort', '{ a: ')
    const r = pipelineOf([a, bad, st('$skip', 'x', false)])
    assert.equal(r.pipeline, undefined)
    assert.deepEqual(Object.keys(r.errors), [bad.id], 'a disabled stage does not count')
  })

  test('ids are unique', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newStage().id))
    assert.equal(ids.size, 50)
    for (const id of ids) assert.match(id, /^[a-z0-9]+$/)
  })
})

describe('pipeline: text', () => {
  test('stages round-trip through text', () => {
    const stages = [st('$match', "{ status: 'shipped' }"), st('$group', "{ _id: '$customerId', total: { $sum: '$total' } }"), st('$limit', '5', false), st('$sort', '{ total: -1 }')]
    const text = pipelineText(stages)
    assert.equal(text, "[\n  {\n    $match: {\n      status: 'shipped'\n    }\n  },\n  {\n    $group: {\n      _id: '$customerId',\n      total: {\n        $sum: '$total'\n      }\n    }\n  },\n  {\n    $sort: {\n      total: -1\n    }\n  }\n]")
    const back = parsePipelineText(text).stages!
    assert.deepEqual(back.map((s) => s.op), ['$match', '$group', '$sort'])
    assert.deepEqual(pipelineOf(back).pipeline, pipelineOf(stages).pipeline)
  })

  test('a stage that does not parse is kept as typed', () => {
    assert.equal(pipelineText([st('$match', '{ a: ')]), '[\n  { $match: { a: }\n]')
    assert.equal(pipelineText([]), '[]')
  })

  test('reading text: one stage alone, empty, and what is not a pipeline', () => {
    assert.deepEqual(parsePipelineText("{ $match: { a: 1 } }").stages!.map((s) => s.op), ['$match'])
    assert.deepEqual(parsePipelineText('  ').stages, [])
    assert.match(parsePipelineText('42').error!, /array of stages/)
    assert.match(parsePipelineText('[{ $match: {}, $limit: 1 }]').error!, /Stage 1 must be a document with one stage name/)
    assert.match(parsePipelineText('[{ match: {} }]').error!, /Stage 1/)
    assert.match(parsePipelineText('[{ $match: ').error!, /line 1/i)
  })

  test('an aggregate statement, with where it runs and its options', () => {
    // The statement from issue #32, as pasted from Compass.
    const r = parsePipelineText(`db.getCollection("products").aggregate([
  { "$match": { "category": "books", "status": "active",
      "$or": [ { "options.featured": { "$exists": true } }, { "options.on_sale": true } ] } },
  { "$project": { "_id": 0, "title": 1,
      "len": { "$strLenCP": { "$trim": { "input": { "$ifNull": ["$title", ""] } } } } } },
  { "$match": { "len": { "$gt": 40 } } },
  { "$sort": { "len": -1 } }
])`)
    assert.equal(r.error, undefined)
    assert.deepEqual(r.stages!.map((s) => s.op), ['$match', '$project', '$match', '$sort'])
    assert.equal(r.source?.collection, 'products')
    assert.equal(r.source?.db, undefined)
    const sibling = parsePipelineText("db.getSiblingDB('blog').posts.aggregate([{ $limit: 1 }], { allowDiskUse: true });")
    assert.deepEqual([sibling.source?.db, sibling.source?.collection, sibling.source?.options], ['blog', 'posts', { allowDiskUse: true }])
    assert.match(parsePipelineText("db.posts.find({ a: 1 })").error!, /runs find\(\)/)
    assert.match(parsePipelineText('db.posts.aggregate(stages)').error!, /literal/)
  })

  test('bodies: short values on one line, long ones laid out', () => {
    assert.equal(bodyText({ a: int(1) }), '{ a: 1 }')
    assert.equal(bodyText('$items'), "'$items'")
    const long = parseShell("{ from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' }")
    assert.equal(bodyText(long), "{\n  from: 'customers',\n  localField: 'customerId',\n  foreignField: '_id',\n  as: 'customer'\n}")
    const stages = stagesFromPipeline([{ $lookup: long }, { $limit: int(3) }]).stages!
    assert.deepEqual(stages.map((s) => [s.op, s.enabled]), [['$lookup', true], ['$limit', true]])
    assert.equal(stageSummary(stages[0]!, 40), "{ from: 'customers', localField: 'custo…")
  })
})

describe('pipeline: previews and writes', () => {
  const a = st('$match', '{ a: 1 }')
  const b = st('$group', "{ _id: '$a' }")
  const off = st('$limit', '1', false)
  const out = st('$out', "'copy'")

  test('a stage previews from the enabled stages before it', () => {
    assert.deepEqual(previewPipelines([a, b], 0), { before: [], stage: { $match: { a: int(1) } }, errors: {} })
    assert.deepEqual(previewPipelines([a, off, b], 2), { before: [{ $match: { a: int(1) } }], stage: { $group: { _id: '$a' } }, errors: {} })
  })

  test('an off stage shows its input as its output; a write is never previewed', () => {
    const r = previewPipelines([a, off], 1)
    assert.deepEqual(r.before, [{ $match: { a: int(1) } }])
    assert.equal(r.stage, undefined)
    assert.match(r.note!, /off/)
    const w = previewPipelines([a, out], 1)
    assert.equal(w.stage, undefined)
    assert.match(w.note!, /\$out writes/)
    const after = previewPipelines([out, a], 1)
    assert.equal(after.before, undefined)
    assert.match(after.note!, /must be the last stage/)
  })

  test('errors before the stage, or in it, stop the preview', () => {
    const bad = st('$match', '{')
    assert.deepEqual(Object.keys(previewPipelines([bad, a], 1).errors), [bad.id])
    assert.deepEqual(Object.keys(previewPipelines([a, bad], 1).errors), [bad.id])
  })

  test('write targets', () => {
    assert.deepEqual(writeTarget([{ $match: {} }, { $out: 'copy' }], 'shop'), { stage: '$out', target: 'shop.copy', ns: { db: 'shop', collection: 'copy' } })
    assert.deepEqual(writeTarget([{ $out: { db: 'other', coll: 'x' } }], 'shop'), { stage: '$out', target: 'other.x', ns: { db: 'other', collection: 'x' } })
    assert.deepEqual(writeTarget([{ $merge: { into: 'x' } }], 'shop'), { stage: '$merge', target: 'shop.x', ns: { db: 'shop', collection: 'x' } })
    assert.deepEqual(writeTarget([{ $merge: 'x' }], 'shop'), { stage: '$merge', target: 'shop.x', ns: { db: 'shop', collection: 'x' } })
    assert.deepEqual(writeTarget([{ $merge: { into: { db: 'archive' } } }], 'shop'), { stage: '$merge', target: 'another collection' })
    assert.equal(writeTarget([{ $match: {} }], 'shop'), undefined)
    assert.equal(writeTarget([], 'shop'), undefined)
    assert.equal(hasWriteStage([{ $out: 'x' }, { $match: {} }]), true)
  })

  test('a find becomes the stages that do the same', () => {
    const stages = stagesFromFind({ filter: { a: int(1) }, projection: { a: int(1) }, sort: { a: int(-1) }, skip: 5, limit: 10 })
    assert.deepEqual(pipelineOf(stages).pipeline, [{ $match: { a: int(1) } }, { $sort: { a: int(-1) } }, { $skip: int(5) }, { $limit: int(10) }, { $project: { a: int(1) } }])
    assert.deepEqual(stagesFromFind({ filter: {} }).map((s) => [s.op, s.body]), [['$match', '{}']])
  })
})
