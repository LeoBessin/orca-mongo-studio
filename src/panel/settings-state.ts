// The Settings tab's state: Mongo Studio's preferences, which are Orca plugin settings declared
// in `orca-plugin.json` (see `src/shared/settings.ts`). Orca keeps them apart from the plugin's
// storage, so resetting them never touches a saved connection.
// The panel holds one normalized copy in `settingsAtom`: read it with `settings()`, which costs a
// read. It is loaded once by `loadSettings()` before the layout comes back, written through on
// each change, and refreshed when someone else changes a setting (another panel, the worker, or
// the person in Orca's Settings). Orca announces every write, ours included, after it lands; a
// key with a write of ours still in flight ignores those announcements, so an older write's echo
// can't undo a newer change, and the copy is already right when the last write lands.
import { atom, read, set, settings as orcaSettings, update, type Disposable } from 'orca'
import { DEFAULT_SETTINGS, normalizeSettings, readSetting, SETTING_KEYS, storedSetting, type SettingKey, type Settings } from '../shared/settings'
import { errorText, view } from './state'

export const SETTINGS_TAB = 'settings'

export const settingsAtom = atom<Settings>({ ...DEFAULT_SETTINGS })
export const settingsOpen = atom(false)
/** Why the last change could not be saved, shown in the Settings tab. */
export const settingsError = atom<string | null>(null)

/** Writes of ours not yet landed, by key. */
const inFlight = new Map<SettingKey, number>()

export function settings(): Settings {
  return read(settingsAtom)
}

function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as string[]).includes(key)
}

/** Reads every setting, and follows changes made elsewhere. */
export async function loadSettings(): Promise<Disposable> {
  let listener: Disposable = { dispose: () => undefined }
  try {
    listener = orcaSettings.onDidChange(({ key }) => {
      if (!isSettingKey(key) || inFlight.get(key)) return
      // Read the value now rather than trust the order announcements arrive in.
      void orcaSettings.get(key).then(
        (value) => {
          if (!inFlight.get(key)) update(settingsAtom, (s) => ({ ...s, [key]: readSetting(key, value) }))
        },
        () => undefined
      )
    })
  } catch {
    // Without change announcements, the settings still load and save; other windows' changes
    // show from the next panel run.
  }
  try {
    set(settingsAtom, normalizeSettings(await orcaSettings.get()))
  } catch {
    // Unreadable settings leave the defaults: Mongo Studio works as it always did.
  }
  return listener
}

function write<K extends SettingKey>(key: K, value: Settings[K]): Promise<void> {
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1)
  return orcaSettings.set(key, storedSetting(key, value)).finally(() => {
    const left = (inFlight.get(key) ?? 1) - 1
    if (left > 0) inFlight.set(key, left)
    else inFlight.delete(key)
  })
}

/** Applies `values` at once, and saves them. A write Orca refuses puts back what it holds. */
export function changeSettings(values: Partial<Settings>): Promise<void> {
  const keys = (Object.keys(values) as SettingKey[]).filter(isSettingKey)
  update(settingsAtom, (s) => ({ ...s, ...values }))
  set(settingsError, null)
  return Promise.all(keys.map((k) => write(k, values[k] as Settings[typeof k])))
    .then(() => undefined)
    .catch(async (error: unknown) => {
      set(settingsError, `Could not save the setting: ${errorText(error)}`)
      try {
        set(settingsAtom, normalizeSettings(await orcaSettings.get()))
      } catch {
        // Keep what is shown; the notice says it was not saved.
      }
    })
}

/** Puts every setting back to its default. Connections, history and saved queries stay. */
export function resetSettings(): Promise<void> {
  return changeSettings({ ...DEFAULT_SETTINGS })
}

/** Whether new tabs, documents and JSON exports show relaxed Extended JSON. */
export function startRelaxed(): boolean {
  return settings().ejson === 'relaxed'
}

export function openSettings(): void {
  set(settingsOpen, true)
  set(view, SETTINGS_TAB)
}

export function closeSettings(): void {
  set(settingsOpen, false)
  if (read(view) === SETTINGS_TAB) set(view, 'tree')
}
