// Connection definitions: the structured model both the form and the URI editor change. Pure
// TypeScript with no Node or Orca imports, so the panel, the worker and tests all share it.
// Secrets never live in a ConnectionDef: they sit in `secrets:own` under SECRET_KEYS.

export type Topology = 'standalone' | 'replicaSet' | 'sharded' | 'srv'

export type AuthMechanism =
  | 'none'
  | 'DEFAULT'
  | 'SCRAM-SHA-256'
  | 'SCRAM-SHA-1'
  | 'MONGODB-X509'
  | 'PLAIN'
  | 'GSSAPI'
  | 'MONGODB-AWS'
  | 'MONGODB-OIDC'

export type OidcFlow = 'browser' | 'azure' | 'gcp' | 'k8s'
export type AwsSource = 'environment' | 'keys'
export type ReadPreferenceMode =
  | 'primary'
  | 'primaryPreferred'
  | 'secondary'
  | 'secondaryPreferred'
  | 'nearest'

export type HostPort = { host: string; port?: number }

/** A PEM value is either a file the worker reads at connect time, or text kept in secrets. */
export type PemSource = { kind: 'none' } | { kind: 'path'; path: string } | { kind: 'inline' }

export type AuthSettings = {
  mechanism: AuthMechanism
  /** SCRAM/PLAIN user, X.509 subject (optional), AWS access key id for `keys`. */
  username: string
  authSource: string
  awsSource: AwsSource
  oidcFlow: OidcFlow
  /** Azure/GCP audience for OIDC. */
  oidcTokenResource: string
  /** Local port the browser sign-in redirects to. */
  oidcRedirectPort: number
  gssapiServiceName: string
  gssapiServiceRealm: string
  gssapiCanonicalizeHostName: 'none' | 'forward' | 'forwardAndReverse'
}

export type TlsSettings = {
  enabled: boolean
  ca: PemSource
  /** Client certificate and key, usually one PEM holding both. */
  clientCert: PemSource
  allowInvalidHostnames: boolean
  allowInvalidCertificates: boolean
}

export type SshSettings = {
  enabled: boolean
  host: string
  port: number
  username: string
  method: 'password' | 'privateKey'
  privateKey: PemSource
  /** SHA-256 of the server's host key, trusted on first connect. */
  knownHostKey: string
}

export type ConnectionOptions = {
  readPreference: ReadPreferenceMode
  appName: string
  defaultDatabase: string
  connectTimeoutMS: number | null
  serverSelectionTimeoutMS: number | null
  socketTimeoutMS: number | null
  directConnection: boolean
  /** Other URI options, `key=value&key=value`, passed through unchanged. */
  extra: string
}

export type ConnectionDef = {
  id: string
  name: string
  group: string
  topology: Topology
  /** One host for `standalone` and `srv` (no port for `srv`). */
  hosts: HostPort[]
  replicaSet: string
  auth: AuthSettings
  tls: TlsSettings
  ssh: SshSettings
  options: ConnectionOptions
  createdAt: number
  updatedAt: number
}

/** Every secret a connection can hold, by key suffix. */
export const SECRET_KEYS = [
  'password',
  'awsSecretAccessKey',
  'awsSessionToken',
  'tlsCaPem',
  'tlsCertPem',
  'tlsKeyPassword',
  'sshPassword',
  'sshPrivateKey',
  'sshPassphrase'
] as const
export type SecretKey = (typeof SECRET_KEYS)[number]
/** What the panel sends: a string sets it, `null` clears it, absent keeps the saved one. */
export type SecretDraft = Partial<Record<SecretKey, string | null>>
/** What the panel learns: only whether each secret is saved, never its value. */
export type SecretFlags = Partial<Record<SecretKey, boolean>>

export const DEFAULT_PORT = 27017

export function emptyConnection(id: string, now: number): ConnectionDef {
  return {
    id,
    name: '',
    group: '',
    topology: 'standalone',
    hosts: [{ host: 'localhost', port: DEFAULT_PORT }],
    replicaSet: '',
    auth: {
      mechanism: 'none',
      username: '',
      authSource: '',
      awsSource: 'environment',
      oidcFlow: 'browser',
      oidcTokenResource: '',
      oidcRedirectPort: 27097,
      gssapiServiceName: '',
      gssapiServiceRealm: '',
      gssapiCanonicalizeHostName: 'none'
    },
    tls: {
      enabled: false,
      ca: { kind: 'none' },
      clientCert: { kind: 'none' },
      allowInvalidHostnames: false,
      allowInvalidCertificates: false
    },
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      method: 'password',
      privateKey: { kind: 'none' },
      knownHostKey: ''
    },
    options: {
      readPreference: 'primary',
      appName: 'Mongo Studio',
      defaultDatabase: '',
      connectTimeoutMS: null,
      serverSelectionTimeoutMS: null,
      socketTimeoutMS: null,
      directConnection: false,
      extra: ''
    },
    createdAt: now,
    updatedAt: now
  }
}

export const AUTH_LABELS: Record<AuthMechanism, string> = {
  none: 'None',
  DEFAULT: 'Username and password (server default)',
  'SCRAM-SHA-256': 'SCRAM-SHA-256',
  'SCRAM-SHA-1': 'SCRAM-SHA-1',
  'MONGODB-X509': 'X.509 certificate',
  PLAIN: 'LDAP (PLAIN)',
  GSSAPI: 'Kerberos (GSSAPI)',
  'MONGODB-AWS': 'AWS IAM',
  'MONGODB-OIDC': 'OpenID Connect (OIDC)'
}

export const TOPOLOGY_LABELS: Record<Topology, string> = {
  standalone: 'Standalone',
  replicaSet: 'Replica set',
  sharded: 'Sharded cluster (mongos)',
  srv: 'DNS seed list (mongodb+srv)'
}

/** Mechanisms that send a password. */
export function usesPassword(mechanism: AuthMechanism): boolean {
  return ['DEFAULT', 'SCRAM-SHA-256', 'SCRAM-SHA-1', 'PLAIN'].includes(mechanism)
}

/** The auth database a mechanism implies when the person leaves it empty. */
export function effectiveAuthSource(auth: AuthSettings, defaultDatabase: string): string {
  if (auth.authSource) return auth.authSource
  if (['MONGODB-X509', 'PLAIN', 'GSSAPI', 'MONGODB-AWS', 'MONGODB-OIDC'].includes(auth.mechanism)) {
    return '$external'
  }
  return defaultDatabase || 'admin'
}

export type FieldError = { field: string; message: string }

const HOSTNAME = /^[A-Za-z0-9._\-[\]:%]+$/

/** Problems that stop a save; `secrets` says which secrets will exist after it. */
export function validateConnection(def: ConnectionDef, secrets: SecretFlags): FieldError[] {
  const errors: FieldError[] = []
  if (!def.name.trim()) errors.push({ field: 'name', message: 'Give the connection a name.' })
  if (def.hosts.length === 0) errors.push({ field: 'hosts', message: 'Add at least one host.' })
  def.hosts.forEach((h, i) => {
    if (!h.host || !HOSTNAME.test(h.host)) {
      errors.push({ field: 'hosts', message: `Host ${i + 1} "${h.host}" is not a valid host name.` })
    }
    if (h.port !== undefined && (!Number.isInteger(h.port) || h.port < 1 || h.port > 65535)) {
      errors.push({ field: 'hosts', message: `Port ${String(h.port)} must be between 1 and 65535.` })
    }
  })
  if (def.topology === 'srv') {
    if (def.hosts.length !== 1) errors.push({ field: 'hosts', message: 'A mongodb+srv connection takes exactly one host name.' })
    if (def.hosts[0]?.port !== undefined) errors.push({ field: 'hosts', message: 'A mongodb+srv host has no port; DNS supplies it.' })
  }
  if (def.topology === 'standalone' && def.hosts.length > 1) {
    errors.push({ field: 'topology', message: 'A standalone server has one host. Choose replica set or sharded for several.' })
  }
  if (def.topology === 'replicaSet' && !def.replicaSet.trim()) {
    errors.push({ field: 'replicaSet', message: 'Enter the replica set name (rs.status().set).' })
  }
  const a = def.auth
  if (usesPassword(a.mechanism)) {
    if (!a.username.trim()) errors.push({ field: 'auth.username', message: 'Enter a user name.' })
  }
  if (a.mechanism === 'GSSAPI' && !a.username.trim()) {
    errors.push({ field: 'auth.username', message: 'Enter the Kerberos principal, such as alice@EXAMPLE.COM.' })
  }
  if (a.mechanism === 'MONGODB-X509' && def.tls.clientCert.kind === 'none') {
    errors.push({ field: 'tls.clientCert', message: 'X.509 needs a client certificate under TLS.' })
  }
  if (a.mechanism === 'MONGODB-X509' && !def.tls.enabled) {
    errors.push({ field: 'tls.enabled', message: 'X.509 needs TLS turned on.' })
  }
  if (a.mechanism === 'MONGODB-AWS' && a.awsSource === 'keys') {
    if (!a.username.trim()) errors.push({ field: 'auth.username', message: 'Enter the AWS access key ID.' })
    if (!secrets.awsSecretAccessKey) errors.push({ field: 'awsSecretAccessKey', message: 'Enter the AWS secret access key.' })
  }
  if (a.mechanism === 'MONGODB-OIDC' && (a.oidcFlow === 'azure' || a.oidcFlow === 'gcp') && !a.oidcTokenResource.trim()) {
    errors.push({ field: 'auth.oidcTokenResource', message: 'Azure and GCP sign-in need the token resource (audience).' })
  }
  if (def.tls.ca.kind === 'path' && !def.tls.ca.path.trim()) errors.push({ field: 'tls.ca', message: 'Enter the CA file path.' })
  if (def.tls.ca.kind === 'inline' && !secrets.tlsCaPem) errors.push({ field: 'tls.ca', message: 'Paste the CA certificate.' })
  if (def.tls.clientCert.kind === 'inline' && !secrets.tlsCertPem) {
    errors.push({ field: 'tls.clientCert', message: 'Paste the client certificate and key.' })
  }
  if (def.ssh.enabled) {
    if (!def.ssh.host.trim()) errors.push({ field: 'ssh.host', message: 'Enter the SSH host.' })
    if (!def.ssh.username.trim()) errors.push({ field: 'ssh.username', message: 'Enter the SSH user name.' })
    if (!Number.isInteger(def.ssh.port) || def.ssh.port < 1 || def.ssh.port > 65535) {
      errors.push({ field: 'ssh.port', message: 'The SSH port must be between 1 and 65535.' })
    }
    if (def.ssh.method === 'privateKey' && def.ssh.privateKey.kind === 'none') {
      errors.push({ field: 'ssh.privateKey', message: 'Give the private key as a file path or paste it.' })
    }
    if (def.ssh.method === 'privateKey' && def.ssh.privateKey.kind === 'inline' && !secrets.sshPrivateKey) {
      errors.push({ field: 'ssh.privateKey', message: 'Paste the private key.' })
    }
  }
  for (const key of ['connectTimeoutMS', 'serverSelectionTimeoutMS', 'socketTimeoutMS'] as const) {
    const v = def.options[key]
    if (v !== null && (!Number.isInteger(v) || v < 0)) {
      errors.push({ field: `options.${key}`, message: `${key} must be a whole number of milliseconds.` })
    }
  }
  return errors
}

/** "user@host:port" style one-liner for the tree and lists. */
export function connectionSubtitle(def: ConnectionDef): string {
  const hosts = def.hosts.map((h) => (h.port && h.port !== DEFAULT_PORT ? `${h.host}:${h.port}` : h.host))
  const first = hosts[0] ?? ''
  const more = hosts.length > 1 ? ` +${hosts.length - 1}` : ''
  const user = def.auth.username && def.auth.mechanism !== 'none' ? `${def.auth.username}@` : ''
  const via = def.ssh.enabled ? ` via ${def.ssh.host}` : ''
  return `${user}${first}${more}${via}`
}

/** Deep copy for plain JSON data. */
export function cloneDef(def: ConnectionDef): ConnectionDef {
  return JSON.parse(JSON.stringify(def)) as ConnectionDef
}
