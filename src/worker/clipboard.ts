// The system clipboard, for "Copy as JSON". A components panel has no clipboard of its own, so the
// worker writes the text through the platform's clipboard tool: pbcopy on macOS, PowerShell's
// Set-Clipboard on Windows, and wl-copy, xclip or xsel on Linux (Wayland first when it runs).
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'

export type ClipboardTool = { command: string; args: string[]; env?: Record<string, string> }

/** How long a tool may take before it is stopped and the copy fails. */
export const TOOL_TIMEOUT_MS = 10_000
/** After a tool fails, how long to wait for the rest of its error output. */
const STDERR_GRACE_MS = 200

/** Lists a directory's entries, or none when it cannot be read. */
export type ListDir = (dir: string) => string[]
const listDir: ListDir = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** The display session the clipboard tools talk to. Orca starts a plugin's worker without
 *  WAYLAND_DISPLAY or DISPLAY, so wl-copy guessed wayland-0 and failed on a compositor that
 *  listens on wayland-1 (niri, for one). What is not set is found from the sockets the session
 *  leaves: wayland-N in XDG_RUNTIME_DIR, and XN in /tmp/.X11-unix for an X server. */
export function sessionEnv(env: NodeJS.ProcessEnv, list: ListDir = listDir): { WAYLAND_DISPLAY?: string; DISPLAY?: string } {
  const out: { WAYLAND_DISPLAY?: string; DISPLAY?: string } = {}
  const byNumber = (a: string, b: string): number => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''))
  if (env.WAYLAND_DISPLAY) out.WAYLAND_DISPLAY = env.WAYLAND_DISPLAY
  else if (env.XDG_RUNTIME_DIR) {
    const socket = list(env.XDG_RUNTIME_DIR).filter((name) => /^wayland-\d+$/.test(name)).sort(byNumber)[0]
    if (socket) out.WAYLAND_DISPLAY = socket
  }
  if (env.DISPLAY) out.DISPLAY = env.DISPLAY
  else {
    const x = list('/tmp/.X11-unix').filter((name) => /^X\d+$/.test(name)).sort(byNumber)[0]
    if (x) out.DISPLAY = `:${x.slice(1)}`
  }
  return out
}

/** The tools to try, in order, for this platform and session. */
export function clipboardTools(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, list: ListDir = listDir): ClipboardTool[] {
  // An app started from Finder or the Dock often has no locale set, and pbcopy then reads its
  // input as MacRoman, which turns UTF-8 text such as "café" into "cafÃ©".
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [], env: { LC_CTYPE: 'UTF-8' } }]
  if (platform === 'win32') {
    // clip.exe reads the console code page and mangles anything past ASCII; Set-Clipboard takes
    // the text as UTF-8 from standard input.
    return [{ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'] }]
  }
  const session = sessionEnv(env, list)
  const wayland: ClipboardTool = { command: 'wl-copy', args: [], ...(session.WAYLAND_DISPLAY ? { env: { WAYLAND_DISPLAY: session.WAYLAND_DISPLAY } } : {}) }
  const xEnv = session.DISPLAY ? { env: { DISPLAY: session.DISPLAY } } : {}
  const x11: ClipboardTool[] = [
    { command: 'xclip', args: ['-selection', 'clipboard'], ...xEnv },
    { command: 'xsel', args: ['--clipboard', '--input'], ...xEnv }
  ]
  return session.WAYLAND_DISPLAY || !session.DISPLAY ? [wayland, ...x11] : [...x11, wayland]
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
      // wl-copy and xclip leave a process serving the clipboard that holds the pipes open until
      // something else is copied: let go of them, so no pipe stays open for each copy.
      child.stdin.destroy()
      child.stderr.destroy()
      child.unref()
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

/** Puts the text on the system clipboard with the first tool that works. A tool that fails (wl-copy
 *  with no Wayland session, say) gives way to the next; when none works, the first failure is the
 *  error. */
export async function writeClipboard(text: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, run: Runner = runTool, list: ListDir = listDir): Promise<void> {
  const tools = clipboardTools(platform, env, list)
  let failure: unknown
  for (const tool of tools) {
    try {
      if ((await run(tool, text)) === 'ok') return
    } catch (error) {
      failure ??= error
    }
  }
  if (failure) throw failure
  throw new Error(
    platform === 'linux'
      ? 'No clipboard tool was found. Install wl-clipboard (Wayland) or xclip (X11), then copy again.'
      : `The clipboard tool (${tools.map((t) => t.command).join(', ')}) was not found.`
  )
}

/** What the worker's handlers write with. Tests replace `write` so they never touch the real
 *  clipboard. */
export const systemClipboard = { write: (text: string): Promise<void> => writeClipboard(text) }
