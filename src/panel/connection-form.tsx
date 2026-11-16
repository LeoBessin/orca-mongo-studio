// The connection editor: form or connection-string mode over one draft, test with diagnostics,
// save. Secret fields are write-only: they show whether a value is saved, never the value.
import {
  Box,
  Button,
  Callout,
  Checkbox,
  CodeView,
  Collapsible,
  Field,
  Heading,
  Input,
  KeyValue,
  List,
  ListItem,
  RadioGroup,
  read,
  Row,
  Select,
  set,
  Switch,
  Text,
  Textarea,
  type IconName,
  type OrcaNode
} from 'orca'
import type { TestStep } from '../protocol'
import {
  AUTH_LABELS,
  DEFAULT_PORT,
  effectiveAuthSource,
  TOPOLOGY_LABELS,
  usesPassword,
  type AuthMechanism,
  type ConnectionDef,
  type HostPort,
  type PemSource,
  type ReadPreferenceMode,
  type SecretKey,
  type Topology
} from '../shared/model'
import { buildConnectionString, hostLabel } from '../shared/uri'
import {
  closeForm,
  edit,
  editUri,
  forgetHostKey,
  formDef,
  formErrors,
  formFlags,
  formIsNew,
  formMode,
  formSecrets,
  runTest,
  saveForm,
  saving,
  setSecret,
  testing,
  testReport,
  uriProblem,
  uriText
} from './state'

const MECHANISM_ORDER: AuthMechanism[] = ['none', 'DEFAULT', 'SCRAM-SHA-256', 'SCRAM-SHA-1', 'MONGODB-X509', 'PLAIN', 'MONGODB-AWS', 'MONGODB-OIDC', 'GSSAPI']
const READ_PREFS: ReadPreferenceMode[] = ['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest']

function errorFor(field: string): string | undefined {
  const found = read(formErrors).filter((e) => e.field === field || e.field.startsWith(`${field}.`))
  return found.length ? found.map((e) => e.message).join(' ') : undefined
}

function textInput(label: string, value: string, onChange: (v: string) => void, extra: { placeholder?: string; field?: string } = {}): OrcaNode {
  const error = extra.field ? errorFor(extra.field) : undefined
  return (
    <Input
      label={label}
      value={value}
      onChange={onChange}
      {...(extra.placeholder ? { placeholder: extra.placeholder } : {})}
      {...(error ? { invalid: true } : {})}
    />
  )
}

function numberInput(label: string, value: number | null, onChange: (v: number | null) => void, placeholder: string, field: string): OrcaNode {
  const error = errorFor(field)
  return (
    <Input
      label={label}
      value={value === null ? '' : String(value)}
      placeholder={placeholder}
      {...(error ? { invalid: true } : {})}
      onChange={(v) => {
        const t = v.trim()
        onChange(t === '' ? null : /^\d+$/.test(t) ? Number(t) : Number.NaN)
      }}
    />
  )
}

/** A write-only secret: typing replaces it, "Forget" clears it, empty keeps the saved one. */
function secretInput(key: SecretKey, label: string, optional = false): OrcaNode {
  const draft = read(formSecrets)[key]
  const saved = read(formFlags)[key] ?? false
  const cleared = draft === null
  const placeholder = cleared ? 'Will be forgotten when you save' : saved ? 'Saved. Type to replace it.' : optional ? 'Optional' : ''
  return (
    <Box gap="xs">
      <Input label={label} type="password" value={typeof draft === 'string' ? draft : ''} placeholder={placeholder} onChange={(v) => setSecret(key, v)} />
      {saved && !cleared ? (
        <Button size="xs" variant="ghost" icon="remove" onPress={() => setSecret(key, null)}>Forget saved {label.toLowerCase()}</Button>
      ) : null}
    </Box>
  )
}

/** A certificate or key: none, a file the worker reads, or pasted text kept in secrets. */
function pemInput(label: string, source: PemSource, secret: SecretKey, onSource: (s: PemSource) => void, field: string, allowNone = true): OrcaNode {
  const error = errorFor(field)
  const draft = read(formSecrets)[secret]
  const saved = read(formFlags)[secret] ?? false
  const options = [
    ...(allowNone ? [{ value: 'none', label: 'None' }] : []),
    { value: 'path', label: 'File on this computer' },
    { value: 'inline', label: 'Paste the PEM text' }
  ]
  return (
    <Field label={label} {...(error ? { error } : {})}>
      <Box gap="xs">
        <Select
          label={`${label} source`}
          labelHidden
          value={source.kind}
          options={options}
          onChange={(v) => onSource(v === 'path' ? { kind: 'path', path: source.kind === 'path' ? source.path : '' } : v === 'inline' ? { kind: 'inline' } : { kind: 'none' })}
        />
        {source.kind === 'path' ? (
          <Input label={`${label} path`} labelHidden value={source.path} placeholder="/path/to/file.pem" onChange={(path) => onSource({ kind: 'path', path })} />
        ) : null}
        {source.kind === 'inline' ? (
          <Textarea
            label={`${label} PEM`}
            labelHidden
            rows={4}
            value={typeof draft === 'string' ? draft : ''}
            placeholder={saved ? 'Saved. Paste to replace it.' : '-----BEGIN …'}
            onChange={(v) => setSecret(secret, v)}
          />
        ) : null}
      </Box>
    </Field>
  )
}

function hostsText(hosts: readonly HostPort[]): string {
  return hosts.map((h) => (h.port !== undefined ? `${h.host}:${h.port}` : h.host)).join('\n')
}

function parseHosts(text: string): HostPort[] {
  return text
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const at = l.lastIndexOf(':')
      if (at > 0 && !l.startsWith('[') && /^\d+$/.test(l.slice(at + 1))) return { host: l.slice(0, at), port: Number(l.slice(at + 1)) }
      return { host: l.replace(/^\[|\]$/g, '') }
    })
}

function serverSection(def: ConnectionDef): OrcaNode {
  const t = def.topology
  const first = def.hosts[0] ?? { host: '' }
  return (
    <Collapsible title="Server" description={`${TOPOLOGY_LABELS[t]} · ${def.hosts.map(hostLabel).join(', ')}`} defaultOpen>
      <Box gap="sm">
        <Select
          label="Type"
          value={t}
          options={(Object.keys(TOPOLOGY_LABELS) as Topology[]).map((k) => ({ value: k, label: TOPOLOGY_LABELS[k] }))}
          onChange={(v) =>
            edit((d) => {
              d.topology = v as Topology
              if (v === 'srv') d.hosts = [{ host: d.hosts[0]?.host ?? '' }]
              else if (v === 'standalone') d.hosts = [{ host: d.hosts[0]?.host ?? 'localhost', port: d.hosts[0]?.port ?? DEFAULT_PORT }]
              if (v === 'srv') d.tls.enabled = true
            })
          }
        />
        {t === 'standalone' ? (
          <Row gap="sm" align="start">
            <Box grow>{textInput('Host', first.host, (host) => edit((d) => (d.hosts = [{ ...first, host }])), { field: 'hosts' })}</Box>
            <Box width={110}>{numberInput('Port', first.port ?? null, (port) => edit((d) => (d.hosts = port === null ? [{ host: first.host }] : [{ host: first.host, port }])), String(DEFAULT_PORT), 'hosts')}</Box>
          </Row>
        ) : t === 'srv' ? (
          textInput('Cluster host name', first.host, (host) => edit((d) => (d.hosts = [{ host: host.replace(/^mongodb\+srv:\/\//, '') }])), { placeholder: 'cluster0.abcde.mongodb.net', field: 'hosts' })
        ) : (
          <Field label="Hosts" description="One host:port per line." {...(errorFor('hosts') ? { error: errorFor('hosts')! } : {})}>
            <Textarea label="Hosts" labelHidden rows={3} defaultValue={hostsText(def.hosts)} onChange={(v) => edit((d) => (d.hosts = parseHosts(v)))} />
          </Field>
        )}
        {t === 'replicaSet' ? textInput('Replica set name', def.replicaSet, (v) => edit((d) => (d.replicaSet = v)), { placeholder: 'rs0', field: 'replicaSet' }) : null}
        {t === 'standalone' ? (
          <Checkbox
            label="Direct connection"
            description="Talk to this server only, even when it is a replica set member."
            checked={def.options.directConnection}
            onChange={(v) => edit((d) => (d.options.directConnection = v))}
          />
        ) : null}
        {errorFor('topology') ? <Text tone="danger" size="sm">{errorFor('topology')}</Text> : null}
      </Box>
    </Collapsible>
  )
}

function authSection(def: ConnectionDef): OrcaNode {
  const a = def.auth
  const m = a.mechanism
  return (
    <Collapsible title="Authentication" description={AUTH_LABELS[m]} defaultOpen={m !== 'none'}>
      <Box gap="sm">
        <Select
          label="Method"
          value={m}
          options={MECHANISM_ORDER.map((k) => ({ value: k, label: AUTH_LABELS[k] }))}
          onChange={(v) => edit((d) => (d.auth.mechanism = v as AuthMechanism))}
        />
        {usesPassword(m) ? (
          <Box gap="sm">
            {textInput('User name', a.username, (v) => edit((d) => (d.auth.username = v)), { field: 'auth.username' })}
            {secretInput('password', 'Password')}
            {textInput('Authentication database', a.authSource, (v) => edit((d) => (d.auth.authSource = v)), { placeholder: effectiveAuthSource({ ...a, authSource: '' }, def.options.defaultDatabase) })}
          </Box>
        ) : null}
        {m === 'MONGODB-X509' ? (
          <Box gap="sm">
            {textInput('Certificate subject', a.username, (v) => edit((d) => (d.auth.username = v)), { placeholder: 'Optional: read from the certificate' })}
            <Text muted size="sm">Set the client certificate under TLS.</Text>
          </Box>
        ) : null}
        {m === 'GSSAPI' ? (
          <Box gap="sm">
            {textInput('Principal', a.username, (v) => edit((d) => (d.auth.username = v)), { placeholder: 'alice@EXAMPLE.COM', field: 'auth.username' })}
            <Text muted size="sm">Mongo Studio signs in with the Kerberos ticket on this computer. Run kinit first if you have none.</Text>
            {textInput('Service name', a.gssapiServiceName, (v) => edit((d) => (d.auth.gssapiServiceName = v)), { placeholder: 'mongodb' })}
            {textInput('Service realm', a.gssapiServiceRealm, (v) => edit((d) => (d.auth.gssapiServiceRealm = v)), { placeholder: "The principal's realm" })}
            <Select
              label="Canonicalize host name"
              value={a.gssapiCanonicalizeHostName}
              options={[
                { value: 'none', label: 'No: use the host name as typed' },
                { value: 'forward', label: 'Forward DNS lookup (CNAME)' },
                { value: 'forwardAndReverse', label: 'Forward and reverse DNS lookup' }
              ]}
              onChange={(v) => edit((d) => (d.auth.gssapiCanonicalizeHostName = v as ConnectionDef['auth']['gssapiCanonicalizeHostName']))}
            />
          </Box>
        ) : null}
        {m === 'MONGODB-AWS' ? (
          <Box gap="sm">
            <RadioGroup
              label="Credentials"
              value={a.awsSource}
              options={[
                { value: 'environment', label: 'From this computer', description: 'Environment variables, ~/.aws profiles, SSO, or an instance role.' },
                { value: 'keys', label: 'Access keys', description: 'Saved encrypted with this connection.' }
              ]}
              onChange={(v) => edit((d) => (d.auth.awsSource = v === 'keys' ? 'keys' : 'environment'))}
            />
            {a.awsSource === 'keys' ? (
              <Box gap="sm">
                {textInput('Access key ID', a.username, (v) => edit((d) => (d.auth.username = v)), { field: 'auth.username' })}
                {secretInput('awsSecretAccessKey', 'Secret access key')}
                {secretInput('awsSessionToken', 'Session token', true)}
              </Box>
            ) : null}
          </Box>
        ) : null}
        {m === 'MONGODB-OIDC' ? (
          <Box gap="sm">
            <Select
              label="Sign-in"
              value={a.oidcFlow}
              options={[
                { value: 'browser', label: 'In the browser (identity provider sign-in)' },
                { value: 'azure', label: 'Azure managed identity' },
                { value: 'gcp', label: 'Google Cloud service account' },
                { value: 'k8s', label: 'Kubernetes service account' }
              ]}
              onChange={(v) => edit((d) => (d.auth.oidcFlow = v as ConnectionDef['auth']['oidcFlow']))}
            />
            {a.oidcFlow === 'browser' ? (
              <Box gap="sm">
                {textInput('User name', a.username, (v) => edit((d) => (d.auth.username = v)), { placeholder: 'Optional: fills in the sign-in page' })}
                {numberInput('Redirect port', a.oidcRedirectPort, (v) => edit((d) => (d.auth.oidcRedirectPort = v ?? 27097)), '27097', 'auth.oidcRedirectPort')}
                <Text muted size="sm">Your identity provider must allow http://localhost:{a.oidcRedirectPort}/redirect as a redirect URI.</Text>
              </Box>
            ) : null}
            {a.oidcFlow === 'azure' || a.oidcFlow === 'gcp'
              ? textInput('Token resource (audience)', a.oidcTokenResource, (v) => edit((d) => (d.auth.oidcTokenResource = v)), { field: 'auth.oidcTokenResource' })
              : null}
          </Box>
        ) : null}
      </Box>
    </Collapsible>
  )
}

function tlsSection(def: ConnectionDef): OrcaNode {
  const tls = def.tls
  return (
    <Collapsible title="TLS" description={tls.enabled ? 'On' : 'Off'} defaultOpen={tls.enabled}>
      <Box gap="sm">
        <Switch label="Use TLS" checked={tls.enabled} onChange={(v) => edit((d) => (d.tls.enabled = v))} />
        {errorFor('tls.enabled') ? <Text tone="danger" size="sm">{errorFor('tls.enabled')}</Text> : null}
        {tls.enabled ? (
          <Box gap="sm">
            {pemInput('CA certificate', tls.ca, 'tlsCaPem', (s) => edit((d) => (d.tls.ca = s)), 'tls.ca')}
            {pemInput('Client certificate and key', tls.clientCert, 'tlsCertPem', (s) => edit((d) => (d.tls.clientCert = s)), 'tls.clientCert')}
            {tls.clientCert.kind !== 'none' ? secretInput('tlsKeyPassword', 'Key password', true) : null}
            <Checkbox label="Allow invalid host names" description="Accept a certificate issued for another name." checked={tls.allowInvalidHostnames} onChange={(v) => edit((d) => (d.tls.allowInvalidHostnames = v))} />
            <Checkbox label="Allow invalid certificates" description="Skip certificate checks. Only for local testing." checked={tls.allowInvalidCertificates} onChange={(v) => edit((d) => (d.tls.allowInvalidCertificates = v))} />
          </Box>
        ) : null}
      </Box>
    </Collapsible>
  )
}

function sshSection(def: ConnectionDef): OrcaNode {
  const s = def.ssh
  return (
    <Collapsible title="SSH tunnel" description={s.enabled ? `${s.username}@${s.host}` : 'None'} defaultOpen={s.enabled}>
      <Box gap="sm">
        <Switch label="Connect through an SSH server" checked={s.enabled} onChange={(v) => edit((d) => (d.ssh.enabled = v))} />
        {s.enabled ? (
          <Box gap="sm">
            <Row gap="sm" align="start">
              <Box grow>{textInput('SSH host', s.host, (v) => edit((d) => (d.ssh.host = v)), { placeholder: 'bastion.example.com', field: 'ssh.host' })}</Box>
              <Box width={90}>{numberInput('Port', s.port, (v) => edit((d) => (d.ssh.port = v ?? 22)), '22', 'ssh.port')}</Box>
            </Row>
            {textInput('SSH user name', s.username, (v) => edit((d) => (d.ssh.username = v)), { field: 'ssh.username' })}
            <RadioGroup
              label="Sign in with"
              orientation="horizontal"
              value={s.method}
              options={[{ value: 'password', label: 'Password' }, { value: 'privateKey', label: 'Private key' }]}
              onChange={(v) => edit((d) => (d.ssh.method = v === 'privateKey' ? 'privateKey' : 'password'))}
            />
            {s.method === 'password' ? secretInput('sshPassword', 'SSH password') : (
              <Box gap="sm">
                {pemInput('Private key', s.privateKey, 'sshPrivateKey', (k) => edit((d) => (d.ssh.privateKey = k)), 'ssh.privateKey', false)}
                {secretInput('sshPassphrase', 'Key passphrase', true)}
              </Box>
            )}
            {s.knownHostKey ? (
              <Box gap="xs">
                <KeyValue label="SSH server" items={[{ label: 'Trusted host key', value: `SHA256 ${s.knownHostKey.slice(0, 16)}…`, code: true }]} />
                <Button size="xs" variant="ghost" icon="remove" onPress={() => (def.id && !read(formIsNew) ? void forgetHostKey(def.id) : edit((d) => (d.ssh.knownHostKey = '')))}>
                  Forget the trusted host key
                </Button>
              </Box>
            ) : (
              <Text muted size="sm">The server's host key is trusted the first time you connect, and checked every time after.</Text>
            )}
            {def.hosts.length > 1 || def.topology === 'srv' ? (
              <Callout tone="warning" icon="info">Through SSH, Mongo Studio connects to the first database host only.</Callout>
            ) : null}
          </Box>
        ) : null}
      </Box>
    </Collapsible>
  )
}

function advancedSection(def: ConnectionDef): OrcaNode {
  const o = def.options
  return (
    <Collapsible title="Advanced" description={`Read preference: ${o.readPreference}`}>
      <Box gap="sm">
        <Select label="Read preference" value={o.readPreference} options={READ_PREFS.map((r) => ({ value: r, label: r }))} onChange={(v) => edit((d) => (d.options.readPreference = v as ReadPreferenceMode))} />
        {textInput('Default database', o.defaultDatabase, (v) => edit((d) => (d.options.defaultDatabase = v)), { placeholder: 'None' })}
        {textInput('App name', o.appName, (v) => edit((d) => (d.options.appName = v)), { placeholder: 'Shown in the server logs and currentOp' })}
        <Row gap="sm" wrap>
          <Box minWidth={120} grow>{numberInput('Connect timeout (ms)', o.connectTimeoutMS, (v) => edit((d) => (d.options.connectTimeoutMS = v)), '30000', 'options.connectTimeoutMS')}</Box>
          <Box minWidth={120} grow>{numberInput('Server selection (ms)', o.serverSelectionTimeoutMS, (v) => edit((d) => (d.options.serverSelectionTimeoutMS = v)), '10000', 'options.serverSelectionTimeoutMS')}</Box>
          <Box minWidth={120} grow>{numberInput('Socket timeout (ms)', o.socketTimeoutMS, (v) => edit((d) => (d.options.socketTimeoutMS = v)), 'none', 'options.socketTimeoutMS')}</Box>
        </Row>
        {textInput('More options', o.extra, (v) => edit((d) => (d.options.extra = v)), { placeholder: 'w=majority&retryWrites=false' })}
      </Box>
    </Collapsible>
  )
}

const STEP_ICON: Record<TestStep['status'], IconName> = { ok: 'check', warning: 'warning', failed: 'error', skipped: 'remove' }

function testResult(): OrcaNode {
  if (read(testing)) {
    return <Callout tone="neutral" icon="activity">Testing… DNS, network, TLS and sign-in are checked in turn.</Callout>
  }
  const report = read(testReport)
  if (!report) return null
  const failed = report.steps.find((s) => s.status === 'failed')
  const warned = report.steps.some((s) => s.status === 'warning')
  const tone = failed ? 'danger' : warned ? 'warning' : 'success'
  const title = failed ? `Failed at "${failed.title}"` : warned ? 'Connected, with warnings' : 'Connected'
  return (
    <Callout tone={tone} icon={failed ? 'error' : warned ? 'warning' : 'check'} title={title}>
      <Box gap="xs">
        {report.server ? <Text size="sm">MongoDB {report.server.version}, {report.server.topology}.</Text> : null}
        <List label="Test steps">
          {report.steps.map((s) => (
            <ListItem key={s.id} icon={STEP_ICON[s.status]} title={`${s.title}${s.status === 'skipped' ? '' : ` · ${s.ms} ms`}`} description={s.hint ? `${s.detail} ${s.hint}` : s.detail} />
          ))}
        </List>
      </Box>
    </Callout>
  )
}

export function ConnectionForm(): OrcaNode {
  const def = read(formDef)
  if (!def) return null
  const mode = read(formMode)
  const problem = read(uriProblem)
  const errors = read(formErrors)
  const flags = read(formFlags)
  const hasPassword = flags.password === true || typeof read(formSecrets).password === 'string'
  return (
    <Box gap="md">
      <Heading level={2}>{read(formIsNew) ? 'New connection' : `Edit ${def.name || 'connection'}`}</Heading>
      <Box gap="sm">
        {textInput('Name', def.name, (v) => edit((d) => (d.name = v)), { placeholder: 'Production cluster', field: 'name' })}
        {textInput('Group', def.group, (v) => edit((d) => (d.group = v)), { placeholder: 'Optional, e.g. Clients or Staging' })}
        <Box gap="none">
          <Switch label="Read only" checked={def.readOnly} onChange={(v) => edit((d) => (d.readOnly = v))} />
          <Text muted size="xs">Mongo Studio refuses every change through this connection: edits, imports, copies into it, administration and shell writes. Reading, exporting and comparing still work.</Text>
        </Box>
        <RadioGroup
          label="Edit as"
          orientation="horizontal"
          value={mode}
          options={[{ value: 'form', label: 'Form' }, { value: 'uri', label: 'Connection string' }]}
          onChange={(v) => set(formMode, v === 'uri' ? 'uri' : 'form')}
        />
      </Box>
      {mode === 'uri' ? (
        <Box gap="sm">
          <Field label="Connection string" description="mongodb:// or mongodb+srv://. A password in it is saved encrypted, apart from the string." {...(problem.error ? { error: problem.error } : {})}>
            <Textarea label="Connection string" labelHidden rows={4} value={read(uriText)} onChange={editUri} invalid={Boolean(problem.error)} />
          </Field>
          {problem.warnings.map((w) => <Text key={w} tone="warning" size="sm">{w}</Text>)}
          <Text muted size="sm">Set the SSH tunnel, pasted certificates and AWS keys in Form mode.</Text>
        </Box>
      ) : (
        <Box gap="xs">
          {serverSection(def)}
          {authSection(def)}
          {tlsSection(def)}
          {sshSection(def)}
          {advancedSection(def)}
        </Box>
      )}
      {mode === 'form' ? (
        <CodeView label="Connection string" code={buildConnectionString(def, hasPassword ? { maskPassword: true } : {})} language="text" wrap />
      ) : null}
      {errors.length ? (
        <Callout tone="danger" icon="error" title="Fix these to save">
          <Box gap="xs">{errors.map((e) => <Text key={`${e.field}:${e.message}`} size="sm">{e.message}</Text>)}</Box>
        </Callout>
      ) : null}
      {testResult()}
      <Row gap="xs" wrap>
        <Button icon="play" disabled={read(testing)} onPress={runTest}>{read(testing) ? 'Testing…' : 'Test connection'}</Button>
        <Button variant="solid" tone="accent" icon="check" disabled={read(saving)} onPress={saveForm}>Save</Button>
        <Button variant="ghost" onPress={closeForm}>Cancel</Button>
      </Row>
    </Box>
  )
}
