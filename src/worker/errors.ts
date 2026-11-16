// Turns driver, network, TLS and SSH errors into a sentence and a next step a person can act on.

export type Diagnosis = { message: string; hint?: string }

type ErrorLike = Error & { code?: unknown; codeName?: unknown; cause?: unknown; errorLabels?: unknown; level?: unknown }

function innermost(error: unknown): ErrorLike | undefined {
  let e = error as ErrorLike | undefined
  for (let i = 0; i < 5 && e && e.cause instanceof Error; i++) e = e.cause as ErrorLike
  return e
}

/** The first network/TLS code anywhere in the cause chain (the driver wraps them). */
function systemCode(error: unknown): string | undefined {
  let e = error as ErrorLike | undefined
  for (let i = 0; i < 6 && e; i++) {
    if (typeof e.code === 'string') return e.code
    e = e.cause as ErrorLike | undefined
  }
  return undefined
}

const HINTS: Record<string, string> = {
  ECONNREFUSED: 'Nothing is listening there. Check the host and port, and that mongod or mongos is running.',
  ENOTFOUND: 'The host name does not resolve. Check its spelling, VPN, or DNS.',
  EAI_AGAIN: 'DNS did not answer in time. Check the network or VPN, then try again.',
  ETIMEDOUT: 'The server did not answer in time. A firewall, a security group, or an Atlas IP access list may be blocking this machine.',
  ECONNRESET: 'The server closed the connection. It may require TLS, or a proxy is dropping the connection.',
  EHOSTUNREACH: 'There is no route to that host. Check the network or VPN.',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'The server uses a self-signed certificate. Add it as the CA certificate under TLS.',
  SELF_SIGNED_CERT_IN_CHAIN: 'The server certificate is signed by a CA this machine does not trust. Add that CA under TLS.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The certificate chain is incomplete. Add the issuing CA under TLS.',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'The certificate issuer is unknown here. Add the CA under TLS.',
  CERT_HAS_EXPIRED: 'The server certificate has expired. Renew it on the server.',
  ERR_TLS_CERT_ALTNAME_INVALID: 'The certificate is not issued for this host name. Connect with the name in the certificate, or allow invalid host names under TLS.',
  ERR_OSSL_BAD_DECRYPT: 'The client key password is wrong.',
  ERR_OSSL_PEM_NO_START_LINE: 'That is not a PEM file. It should contain "-----BEGIN".',
  ENOENT: 'The file does not exist. Check the path.',
  EACCES: 'This user cannot read the file. Check its permissions.'
}

const SERVER_HINTS: Record<number, string> = {
  18: 'Authentication failed. Check the user name, password and auth database (authSource).',
  13: 'The user is not allowed to run this. Grant a role with the needed privilege, or use another user.',
  8000: 'Atlas rejected the credentials. Check the database user (not the Atlas account) and its password.',
  11600: 'The server is shutting down or restarting.'
}

export function diagnose(error: unknown): Diagnosis {
  const top = error as ErrorLike
  const deep = innermost(error)
  const message = deep && deep !== top && deep.message && !top.message.includes(deep.message)
    ? `${top.message} (${deep.message})`
    : top?.message ?? String(error)
  if (top?.name === 'HostKeyMismatchError') {
    return { message, hint: 'The SSH server identifies itself with a different key than before. If the server was rebuilt, forget the saved host key and test again; otherwise, do not connect.' }
  }
  if (/All configured authentication methods failed/i.test(message)) {
    return { message, hint: 'The SSH server refused the user name, password or key.' }
  }
  if (/Timed out while waiting for handshake/i.test(message)) {
    return { message, hint: 'The SSH server did not answer. Check its host, port and firewall.' }
  }
  if (/Cannot parse privateKey|Encrypted private OpenSSH key detected, but no passphrase/i.test(message)) {
    return { message, hint: 'The SSH private key cannot be read. Check the key and its passphrase.' }
  }
  if (/No Kerberos credentials|Credentials cache file .* not found|ticket expired|Ticket expired/i.test(message)) {
    return { message, hint: 'There is no valid Kerberos ticket on this computer. Run "kinit <your principal>" in a terminal, then test again.' }
  }
  if (/Server (\S+ )?not found in Kerberos database/i.test(message)) {
    return { message, hint: 'The KDC has no principal for this MongoDB host. Check the service name, the host name (or turn on host name canonicalization) and the realm.' }
  }
  if (/Cannot contact any KDC|Cannot find KDC/i.test(message)) {
    return { message, hint: 'This computer cannot reach a Kerberos KDC for the realm. Check /etc/krb5.conf (or KRB5_CONFIG) and the network.' }
  }
  if (/Optional module `kerberos` not found|kerberos.*not found/i.test(message)) {
    return { message, hint: 'The Kerberos library is missing from this Mongo Studio build for your platform.' }
  }
  if (/LDAP/i.test(message) && /Authentication failed|bind/i.test(message)) {
    return { message, hint: 'The LDAP server refused the user name or password. LDAP users sign in with authSource $external.' }
  }
  if (typeof top?.code === 'number' && SERVER_HINTS[top.code]) return { message, hint: SERVER_HINTS[top.code] }
  const code = systemCode(error)
  if (code && HINTS[code]) return { message, hint: HINTS[code] }
  if (/querySrv|queryTxt/i.test(message)) {
    return { message, hint: 'The SRV record for this host was not found. Check the cluster host name (it starts after "mongodb+srv://").' }
  }
  if (/replica set name|setName/i.test(message)) {
    return { message, hint: 'The replica set name does not match the server. Use the name rs.status().set shows.' }
  }
  if (/Server selection timed out/i.test(message)) {
    return { message, hint: 'No server answered in time. Check the address, the TLS setting, and the replica set name.' }
  }
  return { message }
}
