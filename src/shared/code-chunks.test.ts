// Splitting documents shown as code so Orca's highlighter colours all of them.
import { assert, describe, test } from 'orca/testing'
import { arrayText, chunkForHighlight, chunkLabel, HIGHLIGHT_CHARS_MAX, HIGHLIGHT_LINE_MAX } from './code-chunks'

const doc = (n: number): string => JSON.stringify({ _id: n, name: `doc ${n}` }, null, 2)

describe('chunkForHighlight', () => {
  test('keeps small documents in one chunk', () => {
    const texts = [doc(1), doc(2), doc(3)]
    assert.deepEqual(chunkForHighlight(texts), [{ from: 0, texts }])
  })

  test('ends a chunk after a document with a line too long to highlight', () => {
    const long = JSON.stringify({ _id: 2, body: 'x'.repeat(HIGHLIGHT_LINE_MAX + 1) }, null, 2)
    const chunks = chunkForHighlight([doc(1), long, doc(3), doc(4)])
    assert.deepEqual(chunks.map((c) => [c.from, c.texts.length]), [[0, 2], [2, 2]])
  })

  test('a line that reaches the limit once indented into the array is still highlighted', () => {
    const edge = `{\n${'x'.repeat(HIGHLIGHT_LINE_MAX - 2)}\n}`
    assert.equal(chunkForHighlight([edge, doc(2)]).length, 1)
    const over = `{\n${'x'.repeat(HIGHLIGHT_LINE_MAX - 1)}\n}`
    assert.equal(chunkForHighlight([over, doc(2)]).length, 2)
  })

  test('starts a new chunk before passing the highlighted size', () => {
    const big = `{ "s": "${'y'.repeat(800)}" }`
    const texts = Array.from({ length: 200 }, () => big)
    const chunks = chunkForHighlight(texts)
    assert.ok(chunks.length > 1)
    for (const c of chunks) assert.ok(arrayText(c.texts).length <= HIGHLIGHT_CHARS_MAX)
    assert.equal(chunks.reduce((n, c) => n + c.texts.length, 0), 200)
  })

  test('a document bigger than the limit gets a chunk of its own', () => {
    const huge = `{\n${Array.from({ length: 800 }, (_, i) => `  "f${i}": "${'z'.repeat(80)}"`).join(',\n')}\n}`
    const chunks = chunkForHighlight([doc(1), huge, doc(3)])
    assert.deepEqual(chunks.map((c) => c.texts.length), [1, 1, 1])
  })

  test('no documents, no chunks', () => {
    assert.deepEqual(chunkForHighlight([]), [])
  })
})

describe('arrayText', () => {
  test('lays out documents like JSON.stringify of the array', () => {
    const docs = [{ a: 1, b: [1, 2] }, { c: { d: 'e' } }]
    assert.equal(arrayText(docs.map((d) => JSON.stringify(d, null, 2))), JSON.stringify(docs, null, 2))
  })

  test('an empty array', () => {
    assert.equal(arrayText([]), '[]')
  })
})

describe('chunkLabel', () => {
  test('names the documents a chunk holds, from the page offset', () => {
    assert.equal(chunkLabel('Documents', { from: 0, texts: ['a'] }, 0, 1), 'Documents')
    assert.equal(chunkLabel('Documents', { from: 2, texts: ['a', 'b', 'c'] }, 20, 2), 'Documents: documents 23–25')
    assert.equal(chunkLabel('Documents', { from: 1, texts: ['a'] }, 0, 3), 'Documents: document 2')
  })
})
