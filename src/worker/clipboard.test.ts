// The system clipboard for "Copy as JSON": which tool runs where, how a tool is run, and what
// happens when none is installed. Tools are faked, or played by Node itself, so these tests never
// touch the real clipboard.
import { assert, describe, test } from 'orca/testing'
import { clipboardTools, runTool, writeClipboard, type ClipboardTool } from './clipboard'

const names = (tools: ClipboardTool[]): string[] => tools.map((t) => t.command)

describe('clipboardTools', () => {
  test('macOS and Windows have one tool each', () => {
    assert.deepEqual(names(clipboardTools('darwin', {})), ['pbcopy'])
    assert.deepEqual(clipboardTools('darwin', {})[0]!.env, { LC_CTYPE: 'UTF-8' }, 'pbcopy reads UTF-8 even without a locale')
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

describe('runTool', () => {
  // Node itself stands in for a clipboard tool, so these run on any machine.
  const node = (script: string): ClipboardTool => ({ command: process.execPath, args: ['-e', script] })

  test('a tool that reads its input and ends cleanly copies', async () => {
    assert.equal(await runTool(node('process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'), 'text'), 'ok')
  })

  test('a tool that is not installed is missing', async () => {
    assert.equal(await runTool({ command: 'mongo-studio-no-such-clipboard-tool', args: [] }, 'text'), 'missing')
  })

  test('a tool that fails reports what it wrote to standard error', async () => {
    await assert.rejects(runTool(node('process.stderr.write("Failed to connect to a Wayland server"); process.exit(1)'), 'text'), /Failed to connect to a Wayland server/)
  })

  test('the tool gets the environment it asks for', async () => {
    const tool = { ...node('process.exit(process.env.LC_CTYPE === "UTF-8" ? 0 : 3)'), env: { LC_CTYPE: 'UTF-8' } }
    assert.equal(await runTool(tool, ''), 'ok')
  })
})
