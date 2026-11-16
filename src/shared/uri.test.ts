// Golden tests: each connection string parses to the expected model and builds back unchanged.
import { assert, describe, test } from 'orca/testing'
import { emptyConnection, validateConnection } from './model'
import { buildConnectionString, ConnectionStringError, parseConnectionString } from './uri'

const parse = (uri: string) => parseConnectionString(uri, 'id-1', 0)

describe('connection strings round-trip', () => {
  const golden = [
    'mongodb://localhost:27017',
    'mongodb://localhost',
    'mongodb://alice@db.example.com:27018/shop?authSource=admin',
    'mongodb://a:1,b:2,c:3/?replicaSet=rs0&readPreference=secondaryPreferred',
    'mongodb://mongos1:27017,mongos2:27017',
    'mongodb+srv://cluster0.abcde.mongodb.net/app?appName=Studio',
    'mongodb+srv://cluster0.abcde.mongodb.net/?tls=false',
    'mongodb://[::1]:27017/?directConnection=true',
    'mongodb://u@h/?authSource=%24external&authMechanism=PLAIN',
    'mongodb://h/?authMechanism=MONGODB-X509&tls=true&tlsCAFile=%2Fetc%2Fca.pem&tlsCertificateKeyFile=%2Fhome%2Fme%2Fclient.pem',
    'mongodb+srv://c.mongodb.net/?authMechanism=MONGODB-OIDC&authMechanismProperties=ENVIRONMENT%3Aazure%2CTOKEN_RESOURCE%3Aapi%3A%2F%2Fmongo',
    'mongodb://user@kdc.example.com/?authMechanism=GSSAPI&authMechanismProperties=SERVICE_NAME%3Amongodb%2CCANONICALIZE_HOST_NAME%3Aforward',
    'mongodb://h/?tls=true&tlsAllowInvalidHostnames=true&tlsAllowInvalidCertificates=true',
    'mongodb://h/?connectTimeoutMS=5000&serverSelectionTimeoutMS=8000&socketTimeoutMS=0',
    'mongodb://h/?w=majority&retryWrites=false&compressors=zstd'
  ]
  for (const uri of golden) {
    test(uri, () => {
      const { def } = parse(uri)
      assert.equal(buildConnectionString(def), uri)
    })
  }
})

describe('parsing', () => {
  test('extracts the password into secrets, never into the model', () => {
    const { def, secrets } = parse('mongodb://alice:p%40ss%3Aw0rd@localhost/?authSource=admin')
    assert.equal(def.auth.username, 'alice')
    assert.equal(def.auth.mechanism, 'DEFAULT')
    assert.deepEqual(secrets, { password: 'p@ss:w0rd' })
    assert.equal(JSON.stringify(def).includes('p@ss'), false)
    assert.equal(buildConnectionString(def), 'mongodb://alice@localhost/?authSource=admin')
    assert.equal(buildConnectionString(def, { maskPassword: true }), 'mongodb://alice:****@localhost/?authSource=admin')
    assert.equal(buildConnectionString(def, { password: 'p@ss:w0rd' }), 'mongodb://alice:p%40ss%3Aw0rd@localhost/?authSource=admin')
  })
  test('user info may contain @ (the last one ends it)', () => {
    const { def, secrets } = parse('mongodb://me%40corp:a@b@host:1/')
    assert.equal(def.auth.username, 'me@corp')
    assert.equal(secrets.password, 'a@b')
    assert.deepEqual(def.hosts, [{ host: 'host', port: 1 }])
  })
  test('detects topology', () => {
    assert.equal(parse('mongodb://h').def.topology, 'standalone')
    assert.equal(parse('mongodb://a,b/?replicaSet=x').def.topology, 'replicaSet')
    assert.equal(parse('mongodb://a,b').def.topology, 'sharded')
    assert.equal(parse('mongodb+srv://c.example.com').def.topology, 'srv')
  })
  test('srv turns TLS on unless told otherwise', () => {
    assert.equal(parse('mongodb+srv://c.example.com').def.tls.enabled, true)
    const off = parse('mongodb+srv://c.example.com/?tls=false')
    assert.equal(off.def.tls.enabled, false)
    assert.equal(off.warnings.length, 1)
  })
  test('ssl= is an alias of tls=, and option names ignore case', () => {
    assert.equal(parse('mongodb://h/?SSL=true').def.tls.enabled, true)
    assert.equal(parse('mongodb://h/?REPLICASET=rs1').def.replicaSet, 'rs1')
  })
  test('tlsInsecure relaxes both checks', () => {
    const { def } = parse('mongodb://h/?tls=true&tlsInsecure=true')
    assert.equal(def.tls.allowInvalidCertificates, true)
    assert.equal(def.tls.allowInvalidHostnames, true)
  })
  test('AWS keys go to secrets, the key id to the user name', () => {
    const { def, secrets } = parse('mongodb://AKIA123:s3cr%2Bt@h/?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN:tok')
    assert.equal(def.auth.awsSource, 'keys')
    assert.equal(def.auth.username, 'AKIA123')
    assert.deepEqual(secrets, { awsSecretAccessKey: 's3cr+t', awsSessionToken: 'tok' })
    // Driver v7 refuses AWS keys in the URI: the built string carries neither.
    assert.equal(buildConnectionString(def), 'mongodb://h/?authMechanism=MONGODB-AWS')
  })
  test('key passwords are secrets', () => {
    const { secrets } = parse('mongodb://h/?tls=true&tlsCertificateKeyFilePassword=k3y')
    assert.equal(secrets.tlsKeyPassword, 'k3y')
  })
  test('database names are decoded', () => {
    assert.equal(parse('mongodb://h/my%20db').def.options.defaultDatabase, 'my db')
  })
  test('bad strings fail with a sentence', () => {
    const bad: [string, RegExp][] = [
      ['http://h', /starts with mongodb/],
      ['mongodb://', /no host/],
      ['mongodb://h:99999', /port/],
      ['mongodb+srv://h:27017', /must not have a port/],
      ['mongodb+srv://a,b', /exactly one host/],
      ['mongodb://h/?authMechanism=NOPE', /Unknown authMechanism/],
      ['mongodb://h,/', /empty/],
      ['mongodb://%zz@h', /%-escape/]
    ]
    for (const [uri, message] of bad) {
      assert.throws(() => parse(uri), (e: unknown) => e instanceof ConnectionStringError && message.test((e as Error).message))
    }
  })
  test('warns on values it cannot use', () => {
    const { warnings, def } = parse('mongodb://h/?readPreference=fastest&connectTimeoutMS=soon&directConnection=maybe')
    assert.equal(warnings.length, 3)
    assert.equal(def.options.readPreference, 'primary')
    assert.equal(def.options.connectTimeoutMS, null)
  })
})

describe('validation', () => {
  test('a fresh connection only needs a name', () => {
    const def = emptyConnection('x', 0)
    assert.deepEqual(validateConnection(def, {}).map((e) => e.field), ['name'])
    def.name = 'Local'
    assert.deepEqual(validateConnection(def, {}), [])
  })
  test('names the fields to fix', () => {
    const def = emptyConnection('x', 0)
    def.name = 'n'
    def.topology = 'replicaSet'
    def.auth.mechanism = 'MONGODB-X509'
    def.ssh.enabled = true
    def.ssh.method = 'privateKey'
    const fields = validateConnection(def, {}).map((e) => e.field)
    assert.deepEqual(fields, ['replicaSet', 'tls.clientCert', 'tls.enabled', 'ssh.host', 'ssh.username', 'ssh.privateKey'])
  })
  test('pasted secrets count only once saved or drafted', () => {
    const def = emptyConnection('x', 0)
    def.name = 'n'
    def.tls.enabled = true
    def.tls.ca = { kind: 'inline' }
    assert.equal(validateConnection(def, {})[0]?.field, 'tls.ca')
    assert.deepEqual(validateConnection(def, { tlsCaPem: true }), [])
  })
})
