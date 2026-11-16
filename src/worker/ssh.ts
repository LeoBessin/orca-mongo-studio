// SSH tunnels: one SSH session per connection, and a local 127.0.0.1 listener per target host whose
// sockets are piped through `forwardOut`. Host keys are trusted on first use and pinned after.
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { Client, type ConnectConfig } from 'ssh2'
import type { HostPort } from '../shared/model'

export class HostKeyMismatchError extends Error {
  override name = 'HostKeyMismatchError'
  constructor(readonly expected: string, readonly actual: string) {
    super(`The SSH host key changed: expected ${expected}, got ${actual}.`)
  }
}

export type TunnelConfig = {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  /** Pinned SHA-256 (hex) of the host key; empty trusts the first one seen. */
  knownHostKey: string
  readyTimeoutMs?: number
}

export type Tunnel = {
  /** Local stand-ins for `targets`, in the same order. */
  local: HostPort[]
  hostKey: string
  close(): Promise<void>
}

export async function openTunnel(config: TunnelConfig, targets: readonly HostPort[]): Promise<Tunnel> {
  const ssh = new Client()
  let seenKey = ''
  const connectConfig: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: config.readyTimeoutMs ?? 15000,
    keepaliveInterval: 15000,
    hostHash: 'sha256',
    hostVerifier: (key: string | Buffer) => {
      seenKey = typeof key === 'string' ? key : key.toString('hex')
      return !config.knownHostKey || config.knownHostKey === seenKey
    }
  }
  if (config.password !== undefined) connectConfig.password = config.password
  if (config.privateKey !== undefined) connectConfig.privateKey = config.privateKey
  if (config.passphrase !== undefined) connectConfig.passphrase = config.passphrase

  await new Promise<void>((resolve, reject) => {
    ssh.once('ready', () => resolve())
    ssh.once('error', (error: Error) => {
      if (config.knownHostKey && seenKey && seenKey !== config.knownHostKey) {
        reject(new HostKeyMismatchError(config.knownHostKey, seenKey))
      } else reject(error)
    })
    ssh.connect(connectConfig)
  })

  const servers: Server[] = []
  const sockets = new Set<Socket>()
  const closeAll = async (): Promise<void> => {
    // server.close() waits for open sockets, so end them first or closing can hang.
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
    ssh.end()
  }
  try {
    const local: HostPort[] = []
    for (const target of targets) {
      const server = createServer((socket) => {
        // A refused forward or a dropped client must not become an unhandled error: it would
        // take the whole worker down. The driver sees the closed socket and reports it.
        socket.on('error', () => undefined)
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
        ssh.forwardOut('127.0.0.1', socket.localPort ?? 0, target.host, target.port ?? 27017, (error, stream) => {
          if (error) {
            socket.destroy()
            return
          }
          socket.pipe(stream).pipe(socket)
          socket.on('error', () => stream.close())
          socket.on('close', () => stream.close())
          stream.on('error', () => socket.destroy())
        })
      })
      servers.push(server)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
      })
      local.push({ host: '127.0.0.1', port: (server.address() as AddressInfo).port })
    }
    ssh.on('error', () => void closeAll())
    return { local, hostKey: seenKey, close: closeAll }
  } catch (error) {
    await closeAll()
    throw error
  }
}

/** `ab12cd…` as `SHA256 ab:12:cd…`, for showing a host key. */
export function formatHostKey(hex: string): string {
  return hex ? `SHA256 ${hex.match(/.{1,2}/g)?.join(':') ?? hex}` : ''
}
