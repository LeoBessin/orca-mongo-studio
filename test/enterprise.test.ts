// Kerberos (GSSAPI) and LDAP (PLAIN) against MongoDB Enterprise, a KDC and OpenLDAP (compose
// profile "enterprise", then dev/test-env/setup-enterprise.sh for the ticket).
// Run with MONGO_STUDIO_IT_ENTERPRISE=1 (npm run test:enterprise).
import { join } from 'node:path'
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import { emptyConnection, type ConnectionDef, type SecretDraft } from '../src/shared/model'
import * as main from '../src/worker'

const ON = process.env.MONGO_STUDIO_IT_ENTERPRISE === '1'
const ENV = join(import.meta.dirname, '..', 'dev', 'test-env')
if (ON) {
  // Read by libkrb5 when the kerberos addon first loads.
  process.env.KRB5_CONFIG = join(ENV, 'krb5-client.conf')
  process.env.KRB5CCNAME = `FILE:${join(ENV, 'out', 'krb5cc')}`
}

function conn(edit: (d: ConnectionDef) => void): ConnectionDef {
  const def = emptyConnection('', 0)
  def.name = 'enterprise'
  def.hosts = [{ host: 'localhost', port: 27020 }]
  def.options.connectTimeoutMS = 5000
  edit(def)
  return def
}

async function check(def: ConnectionDef, secrets: SecretDraft = {}) {
  const w = await mountWorker(main, { host: mockHost() })
  try {
    return await w.request('connections.test', { def, secrets })
  } finally {
    await w.deactivate()
  }
}

describe('enterprise authentication', () => {
  test('Kerberos (GSSAPI) with the ticket from kinit', async () => {
    if (!ON) return
    const r = await check(conn((d) => {
      d.auth.mechanism = 'GSSAPI'
      d.auth.username = 'alice@STUDIO.TEST'
    }))
    const auth = r.steps.find((s) => s.id === 'auth')!
    assert.equal(auth.status, 'ok', `${auth.detail} ${auth.hint ?? ''}`)
    assert.match(auth.detail, /alice@STUDIO.TEST \(\$external\)/)
  })

  test('Kerberos with a wrong service name explains the missing principal', async () => {
    if (!ON) return
    const r = await check(conn((d) => {
      d.auth.mechanism = 'GSSAPI'
      d.auth.username = 'alice@STUDIO.TEST'
      d.auth.gssapiServiceName = 'nosuchservice'
    }))
    const auth = r.steps.find((s) => s.id === 'auth')!
    assert.equal(auth.status, 'failed')
    assert.match(auth.hint ?? '', /no principal for this MongoDB host/, auth.detail)
  })

  test('LDAP (PLAIN), right and wrong password', async () => {
    if (!ON) return
    const def = conn((d) => {
      d.auth.mechanism = 'PLAIN'
      d.auth.username = 'bob'
    })
    const ok = await check(def, { password: 'bob-ldap-dev' })
    assert.equal(ok.steps.find((s) => s.id === 'auth')!.status, 'ok')
    assert.equal(ok.ok, true)
    const bad = await check(def, { password: 'nope' })
    assert.equal(bad.steps.find((s) => s.id === 'auth')!.status, 'failed')
  })
})
