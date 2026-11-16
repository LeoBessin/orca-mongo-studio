// The Schema Explorer's analysis on canonical Extended JSON: types and presence, nested and array
// paths, histograms, common strings, the field cap, and both JSON Schema flavours.
import { assert, describe, test } from 'orca/testing'
import type { JsonObject } from './ejson-view'
import { analyzeDocuments, bar, dateBuckets, niceStep, numberBuckets, presenceText, toJsonSchema, typeSummary } from './schema'

const int = (n: number) => ({ $numberInt: String(n) })
const dbl = (n: number) => ({ $numberDouble: String(n) })
const date = (iso: string) => ({ $date: { $numberLong: String(Date.parse(iso)) } })

const docs: JsonObject[] = [
  { _id: { $oid: '64b000000000000000000001' }, name: 'Ada', age: int(36), tags: ['a', 'b'], address: { city: 'Paris', zip: '75001' }, at: date('2024-01-05T00:00:00Z') },
  { _id: { $oid: '64b000000000000000000002' }, name: 'Bob', age: dbl(41.5), tags: [], address: { city: 'Lyon' }, at: date('2024-03-20T00:00:00Z') },
  { _id: { $oid: '64b000000000000000000003' }, name: 'Ada', age: null, items: [{ sku: 'x', qty: int(2) }, { sku: 'y' }], at: date('2024-06-01T00:00:00Z') },
  { _id: { $oid: '64b000000000000000000004' }, name: 'Cy', active: true, at: date('2024-06-02T00:00:00Z') }
]

describe('schema analysis', () => {
  const r = analyzeDocuments(docs, {}, 10, 5)
  const f = (path: string) => r.fields.find((x) => x.path === path)!

  test('counts types and presence per field, in a stable order', () => {
    assert.equal(r.sampled, 4)
    assert.equal(r.requested, 10)
    assert.deepEqual(
      r.fields.filter((x) => !x.parent).map((x) => x.path),
      ['_id', 'active', 'address', 'age', 'at', 'items', 'name', 'tags']
    )
    assert.deepEqual(f('age').types, [
      { type: 'double', count: 1 },
      { type: 'int', count: 1 },
      { type: 'null', count: 1 }
    ])
    assert.equal(typeSummary(f('age')), 'double 33.3% · int 33.3% · null 33.3%')
    assert.equal(f('age').parentCount, 4)
    assert.equal(presenceText(f('age')), 'in 75% of documents')
    assert.equal(presenceText(f('active')), 'in 25% of documents')
    assert.deepEqual(f('active').bools, { true: 1, false: 0 })
  })

  test('nested fields count against their parent objects, array elements against arrays', () => {
    assert.equal(f('address.city').parentCount, 2)
    assert.equal(f('address.zip').count, 1)
    assert.equal(presenceText(f('address.zip')), 'in 50% of its parent objects')
    assert.equal(f('tags[]').count, 2)
    assert.equal(f('tags[]').parentCount, 2)
    assert.equal(presenceText(f('tags[]')), '2 elements in 2 arrays')
    assert.deepEqual(f('tags').arrays, { minLength: 0, maxLength: 2, avgLength: 1 })
    assert.equal(f('items[].sku').parentCount, 2)
    assert.equal(f('items[].qty').count, 1)
    // An array's elements come right under it.
    const at = r.fields.findIndex((x) => x.path === 'items')
    assert.equal(r.fields[at + 1]!.path, 'items[]')
  })

  test('strings: lengths, distinct values and the most common', () => {
    assert.deepEqual(f('name').strings, { minLength: 2, maxLength: 3, distinct: 3, distinctCapped: false, top: [{ value: 'Ada', count: 2 }, { value: 'Bob', count: 1 }, { value: 'Cy', count: 1 }] })
    const capped = analyzeDocuments([{ s: 'a' }, { s: 'b' }, { s: 'c' }, { s: 'a' }], { maxDistinct: 2 })
    assert.deepEqual(capped.fields[0]!.strings, { minLength: 1, maxLength: 1, distinct: 2, distinctCapped: true, top: [{ value: 'a', count: 2 }, { value: 'b', count: 1 }] })
  })

  test('numbers and dates get ranges and histograms', () => {
    assert.equal(f('age').numbers!.min, 36)
    assert.equal(f('age').numbers!.max, 41.5)
    assert.equal(f('age').numbers!.mean, 38.75)
    const d = f('at').dates!
    assert.equal(d.min, Date.parse('2024-01-05T00:00:00Z'))
    assert.deepEqual(d.buckets.map((b) => [b.label, b.count]), [
      ['2024-01', 1],
      ['2024-02', 0],
      ['2024-03', 1],
      ['2024-04', 0],
      ['2024-05', 0],
      ['2024-06', 2]
    ])
  })

  test('the field cap keeps shallow, common fields and their parents', () => {
    const wide = Array.from({ length: 3 }, (_, i) => Object.fromEntries([['_id', int(i)], ...Array.from({ length: 30 }, (_, k) => [`f${k}`, { deep: int(k) }])]))
    const capped = analyzeDocuments(wide as JsonObject[], { maxFields: 10 })
    assert.equal(capped.fieldsCapped, true)
    assert.equal(capped.fields.length, 10)
    assert.ok(capped.fields.every((x) => !x.parent || capped.fields.some((p) => p.path === x.parent)))
  })
})

describe('histograms', () => {
  test('nice steps are 1, 2 or 5 times a power of ten', () => {
    assert.deepEqual([0.3, 1, 1.2, 3, 7, 12, 4500].map(niceStep), [0.5, 1, 2, 5, 10, 20, 5000])
  })

  test('a few whole numbers get one bar each', () => {
    const b = numberBuckets([1, 2, 2, 3, 5], 1, 5)
    assert.deepEqual(b.map((x) => [x.label, x.count]), [['1', 1], ['2', 2], ['3', 1], ['4', 0], ['5', 1]])
  })

  test('wider ranges get nice equal buckets, the top value in the last', () => {
    const values = Array.from({ length: 101 }, (_, i) => i)
    const b = numberBuckets(values, 0, 100)
    assert.equal(b[0]!.label, '0 – 10')
    assert.equal(b.length, 11)
    assert.equal(b.reduce((s, x) => s + x.count, 0), 101)
    const frac = numberBuckets([0.1, 0.25, 0.9], 0.1, 0.9)
    assert.equal(frac[0]!.from, 0.1)
    assert.equal(frac.reduce((s, x) => s + x.count, 0), 3)
  })

  test('huge whole numbers and far dates still bucket', () => {
    const big = numberBuckets([9223372036854775807, 9223372036854775807, -9223372036854775808], -9223372036854775808, 9223372036854775807)
    assert.ok(big.length >= 2 && big.length <= 11)
    assert.equal(big.reduce((s, x) => s + x.count, 0), 3)
    assert.deepEqual(numberBuckets([2 ** 60, 2 ** 60], 2 ** 60, 2 ** 60).map((x) => x.count), [2])
    const far = dateBuckets([-62135596800000, 253402300799000], -62135596800000, 253402300799000)
    assert.ok(far.length >= 2 && far.length <= 12)
    assert.equal(far.reduce((s, x) => s + x.count, 0), 2)
  })

  test('counts from a reservoir scale up to every value seen', () => {
    const b = numberBuckets([1, 2], 1, 2, 10)
    assert.deepEqual(b.map((x) => x.count), [5, 5])
  })

  test('dates bucket by hour, day, month or year, merging to fit', () => {
    const t = (iso: string) => Date.parse(iso)
    const hours = dateBuckets([t('2024-01-01T00:10:00Z'), t('2024-01-01T05:00:00Z')], t('2024-01-01T00:10:00Z'), t('2024-01-01T05:00:00Z'))
    assert.equal(hours[0]!.label, '2024-01-01 00:00')
    assert.equal(hours.length, 6)
    const years = dateBuckets([t('1990-06-01T00:00:00Z'), t('2024-01-01T00:00:00Z')], t('1990-06-01T00:00:00Z'), t('2024-01-01T00:00:00Z'))
    assert.ok(years.length <= 12)
    assert.equal(years[0]!.label, '1990 – 1994')
    assert.equal(years.reduce((s, x) => s + x.count, 0), 2)
  })

  test('text bars', () => {
    assert.equal(bar(1, 1, 4), '████')
    assert.equal(bar(1, 2, 4), '██')
    assert.equal(bar(0, 2, 4), '')
    assert.equal(bar(1, 100, 4), '▏')
  })
})

describe('JSON Schema export', () => {
  const r = analyzeDocuments(docs)

  test('a $jsonSchema validator with BSON types, nested objects and array items', () => {
    const s = toJsonSchema(r, { flavor: 'mongo', required: true, closed: false }) as { $jsonSchema: JsonObject }
    const js = s.$jsonSchema as { bsonType: string; required: string[]; properties: Record<string, JsonObject> }
    assert.equal(js.bsonType, 'object')
    assert.deepEqual(js.required, ['_id', 'at', 'name'])
    assert.deepEqual(js.properties._id, { bsonType: 'objectId' })
    assert.deepEqual(js.properties.age, { bsonType: ['double', 'int', 'null'] })
    assert.deepEqual(js.properties.address, { bsonType: 'object', required: ['city'], properties: { city: { bsonType: 'string' }, zip: { bsonType: 'string' } } })
    assert.deepEqual(js.properties.tags, { bsonType: 'array', items: { bsonType: 'string' } })
    assert.deepEqual(js.properties.items, {
      bsonType: 'array',
      items: { bsonType: 'object', required: ['sku'], properties: { qty: { bsonType: 'int' }, sku: { bsonType: 'string' } } }
    })
  })

  test('a draft 2020-12 JSON Schema, closed', () => {
    const s = toJsonSchema(r, { flavor: 'json', required: false, closed: true }) as Record<string, JsonObject | string | boolean>
    assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.equal(s.additionalProperties, false)
    assert.equal(s.required, undefined)
    const props = s.properties as Record<string, JsonObject>
    assert.deepEqual(props.age, { type: ['number', 'null'] })
    assert.deepEqual(props.at, { type: 'string', format: 'date-time' })
    assert.deepEqual(props._id, { type: 'string', pattern: '^[0-9a-fA-F]{24}$' })
    assert.deepEqual(props.active, { type: 'boolean' })
    assert.equal((props.address as JsonObject).additionalProperties, false)
  })
})
