// The system clipboard, for "Copy as JSON". A components panel has no clipboard of its own, so the
// worker writes the text through the platform's clipboard tool: pbcopy on macOS, PowerShell's
// Set-Clipboard on Windows, and wl-copy, xclip or xsel on Linux (Wayland first when it runs).
import { spawn } from 'node:child_process'

export type ClipboardTool = { command: string; args: string[]; env?: Record<string, string> }

/** How long a tool may take before it is stopped and the copy fails. */
export const TOOL_TIMEOUT_MS = 10_000
/** After a tool fails, how long to wait for the rest of its error output. */
const STDERR_GRACE_MS = 200

/** The tools to try, in order, for this platform and session. */
export function clipboardTools(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ClipboardTool[] {
  // An app started from Finder or the Dock often has no locale set, and pbcopy then reads its
  // input as MacRoman, which turns UTF-8 text such as "café" into "cafÃ©".
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [], env: { LC_CTYPE: 'UTF-8' } }]
  if (platform === 'win32') {
    // clip.exe reads the console code page and mangles anything past ASCII; Set-Clipboard takes
    // the text as UTF-8 from standard input.
    return [{ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'] }]
  }
  const wayland = { command: 'wl-copy', args: [] }
  const x11 = [
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] }
  ]
  return env.WAYLAND_DISPLAY ? [wayland, ...x11] : env.DISPLAY ? [...x11, wayland] : [wayland, ...x11]
}

export type Runner = (tool: ClipboardTool, text: string) => Promise<'ok' | 'missing'>

/** Runs a tool with the text on its standard input: `missing` when it is not installed. */
export const runTool: Runner = (tool, text) =>
  new Promise((resolve, reject) => {
    const child = spawn(tool.command, tool.args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
      ...(tool.env ? { env: { ...process.env, ...tool.env } } : {})
    })
    let stderr = ''
    let stderrDone = false
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill()
      settle(() => reject(new Error(`${tool.command} did not finish copying within ${TOOL_TIMEOUT_MS / 1000} seconds.`)))
    }, TOOL_TIMEOUT_MS)
    const failure = (code: number | null): Error => new Error(`${tool.command} could not copy: ${stderr.trim() || `it ended with code ${code}`}`)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.stderr.on('end', () => (stderrDone = true))
    child.on('error', (error: NodeJS.ErrnoException) => settle(() => (error.code === 'ENOENT' ? resolve('missing') : reject(error))))
    // 'exit', not 'close': wl-copy and xclip leave a process serving the clipboard that keeps
    // standard error open after the command itself has ended. A failure waits briefly for the rest
    // of its message, which can arrive after the exit.
    child.on('exit', (code) => {
      if (code === 0) return settle(() => resolve('ok'))
      if (stderrDone) return settle(() => reject(failure(code)))
      const done = (): void => settle(() => reject(failure(code)))
      child.stderr.once('end', done)
      setTimeout(done, STDERR_GRACE_MS)
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(text, 'utf8')
  })

/** Puts the text on the system clipboard with the first tool that is installed. */
export async function writeClipboard(text: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, run: Runner = runTool): Promise<void> {
  const tools = clipboardTools(platform, env)
  for (const tool of tools) if ((await run(tool, text)) === 'ok') return
  throw new Error(
    platform === 'linux'
      ? 'No clipboard tool was found. Install wl-clipboard (Wayland) or xclip (X11), then copy again.'
      : `The clipboard tool (${tools.map((t) => t.command).join(', ')}) was not found.`
  )
}

/** What the worker's handlers write with. Tests replace `write` so they never touch the real
 *  clipboard. */
export const systemClipboard = { write: (text: string): Promise<void> => writeClipboard(text) }
