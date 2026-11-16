// Auth wiring that needs no live server: the driver options each mechanism produces, and the OIDC
// browser sign-in against a mock identity provider (discovery, PKCE, redirect, token exchange).
// Orca's test loader allows npm packages only in modules reached from the manifest's `main`;
// importing the worker entry first puts ./client and ./oidc in that graph.
import '../worker'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OIDCCallbackParams } from 'mongodb'
import { assert, describe, test } from 'orca/testing'
import { emptyConnection, type ConnectionDef } from '../shared/model'
import { driverConfig } from './client'
import { base64url, humanCallback } from './oidc'

function def(edit: (d: ConnectionDef) => void): ConnectionDef {
  const d = emptyConnection('x', 0)
  d.name = 'x'
  d.hosts = [{ host: 'db.example.com', port: 27017 }]
  edit(d)
  return d
}

describe('driver options per mechanism', () => {
  test('passwords go in options.auth, never in the URI', async () => {
    const { uri, options } = await driverConfig(def((d) => { d.auth.mechanism = 'SCRAM-SHA-256'; d.auth.username = 'app' }), { password: 'p@ss' })
    assert.equal(uri.includes('p%40ss') || uri.includes('p@ss') || uri.includes('//app@'), false)
    assert.deepEqual(options.auth, { username: 'app', password: 'p@ss' })
    assert.match(uri, /authMechanism=SCRAM-SHA-256/)
  })
  test('AWS access keys reach the driver through a credential provider', async () => {
    const { uri, options } = await driverConfig(
      def((d) => { d.auth.mechanism = 'MONGODB-AWS'; d.auth.awsSource = 'keys'; d.auth.username = 'AKIA1' }),
      { awsSecretAccessKey: 'shh', awsSessionToken: 'tok' }
    )
    assert.equal(uri, 'mongodb://db.example.com:27017/?authMechanism=MONGODB-AWS&appName=Mongo%20Studio')
    const provider = options.authMechanismProperties?.AWS_CREDENTIAL_PROVIDER
    assert.ok(provider)
    assert.deepEqual(await provider(), { accessKeyId: 'AKIA1', secretAccessKey: 'shh', sessionToken: 'tok' })
  })
  test('AWS from the environment leaves it to the AWS SDK', async () => {
    const { options } = await driverConfig(def((d) => { d.auth.mechanism = 'MONGODB-AWS' }), {})
    assert.equal(options.authMechanismProperties, undefined)
  })
  test('GSSAPI keeps the principal and service settings in the URI', async () => {
    const { uri, options } = await driverConfig(
      def((d) => { d.auth.mechanism = 'GSSAPI'; d.auth.username = 'alice@EX.COM'; d.auth.gssapiServiceName = 'mongo' }),
      {}
    )
    assert.match(uri, /^mongodb:\/\/alice%40EX.COM@db.example.com:27017\/\?authMechanism=GSSAPI&authMechanismProperties=SERVICE_NAME%3Amongo/)
    assert.equal(options.auth, undefined)
  })
  test('OIDC browser sign-in needs the panel, and allows the connection host', async () => {
    const oidc = def((d) => { d.auth.mechanism = 'MONGODB-OIDC' })
    await assert.rejects(driverConfig(oidc, {}), /panel open/)
    const { options } = await driverConfig(oidc, {}, { onOidcSignIn: () => {} })
    assert.ok(options.authMechanismProperties?.OIDC_HUMAN_CALLBACK)
    assert.ok(options.authMechanismProperties?.ALLOWED_HOSTS?.includes('db.example.com'))
  })
  test('OIDC workload identity goes in the URI', async () => {
    const { uri } = await driverConfig(def((d) => { d.auth.mechanism = 'MONGODB-OIDC'; d.auth.oidcFlow = 'azure'; d.auth.oidcTokenResource = 'api://x' }), {})
    assert.match(uri, /authMechanismProperties=ENVIRONMENT%3Aazure%2CTOKEN_RESOURCE%3Aapi%3A%2F%2Fx/)
  })
  test('without auth for the handshake step', async () => {
    const { uri, options } = await driverConfig(def((d) => { d.auth.mechanism = 'PLAIN'; d.auth.username = 'bob' }), { password: 'x' }, { withoutAuth: true })
    assert.equal(options.auth, undefined)
    assert.equal(uri.includes('authMechanism'), false)
  })
})

/** A tiny identity provider: discovery, and a token endpoint that checks PKCE. */
async function mockIdp(): Promise<{ issuer: string; server: Server; challenges: Map<string, string> }> {
  const challenges = new Map<string, string>()
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://idp')
    if (url.pathname === '/.well-known/openid-configuration') {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      res.end(JSON.stringify({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` }))
      return
    }
    if (url.pathname === '/token') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const form = new URLSearchParams(body)
        if (form.get('grant_type') === 'refresh_token') {
          res.end(JSON.stringify({ access_token: 'refreshed', expires_in: 60 }))
          return
        }
        const expected = challenges.get(form.get('code') ?? '')
        const actual = base64url(createHash('sha256').update(form.get('code_verifier') ?? '').digest())
        if (!expected || expected !== actual) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE check failed' }))
          return
        }
        res.end(JSON.stringify({ access_token: 'token-123', expires_in: 3600, refresh_token: 'r1' }))
      })
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { issuer: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, challenges }
}

describe('OIDC browser sign-in', () => {
  test('authorization code with PKCE, through the localhost redirect', async () => {
    const idp = await mockIdp()
    const port = 27000 + Math.floor(Math.random() * 900)
    try {
      let shown = ''
      const callback = humanCallback({
        redirectPort: port,
        showSignIn: (url) => {
          shown = url
          // Plays the browser: the IdP approves and redirects back with a code.
          const u = new URL(url)
          idp.challenges.set('code-1', u.searchParams.get('code_challenge') ?? '')
          void fetch(`${u.searchParams.get('redirect_uri')}?code=code-1&state=${u.searchParams.get('state')}`)
        }
      })
      const params: OIDCCallbackParams = { version: 1, timeoutContext: AbortSignal.timeout(5000), idpInfo: { issuer: idp.issuer, clientId: 'studio', requestScopes: ['mongo'] }, username: 'ada@example.com' }
      const result = await callback(params)
      assert.deepEqual(result, { accessToken: 'token-123', expiresInSeconds: 3600, refreshToken: 'r1' })
      const u = new URL(shown)
      assert.equal(u.searchParams.get('client_id'), 'studio')
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
      assert.equal(u.searchParams.get('scope'), 'openid offline_access mongo')
      assert.equal(u.searchParams.get('login_hint'), 'ada@example.com')
      assert.equal(u.searchParams.get('redirect_uri'), `http://localhost:${port}/redirect`)
    } finally {
      idp.server.close()
    }
  })

  test('uses the refresh token when it has one', async () => {
    const idp = await mockIdp()
    try {
      const callback = humanCallback({ redirectPort: 1, showSignIn: () => assert.fail('no browser needed') })
      const result = await callback({ version: 1, timeoutContext: AbortSignal.timeout(5000), idpInfo: { issuer: idp.issuer, clientId: 'studio' }, refreshToken: 'r1' })
      assert.equal(result.accessToken, 'refreshed')
    } finally {
      idp.server.close()
    }
  })

  test('a stale state is ignored and the sign-in times out cleanly', async () => {
    const idp = await mockIdp()
    const port = 27000 + Math.floor(Math.random() * 900)
    try {
      const callback = humanCallback({
        redirectPort: port,
        showSignIn: (url) => void fetch(`${new URL(url).searchParams.get('redirect_uri')}?code=x&state=forged`)
      })
      await assert.rejects(
        callback({ version: 1, timeoutContext: AbortSignal.timeout(600), idpInfo: { issuer: idp.issuer, clientId: 'studio' } }),
        /timed out or was cancelled/
      )
    } finally {
      idp.server.close()
    }
  })
})
