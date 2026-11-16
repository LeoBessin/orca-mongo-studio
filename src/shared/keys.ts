// Keyboard chords: Orca's notation (`Mod+Shift+BracketLeft`) and CodeMirror's (`Shift-Mod-[`) read
// into one form per platform, so the plugin's keys can be checked against Orca's own. The shell
// editor drops CodeMirror's default keys that Orca uses (src/editor/main.ts), and a test checks the
// manifest's keybindings and the editor's own keys.
import { ORCA_RESERVED_KEYS } from './orca-keys'

export type Platform = 'darwin' | 'linux' | 'win32'

/** The shell editor's own keys, in CodeMirror's notation. */
export const SHELL_EDITOR_KEYS = { runCurrent: 'Mod-Enter', runAll: 'Shift-Mod-Enter' } as const

const KEY_NAMES: Record<string, string> = {
  '[': 'bracketleft',
  ']': 'bracketright',
  '=': 'equal',
  '-': 'minus',
  '+': 'plus',
  '/': 'slash',
  '\\': 'backslash',
  ',': 'comma',
  '.': 'period',
  ';': 'semicolon',
  "'": 'quote',
  '`': 'backquote',
  ' ': 'space',
  esc: 'escape',
  del: 'delete',
  return: 'enter',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright'
}

function keyName(key: string): string {
  const lower = key.toLowerCase()
  return KEY_NAMES[key] ?? KEY_NAMES[lower] ?? lower
}

/** `alt+ctrl+meta+shift+key` (modifiers in that order, each once), or undefined for a chord this
 *  file can't read. */
function canonical(mods: Set<string>, key: string): string {
  return [...['alt', 'ctrl', 'meta', 'shift'].filter((m) => mods.has(m)), keyName(key)].join('+')
}

/** Orca's notation: `+` between parts, `Mod` is Cmd on macOS and Ctrl elsewhere. */
export function orcaChord(spec: string, platform: Platform): string {
  const parts = spec.split('+')
  // `Mod+Shift+Plus` names the key; a trailing empty part means the key was `+` itself.
  const key = parts.pop() || '+'
  const mods = new Set<string>()
  for (const p of parts.map((x) => x.toLowerCase())) {
    if (p === 'mod') mods.add(platform === 'darwin' ? 'meta' : 'ctrl')
    else if (p === 'cmd' || p === 'meta' || p === 'command') mods.add('meta')
    else if (p === 'ctrl' || p === 'control') mods.add('ctrl')
    else if (p === 'alt' || p === 'option') mods.add('alt')
    else if (p === 'shift') mods.add('shift')
  }
  return canonical(mods, key)
}

/** CodeMirror's notation: `-` between parts (`Mod-Alt-[`, `Shift-Mod-k`, `Ctrl--`). */
export function codemirrorChord(spec: string, platform: Platform): string {
  const parts = spec.split(/-(?!$)/)
  const key = parts.pop()!
  const mods = new Set<string>()
  for (const p of parts.map((x) => x.toLowerCase())) {
    if (p === 'mod') mods.add(platform === 'darwin' ? 'meta' : 'ctrl')
    else if (p === 'cmd' || p === 'meta' || p === 'm') mods.add('meta')
    else if (p === 'ctrl' || p === 'control' || p === 'c') mods.add('ctrl')
    else if (p === 'alt' || p === 'a') mods.add('alt')
    else if (p === 'shift' || p === 's') mods.add('shift')
  }
  return canonical(mods, key)
}

const reservedCache = new Map<Platform, Set<string>>()

/** Orca's default global and tab shortcuts on a platform, in canonical form. */
export function reservedChords(platform: Platform): Set<string> {
  let set = reservedCache.get(platform)
  if (!set) {
    set = new Set(ORCA_RESERVED_KEYS[platform].map((k) => orcaChord(k, platform)))
    reservedCache.set(platform, set)
  }
  return set
}

/** Whether a CodeMirror key is one of Orca's on that platform. */
export function codemirrorClashes(spec: string, platform: Platform): boolean {
  return reservedChords(platform).has(codemirrorChord(spec, platform))
}

/** Whether an Orca-notation chord (the manifest's) is one of Orca's own on that platform. */
export function orcaClashes(spec: string, platform: Platform): boolean {
  return reservedChords(platform).has(orcaChord(spec, platform))
}

type CmBinding = { key?: string; mac?: string; win?: string; linux?: string }

/** The key CodeMirror uses for a binding on a platform: the platform's own, else `key`. */
export function effectiveKey(b: CmBinding, platform: Platform): string | undefined {
  return (platform === 'darwin' ? b.mac : platform === 'win32' ? b.win : b.linux) ?? b.key
}

/** CodeMirror bindings without the ones whose key Orca uses on this platform. */
export function withoutOrcaKeys<T extends CmBinding>(bindings: readonly T[], platform: Platform): T[] {
  return bindings.filter((b) => {
    const key = effectiveKey(b, platform)
    return !key || !codemirrorClashes(key, platform)
  })
}

/** The platform an editor frame runs on, as CodeMirror itself decides it. */
export function framePlatform(nav: { platform?: string; userAgent?: string } | undefined): Platform {
  const p = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`
  if (/Mac|iPhone|iPad/.test(p)) return 'darwin'
  if (/Win/.test(p)) return 'win32'
  return 'linux'
}
