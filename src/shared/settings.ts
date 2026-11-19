// Mongo Studio's preferences. They are Orca plugin settings, declared in `orca-plugin.json`
// (`contributes.settings`, read and written with the `settings:own` capability), so Orca keeps
// them apart from the plugin's storage and its saved connections, checks each value's type, and
// shows them under the plugin in its own Settings too. The panel's Settings tab edits the same
// values. `settings.test.ts` checks that the manifest declares exactly these keys, defaults and
// values.
// Settings can still hold a value an older or newer version declared: `normalizeSettings` reads
// whatever is there and falls back to the default for anything missing or unknown.

export const RESULT_VIEW_KEYS = ['table', 'tree', 'json'] as const
export const DOC_VIEW_KEYS = ['tree', 'json', 'shell'] as const
export const PAGE_SIZES = [20, 50, 100, 200, 500] as const
/** Documents per page when nothing was chosen yet. */
export const DEFAULT_PAGE_SIZE: PageSize = 50

export type ResultView = (typeof RESULT_VIEW_KEYS)[number]
export type DocView = (typeof DOC_VIEW_KEYS)[number]
export type PageSize = (typeof PAGE_SIZES)[number]
/** `last`: start where the person left off last time. */
export type Remembered<T> = 'last' | T

export type Settings = {
  /** The view new result tabs open in. */
  resultView: Remembered<ResultView>
  /** The view an opened document starts in. */
  docView: Remembered<DocView>
  /** Documents per page in new tabs. */
  pageSize: Remembered<PageSize>
  /** Extended JSON shown relaxed (plain numbers and dates) or canonical (every type exact), in
   *  new tabs, documents, shell results and JSON exports. */
  ejson: 'relaxed' | 'canonical'
  /** Each query bar field says what doesn't parse while it is typed. */
  liveCheck: boolean
  /** The query bar's Format buttons. */
  formatButtons: boolean
  /** Ask before deleting selected documents or the open one. */
  confirmDeleteDocs: boolean
  /** Ask before dropping a collection, a view or an index, or deleting all of a collection's
   *  documents. */
  confirmDrop: boolean
  /** Type the name before dropping a database or updating every document of a collection. */
  confirmByName: boolean
}

export type SettingKey = keyof Settings
/** The settings that are on or off. */
export type FlagKey = { [K in SettingKey]: Settings[K] extends boolean ? K : never }[SettingKey]

export const DEFAULT_SETTINGS: Settings = {
  resultView: 'last',
  docView: 'last',
  pageSize: 'last',
  ejson: 'relaxed',
  liveCheck: true,
  formatButtons: true,
  confirmDeleteDocs: true,
  confirmDrop: true,
  confirmByName: true
}

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[]

/** Orca settings hold one JSON type per key, so "Last used" page size is stored as 0. */
const PAGE_SIZE_LAST = 0

/** `value` when it is one of `allowed`, otherwise `fallback`. */
export function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** One setting as read from Orca, or its default if it holds something this version doesn't
 *  know. */
export function readSetting<K extends SettingKey>(key: K, raw: unknown): Settings[K] {
  const d = DEFAULT_SETTINGS
  const read: { [P in SettingKey]: (r: unknown) => Settings[P] } = {
    resultView: (r) => oneOf<Settings['resultView']>(r, ['last', ...RESULT_VIEW_KEYS], d.resultView),
    docView: (r) => oneOf<Settings['docView']>(r, ['last', ...DOC_VIEW_KEYS], d.docView),
    pageSize: (r) => (r === PAGE_SIZE_LAST ? 'last' : oneOf<Settings['pageSize']>(r, ['last', ...PAGE_SIZES], d.pageSize)),
    ejson: (r) => oneOf<Settings['ejson']>(r, ['relaxed', 'canonical'], d.ejson),
    liveCheck: (r) => flag(r, d.liveCheck),
    formatButtons: (r) => flag(r, d.formatButtons),
    confirmDeleteDocs: (r) => flag(r, d.confirmDeleteDocs),
    confirmDrop: (r) => flag(r, d.confirmDrop),
    confirmByName: (r) => flag(r, d.confirmByName)
  }
  return read[key](raw)
}

/** One setting as Orca stores it. */
export function storedSetting<K extends SettingKey>(key: K, value: Settings[K]): string | number | boolean {
  return key === 'pageSize' && value === 'last' ? PAGE_SIZE_LAST : (value as string | number | boolean)
}

/** The settings in `raw` (what Orca's `settings.get()` answers), with the default for every key
 *  that is missing or holds something this version doesn't know. Keys it doesn't know are
 *  dropped. */
export function normalizeSettings(raw: unknown): Settings {
  const r = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, readSetting(k, r[k])])) as Settings
}

/** Whether every setting is at its default, so "Reset to defaults" has nothing to do. */
export function isDefault(s: Settings): boolean {
  return SETTING_KEYS.every((k) => s[k] === DEFAULT_SETTINGS[k])
}

/** Where to start: the chosen value, or `remembered` when the setting says "last used" and
 *  storage holds a value this version knows, or else `fallback`. */
export function startValue<T>(setting: Remembered<T>, remembered: unknown, allowed: readonly T[], fallback: T): T {
  if (setting !== 'last') return setting
  return oneOf(remembered, allowed, fallback)
}
