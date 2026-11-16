// Connection strings <-> ConnectionDef. Form mode and URI mode edit the same model, so the URI is
// always derived from it; options this file does not model are kept verbatim in `options.extra`.
import {
  DEFAULT_PORT,
  emptyConnection,
  type AuthMechanism,
  type ConnectionDef,
  type HostPort,
  type ReadPreferenceMode,
  type SecretDraft
} from './model'

export class ConnectionStringError extends Error {
  override name = 'ConnectionStringError'
}

export type ParsedConnection = {
  def: ConnectionDef
  /** Secrets that were in the string (password, key password): saved apart from the def. */
  secrets: SecretDraft
  warnings: string[]
}

const MECHANISMS: readonly AuthMechanism[] = [
  'DEFAULT',
  'SCRAM-SHA-256',
  'SCRAM-SHA-1',
  'MONGODB-X509',
  'PLAIN',
  'GSSAPI',
  'MONGODB-AWS',
  'MONGODB-OIDC'
]
const READ_PREFERENCES: readonly ReadPreferenceMode[] = [
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest'
]

function decode(part: string, what: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    throw new ConnectionStringError(`The ${what} has a broken %-escape: "${part}".`)
  }
}

function parseBool(value: string, key: string, warnings: string[]): boolean {
  const v = value.toLowerCase()
  if (v === 'true') return true
  if (v === 'false') return false
  warnings.push(`${key}=${value} is not true or false; treated as false.`)
  return false
}

function parseMs(value: string, key: string, warnings: string[]): number | null {
  const n = Number(value)
  if (Number.isInteger(n) && n >= 0) return n
  warnings.push(`${key}=${value} is not a whole number of milliseconds; ignored.`)
  return null
}

function parseHost(raw: string, srv: boolean): HostPort {
  const text = decode(raw, 'host')
  if (!text) throw new ConnectionStringError('A host is empty (check for a stray comma).')
  let host = text
  let portText: string | undefined
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end < 0) throw new ConnectionStringError(`The IPv6 host "${text}" is missing "]".`)
    host = text.slice(1, end)
    const rest = text.slice(end + 1)
    if (rest.startsWith(':')) portText = rest.slice(1)
    else if (rest) throw new ConnectionStringError(`Unexpected "${rest}" after the IPv6 host.`)
  } else if (text.includes(':')) {
    const at = text.lastIndexOf(':')
    host = text.slice(0, at)
    portText = text.slice(at + 1)
  }
  if (portText === undefined) return { host }
  if (srv) throw new ConnectionStringError('A mongodb+srv host must not have a port.')
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConnectionStringError(`The port "${portText}" must be a number from 1 to 65535.`)
  }
  return { host, port }
}

/** Splits `A:1,B:x:y` into pairs on each comma and the first colon. */
function parseProperties(value: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of value.split(',')) {
    if (!pair) continue
    const at = pair.indexOf(':')
    if (at < 0) out[pair] = ''
    else out[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return out
}

export function parseConnectionString(uri: string, id: string, now: number): ParsedConnection {
  const text = uri.trim()
  const warnings: string[] = []
  const secrets: SecretDraft = {}
  const match = /^(mongodb(?:\+srv)?):\/\/(.*)$/i.exec(text)
  if (!match) {
    throw new ConnectionStringError('A connection string starts with mongodb:// or mongodb+srv://.')
  }
  const srv = match[1]!.toLowerCase() === 'mongodb+srv'
  let rest = match[2]!
  const def = emptyConnection(id, now)

  // Authority ends at the first "/" or "?"; user info ends at the last "@" inside it.
  const authorityEnd = rest.search(/[/?]/)
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd)
  rest = authorityEnd < 0 ? '' : rest.slice(authorityEnd)
  const at = authority.lastIndexOf('@')
  const userInfo = at >= 0 ? authority.slice(0, at) : ''
  const hostList = at >= 0 ? authority.slice(at + 1) : authority
  if (!hostList) throw new ConnectionStringError('The connection string has no host.')
  def.hosts = hostList.split(',').map((h) => parseHost(h, srv))
  if (srv && def.hosts.length !== 1) {
    throw new ConnectionStringError('A mongodb+srv connection string takes exactly one host name.')
  }

  let username = ''
  let password: string | undefined
  if (userInfo) {
    const colon = userInfo.indexOf(':')
    username = decode(colon < 0 ? userInfo : userInfo.slice(0, colon), 'user name')
    if (colon >= 0) password = decode(userInfo.slice(colon + 1), 'password')
  }

  let path = rest
  let query = ''
  const q = rest.indexOf('?')
  if (q >= 0) {
    path = rest.slice(0, q)
    query = rest.slice(q + 1)
  }
  const db = decode(path.replace(/^\//, ''), 'database name')
  def.options.defaultDatabase = db

  const extra: string[] = []
  let mechanism: AuthMechanism | undefined
  let tls: boolean | undefined
  let props: Record<string, string> = {}
  def.options.appName = ''
  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const rawKey = eq < 0 ? pair : pair.slice(0, eq)
    const rawValue = eq < 0 ? '' : pair.slice(eq + 1)
    const key = decode(rawKey, 'option name')
    const value = decode(rawValue, `${key} value`)
    switch (key.toLowerCase()) {
      case 'replicaset':
        def.replicaSet = value
        break
      case 'authsource':
        def.auth.authSource = value
        break
      case 'authmechanism': {
        const found = MECHANISMS.find((m) => m.toLowerCase() === value.toLowerCase())
        if (found) mechanism = found
        else throw new ConnectionStringError(`Unknown authMechanism "${value}".`)
        break
      }
      case 'authmechanismproperties':
        props = { ...props, ...parseProperties(value) }
        break
      case 'tls':
      case 'ssl':
        tls = parseBool(value, key, warnings)
        break
      case 'tlscafile':
        def.tls.ca = { kind: 'path', path: value }
        break
      case 'tlscertificatekeyfile':
        def.tls.clientCert = { kind: 'path', path: value }
        break
      case 'tlscertificatekeyfilepassword':
        secrets.tlsKeyPassword = value
        break
      case 'tlsallowinvalidhostnames':
        def.tls.allowInvalidHostnames = parseBool(value, key, warnings)
        break
      case 'tlsallowinvalidcertificates':
        def.tls.allowInvalidCertificates = parseBool(value, key, warnings)
        break
      case 'tlsinsecure':
        if (parseBool(value, key, warnings)) {
          def.tls.allowInvalidHostnames = true
          def.tls.allowInvalidCertificates = true
        }
        break
      case 'readpreference': {
        const found = READ_PREFERENCES.find((m) => m.toLowerCase() === value.toLowerCase())
        if (found) def.options.readPreference = found
        else warnings.push(`Unknown readPreference "${value}"; using primary.`)
        break
      }
      case 'appname':
        def.options.appName = value
        break
      case 'connecttimeoutms':
        def.options.connectTimeoutMS = parseMs(value, key, warnings)
        break
      case 'serverselectiontimeoutms':
        def.options.serverSelectionTimeoutMS = parseMs(value, key, warnings)
        break
      case 'sockettimeoutms':
        def.options.socketTimeoutMS = parseMs(value, key, warnings)
        break
      case 'directconnection':
        def.options.directConnection = parseBool(value, key, warnings)
        break
      default:
        extra.push(eq < 0 ? rawKey : `${rawKey}=${rawValue}`)
    }
  }
  def.options.extra = extra.join('&')

  def.topology = srv ? 'srv' : def.replicaSet ? 'replicaSet' : def.hosts.length > 1 ? 'sharded' : 'standalone'
  def.tls.enabled = tls ?? (srv || def.tls.ca.kind !== 'none' || def.tls.clientCert.kind !== 'none')
  if (srv && tls === false) warnings.push('tls=false on a mongodb+srv string turns off TLS, which Atlas refuses.')

  const auth = def.auth
  auth.mechanism = mechanism ?? (username ? 'DEFAULT' : 'none')
  auth.username = username
  if (auth.mechanism === 'MONGODB-AWS') {
    auth.awsSource = username ? 'keys' : 'environment'
    if (password !== undefined) secrets.awsSecretAccessKey = password
    if (props.AWS_SESSION_TOKEN) secrets.awsSessionToken = props.AWS_SESSION_TOKEN
  } else if (password !== undefined) {
    secrets.password = password
  }
  if (auth.mechanism === 'MONGODB-OIDC') {
    const env = props.ENVIRONMENT
    if (env === 'azure' || env === 'gcp' || env === 'k8s') auth.oidcFlow = env
    else if (env) warnings.push(`OIDC ENVIRONMENT "${env}" is not supported; using browser sign-in.`)
    auth.oidcTokenResource = props.TOKEN_RESOURCE ?? ''
  }
  if (auth.mechanism === 'GSSAPI') {
    auth.gssapiServiceName = props.SERVICE_NAME ?? ''
    auth.gssapiServiceRealm = props.SERVICE_REALM ?? ''
    const c = props.CANONICALIZE_HOST_NAME
    auth.gssapiCanonicalizeHostName =
      c === 'forward' || c === 'true' ? 'forward' : c === 'forwardAndReverse' ? 'forwardAndReverse' : 'none'
  }
  if (password !== undefined && !username) warnings.push('The string has a password but no user name.')
  return { def, secrets, warnings }
}

export type BuildOptions = {
  /** Put this password in the string (the worker never does; display and export only). */
  password?: string
  /** Show `****` where a saved password goes. */
  maskPassword?: boolean
}

function formatHost(h: HostPort): string {
  const host = h.host.includes(':') ? `[${h.host}]` : h.host
  return h.port !== undefined ? `${host}:${h.port}` : host
}

const enc = encodeURIComponent

export function buildConnectionString(def: ConnectionDef, options: BuildOptions = {}): string {
  const srv = def.topology === 'srv'
  const a = def.auth
  const params: string[] = []
  const add = (key: string, value: string | number | boolean): void => {
    params.push(`${key}=${enc(String(value))}`)
  }

  let userInfo = ''
  const sendsUser = a.mechanism !== 'none' && !(a.mechanism === 'MONGODB-AWS') && a.username !== ''
  if (sendsUser) {
    userInfo = enc(a.username)
    if (options.password !== undefined) userInfo += `:${enc(options.password)}`
    else if (options.maskPassword) userInfo += ':****'
    userInfo += '@'
  }
  const hosts = (srv ? def.hosts.slice(0, 1).map((h) => ({ host: h.host })) : def.hosts).map(formatHost)
  const db = def.options.defaultDatabase ? enc(def.options.defaultDatabase) : ''

  if (def.topology === 'replicaSet' && def.replicaSet) add('replicaSet', def.replicaSet)
  if (a.authSource && a.mechanism !== 'none') add('authSource', a.authSource)
  if (a.mechanism !== 'none' && a.mechanism !== 'DEFAULT') add('authMechanism', a.mechanism)
  const props: string[] = []
  if (a.mechanism === 'MONGODB-OIDC' && a.oidcFlow !== 'browser') {
    props.push(`ENVIRONMENT:${a.oidcFlow}`)
    if (a.oidcTokenResource) props.push(`TOKEN_RESOURCE:${a.oidcTokenResource}`)
  }
  if (a.mechanism === 'GSSAPI') {
    if (a.gssapiServiceName) props.push(`SERVICE_NAME:${a.gssapiServiceName}`)
    if (a.gssapiServiceRealm) props.push(`SERVICE_REALM:${a.gssapiServiceRealm}`)
    if (a.gssapiCanonicalizeHostName !== 'none') props.push(`CANONICALIZE_HOST_NAME:${a.gssapiCanonicalizeHostName}`)
  }
  if (props.length) add('authMechanismProperties', props.join(','))
  if (def.tls.enabled && !srv) add('tls', true)
  if (!def.tls.enabled && srv) add('tls', false)
  if (def.tls.enabled) {
    if (def.tls.ca.kind === 'path') add('tlsCAFile', def.tls.ca.path)
    if (def.tls.clientCert.kind === 'path') add('tlsCertificateKeyFile', def.tls.clientCert.path)
    if (def.tls.allowInvalidHostnames) add('tlsAllowInvalidHostnames', true)
    if (def.tls.allowInvalidCertificates) add('tlsAllowInvalidCertificates', true)
  }
  const o = def.options
  if (o.readPreference !== 'primary') add('readPreference', o.readPreference)
  if (o.appName) add('appName', o.appName)
  if (o.connectTimeoutMS !== null) add('connectTimeoutMS', o.connectTimeoutMS)
  if (o.serverSelectionTimeoutMS !== null) add('serverSelectionTimeoutMS', o.serverSelectionTimeoutMS)
  if (o.socketTimeoutMS !== null) add('socketTimeoutMS', o.socketTimeoutMS)
  if (o.directConnection) add('directConnection', true)
  if (o.extra) params.push(o.extra.replace(/^[?&]+/, ''))

  const query = params.length ? `?${params.join('&')}` : ''
  const path = db || query ? `/${db}` : ''
  return `${srv ? 'mongodb+srv' : 'mongodb'}://${userInfo}${hosts.join(',')}${path}${query}`
}

/** A host as people write it: with the port only when it isn't 27017. */
export function hostLabel(h: HostPort): string {
  return h.port !== undefined && h.port !== DEFAULT_PORT ? `${h.host}:${h.port}` : h.host
}
