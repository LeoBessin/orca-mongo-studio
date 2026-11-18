// Suggestions for the connection form's Group field.
import { assert, describe, test } from 'orca/testing'
import { existingGroups, suggestGroups } from './groups'

describe('existingGroups', () => {
  test('keeps distinct non-empty names, trimmed and sorted', () => {
    assert.deepEqual(existingGroups([{ group: 'Staging' }, { group: '' }, { group: 'Clients' }, { group: ' Staging ' }, { group: '  ' }]), ['Clients', 'Staging'])
  })
})

describe('suggestGroups', () => {
  const groups = ['Clients', 'Internal', 'Personal', 'Staging']

  test('offers every group while nothing is typed', () => {
    assert.deepEqual(suggestGroups(groups, ''), groups)
    assert.deepEqual(suggestGroups(groups, '  '), groups)
  })

  test('filters by substring, ignoring case, prefix matches first', () => {
    assert.deepEqual(suggestGroups(groups, 'in'), ['Internal', 'Staging'])
    assert.deepEqual(suggestGroups(groups, 'CLI'), ['Clients'])
  })

  test('offers a shorter existing name when the typed one extends it', () => {
    assert.deepEqual(suggestGroups(['Client'], 'Clients'), ['Client'])
  })

  test('does not offer the name typed exactly, but does offer other casings', () => {
    assert.deepEqual(suggestGroups(groups, 'Clients'), [])
    assert.deepEqual(suggestGroups(groups, 'clients'), ['Clients'])
  })

  test('returns nothing when no group matches, and respects the limit', () => {
    assert.deepEqual(suggestGroups(groups, 'prod'), [])
    assert.deepEqual(suggestGroups(groups, '', 2), ['Clients', 'Internal'])
  })
})
