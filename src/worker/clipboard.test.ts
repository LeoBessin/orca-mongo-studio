// The system clipboard for "Copy as JSON": which tool runs where, and what happens when none is
// installed. The runner is faked, so these tests never touch the real clipboard.
import { assert, describe, test } from 'orca/testing'
import { clipboardTools, writeClipboard, type ClipboardTool } from './clipboard'

const names = (tools: ClipboardTool[]): string[] => tools.map((t) => t.command)

describe('clipboardTools', () => {
  test('macOS and Windows have one tool each', () => {
    assert.deepEqual(names(clipboardTools('darwin', {})), ['pbcopy'])
    assert.deepEqual(names(clipboardTools('win32', {})), ['powershell.exe'])
  })

  test('Linux tries Wayland first in a Wayland session, X11 first in an X11 one', () => {
    assert.deepEqual(names(clipboardTools('linux', { WAYLAND_DISPLAY: 'wayland-1' })), ['wl-copy', 'xclip', 'xsel'])
    assert.deepEqual(names(clipboardTools('linux', { DISPLAY: ':0' })), ['xclip', 'xsel', 'wl-copy'])
  })
})

describe('writeClipboard', () => {
  test('uses the first tool that is installed, with the text', async () => {
    const tried: [string, string][] = []
    await writeClipboard('{ "a": 1 }', 'linux', { WAYLAND_DISPLAY: 'w' }, async (tool, text) => {
      tried.push([tool.command, text])
      return tool.command === 'xclip' ? 'ok' : 'missing'
    })
    assert.deepEqual(tried, [['wl-copy', '{ "a": 1 }'], ['xclip', '{ "a": 1 }']])
  })

  test('says what to install when no tool is there', async () => {
    await assert.rejects(writeClipboard('x', 'linux', {}, async () => 'missing'), /Install wl-clipboard \(Wayland\) or xclip \(X11\)/)
  })

  test('a tool that fails is reported, not skipped', async () => {
    await assert.rejects(writeClipboard('x', 'darwin', {}, async () => { throw new Error('pbcopy could not copy') }), /pbcopy could not copy/)
  })
})
