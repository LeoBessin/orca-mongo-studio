// Integration tests against the docker databases in dev/docker-compose.yml (profile "test").
// Run with MONGO_STUDIO_IT=1 (npm run test:it); without it every test returns at once.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import type { TestReport } from '../src/protocol'
import { emptyConnection, type ConnectionDef, type SecretDraft } from '../src/shared/model'
import * as main from '../src/worker'

const ON = process.env.MONGO_STUDIO_IT === '1'
const CERTS = join(import.meta.dirname, '..', 'dev', 'test-env', 'out')
const pem = (name: string): string => readFileSync(join(CERTS, name), 'utf8')

function conn(name: string, host: string, port: number, edit: (d: ConnectionDef) => void = () => {}): ConnectionDef {
  const def = emptyConnection('', 0)
  def.name = name
  def.hosts = [{ host, port }]
  def.options.connectTimeoutMS = 3000
  edit(def)
  return def
}

async function worker() {
  return mountWorker(main, { host: mockHost({ results: { 'secrets.protection': { status: 'os-keyring' } } }) })
}

async function check(def: ConnectionDef, secrets: SecretDraft = {}): Promise<TestReport> {
  const w = await worker()
  try {
    return await w.request('connections.test', { def, secrets })
  } finally {
    await w.deactivate()
  }
}

const statuses = (r: TestReport): string => r.steps.map((s) => `${s.id}:${s.status}`).join(' ')
const step = (r: TestReport, id: string) => r.steps.find((s) => s.id === id)!

describe('test connection', () => {
  test('dev replica set, no auth', async () => {
    if (!ON) return
    const r = await check(conn('dev', 'localhost', 27017, (d) => { d.options.directConnection = true }))
    assert.equal(statuses(r), 'dns:ok ssh:skipped tcp:ok tls:skipped handshake:ok auth:skipped permissions:ok')
    assert.match(r.server!.topology, /replica set "rs0"/)
    assert.equal(r.ok, true)
  })

  test('standalone choice on a replica set member warns', async () => {
    if (!ON) return
    const r = await check(conn('dev', 'localhost', 27017))
    assert.equal(step(r, 'handshake').status, 'warning')
    assert.match(step(r, 'handshake').hint!, /Replica set/)
  })

  test('nothing listening', async () => {
    if (!ON) return
    const r = await check(conn('closed', '127.0.0.1', 27999))
    assert.equal(statuses(r), 'dns:ok ssh:skipped tcp:failed')
    assert.match(step(r, 'tcp').hint!, /Nothing is listening/)
  })

  test('unknown host', async () => {
    if (!ON) return
    const r = await check(conn('typo', 'no-such-host.invalid', 27017))
    assert.equal(step(r, 'dns').status, 'failed')
    assert.match(step(r, 'dns').hint!, /does not resolve/)
  })

  test('SCRAM-SHA-256 sign-in, right and wrong password', async () => {
    if (!ON) return
    const auth = (d: ConnectionDef) => {
      d.auth.mechanism = 'SCRAM-SHA-256'
      d.auth.username = 'root'
    }
    const ok = await check(conn('auth', 'localhost', 27019, auth), { password: 'root-dev-only' })
    assert.equal(statuses(ok), 'dns:ok ssh:skipped tcp:ok tls:skipped handshake:ok auth:ok permissions:ok')
    assert.match(step(ok, 'auth').detail, /root \(admin\)/)
    const bad = await check(conn('auth', 'localhost', 27019, auth), { password: 'nope' })
    assert.equal(step(bad, 'auth').status, 'failed')
    assert.match(step(bad, 'auth').hint!, /Check the user name, password and auth database/)
  })

  test('SCRAM-SHA-1 user', async () => {
    if (!ON) return
    const r = await check(conn('sha1', 'localhost', 27019, (d) => {
      d.auth.mechanism = 'SCRAM-SHA-1'
      d.auth.username = 'ldapless'
    }), { password: 'sha1-dev-only' })
    assert.equal(step(r, 'auth').status, 'ok')
  })

  test('a user that cannot list databases gets a warning, not a failure', async () => {
    if (!ON) return
    const r = await check(conn('reader', 'localhost', 27019, (d) => {
      d.auth.mechanism = 'DEFAULT'
      d.auth.username = 'reader'
      d.auth.authSource = 'shop'
    }), { password: 'reader-dev-only' })
    assert.equal(step(r, 'auth').status, 'ok')
    // read@shop may list the databases it has privileges on only; the driver asks for exactly that.
    assert.ok(['ok', 'warning'].includes(step(r, 'permissions').status))
    assert.equal(r.ok, true)
  })

  test('server needs auth but none is set', async () => {
    if (!ON) return
    const r = await check(conn('noauth', 'localhost', 27019))
    assert.equal(step(r, 'permissions').status, 'warning')
    assert.match(step(r, 'permissions').hint!, /requires sign-in/)
  })

  test('TLS server without TLS on', async () => {
    if (!ON) return
    const r = await check(conn('plain', 'localhost', 27018))
    assert.equal(step(r, 'handshake').status, 'failed')
  })

  test('TLS without the CA explains the self-signed chain', async () => {
    if (!ON) return
    const r = await check(conn('tls', 'localhost', 27018, (d) => { d.tls.enabled = true }))
    assert.equal(step(r, 'tls').status, 'failed')
    assert.match(step(r, 'tls').hint!, /Add .*CA/)
  })

  test('TLS host name mismatch, and allowing it', async () => {
    if (!ON) return
    const edit = (d: ConnectionDef) => {
      d.tls.enabled = true
      d.tls.ca = { kind: 'inline' }
    }
    // The certificate names localhost and 127.0.0.1, not ::1-style aliases like this one.
    const r = await check(conn('tls', 'localhost.localdomain', 27018, edit), { tlsCaPem: pem('ca.pem') })
    if (step(r, 'dns').status === 'failed') return // the alias does not resolve on this machine
    assert.equal(step(r, 'tls').status, 'failed')
    assert.match(step(r, 'tls').hint!, /not issued for this host name/)
    const relaxed = await check(conn('tls', 'localhost.localdomain', 27018, (d) => { edit(d); d.tls.allowInvalidHostnames = true }), { tlsCaPem: pem('ca.pem') })
    assert.equal(step(relaxed, 'tls').status, 'warning')
  })

  test('X.509 with pasted PEMs', async () => {
    if (!ON) return
    const r = await check(conn('x509', 'localhost', 27018, (d) => {
      d.tls.enabled = true
      d.tls.ca = { kind: 'inline' }
      d.tls.clientCert = { kind: 'inline' }
      d.auth.mechanism = 'MONGODB-X509'
    }), { tlsCaPem: pem('ca.pem'), tlsCertPem: pem('client.pem') })
    assert.equal(statuses(r), 'dns:ok ssh:skipped tcp:ok tls:ok handshake:ok auth:ok permissions:ok')
    assert.match(step(r, 'auth').detail, /CN=studio-client/)
  })

  test('X.509 with file paths and an encrypted key', async () => {
    if (!ON) return
    const def = conn('x509', 'localhost', 27018, (d) => {
      d.tls.enabled = true
      d.tls.ca = { kind: 'path', path: join(CERTS, 'ca.pem') }
      d.tls.clientCert = { kind: 'path', path: join(CERTS, 'client-encrypted.pem') }
      d.auth.mechanism = 'MONGODB-X509'
    })
    assert.equal(step(await check(def, { tlsKeyPassword: 'key-pass-dev' }), 'auth').status, 'ok')
    const wrong = await check(def, { tlsKeyPassword: 'nope' })
    assert.equal(wrong.ok, false)
    const missing = await check(conn('x509', 'localhost', 27018, (d) => {
      d.tls.enabled = true
      d.tls.ca = { kind: 'path', path: '/nonexistent/ca.pem' }
    }))
    assert.match(step(missing, 'tls').detail, /Can't read the CA certificate at \/nonexistent\/ca.pem: ENOENT/)
  })

  test('SSH tunnel with a password, host key pinned on first use', async () => {
    if (!ON) return
    const def = conn('ssh', 'mongo', 27017, (d) => {
      d.options.directConnection = true
      d.ssh = { ...d.ssh, enabled: true, host: '127.0.0.1', port: 2222, username: 'studio', method: 'password' }
    })
    const first = await check(def, { sshPassword: 'studio-ssh-pw' })
    assert.equal(statuses(first), 'dns:skipped ssh:ok tcp:ok tls:skipped handshake:ok auth:skipped permissions:ok')
    assert.match(first.sshHostKey ?? '', /^[0-9a-f]{64}$/)
    assert.match(step(first, 'ssh').detail, /new: it will be trusted/)

    def.ssh.knownHostKey = first.sshHostKey!
    const again = await check(def, { sshPassword: 'studio-ssh-pw' })
    assert.match(step(again, 'ssh').detail, /matches the saved key/)

    def.ssh.knownHostKey = 'ab'.repeat(32)
    const changed = await check(def, { sshPassword: 'studio-ssh-pw' })
    assert.equal(step(changed, 'ssh').status, 'failed')
    assert.match(step(changed, 'ssh').hint!, /different key than before/)

    def.ssh.knownHostKey = ''
    const badPw = await check(def, { sshPassword: 'wrong' })
    assert.match(step(badPw, 'ssh').hint!, /refused the user name, password or key/)
  })

  test('SSH with a private key and passphrase, and a forward the bastion cannot reach', async () => {
    if (!ON) return
    const def = conn('sshkey', 'mongo', 27017, (d) => {
      d.options.directConnection = true
      d.ssh = { ...d.ssh, enabled: true, host: '127.0.0.1', port: 2222, username: 'studio', method: 'privateKey', privateKey: { kind: 'path', path: join(CERTS, 'id_ed25519_pass') } }
    })
    assert.equal((await check(def, { sshPassphrase: 'ssh-pass-dev' })).ok, true)
    const inline = conn('sshkey', 'mongo', 27017, (d) => {
      d.options.directConnection = true
      d.ssh = { ...d.ssh, enabled: true, host: '127.0.0.1', port: 2222, username: 'studio', method: 'privateKey', privateKey: { kind: 'inline' } }
    })
    assert.equal((await check(inline, { sshPrivateKey: pem('id_ed25519') })).ok, true)
    def.hosts = [{ host: 'mongo', port: 27999 }]
    const refused = await check(def, { sshPassphrase: 'ssh-pass-dev' })
    assert.equal(step(refused, 'tcp').status, 'failed')
  })

  test('TLS through SSH checks the certificate against the real host name', async () => {
    if (!ON) return
    const r = await check(conn('tls-ssh', 'mongo-tls', 27017, (d) => {
      d.ssh = { ...d.ssh, enabled: true, host: '127.0.0.1', port: 2222, username: 'studio', method: 'password' }
      d.tls.enabled = true
      d.tls.ca = { kind: 'inline' }
      d.tls.clientCert = { kind: 'inline' }
      d.auth.mechanism = 'MONGODB-X509'
    }), { sshPassword: 'studio-ssh-pw', tlsCaPem: pem('ca.pem'), tlsCertPem: pem('client.pem') })
    assert.equal(statuses(r), 'dns:skipped ssh:ok tcp:ok tls:ok handshake:ok auth:ok permissions:ok')
  })
})

describe('tree', () => {
  test('browses the seeded dev database', async () => {
    if (!ON) return
    const w = await worker()
    try {
      const saved = await w.request('connections.save', {
        def: conn('dev', 'localhost', 27017, (d) => { d.topology = 'replicaSet'; d.replicaSet = 'rs0' }),
        secrets: {}
      })
      assert.ok(saved.ok)
      if (!saved.ok) return
      const root = `conn:${saved.id}`
      const dbs = (await w.request('tree.children', { key: root })).nodes
      assert.deepEqual(dbs.map((n) => n.label).filter((n) => ['shop', 'blog', 'analytics', 'types_zoo'].includes(n)), ['analytics', 'blog', 'shop', 'types_zoo'])
      assert.ok((await w.request('connections.state')).connections[0]!.connected)

      const shop = dbs.find((n) => n.label === 'shop')!
      const colls = (await w.request('tree.children', { key: shop.key })).nodes
      const byLabel = Object.fromEntries(colls.map((n) => [n.label, n]))
      assert.equal(byLabel.attachments!.kind, 'bucket')
      assert.match(byLabel.attachments!.description!, /GridFS · 3 files/)
      assert.equal(byLabel.order_totals_by_month!.kind, 'view')
      assert.match(byLabel.orders!.description!, /^20,000 docs · /)
      assert.match(byLabel.events_log!.description!, /capped/)
      assert.equal(byLabel['attachments.files'], undefined, 'bucket collections sit under the bucket')
      assert.deepEqual(colls.slice(-2).map((n) => n.kind), ['users', 'roles'])

      const analytics = (await w.request('tree.children', { key: dbs.find((n) => n.label === 'analytics')!.key })).nodes
      assert.equal(analytics.find((n) => n.label === 'pageviews')!.kind, 'timeseries')
      assert.equal(analytics.some((n) => n.label.startsWith('system.')), false)

      const [indexesFolder] = (await w.request('tree.children', { key: byLabel.customers!.key })).nodes
      assert.equal(indexesFolder!.description, '8 indexes')
      const indexes = (await w.request('tree.children', { key: indexesFolder!.key })).nodes
      const flags = Object.fromEntries(indexes.map((n) => [n.label, n.description ?? '']))
      assert.match(flags.email_unique!, /unique/)
      assert.match(flags.location_2dsphere!, /2dsphere/)
      assert.match(flags.externalId_hashed!, /hashed/)
      assert.match(flags.phone_partial!, /partial/)
      assert.match(flags.tags_hidden!, /hidden/)
      assert.match(flags.lastname_ci!, /collation fr/)

      const users = (await w.request('tree.children', { key: colls.at(-2)!.key })).nodes
      assert.deepEqual(users.map((u) => u.label).sort(), ['app', 'reporter'])
      const adminRoles = (await w.request('tree.children', { key: `${root}/db:admin/roles` })).nodes
      assert.deepEqual(adminRoles.map((r) => r.label), ['shopReporter'])

      const details = await w.request('tree.details', { key: indexes.find((n) => n.label === 'email_unique')!.key })
      assert.match(details.json!, /"unique": true/)
      const view = await w.request('tree.details', { key: byLabel.order_totals_by_month!.key })
      assert.match(view.json!, /\$dateTrunc/)
      const role = await w.request('tree.details', { key: adminRoles[0]!.key })
      assert.match(role.json!, /"find"/)
      const connDetails = await w.request('tree.details', { key: root })
      assert.equal(connDetails.items[0]!.value, 'connected')

      await w.request('connections.disconnect', { id: saved.id })
      assert.equal((await w.request('connections.state')).connections[0]!.connected, false)
    } finally {
      await w.deactivate()
    }
  })

  test('a limited user sees only what it may', async () => {
    if (!ON) return
    const w = await worker()
    try {
      const saved = await w.request('connections.save', {
        def: conn('reader', 'localhost', 27019, (d) => { d.auth.mechanism = 'DEFAULT'; d.auth.username = 'reader'; d.auth.authSource = 'shop' }),
        secrets: { password: 'reader-dev-only' }
      })
      assert.ok(saved.ok)
      if (!saved.ok) return
      const dbs = (await w.request('tree.children', { key: `conn:${saved.id}` })).nodes
      assert.deepEqual(dbs.filter((n) => n.kind === 'db').map((n) => n.label), ['shop'])
    } finally {
      await w.deactivate()
    }
  })
})

describe('file paths', () => {
  test('~ expands to the home folder; relative paths are refused with advice', async () => {
    const { expandPath, readPem } = await import('../src/worker/client')
    const { homedir } = await import('node:os')
    assert.equal(expandPath('~/x/ca.pem'), `${homedir()}/x/ca.pem`)
    assert.equal(expandPath('/abs/ca.pem'), '/abs/ca.pem')
    await assert.rejects(readPem({ kind: 'path', path: 'certs/ca.pem' }, undefined, 'CA certificate'), /is relative\. Use a full path/)
  })
})
