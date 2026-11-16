// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// Secrets only ever travel panel -> worker (as a SecretDraft); answers carry SecretFlags.
import type { JsonObject, JsonValue } from './shared/ejson-view'
import type { ConnectionDef, FieldError, SecretDraft, SecretFlags } from './shared/model'
import type { NodeKind } from './shared/nodes'

export type ConnectionSummary = {
  id: string
  name: string
  group: string
  subtitle: string
  topology: ConnectionDef['topology']
  connected: boolean
}

export type ConnectionsState = {
  connections: ConnectionSummary[]
  /** Node keys the person starred, with what to show for them. */
  favourites: FavouriteNode[]
  /** `unavailable`: Orca can't encrypt secrets here, so they last only until the worker stops. */
  secretsProtection: 'os-keyring' | 'unavailable'
}

export type FavouriteNode = { key: string; label: string; kind: NodeKind; path: string }

export type TreeNode = {
  key: string
  kind: NodeKind
  label: string
  description?: string
  /** Children exist but load on expand. */
  hasChildren: boolean
  /** Rows the person can't act on, such as an error or "no permission" message. */
  disabled?: boolean
}

export type DetailItem = { label: string; value: string | number | boolean | null; code?: boolean; tone?: 'success' | 'warning' | 'danger' }
export type NodeDetails = {
  title: string
  subtitle: string
  items: DetailItem[]
  /** Extended JSON of the node's definition (index spec, user, role, view pipeline), if any. */
  json?: string
}

export type TestStatus = 'ok' | 'warning' | 'failed' | 'skipped'
export type TestStep = {
  id: 'dns' | 'ssh' | 'tcp' | 'tls' | 'handshake' | 'auth' | 'permissions'
  title: string
  status: TestStatus
  ms: number
  detail: string
  /** What to check next, when the step failed or warned. */
  hint?: string
}
export type TestReport = {
  ok: boolean
  steps: TestStep[]
  server?: { version: string; topology: string; setName?: string }
  /** First-time SSH host key, now trusted for this connection after save. */
  sshHostKey?: string
}

export type ImportReport = { imported: { id: string; name: string; warnings: string[] }[]; errors: string[] }

export type SaveResult = { ok: true; id: string } | { ok: false; errors: FieldError[] }

/** A collection, view or time-series collection on a saved connection. */
export type Namespace = { connectionId: string; db: string; collection: string }

/**
 * A find, parsed by the panel from shell syntax into canonical Extended JSON. `limit: 0` means
 * no limit; the worker reads pages within it.
 */
export type QuerySpec = {
  filter: JsonObject
  projection?: JsonObject
  sort?: JsonObject
  collation?: JsonObject
  skip: number
  limit: number
}

/** What the person typed, kept in history and saved queries as written. */
export type QueryText = { filter: string; projection: string; sort: string; collation: string; skip: string; limit: string }
export type HistoryEntry = { at: number; query: QueryText }
export type SavedQuery = { name: string; at: number; query: QueryText }
export type QueryLibrary = { history: HistoryEntry[]; saved: SavedQuery[] }

export type QueryPage = {
  queryId: string
  /** Where this page starts, counted from the first result (after the query's own skip). */
  offset: number
  /** Canonical Extended JSON. Values too big for a page are `{ $msTruncated: ... }`. */
  docs: JsonObject[]
  /** Indexes in `docs` of documents with truncated values; editing fetches them in full. */
  truncated: number[]
  hasMore: boolean
  /** The page stopped before `pageSize` documents to stay under the answer size limit. */
  stoppedForSize: boolean
  ms: number
}

export type CountResult = { count: number | null; approximate: boolean; ms: number; error?: string }

export type WriteResult = { matched: number; modified: number }

declare module 'orca' {
  interface PluginRequests {
    'connections.state': { output: ConnectionsState }
    /** A saved definition and which of its secrets are set (never their values). */
    'connections.get': { input: { id: string }; output: { def: ConnectionDef; secrets: SecretFlags } }
    'connections.save': { input: { def: ConnectionDef; secrets: SecretDraft }; output: SaveResult }
    'connections.clone': { input: { id: string }; output: { id: string } }
    'connections.delete': { input: { id: string }; output: null }
    /** Renames a group on every connection in it (`to: ''` ungroups them). */
    'connections.renameGroup': { input: { from: string; to: string }; output: null }
    'connections.import': { input: { text: string }; output: ImportReport }
    /** JSON with every definition named, or all; secrets are never included. */
    'connections.export': { input: { ids?: string[] }; output: { json: string; count: number } }
    /** Tests an unsaved draft; `id` lets it reuse that connection's saved secrets. */
    'connections.test': { input: { def: ConnectionDef; secrets: SecretDraft; id?: string }; output: TestReport }
    'connections.connect': { input: { id: string }; output: null }
    'connections.disconnect': { input: { id: string }; output: null }
    'connections.forgetHostKey': { input: { id: string }; output: null }
    'tree.children': { input: { key: string }; output: { nodes: TreeNode[] } }
    'tree.details': { input: { key: string }; output: NodeDetails }
    /** Runs a find and answers its first page; `text` is recorded in the query history. */
    'query.run': { input: { ns: Namespace; spec: QuerySpec; pageSize: number; text?: QueryText }; output: QueryPage }
    /** Another page of a query: read on from its cursor, or re-run with skip when needed. */
    'query.page': { input: { queryId: string; ns: Namespace; spec: QuerySpec; offset: number; pageSize: number }; output: QueryPage }
    /** Counted separately, with a time limit, so the first page never waits for it. */
    'query.count': { input: { ns: Namespace; spec: QuerySpec }; output: CountResult }
    'query.close': { input: { queryId: string }; output: null }
    /** The whole document by `_id`, untruncated, for editing. */
    'doc.get': { input: { ns: Namespace; id: JsonValue }; output: { doc: JsonObject | null } }
    /** Sets (or with `remove`, unsets) one field by path; array items are numbers in the path. */
    'doc.updateField': { input: { ns: Namespace; id: JsonValue; path: (string | number)[]; value?: JsonValue; remove?: boolean }; output: WriteResult }
    'doc.replace': { input: { ns: Namespace; id: JsonValue; doc: JsonObject }; output: WriteResult }
    'doc.insert': { input: { ns: Namespace; docs: JsonObject[] }; output: { insertedIds: JsonValue[] } }
    'doc.deleteMany': { input: { ns: Namespace; ids: JsonValue[] }; output: { deleted: number } }
    'history.list': { input: { ns: Namespace }; output: QueryLibrary }
    'history.clear': { input: { ns: Namespace }; output: QueryLibrary }
    'saved.save': { input: { ns: Namespace; name: string; query: QueryText }; output: QueryLibrary }
    'saved.delete': { input: { ns: Namespace; name: string }; output: QueryLibrary }
    'favourites.toggle': { input: { key: string; label: string; kind: NodeKind; path: string }; output: { favourites: FavouriteNode[] } }
  }
  interface PluginPanelEvents {
    /** Saved connections, favourites or connection states changed. */
    'connections.changed': ConnectionsState
    /** A command from the palette: show this view. */
    'ui.navigate': { view: 'new' | 'import' | 'export' | 'tree' }
    /** OIDC browser sign-in is waiting for the person to open this page. */
    'oidc.signIn': { connectionId: string; name: string; url: string }
    'oidc.done': { connectionId: string; ok: boolean; message?: string }
  }
}
