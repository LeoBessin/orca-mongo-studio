// The Settings tab's state: Mongo Studio's preferences, in the plugin's storage under keys of
// their own (`mongo-studio.settings.<name>`), apart from the saved connections (`connections.v1`,
// written by the worker). `storage` atoms are shared with panels in other windows and kept
// current, so a change applies everywhere at once.
// Each setting has its own key: storage echoes every write back to the atom, and with one object
// for all of them, the echo of one change could land after the next and undo it.
// Read them through `settings()`, never the atoms directly: storage holds whatever an older or
// newer version wrote.
import { atom, read, set, type Atom } from 'orca'
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '../shared/settings'
import { view } from './state'

export const SETTINGS_TAB = 'settings'
export const SETTINGS_PREFIX = 'mongo-studio.settings.'

type Key = keyof Settings
const KEYS = Object.keys(DEFAULT_SETTINGS) as Key[]

const atoms = Object.fromEntries(
  KEYS.map((k) => [k, atom<unknown>(`${SETTINGS_PREFIX}${k}`, DEFAULT_SETTINGS[k], { persist: 'storage' })])
) as Record<Key, Atom<unknown>>

export const settingsOpen = atom(false)

export function settings(): Settings {
  return normalizeSettings(Object.fromEntries(KEYS.map((k) => [k, read(atoms[k])])))
}

export function changeSettings(values: Partial<Settings>): void {
  for (const k of Object.keys(values) as Key[]) if (k in atoms) set(atoms[k], values[k])
}

/** Puts every setting back to its default. Connections, history and saved queries stay. */
export function resetSettings(): void {
  for (const k of KEYS) set(atoms[k], DEFAULT_SETTINGS[k])
}

export function openSettings(): void {
  set(settingsOpen, true)
  set(view, SETTINGS_TAB)
}

export function closeSettings(): void {
  set(settingsOpen, false)
  if (read(view) === SETTINGS_TAB) set(view, 'tree')
}
