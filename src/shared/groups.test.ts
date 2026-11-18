// Group names: normalising them, and the suggestions under the connection form's Group field.
import { assert, describe, test } from 'orca/testing'
import { canonicalGroup, existingGroups, normalizeGroup, suggestGroups } from './groups'

describe('normalizeGroup', () => {
  test('trims strings and reads anything else as no group', () => {
    assert.equal(normalizeGroup(' Staging '), 'Staging')
    assert.equal(normalizeGroup(null), '')
    assert.equal(normalizeGroup(undefined), '')
    assert.equal(normalizeGroup(3), '')
  })
})

describe('existingGroups', () => {
  test('keeps distinct non-empty names, trimmed and sorted', () => {
    assert.deepEqual(existingGroups([{ group: 'Staging' }, { group: '' }, { group: 'Clients' }, { group: ' Staging ' }, { group: '  ' }]), ['Clients', 'Staging'])
  })

  test('copes with groups that are not strings', () => {
    assert.deepEqual(existingGroups([{ group: null }, { group: 3 }, { group: 'Clients' }]), ['Clients'])
  })
})

describe('canonicalGroup', () => {
  test('uses the existing spelling of a group that differs only in case', () => {
    assert.equal(canonicalGroup('clients', ['Clients', 'Staging']), 'Clients')
    assert.equal(canonicalGroup('Clients', ['Clients']), 'Clients')
  })

  test('keeps a new name, and no group, as they are', () => {
    assert.equal(canonicalGroup('Archive', ['Clients']), 'Archive')
    assert.equal(canonicalGroup('', ['Clients']), '')
  })
})

describe('suggestGroups', () => {
  const groups = ['Clients', 'Internal', 'Personal', 'Staging']

  test('offers every group while nothing is typed', () => {
    assert.deepEqual(suggestGroups(groups, ''), { names: groups, hidden: 0, filtered: false })
    assert.deepEqual(suggestGroups(groups, '  ').names, groups)
  })

  test('filters by substring, ignoring case, prefix matches first', () => {
    assert.deepEqual(suggestGroups(groups, 'in'), { names: ['Internal', 'Staging'], hidden: 0, filtered: true })
    assert.deepEqual(suggestGroups(groups, 'CLI').names, ['Clients'])
  })

  test('offers a shorter existing name only when the typed text starts with it', () => {
    assert.deepEqual(suggestGroups(['Client'], 'Clients').names, ['Client'])
    assert.deepEqual(suggestGroups(['A', 'US', 'Int', 'test'], 'Business').names, [])
    assert.deepEqual(suggestGroups(['A', 'US', 'Int', 'test'], 'Print contest').names, [])
  })

  test('once the field names an existing group, offers the other groups to move to', () => {
    assert.deepEqual(suggestGroups(groups, 'Clients'), { names: ['Internal', 'Personal', 'Staging'], hidden: 0, filtered: false })
  })

  test('offers the existing casing of what was typed', () => {
    assert.deepEqual(suggestGroups(groups, 'clients').names, ['Clients'])
  })

  test('returns nothing when no group matches', () => {
    assert.deepEqual(suggestGroups(groups, 'prod'), { names: [], hidden: 0, filtered: true })
  })

  test('cuts at the limit and says how many were left out', () => {
    assert.deepEqual(suggestGroups(groups, '', 2), { names: ['Clients', 'Internal'], hidden: 2, filtered: false })
  })

  test('prefix matches survive the limit on the filtered path', () => {
    // 'Ops' and 'Opsec' start with 'op'; the other five only contain it.
    const many = ['Aop', 'Bop', 'Cop', 'Dop', 'Eop', 'Ops', 'Opsec']
    assert.deepEqual(suggestGroups(many, 'op', 3), { names: ['Ops', 'Opsec', 'Aop'], hidden: 4, filtered: true })
  })
})
