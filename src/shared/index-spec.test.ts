// The index form: every key kind, the options each allows, and the errors it gives before the
// server would.
import { assert, describe, test } from 'orca/testing'
import { buildIndex, createIndexCommand, defaultIndexName, emptyIndexDraft, type IndexDraft, type IndexKeyRow } from './index-spec'

const draft = (keys: Omit<IndexKeyRow, 'id'>[], extra: Partial<IndexDraft> = {}): IndexDraft => ({ ...emptyIndexDraft(), keys: keys.map((k, i) => ({ ...k, id: `k${i}` })), ...extra })
const one = { $numberInt: '1' }

describe('index form', () => {
  test('a compound ascending/descending index, unique, named', () => {
    const b = buildIndex(draft([{ field: 'email', kind: '1' }, { field: 'at', kind: '-1' }], { unique: true, name: 'by_email' }))
    assert.deepEqual(b.errors, {})
    assert.deepEqual(b.key, { email: one, at: { $numberInt: '-1' } })
    assert.deepEqual(b.options, { name: 'by_email', unique: true })
    assert.equal(createIndexCommand('users', b.key!, b.options!), "db.users.createIndex({ email: 1, at: -1 }, { name: 'by_email', unique: true })")
    assert.equal(defaultIndexName(b.key!), 'email_1_at_-1')
  })

  test('text with weights and languages; geo; hashed', () => {
    const t = buildIndex(draft([{ field: 'title', kind: 'text' }, { field: 'body', kind: 'text' }], { weights: '{ title: 10 }', defaultLanguage: 'french', languageOverride: 'lang' }))
    assert.deepEqual(t.key, { title: 'text', body: 'text' })
    assert.deepEqual(t.options, { weights: { title: { $numberInt: '10' } }, default_language: 'french', language_override: 'lang' })
    assert.deepEqual(buildIndex(draft([{ field: 'loc', kind: '2dsphere' }, { field: 'kind', kind: '1' }])).key, { loc: '2dsphere', kind: one })
    const flat = buildIndex(draft([{ field: 'xy', kind: '2d' }], { extra: '{ bits: 26, min: -500, max: 500 }' }))
    assert.deepEqual(flat.options, { bits: { $numberInt: '26' }, min: { $numberInt: '-500' }, max: { $numberInt: '500' } })
    assert.deepEqual(buildIndex(draft([{ field: 'userId', kind: 'hashed' }])).key, { userId: 'hashed' })
    assert.equal(createIndexCommand('system.x', { a: 'hashed' }, {}), "db.getCollection('system.x').createIndex({ a: 'hashed' })")
  })

  test('wildcard on all fields with a projection, or under one field', () => {
    const all = buildIndex(draft([{ field: '', kind: 'wildcard' }], { wildcardProjection: '{ secret: 0 }' }))
    assert.deepEqual(all.key, { '$**': one })
    assert.deepEqual(all.options, { wildcardProjection: { secret: { $numberInt: '0' } } })
    assert.deepEqual(buildIndex(draft([{ field: 'attrs', kind: 'wildcard' }])).key, { 'attrs.$**': one })
    assert.match(buildIndex(draft([{ field: 'attrs', kind: 'wildcard' }], { wildcardProjection: '{ a: 1 }' })).errors.wildcardProjection!, /all fields/)
  })

  test('TTL, partial, sparse, hidden and collation', () => {
    const ttl = buildIndex(draft([{ field: 'createdAt', kind: '1' }], { ttl: '3600', hidden: true }))
    assert.deepEqual(ttl.options, { hidden: true, expireAfterSeconds: { $numberInt: '3600' } })
    const partial = buildIndex(draft([{ field: 'email', kind: '1' }], { unique: true, partial: "{ email: { $exists: true } }", collation: "{ locale: 'en', strength: 2 }" }))
    assert.deepEqual(partial.options, { unique: true, partialFilterExpression: { email: { $exists: true } }, collation: { locale: 'en', strength: { $numberInt: '2' } } })
    assert.deepEqual(buildIndex(draft([{ field: 'a', kind: '1' }], { sparse: true })).options, { sparse: true })
  })

  test('errors say what to change', () => {
    const e = (d: IndexDraft) => buildIndex(d).errors
    assert.match(e(draft([{ field: '', kind: '1' }])).keys!, /at least one/)
    assert.match(e(draft([{ field: 'a', kind: '1' }, { field: 'a', kind: '-1' }])).keys!, /twice/)
    assert.match(e(draft([{ field: '$a', kind: '1' }])).keys!, /start with \$/)
    assert.match(e(draft([{ field: 'a..b', kind: '1' }])).keys!, /empty part/)
    assert.match(e(draft([{ field: 'a', kind: 'hashed' }, { field: 'b', kind: 'hashed' }])).keys!, /one hashed/)
    assert.match(e(draft([{ field: 'a', kind: '1' }, { field: 'b', kind: '2d' }])).keys!, /first/)
    assert.match(e(draft([{ field: '', kind: 'wildcard' }, { field: 't', kind: 'text' }])).keys!, /wildcard index can be compound/)
    assert.match(e(draft([{ field: 'a', kind: 'hashed' }], { unique: true })).unique!, /can't be unique/)
    assert.match(e(draft([{ field: 'a', kind: '1' }, { field: 'b', kind: '1' }], { ttl: '60' })).ttl!, /one ascending/)
    assert.match(e(draft([{ field: '_id', kind: '1' }], { ttl: '60' })).ttl!, /_id/)
    assert.match(e(draft([{ field: 'a', kind: '1' }], { ttl: '1.5' })).ttl!, /whole number/)
    assert.match(e(draft([{ field: 'a', kind: '1' }], { sparse: true, partial: '{ a: 1 }' })).partial!, /not both/)
    assert.match(e(draft([{ field: 'a', kind: '1' }], { collation: '{ strength: 2 }' })).collation!, /locale/)
    assert.match(e(draft([{ field: 'a', kind: '1' }], { weights: '{ a: 2 }' })).weights!, /text indexes/)
    assert.match(e(draft([{ field: 'a', kind: '1' }], { partial: '{ a: ' })).partial!, /text ended/)
    assert.match(e(draft([{ field: 'a', kind: '1' }], { extra: '{ background: true }' })).extra!, /not an index option/)
    assert.match(e(draft([{ field: 'a', kind: '1' }], { name: 'x', extra: "{ name: 'y' }" })).extra!, /set above/)
  })
})
