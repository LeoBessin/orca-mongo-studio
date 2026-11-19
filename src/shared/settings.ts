// Mongo Studio's preferences, as the Settings tab edits them. They are kept in the plugin's
// storage under their own key, apart from the saved connections, so resetting them never touches
// a connection. Storage keeps values as written, with no migration step: `normalizeSettings`
// reads whatever is there and falls back to the default for anything missing or unknown, so an
// older or newer version's value never breaks the panel.

export const RESULT_VIEW_KEYS = ['table', 'tree', 'json'] as const
export const DOC_VIEW_KEYS = ['tree', 'json', 'shell'] as const
export const PAGE_SIZES = [20, 50, 100, 200, 500] as const

export type ResultView = (typeof RESULT_VIEW_KEYS)[number]
export type DocView = (typeof DOC_VIEW_KEYS)[number]
/** `last`: start where the person left off last time. */
export type Remembered<T> = 'last' | T

export type Settings = {
  /** The view new result tabs open in. */
  resultView: Remembered<ResultView>
  /** The view an opened document starts in. */
  docView: Remembered<DocView>
  /** Documents per page in new tabs. */
  pageSize: Remembered<number>
  /** Extended JSON shown relaxed (plain numbers and dates) or canonical (every type exact), in
   *  new tabs, documents and JSON exports. */
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

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** The settings in `raw`, with the default for every key that is missing or holds something
 *  this version doesn't know. Keys it doesn't know are dropped. */
export function normalizeSettings(raw: unknown): Settings {
  const r = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const d = DEFAULT_SETTINGS
  return {
    resultView: oneOf<Settings['resultView']>(r.resultView, ['last', ...RESULT_VIEW_KEYS], d.resultView),
    docView: oneOf<Settings['docView']>(r.docView, ['last', ...DOC_VIEW_KEYS], d.docView),
    pageSize: oneOf<Settings['pageSize']>(r.pageSize, ['last', ...PAGE_SIZES], d.pageSize),
    ejson: oneOf<Settings['ejson']>(r.ejson, ['relaxed', 'canonical'], d.ejson),
    liveCheck: flag(r.liveCheck, d.liveCheck),
    formatButtons: flag(r.formatButtons, d.formatButtons),
    confirmDeleteDocs: flag(r.confirmDeleteDocs, d.confirmDeleteDocs),
    confirmDrop: flag(r.confirmDrop, d.confirmDrop),
    confirmByName: flag(r.confirmByName, d.confirmByName)
  }
}

/** Whether every setting is at its default, so "Reset to defaults" has nothing to do. */
export function isDefault(s: Settings): boolean {
  return (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).every((k) => s[k] === DEFAULT_SETTINGS[k])
}

/** The view to start in: the chosen one, or `remembered` when the setting says "last used" and
 *  storage holds a view this version knows. */
export function startView<T extends string>(setting: Remembered<T>, remembered: unknown, allowed: readonly T[], fallback: T): T {
  if (setting !== 'last') return setting
  return typeof remembered === 'string' && allowed.includes(remembered as T) ? (remembered as T) : fallback
}
