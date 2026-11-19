// The system clipboard for "Copy as JSON": which tool runs where, how a tool is run, and what
// happens when none is installed. Tools are faked, or played by Node itself, so these tests never
// touch the real clipboard.
import { assert, describe, test } from 'orca/testing'
import { clipboardTools, runTool, sessionEnv, writeClipboard, type ClipboardTool, type ListDir } from './clipboard'

const names = (tools: ClipboardTool[]): string[] => tools.map((t) => t.command)
const none: ListDir = () => []
/** A session's sockets, as the runtime directory and /tmp/.X11-unix list them. */
const sockets = (dirs: Record<string, string[]>): ListDir => (dir) => dirs[dir] ?? []

describe('clipboardTools', () => {
  test('macOS and Windows have one tool each', () => {
    assert.deepEqual(names(clipboardTools('darwin', {})), ['pbcopy'])
    assert.deepEqual(clipboardTools('darwin', {})[0]!.env, { LC_CTYPE: 'UTF-8' }, 'pbcopy reads UTF-8 even without a locale')
    assert.deepEqual(names(clipboardTools('win32', {})), ['powershell.exe'])
  })

  test('Linux tries Wayland first in a Wayland session, X11 first in an X11 one', () => {
    assert.deepEqual(names(clipboardTools('linux', { WAYLAND_DISPLAY: 'wayland-1' }, none)), ['wl-copy', 'xclip', 'xsel'])
    assert.deepEqual(names(clipboardTools('linux', { DISPLAY: ':0' }, none)), ['xclip', 'xsel', 'wl-copy'])
  })

  test('each tool is told the session, found from its sockets when the worker was not', () => {
    const tools = clipboardTools('linux', { XDG_RUNTIME_DIR: '/run/user/1000' }, sockets({ '/run/user/1000': ['wayland-1', 'wayland-1.lock'], '/tmp/.X11-unix': ['X1'] }))
    assert.deepEqual(tools.map((t) => [t.command, t.env]), [
      ['wl-copy', { WAYLAND_DISPLAY: 'wayland-1' }],
      ['xclip', { DISPLAY: ':1' }],
      ['xsel', { DISPLAY: ':1' }]
    ])
  })
})

describe('sessionEnv', () => {
  test('keeps what is set', () => {
    assert.deepEqual(sessionEnv({ WAYLAND_DISPLAY: 'wayland-3', DISPLAY: ':2', XDG_RUNTIME_DIR: '/r' }, sockets({ '/r': ['wayland-0'] })), { WAYLAND_DISPLAY: 'wayland-3', DISPLAY: ':2' })
  })

  test('finds the lowest-numbered Wayland and X sockets, ignoring locks and other files', () => {
    const list = sockets({ '/r': ['wayland-1.lock', 'niri.wayland-1.2954.sock', 'wayland-10', 'wayland-1', 'wayland-1-awww-daemon.sock'], '/tmp/.X11-unix': ['X11', 'X1'] })
    assert.deepEqual(sessionEnv({ XDG_RUNTIME_DIR: '/r' }, list), { WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':1' })
  })

  test('nothing to find, nothing set', () => {
    assert.deepEqual(sessionEnv({}, none), {})
  })
})

describe('writeClipboard', () => {
  test('uses the first tool that is installed, with the text', async () => {
    const tried: [string, string][] = []
    const run = async (tool: ClipboardTool, text: string): Promise<'ok' | 'missing'> => {
      tried.push([tool.command, text])
      return tool.command === 'xclip' ? 'ok' : 'missing'
    }
    await writeClipboard('{ "a": 1 }', 'linux', { WAYLAND_DISPLAY: 'w' }, run, none)
    assert.deepEqual(tried, [['wl-copy', '{ "a": 1 }'], ['xclip', '{ "a": 1 }']])
  })

  test('a tool that fails gives way to the next', async () => {
    const run = async (tool: ClipboardTool): Promise<'ok' | 'missing'> => {
      if (tool.command === 'wl-copy') throw new Error('wl-copy could not copy: Failed to connect to a Wayland server')
      return 'ok'
    }
    await writeClipboard('x', 'linux', { WAYLAND_DISPLAY: 'w' }, run, none)
  })

  test('when every tool fails, the first failure is the error', async () => {
    const run = async (tool: ClipboardTool): Promise<'ok' | 'missing'> => {
      if (tool.command === 'wl-copy') throw new Error('wl-copy could not copy: Failed to connect to a Wayland server')
      return 'missing'
    }
    await assert.rejects(writeClipboard('x', 'linux', {}, run, none), /Failed to connect to a Wayland server/)
  })

  test('says what to install when no tool is there', async () => {
    await assert.rejects(writeClipboard('x', 'linux', {}, async () => 'missing', none), /Install wl-clipboard \(Wayland\) or xclip \(X11\)/)
  })

  test('a tool that fails is reported', async () => {
    await assert.rejects(writeClipboard('x', 'darwin', {}, async () => { throw new Error('pbcopy could not copy') }, none), /pbcopy could not copy/)
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
