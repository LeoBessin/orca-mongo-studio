// Keyboard chords in both notations, and that the shell editor's own keys stay clear of Orca's.
import { assert, describe, test } from 'orca/testing'
import { codemirrorChord, codemirrorClashes, effectiveKey, framePlatform, orcaChord, orcaClashes, SHELL_EDITOR_KEYS, withoutOrcaKeys } from './keys'

describe('chords', () => {
  test('both notations read to the same form', () => {
    assert.equal(orcaChord('Mod+Shift+BracketLeft', 'linux'), 'ctrl+shift+bracketleft')
    assert.equal(codemirrorChord('Shift-Mod-[', 'linux'), 'ctrl+shift+bracketleft')
    assert.equal(orcaChord('Mod+Shift+BracketLeft', 'darwin'), 'meta+shift+bracketleft')
    assert.equal(codemirrorChord('Cmd-Alt-[', 'darwin'), 'alt+meta+bracketleft')
    assert.equal(codemirrorChord('Ctrl--', 'linux'), 'ctrl+minus')
    assert.equal(codemirrorChord('Shift-Mod-k', 'win32'), 'ctrl+shift+k')
    assert.equal(orcaChord('Mod+Equal', 'linux'), 'ctrl+equal')
    assert.equal(orcaChord('Ctrl+Tab', 'darwin'), 'ctrl+tab')
  })

  test('Orca\'s own chords are known per platform', () => {
    assert.ok(orcaClashes('Mod+P', 'linux'))
    assert.ok(orcaClashes('Mod+Shift+BracketRight', 'darwin'))
    assert.ok(codemirrorClashes('Ctrl-Shift-[', 'linux'), 'CodeMirror\'s fold key switches Orca\'s tabs')
    assert.ok(codemirrorClashes('Cmd-Alt-[', 'darwin'))
    assert.equal(codemirrorClashes('Mod-f', 'linux'), false, 'Find is the editor\'s own')
  })

  test('the shell editor\'s keys and the manifest\'s are clear of Orca\'s on every platform', () => {
    for (const p of ['darwin', 'linux', 'win32'] as const) {
      for (const key of Object.values(SHELL_EDITOR_KEYS)) assert.equal(codemirrorClashes(key, p), false, `${key} on ${p}`)
      for (const key of ['Mod+Alt+Shift+T', 'Mod+Alt+Shift+R']) assert.equal(orcaClashes(key, p), false, `${key} on ${p}`)
    }
  })

  test('CodeMirror bindings lose only the clashing ones, per platform', () => {
    const fold = { key: 'Ctrl-Shift-[', mac: 'Cmd-Alt-[' }
    const find = { key: 'Mod-f' }
    const macOnly = { key: 'Alt-l', mac: 'Ctrl-l' }
    assert.equal(effectiveKey(fold, 'darwin'), 'Cmd-Alt-[')
    assert.equal(effectiveKey(fold, 'linux'), 'Ctrl-Shift-[')
    assert.deepEqual(withoutOrcaKeys([fold, find, macOnly], 'linux'), [find, macOnly])
    assert.deepEqual(withoutOrcaKeys([fold, find, macOnly], 'darwin'), [find, macOnly])
    assert.equal(framePlatform({ platform: 'MacIntel' }), 'darwin')
    assert.equal(framePlatform({ platform: 'Win32' }), 'win32')
    assert.equal(framePlatform({ platform: 'Linux x86_64' }), 'linux')
  })
})
