// Turns a ConnectionDef plus its secrets into a connected MongoClient, through an SSH tunnel when
// one is set. Credentials go in the options object, never in the URI string, and PEM files are
// read here so a missing file gets a clear error instead of a driver-level one.
import { promises as dns } from 'node:dns'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { MongoClient, type AuthMechanismProperties, type MongoClientOptions } from 'mongodb'
import { cloneDef, type ConnectionDef, type HostPort, type PemSource, type SecretKey } from '../shared/model'
import { buildConnectionString } from '../shared/uri'
import { humanCallback } from './oidc'
import { openTunnel, type Tunnel, type TunnelConfig } from './ssh'

export type Secrets = Partial<Record<SecretKey, string>>

/** Hosts Atlas and local servers use, plus the connection's own, for OIDC browser sign-in. */
const OIDC_DEFAULT_ALLOWED = ['*.mongodb.net', '*.mongodb-qa.net', '*.mongodb-dev.net', '*.mongodbgov.net', 'localhost', '127.0.0.1', '::1']

/** `~` and `~/x` mean the home folder, as people type them. */
export function expandPath(path: string): string {
  const p = path.trim()
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

export async function readPem(source: PemSource, inline: string | undefined, what: string): Promise<string | undefined> {
  if (source.kind === 'none') return undefined
  if (source.kind === 'inline') {
    if (!inline) throw new Error(`The ${what} is set to pasted text, but none is saved.`)
    return inline
  }
  const path = expandPath(source.path)
  if (!isAbsolute(path)) {
    throw new Error(`The ${what} path "${source.path}" is relative. Use a full path, such as ~/certs/ca.pem.`)
  }
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    const e = error as NodeJS.ErrnoException
    const wrapped = new Error(`Can't read the ${what} at ${source.path}: ${e.code ?? e.message}`)
    ;(wrapped as Error & { cause?: unknown }).cause = error
    throw wrapped
  }
}

export async function sshConfig(def: ConnectionDef, secrets: Secrets): Promise<TunnelConfig> {
  const s = def.ssh
  const config: TunnelConfig = { host: s.host, port: s.port, username: s.username, knownHostKey: s.knownHostKey }
  if (s.method === 'password') {
    if (secrets.sshPassword === undefined) throw new Error('The SSH password is not saved. Enter it in the connection settings.')
    config.password = secrets.sshPassword
  } else {
    const key = await readPem(s.privateKey, secrets.sshPrivateKey, 'SSH private key')
    if (key !== undefined) config.privateKey = key
    if (secrets.sshPassphrase !== undefined) config.passphrase = secrets.sshPassphrase
  }
  return config
}

/** The hosts behind a mongodb+srv name, and the options its TXT record adds. */
export async function resolveSrvSeed(host: string): Promise<{ hosts: HostPort[]; txt: string }> {
  const records = await dns.resolveSrv(`_mongodb._tcp.${host}`)
  let txt = ''
  try {
    txt = (await dns.resolveTxt(host)).map((chunks) => chunks.join('')).join('&')
  } catch {
    // TXT is optional.
  }
  return { hosts: records.map((r) => ({ host: r.name, port: r.port })), txt }
}

export type OpenOptions = {
  /** Shows the OIDC sign-in page; without it, browser sign-in fails with a clear message. */
  onOidcSignIn?: (url: string) => void
  /** Used when the definition sets none. */
  serverSelectionTimeoutMS?: number
  /** Connect without credentials (the handshake step of a connection test). */
  withoutAuth?: boolean
  /** Reuse an open tunnel instead of starting one. */
  tunnel?: Tunnel
}

export type DriverConfig = { uri: string; options: MongoClientOptions; tunnel?: Tunnel; ownsTunnel: boolean }

/** Builds the URI and options; opens the SSH tunnel when needed (the caller closes it). */
export async function driverConfig(source: ConnectionDef, secrets: Secrets, open: OpenOptions = {}): Promise<DriverConfig> {
  const def = cloneDef(source)
  const a = def.auth
  let tunnel = open.tunnel
  let ownsTunnel = false
  let tunneledHost: string | undefined

  if (def.ssh.enabled) {
    let targets = def.hosts
    if (def.topology === 'srv') {
      const seed = await resolveSrvSeed(def.hosts[0]?.host ?? '')
      targets = seed.hosts
      for (const pair of seed.txt.split('&')) {
        const [k, v] = pair.split('=')
        if (k === 'replicaSet' && v && !def.replicaSet) def.replicaSet = v
        if (k === 'authSource' && v && !a.authSource) a.authSource = v
      }
    }
    // Through SSH the driver can't reach the other members it discovers, so it talks to the first
    // host directly. Reads still follow the read preference that host can serve.
    const first = targets[0]
    if (!first) throw new Error('There is no host to tunnel to.')
    if (!tunnel) {
      tunnel = await openTunnel(await sshConfig(def, secrets), [first])
      ownsTunnel = true
    }
    tunneledHost = first.host
    def.hosts = tunnel.local
    def.topology = 'standalone'
    def.replicaSet = ''
    def.options.directConnection = true
  }

  const options: MongoClientOptions = {}
  if (def.options.serverSelectionTimeoutMS === null) options.serverSelectionTimeoutMS = open.serverSelectionTimeoutMS ?? 10000

  if (def.tls.enabled) {
    const ca = await readPem(def.tls.ca, secrets.tlsCaPem, 'CA certificate')
    const cert = await readPem(def.tls.clientCert, secrets.tlsCertPem, 'client certificate')
    if (ca !== undefined) options.ca = ca
    if (cert !== undefined) {
      options.cert = cert
      options.key = cert
    }
    if (secrets.tlsKeyPassword !== undefined) options.passphrase = secrets.tlsKeyPassword
    if (tunneledHost && !def.tls.allowInvalidHostnames) {
      const realHost = tunneledHost
      options.servername = realHost
      options.checkServerIdentity = (_host: string, cert: PeerCertificate) => checkServerIdentity(realHost, cert)
    }
  }
  // Paths were read above, so the URI carries no file names.
  def.tls.ca = { kind: 'none' }
  def.tls.clientCert = { kind: 'none' }

  const properties: AuthMechanismProperties = {}
  const mechanism = open.withoutAuth ? 'none' : a.mechanism
  switch (mechanism) {
    case 'DEFAULT':
    case 'SCRAM-SHA-256':
    case 'SCRAM-SHA-1':
    case 'PLAIN':
      options.auth = { username: a.username, password: secrets.password ?? '' }
      break
    case 'MONGODB-X509':
      // Mechanisms without a password take the user name from the URI (see below): the
      // driver's `auth` option requires a password.
      break
    case 'MONGODB-AWS':
      if (a.awsSource === 'keys') {
        const accessKeyId = a.username
        const secretAccessKey = secrets.awsSecretAccessKey ?? ''
        const sessionToken = secrets.awsSessionToken
        properties.AWS_CREDENTIAL_PROVIDER = async () =>
          sessionToken ? { accessKeyId, secretAccessKey, sessionToken } : { accessKeyId, secretAccessKey }
      }
      break
    case 'MONGODB-OIDC':
      if (a.oidcFlow === 'browser') {
        const show = open.onOidcSignIn
        if (!show) throw new Error('OIDC browser sign-in needs the Mongo Studio panel open to show the sign-in link.')
        properties.OIDC_HUMAN_CALLBACK = humanCallback({ redirectPort: a.oidcRedirectPort, showSignIn: show })
        properties.ALLOWED_HOSTS = [...OIDC_DEFAULT_ALLOWED, ...source.hosts.map((h) => h.host)]
      }
      break
    case 'GSSAPI':
      // The `kerberos` addon uses this computer's ticket cache (kinit); the URI carries the
      // principal, service name, realm and host name canonicalization.
      break
    case 'none':
      break
  }
  if (Object.keys(properties).length > 0) options.authMechanismProperties = properties

  const uriDef = cloneDef(def)
  // Passwords go in `options.auth`, never in the string; so does their user name.
  if (options.auth) uriDef.auth.username = ''
  if (mechanism === 'none') uriDef.auth.mechanism = 'none'
  const uri = buildConnectionString(uriDef)
  const config: DriverConfig = { uri, options, ownsTunnel }
  if (tunnel) config.tunnel = tunnel
  return config
}

export type OpenClient = { client: MongoClient; tunnel?: Tunnel; close(): Promise<void> }

export async function openClient(def: ConnectionDef, secrets: Secrets, open: OpenOptions = {}): Promise<OpenClient> {
  const config = await driverConfig(def, secrets, open)
  const client = new MongoClient(config.uri, config.options)
  const close = async (): Promise<void> => {
    await client.close().catch(() => undefined)
    if (config.ownsTunnel) await config.tunnel?.close()
  }
  try {
    await client.connect()
  } catch (error) {
    await close()
    throw error
  }
  const result: OpenClient = { client, close }
  if (config.tunnel) result.tunnel = config.tunnel
  return result
}

/** Open clients by connection id; connects lazily and only once at a time per id. */
export class ClientPool {
  private readonly entries = new Map<string, Promise<OpenClient>>()

  constructor(
    private readonly load: (id: string) => Promise<{ def: ConnectionDef; secrets: Secrets } | undefined>,
    private readonly hooks: {
      onChange: (id: string) => void
      onOidcSignIn: (id: string, name: string, url: string) => void
      /** First SSH connect with no pinned key: the key seen, to pin it. */
      onFirstHostKey: (id: string, hostKey: string) => Promise<void>
    }
  ) {}

  isOpen(id: string): boolean {
    return this.entries.has(id)
  }

  get(id: string): Promise<MongoClient> {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = (async () => {
        const loaded = await this.load(id)
        if (!loaded) throw new Error('This connection no longer exists.')
        const open = await openClient(loaded.def, loaded.secrets, {
          onOidcSignIn: (url) => this.hooks.onOidcSignIn(id, loaded.def.name, url)
        })
        if (loaded.def.ssh.enabled && !loaded.def.ssh.knownHostKey && open.tunnel?.hostKey) {
          await this.hooks.onFirstHostKey(id, open.tunnel.hostKey)
        }
        return open
      })()
      this.entries.set(id, entry)
      entry.then(
        () => this.hooks.onChange(id),
        () => {
          this.entries.delete(id)
          this.hooks.onChange(id)
        }
      )
    }
    return entry.then((open) => open.client)
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    await entry.then((open) => open.close(), () => undefined)
    this.hooks.onChange(id)
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.disconnect(id)))
  }
}
