// Saved connections (storage:own) and their secrets (secrets:own). The worker is the only writer;
// panels learn about changes through `connections.changed`. When Orca reports that secrets can't
// be encrypted on this machine, they stay in this process's memory only and are never written.
import type { OrcaWorkerApi } from 'orca/worker'
import type { FavouriteNode } from '../protocol'
import { isObject, toJson } from './json'
import {
  cloneDef,
  emptyConnection,
  SECRET_KEYS,
  type ConnectionDef,
  type SecretDraft,
  type SecretFlags,
  type SecretKey
} from '../shared/model'

const CONNECTIONS = 'connections.v1'
const FAVOURITES = 'favourites.v1'

type StoredConnections = { items: ConnectionDef[] }

export function secretStorageKey(id: string, key: SecretKey): string {
  return `conn.${id}.${key}`
}

export class ConnectionStore {
  private queue: Promise<unknown> = Promise.resolve()
  private memorySecrets = new Map<string, string>()
  private protection: 'os-keyring' | 'unavailable' | undefined

  constructor(private readonly orca: OrcaWorkerApi) {}

  /** Serializes writes so two quick saves can't lose one another. */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  async secretsProtection(): Promise<'os-keyring' | 'unavailable'> {
    if (this.protection) return this.protection
    try {
      const { status } = await this.orca.host.call('secrets.protection')
      this.protection = status
    } catch {
      this.protection = 'unavailable'
    }
    return this.protection
  }

  async list(): Promise<ConnectionDef[]> {
    const raw = await this.orca.storage.get(CONNECTIONS)
    const items = isObject(raw) && Array.isArray(raw.items) ? raw.items : []
    // Older or partial records get the current defaults for fields they lack.
    return items.filter(isStoredDef).map((d) => withDefaults(d))
  }

  async get(id: string): Promise<ConnectionDef | undefined> {
    return (await this.list()).find((d) => d.id === id)
  }

  private async writeAll(items: ConnectionDef[]): Promise<void> {
    const value: StoredConnections = { items }
    await this.orca.storage.set(CONNECTIONS, toJson(value))
  }

  put(def: ConnectionDef): Promise<void> {
    return this.exclusive(async () => {
      const items = await this.list()
      const at = items.findIndex((d) => d.id === def.id)
      if (at >= 0) items[at] = cloneDef(def)
      else items.push(cloneDef(def))
      await this.writeAll(items)
    })
  }

  putMany(defs: readonly ConnectionDef[]): Promise<void> {
    return this.exclusive(async () => {
      const items = await this.list()
      for (const def of defs) {
        const at = items.findIndex((d) => d.id === def.id)
        if (at >= 0) items[at] = cloneDef(def)
        else items.push(cloneDef(def))
      }
      await this.writeAll(items)
    })
  }

  remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      await this.writeAll((await this.list()).filter((d) => d.id !== id))
      await Promise.all(SECRET_KEYS.map((k) => this.deleteSecret(id, k)))
      const favs = (await this.favourites()).filter((f) => !f.key.startsWith(`conn:${encodeURIComponent(id)}`))
      await this.orca.storage.set(FAVOURITES, toJson(favs))
    })
  }

  async getSecret(id: string, key: SecretKey): Promise<string | null> {
    const storageKey = secretStorageKey(id, key)
    if ((await this.secretsProtection()) === 'unavailable') return this.memorySecrets.get(storageKey) ?? null
    return this.orca.secrets.get(storageKey)
  }

  private async deleteSecret(id: string, key: SecretKey): Promise<void> {
    const storageKey = secretStorageKey(id, key)
    this.memorySecrets.delete(storageKey)
    if ((await this.secretsProtection()) === 'os-keyring') await this.orca.secrets.delete(storageKey)
  }

  /** Applies a draft: strings set, `null` clears, absent keys stay as they are. */
  async applySecrets(id: string, draft: SecretDraft): Promise<void> {
    const secure = (await this.secretsProtection()) === 'os-keyring'
    for (const key of SECRET_KEYS) {
      const value = draft[key]
      if (value === undefined) continue
      if (value === null || value === '') {
        await this.deleteSecret(id, key)
      } else if (secure) {
        await this.orca.secrets.set(secretStorageKey(id, key), value)
      } else {
        this.memorySecrets.set(secretStorageKey(id, key), value)
      }
    }
  }

  async secretFlags(id: string | undefined, draft: SecretDraft = {}): Promise<SecretFlags> {
    const flags: SecretFlags = {}
    for (const key of SECRET_KEYS) {
      const pending = draft[key]
      if (pending !== undefined) flags[key] = pending !== null && pending !== ''
      else if (id) flags[key] = (await this.getSecret(id, key)) !== null
    }
    return flags
  }

  /** Saved secrets with a draft laid over them, for testing an unsaved edit. */
  async resolveSecrets(id: string | undefined, draft: SecretDraft): Promise<Partial<Record<SecretKey, string>>> {
    const out: Partial<Record<SecretKey, string>> = {}
    for (const key of SECRET_KEYS) {
      const pending = draft[key]
      const value = pending !== undefined ? pending : id ? await this.getSecret(id, key) : null
      if (value) out[key] = value
    }
    return out
  }

  async copySecrets(from: string, to: string): Promise<void> {
    const draft: SecretDraft = {}
    for (const key of SECRET_KEYS) {
      const value = await this.getSecret(from, key)
      if (value !== null) draft[key] = value
    }
    await this.applySecrets(to, draft)
  }

  async favourites(): Promise<FavouriteNode[]> {
    const raw = await this.orca.storage.get(FAVOURITES)
    return Array.isArray(raw) ? raw.filter(isFavourite) : []
  }

  toggleFavourite(node: FavouriteNode): Promise<FavouriteNode[]> {
    return this.exclusive(async () => {
      const favs = await this.favourites()
      const next = favs.some((f) => f.key === node.key) ? favs.filter((f) => f.key !== node.key) : [...favs, node]
      await this.orca.storage.set(FAVOURITES, toJson(next))
      return next
    })
  }
}

function isStoredDef(value: unknown): value is ConnectionDef {
  return isObject(value) && typeof value.id === 'string' && typeof value.name === 'string' && Array.isArray(value.hosts)
}

function isFavourite(value: unknown): value is FavouriteNode {
  return isObject(value) && typeof value.key === 'string' && typeof value.label === 'string' && typeof value.kind === 'string'
}

function withDefaults(raw: ConnectionDef): ConnectionDef {
  const base = emptyConnection(raw.id, raw.createdAt ?? 0)
  return {
    ...base,
    ...raw,
    auth: { ...base.auth, ...raw.auth },
    tls: { ...base.tls, ...raw.tls },
    ssh: { ...base.ssh, ...raw.ssh },
    options: { ...base.options, ...raw.options }
  }
}
