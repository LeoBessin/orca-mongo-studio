// Settings as read back from Orca: defaults for what is missing or unknown, how they are stored,
// where new tabs start, and the manifest declaring exactly these settings.
import { assert, describe, test } from 'orca/testing'
import { DEFAULT_SETTINGS, DOC_VIEW_KEYS, isDefault, normalizeSettings, PAGE_SIZES, readSetting, RESULT_VIEW_KEYS, SETTING_KEYS, startValue, storedSetting, type SettingKey } from './settings'

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

describe('stored values', () => {
  test('"Last used" page size is stored as 0 and read back', () => {
    assert.equal(storedSetting('pageSize', 'last'), 0)
    assert.equal(readSetting('pageSize', 0), 'last')
    assert.equal(storedSetting('pageSize', 100), 100)
    assert.equal(readSetting('pageSize', 100), 100)
  })

  test('every default survives being stored and read back', () => {
    for (const k of SETTING_KEYS) assert.equal(readSetting(k, storedSetting(k, DEFAULT_SETTINGS[k])), DEFAULT_SETTINGS[k], k)
  })
})

describe('isDefault', () => {
  test('tells the defaults from any change', () => {
    assert.equal(isDefault(DEFAULT_SETTINGS), true)
    assert.equal(isDefault({ ...DEFAULT_SETTINGS, formatButtons: false }), false)
  })
})

describe('startValue', () => {
  test('uses the chosen value over the remembered one', () => {
    assert.equal(startValue('tree', 'json', RESULT_VIEW_KEYS, 'table'), 'tree')
    assert.equal(startValue(200, 20, PAGE_SIZES, 50), 200)
  })

  test('uses the remembered value for "last used", or the fallback if it is unknown', () => {
    assert.equal(startValue('last', 'json', RESULT_VIEW_KEYS, 'table'), 'json')
    assert.equal(startValue('last', 'chart', RESULT_VIEW_KEYS, 'table'), 'table')
    assert.equal(startValue('last', undefined, DOC_VIEW_KEYS, 'tree'), 'tree')
    assert.equal(startValue('last', 25, PAGE_SIZES, 50), 50)
  })
})

describe('the manifest', () => {
  test('declares exactly these settings, with their defaults and every value they take', async () => {
    const { readFileSync } = await import('node:fs')
    type Declared = { key: string; type: string; default: unknown; enum?: unknown[]; enumLabels?: string[] }
    const manifest = JSON.parse(readFileSync(new URL('../../orca-plugin.json', import.meta.url), 'utf8')) as { contributes: { settings: Declared[] }; capabilities: { kind: string }[] }
    const declared = manifest.contributes.settings
    assert.deepEqual(declared.map((d) => d.key), SETTING_KEYS)
    assert.ok(manifest.capabilities.some((c) => c.kind === 'settings:own'))
    const values: Record<SettingKey, unknown[] | undefined> = {
      resultView: ['last', ...RESULT_VIEW_KEYS],
      docView: ['last', ...DOC_VIEW_KEYS],
      pageSize: ['last', ...PAGE_SIZES],
      ejson: ['relaxed', 'canonical'],
      liveCheck: undefined,
      formatButtons: undefined,
      sampleFields: undefined,
      confirmDeleteDocs: undefined,
      confirmDrop: undefined,
      confirmByName: undefined
    }
    for (const d of declared) {
      const key = d.key as SettingKey
      assert.equal(d.default, storedSetting(key, DEFAULT_SETTINGS[key]), `${key} default`)
      const all = values[key]
      if (all) assert.deepEqual(d.enum, all.map((v) => storedSetting(key, v as never)), `${key} values`)
      else assert.equal(d.type, 'boolean', key)
    }
  })
})
