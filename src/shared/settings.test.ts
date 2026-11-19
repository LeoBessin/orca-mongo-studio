// Settings as read back from storage: defaults for what is missing or unknown, and the views
// new tabs and documents start in.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT_SETTINGS, DOC_VIEW_KEYS, isDefault, normalizeSettings, RESULT_VIEW_KEYS, startView } from './settings'

describe('normalizeSettings', () => {
  test('reads nothing stored as the defaults', () => {
    assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS)
    assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS)
    assert.deepEqual(normalizeSettings([]), DEFAULT_SETTINGS)
    assert.deepEqual(normalizeSettings('table'), DEFAULT_SETTINGS)
  })

  test('keeps known values and fills in the rest', () => {
    const s = normalizeSettings({ resultView: 'json', pageSize: 200, ejson: 'canonical', confirmDrop: false })
    assert.deepEqual(s, { ...DEFAULT_SETTINGS, resultView: 'json', pageSize: 200, ejson: 'canonical', confirmDrop: false })
  })

  test('replaces values this version does not know, and drops unknown keys', () => {
    const s = normalizeSettings({ resultView: 'chart', docView: 3, pageSize: 33, ejson: 'loose', liveCheck: 'no', extra: true })
    assert.deepEqual(s, DEFAULT_SETTINGS)
  })
})

describe('isDefault', () => {
  test('tells the defaults from any change', () => {
    assert.equal(isDefault(DEFAULT_SETTINGS), true)
    assert.equal(isDefault({ ...DEFAULT_SETTINGS, formatButtons: false }), false)
  })
})

describe('startView', () => {
  test('uses the chosen view over the remembered one', () => {
    assert.equal(startView('tree', 'json', RESULT_VIEW_KEYS, 'table'), 'tree')
  })

  test('uses the remembered view for "last used", or the fallback if it is unknown', () => {
    assert.equal(startView('last', 'json', RESULT_VIEW_KEYS, 'table'), 'json')
    assert.equal(startView('last', 'chart', RESULT_VIEW_KEYS, 'table'), 'table')
    assert.equal(startView('last', undefined, DOC_VIEW_KEYS, 'tree'), 'tree')
  })
})
