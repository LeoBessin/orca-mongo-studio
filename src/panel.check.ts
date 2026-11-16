// `orca plugin check` and `orca plugin shot --scenario` render the panel once per scenario.
import { defineCheck } from 'orca/testing'
import { emptyConnection } from './shared/model'

const now = Date.UTC(2026, 10, 16)
const local = { ...emptyConnection('local', now), name: 'Local dev (rs0)', topology: 'replicaSet' as const, replicaSet: 'rs0' }
const atlas = { ...emptyConnection('atlas', now), name: 'Atlas staging', group: 'Clients', topology: 'srv' as const, hosts: [{ host: 'cluster0.abcde.mongodb.net' }] }
atlas.auth = { ...atlas.auth, mechanism: 'SCRAM-SHA-256', username: 'reporter' }
atlas.tls = { ...atlas.tls, enabled: true }
const bastion = { ...emptyConnection('bastion', now), name: 'Billing (via bastion)', group: 'Clients', hosts: [{ host: '10.0.3.12', port: 27017 }] }
bastion.ssh = { ...bastion.ssh, enabled: true, host: 'bastion.example.com', username: 'deploy', method: 'privateKey', privateKey: { kind: 'path', path: '~/.ssh/id_ed25519' } }

export default defineCheck({
  empty: {},
  connections: { storage: { 'connections.v1': { items: [local, atlas, bastion] } } },
  noKeyring: {
    storage: { 'connections.v1': { items: [local] } },
    results: { 'secrets.protection': { status: 'unavailable' } }
  }
})
