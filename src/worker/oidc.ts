// OIDC browser sign-in (authorization code + PKCE) for MONGODB-OIDC human flow. The server tells
// the driver which identity provider to use (idpInfo); the worker discovers its endpoints, listens
// on localhost for the redirect, and the panel shows the sign-in link (opening a browser needs a
// press in a panel). Tokens stay in this process; nothing is written to disk.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { OIDCCallbackParams, OIDCResponse } from 'mongodb'

export type OidcEndpoints = { authorization_endpoint: string; token_endpoint: string }

export function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function authorizationUrl(
  endpoint: string,
  params: { clientId: string; redirectUri: string; scopes: readonly string[]; challenge: string; state: string; loginHint?: string }
): string {
  const url = new URL(endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('scope', ['openid', 'offline_access', ...params.scopes].join(' '))
  url.searchParams.set('code_challenge', params.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', params.state)
  if (params.loginHint) url.searchParams.set('login_hint', params.loginHint)
  return url.toString()
}

async function discover(issuer: string, signal: AbortSignal): Promise<OidcEndpoints> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`The identity provider's discovery document (${url}) answered ${res.status}.`)
  const doc = (await res.json()) as Partial<OidcEndpoints>
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error(`The identity provider at ${issuer} does not list its authorization and token endpoints.`)
  }
  return { authorization_endpoint: doc.authorization_endpoint, token_endpoint: doc.token_endpoint }
}

async function tokenRequest(endpoint: string, body: Record<string, string>, signal: AbortSignal): Promise<OIDCResponse> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    signal
  })
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    refresh_token?: string
    error?: string
    error_description?: string
  }
  if (!res.ok || !json.access_token) {
    throw new Error(`The identity provider refused the sign-in: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}.`)
  }
  const out: OIDCResponse = { accessToken: json.access_token }
  if (json.expires_in !== undefined) out.expiresInSeconds = json.expires_in
  if (json.refresh_token !== undefined) out.refreshToken = json.refresh_token
  return out
}

/** Waits for one `GET /redirect?code&state` on 127.0.0.1:port and answers the browser. */
function awaitRedirect(port: number, state: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const page = (res: ServerResponse, status: number, text: string): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><title>Mongo Studio</title><p style="font:16px system-ui;margin:3rem">${text}</p>`)
    }
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`)
      if (url.pathname !== '/redirect') return page(res, 404, 'Not found.')
      const error = url.searchParams.get('error')
      if (error) {
        page(res, 400, 'Sign-in failed. You can close this tab.')
        finish(new Error(`The identity provider returned ${error}: ${url.searchParams.get('error_description') ?? ''}`.trim()))
        return
      }
      if (url.searchParams.get('state') !== state) return page(res, 400, 'This sign-in link is stale. Start again from Orca.')
      const code = url.searchParams.get('code')
      if (!code) return page(res, 400, 'The redirect has no code.')
      page(res, 200, 'Signed in. You can close this tab and return to Orca.')
      finish(null, code)
    })
    const onAbort = (): void => finish(new Error('The sign-in timed out or was cancelled.'))
    let done = false
    function finish(error: Error | null, code?: string): void {
      if (done) return
      done = true
      signal.removeEventListener('abort', onAbort)
      server.close()
      if (error) reject(error)
      else resolve(code ?? '')
    }
    signal.addEventListener('abort', onAbort)
    server.once('error', (e: Error) => finish(new Error(`Can't listen on localhost:${port} for the sign-in redirect: ${e.message}`)))
    server.listen(port, '127.0.0.1')
  })
}

export type BrowserSignIn = {
  redirectPort: number
  /** Called with the page the person must open. */
  showSignIn: (url: string) => void
}

export function humanCallback(options: BrowserSignIn): (params: OIDCCallbackParams) => Promise<OIDCResponse> {
  return async (params) => {
    const idp = params.idpInfo
    if (!idp?.clientId) throw new Error('The server did not name an OIDC client id, so browser sign-in is not possible.')
    const signal = params.timeoutContext
    const endpoints = await discover(idp.issuer, signal)
    if (params.refreshToken) {
      try {
        return await tokenRequest(endpoints.token_endpoint, { grant_type: 'refresh_token', refresh_token: params.refreshToken, client_id: idp.clientId }, signal)
      } catch {
        // Fall through to a fresh sign-in.
      }
    }
    const redirectUri = `http://localhost:${options.redirectPort}/redirect`
    const { verifier, challenge } = pkcePair()
    const state = base64url(randomBytes(16))
    const waiting = awaitRedirect(options.redirectPort, state, signal)
    options.showSignIn(
      authorizationUrl(endpoints.authorization_endpoint, {
        clientId: idp.clientId,
        redirectUri,
        scopes: idp.requestScopes ?? [],
        challenge,
        state,
        ...(params.username ? { loginHint: params.username } : {})
      })
    )
    const code = await waiting
    return tokenRequest(
      endpoints.token_endpoint,
      { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: idp.clientId, code_verifier: verifier },
      signal
    )
  }
}
