// "Test connection": runs DNS, SSH, TCP, TLS, handshake, sign-in and permission checks in order
// and stops at the first failure, so the report says where it broke and what to do next.
import { promises as dns } from 'node:dns'
import { connect as netConnect, isIP } from 'node:net'
import { checkServerIdentity, connect as tlsConnect, type ConnectionOptions as TlsOptions, type PeerCertificate } from 'node:tls'
import type { TestReport, TestStatus, TestStep } from '../protocol'
import type { ConnectionDef, HostPort } from '../shared/model'
import { hostLabel } from '../shared/uri'
import { openClient, readPem, resolveSrvSeed, sshConfig, type OpenClient, type Secrets } from './client'
import { diagnose } from './errors'
import { formatHostKey, openTunnel, type Tunnel } from './ssh'

type StepResult = { status: TestStatus; detail: string; hint?: string }
type Run = (step: TestStep['id'], title: string, body: () => Promise<StepResult>) => Promise<boolean>

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${what} did not answer within ${ms / 1000} s.`) as Error & { code: string }
      e.code = 'ETIMEDOUT'
      reject(e)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function tcpProbe(target: HostPort, timeoutMs: number, holdMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: target.host, port: target.port ?? 27017 })
    const timer = setTimeout(() => {
      socket.destroy()
      const e = new Error(`No answer from ${hostLabel(target)} within ${timeoutMs / 1000} s.`) as Error & { code: string }
      e.code = 'ETIMEDOUT'
      reject(e)
    }, timeoutMs)
    socket.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    socket.once('connect', () => {
      clearTimeout(timer)
      // Through a tunnel the local side always accepts; a refused forward closes it right after.
      if (holdMs === 0) {
        socket.destroy()
        resolve()
        return
      }
      const hold = setTimeout(() => {
        socket.destroy()
        resolve()
      }, holdMs)
      socket.once('close', () => {
        clearTimeout(hold)
        reject(new Error('The SSH server could not open a connection to the database host (the forward was refused).'))
      })
    })
  })
}

function certName(name: PeerCertificate['subject'] | undefined): string {
  if (!name) return 'unknown'
  const pick = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)
  return pick(name.CN) || pick(name.O) || 'unnamed'
}

export async function testConnection(def: ConnectionDef, secrets: Secrets, onOidcSignIn?: (url: string) => void): Promise<TestReport> {
  const steps: TestStep[] = []
  const report: TestReport = { ok: false, steps }
  const run: Run = async (id, title, body) => {
    const start = performance.now()
    let result: StepResult
    try {
      result = await body()
    } catch (error) {
      const d = diagnose(error)
      result = d.hint ? { status: 'failed', detail: d.message, hint: d.hint } : { status: 'failed', detail: d.message }
    }
    steps.push({ id, title, ms: Math.round(performance.now() - start), ...result })
    return result.status !== 'failed'
  }
  const skip = (id: TestStep['id'], title: string, detail: string): void => {
    steps.push({ id, title, status: 'skipped', ms: 0, detail })
  }

  const timeoutMs = def.options.connectTimeoutMS ?? 8000
  let targets: HostPort[] = def.hosts
  let tunnel: Tunnel | undefined
  const clients: OpenClient[] = []
  try {
    // 1. DNS
    let ok: boolean
    if (def.topology === 'srv') {
      ok = await run('dns', 'Resolve the DNS seed list', async () => {
        const seed = await withTimeout(resolveSrvSeed(def.hosts[0]?.host ?? ''), timeoutMs, 'DNS')
        targets = seed.hosts
        const list = seed.hosts.map(hostLabel).join(', ')
        return { status: 'ok', detail: `${seed.hosts.length} host(s): ${list}${seed.txt ? `. TXT options: ${seed.txt}` : ''}` }
      })
    } else if (def.ssh.enabled) {
      skip('dns', 'Resolve host names', 'The SSH server resolves the database host names.')
      ok = true
    } else {
      ok = await run('dns', 'Resolve host names', async () => {
        const parts: string[] = []
        for (const h of def.hosts) {
          if (isIP(h.host)) continue
          const found = await withTimeout(dns.lookup(h.host, { all: true }), timeoutMs, 'DNS')
          parts.push(`${h.host} → ${found.map((a) => a.address).join(', ')}`)
        }
        return { status: 'ok', detail: parts.length ? parts.join('; ') : 'Hosts are IP addresses.' }
      })
    }
    if (!ok) return report

    // 2. SSH
    if (def.ssh.enabled) {
      ok = await run('ssh', 'Open the SSH tunnel', async () => {
        const first = targets[0]
        if (!first) throw new Error('There is no host to tunnel to.')
        tunnel = await openTunnel({ ...(await sshConfig(def, secrets)), readyTimeoutMs: timeoutMs }, [first])
        const firstTime = !def.ssh.knownHostKey
        if (firstTime) report.sshHostKey = tunnel.hostKey
        const many = targets.length > 1 ? ` Through SSH, Mongo Studio talks to ${hostLabel(first)} only.` : ''
        return {
          status: targets.length > 1 ? 'warning' : 'ok',
          detail: `Signed in to ${def.ssh.host}:${def.ssh.port} as ${def.ssh.username}. Host key ${formatHostKey(tunnel.hostKey)}${firstTime ? ' (new: it will be trusted when you save).' : ' (matches the saved key).'}${many}`,
          ...(many ? { hint: 'Use a mongos or the primary as the first host, or connect without SSH to use the whole replica set.' } : {})
        }
      })
      if (!ok) return report
    } else {
      skip('ssh', 'Open the SSH tunnel', 'No SSH tunnel.')
    }

    // 3. TCP
    const endpoints = tunnel ? tunnel.local : targets
    ok = await run('tcp', tunnel ? 'Reach the database through SSH' : 'Reach each host', async () => {
      const results = await Promise.allSettled(endpoints.map((e) => tcpProbe(e, timeoutMs, tunnel ? 700 : 0)))
      const names = tunnel ? targets.slice(0, 1) : targets
      const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [{ host: names[i]!, error: r.reason as unknown }] : []))
      if (failed.length === results.length) throw failed[0]?.error ?? new Error('No host answered.')
      if (failed.length > 0) {
        const d = diagnose(failed[0]!.error)
        return {
          status: 'warning',
          detail: `${results.length - failed.length} of ${results.length} hosts answered. ${hostLabel(failed[0]!.host)}: ${d.message}`,
          hint: d.hint ?? 'Some members are unreachable; the driver will use the others.'
        }
      }
      return { status: 'ok', detail: `${names.map(hostLabel).join(', ')} accepted a TCP connection.` }
    })
    if (!ok) return report

    // 4. TLS
    if (def.tls.enabled) {
      ok = await run('tls', 'TLS handshake', async () => {
        const endpoint = endpoints[0]!
        const realHost = targets[0]?.host ?? endpoint.host
        const ca = await readPem(def.tls.ca, secrets.tlsCaPem, 'CA certificate')
        const cert = await readPem(def.tls.clientCert, secrets.tlsCertPem, 'client certificate')
        const options: TlsOptions = {
          host: endpoint.host,
          port: endpoint.port ?? 27017,
          rejectUnauthorized: !def.tls.allowInvalidCertificates,
          checkServerIdentity: def.tls.allowInvalidHostnames ? () => undefined : (_h: string, c: PeerCertificate) => checkServerIdentity(realHost, c)
        }
        if (!isIP(realHost)) options.servername = realHost
        if (ca) options.ca = ca
        if (cert) {
          options.cert = cert
          options.key = cert
        }
        if (secrets.tlsKeyPassword) options.passphrase = secrets.tlsKeyPassword
        const info = await withTimeout(
          new Promise<{ protocol: string; peer: PeerCertificate }>((resolve, reject) => {
            const socket = tlsConnect(options, () => {
              const result = { protocol: socket.getProtocol() ?? 'TLS', peer: socket.getPeerCertificate() }
              socket.end()
              resolve(result)
            })
            socket.once('error', reject)
          }),
          timeoutMs,
          'The TLS handshake'
        )
        const until = new Date(info.peer.valid_to)
        const days = Math.floor((until.getTime() - Date.now()) / 86400000)
        const relaxed = [def.tls.allowInvalidCertificates && 'certificate checks are off', def.tls.allowInvalidHostnames && 'host name checks are off'].filter(Boolean)
        const detail = `${info.protocol}. Server certificate "${certName(info.peer.subject)}" from "${certName(info.peer.issuer)}", valid until ${until.toISOString().slice(0, 10)}.${relaxed.length ? ` Note: ${relaxed.join(' and ')}.` : ''}`
        if (days < 30) return { status: 'warning', detail, hint: `The server certificate expires in ${days} day(s).` }
        if (relaxed.length) return { status: 'warning', detail, hint: 'Turn the relaxed TLS checks off once the CA and host name are set up; they hide man-in-the-middle attacks.' }
        return { status: 'ok', detail }
      })
      if (!ok) return report
    } else {
      skip('tls', 'TLS handshake', 'TLS is off.')
    }

    // 5. MongoDB handshake, no credentials
    let anonymous: OpenClient | undefined
    ok = await run('handshake', 'MongoDB handshake', async () => {
      try {
        anonymous = await openClient(def, secrets, { withoutAuth: true, serverSelectionTimeoutMS: timeoutMs, ...(tunnel ? { tunnel } : {}) })
      } catch (error) {
        if (!def.tls.enabled && /ECONNRESET|closed/i.test(String((error as Error).message))) {
          return { status: 'failed', detail: (error as Error).message, hint: 'The server closed the connection. It may require TLS: turn TLS on.' }
        }
        throw error
      }
      clients.push(anonymous)
      const admin = anonymous.client.db('admin')
      const hello = await admin.command({ hello: 1 })
      const build = await admin.command({ buildInfo: 1 }).catch(() => ({ version: 'unknown' }))
      const kind = hello.msg === 'isdbgrid' ? 'sharded cluster (mongos)' : hello.setName ? `replica set "${String(hello.setName)}" (${hello.isWritablePrimary ? 'primary' : 'secondary'})` : 'standalone server'
      report.server = { version: String(build.version), topology: kind }
      if (hello.setName) report.server.setName = String(hello.setName)
      const warn = def.topology === 'standalone' && hello.setName && !def.options.directConnection
      return {
        status: warn ? 'warning' : 'ok',
        detail: `MongoDB ${String(build.version)}, ${kind}.`,
        ...(warn ? { hint: `This server is in replica set "${String(hello.setName)}". Choose "Replica set" to follow failovers, or turn on direct connection to stay on this member.` } : {})
      }
    })
    if (!ok) return report

    // 6. Sign-in
    let authed = anonymous
    if (def.auth.mechanism === 'none') {
      skip('auth', 'Sign in', 'No authentication.')
    } else {
      ok = await run('auth', 'Sign in', async () => {
        const open = await openClient(def, secrets, {
          serverSelectionTimeoutMS: timeoutMs,
          ...(tunnel ? { tunnel } : {}),
          ...(onOidcSignIn ? { onOidcSignIn } : {})
        })
        clients.push(open)
        authed = open
        const status = await open.client.db('admin').command({ connectionStatus: 1 })
        const users = (status.authInfo?.authenticatedUsers ?? []) as { user: string; db: string }[]
        if (users.length === 0) throw new Error('The server accepted the connection but no user is signed in.')
        return { status: 'ok', detail: `Signed in as ${users.map((u) => `${u.user} (${u.db})`).join(', ')}.` }
      })
      if (!ok) return report
    }

    // 7. What the user can see
    await run('permissions', 'List databases', async () => {
      const client = authed?.client
      if (!client) throw new Error('No open client.')
      try {
        const { databases } = await client.db('admin').admin().listDatabases({ nameOnly: true })
        return { status: 'ok', detail: `${databases.length} database(s) visible: ${databases.slice(0, 6).map((d) => d.name).join(', ')}${databases.length > 6 ? ', …' : ''}.` }
      } catch (error) {
        const d = diagnose(error)
        return {
          status: 'warning',
          detail: d.message,
          hint:
            def.auth.mechanism === 'none'
              ? 'The server requires sign-in. Choose an authentication method.'
              : 'This user cannot list all databases. The tree will show the default database and the databases the user has privileges on.'
        }
      }
    })
    report.ok = steps.every((s) => s.status !== 'failed')
    return report
  } finally {
    await Promise.all(clients.map((c) => c.close()))
    await tunnel?.close()
  }
}
