// The system clipboard, for "Copy as JSON". A components panel has no clipboard of its own, so the
// worker writes the text through the platform's clipboard tool: pbcopy on macOS, PowerShell's
// Set-Clipboard on Windows, and wl-copy, xclip or xsel on Linux (Wayland first when it runs).
import { spawn } from 'node:child_process'

export type ClipboardTool = { command: string; args: string[] }

/** The tools to try, in order, for this platform and session. */
export function clipboardTools(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ClipboardTool[] {
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }]
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
    const child = spawn(tool.command, tool.args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? resolve('missing') : reject(error)))
    // 'exit', not 'close': wl-copy and xclip leave a process serving the clipboard that keeps
    // standard error open after the command itself has ended.
    child.on('exit', (code) => (code === 0 ? resolve('ok') : reject(new Error(`${tool.command} could not copy: ${stderr.trim() || `it ended with code ${code}`}`))))
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
