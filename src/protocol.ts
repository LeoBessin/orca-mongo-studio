// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// Secrets only ever travel panel -> worker (as a SecretDraft); answers carry SecretFlags.
import type { JsonObject, JsonValue } from './shared/ejson-view'
import type { ConnectionDef, FieldError, SecretDraft, SecretFlags } from './shared/model'
import type { ExplainSummary, ExplainVerbosity } from './shared/explain'
import type { NodeKind } from './shared/nodes'
import type { Operation } from './shared/operation'
import type { StageText } from './shared/pipeline'
import type { CsvColumn } from './shared/csv'
import type { CompareRules, FieldDiff } from './shared/compare'
import type { Task, TaskRequest } from './shared/tasks'

export type ConnectionSummary = {
  id: string
  name: string
  group: string
  subtitle: string
  topology: ConnectionDef['topology']
  connected: boolean
  /** Changes through it are refused by the worker. */
  readOnly: boolean
  /** It can connect again without the person: no browser sign-in, and its secrets are kept. The
   *  panel reconnects such a connection when it was open before Orca stopped the worker. */
  resumable?: boolean
}

export type ConnectionsState = {
  connections: ConnectionSummary[]
  /** Node keys the person starred, with what to show for them. */
  favourites: FavouriteNode[]
  /** `unavailable`: Orca can't encrypt secrets here, so they last only until the worker stops. */
  secretsProtection: 'os-keyring' | 'unavailable'
}

/** What a palette command asks the panel to show. */
export type NavigateView = 'new' | 'import' | 'export' | 'tree' | 'shell' | 'tasks'

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

export type ImportReport = { imported: { id: string; name: string; warnings: string[] }[]; errors: string[]; /** Names of the saved tasks the file brought. */ tasks?: string[] }

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

// ---- Aggregation and explain ----

/** Options an aggregation runs with. */
export type AggOptions = { allowDiskUse?: boolean; collation?: JsonObject }

/** A few documents of a stage's input or output. */
export type PreviewDocs = {
  docs: JsonObject[]
  truncated: number[]
  /** There are more documents than shown. */
  more: boolean
  stoppedForSize: boolean
}

/** A stage's preview. `output` is missing when the stage is off or writes. */
export type PreviewResult = { input: PreviewDocs; output?: PreviewDocs; ms: number }

export type ExplainResult = {
  summary: ExplainSummary
  /** The server's answer as relaxed Extended JSON text. */
  raw: string
  rawCut: boolean
  /** The verbosity it ran with (a pipeline that writes is only planned). */
  verbosity: ExplainVerbosity
  note?: string
  ms: number
}

export type SavedPipeline = { name: string; at: number; stages: StageText[] }

// ---- Shell ----

/** One line of a shell run's output, in the order the script produced it. */
export type ShellEntry =
  | { kind: 'print'; text: string }
  | { kind: 'info'; text: string }
  /** A statement's value. `resultIndex` names it in the run's results, which the panel shows. */
  | { kind: 'result'; line: number; ms: number; text: string; resultIndex?: number; summary?: string; note?: string }
  | { kind: 'error'; line?: number; column?: number; text: string }

export type ShellPoll = {
  entries: ShellEntry[]
  done: boolean
  /** The database `db` names now (a script may `use` another). */
  db: string
  ms: number
}

export type ShellResultInfo = {
  index: number
  /** The statement's first line, shortened. */
  title: string
  line: number
  kind: 'cursor' | 'docs'
  /** For an unread find or aggregate cursor: the operation, so it can open in a collection tab
   *  or become code. */
  op?: Operation
  /** Documents held, for `docs` results. */
  count?: number
}

export type ShellRunSummary = {
  runId: string
  connectionId: string
  connectionName: string
  db: string
  at: number
  results: ShellResultInfo[]
}

/** Statements to run: `line` and `column` say where `code` starts in the editor. */
export type ShellRunInput = { connectionId: string; db: string; code: string; line: number; column: number }


// ---- Administration ----

/** A database on a saved connection. */
export type DbRef = { connectionId: string; db: string }

export type IndexInfo = {
  name: string
  /** Canonical Extended JSON. */
  key: JsonObject
  /** Kinds and options in words: unique, sparse, TTL 3600s, text, hidden, … */
  kinds: string[]
  hidden: boolean
  unique: boolean
  /** Seconds, for a TTL index. */
  ttl?: number
  size?: number
  /** Times used since `since` (from $indexStats), when the user may read it. */
  ops?: number
  since?: number
  /** The whole definition, canonical. */
  spec: JsonObject
}
/** An index build running now (from $currentOp). */
export type IndexBuild = { names: string[]; progress?: string; secs?: number }
export type IndexList = { indexes: IndexInfo[]; building: IndexBuild[]; ms: number }

export type CollectionKind = 'collection' | 'view' | 'timeseries'
export type ValidationLevel = 'off' | 'strict' | 'moderate'
export type ValidationAction = 'error' | 'warn' | 'errorAndLog'
export type CollectionInfo = {
  kind: CollectionKind
  stats: DetailItem[]
  /** Documents (estimated), for confirmations. */
  count: number | null
  /** Options the collection was created with, canonical. */
  options: JsonObject
  validator: JsonObject | null
  validationLevel: ValidationLevel
  validationAction: ValidationAction
  capped: boolean
}
export type ValidationCheck = { failing: number | null; checked: number | null; ms: number; firstId?: JsonValue; error?: string }

export type CreateCollectionSpec = {
  name: string
  kind: 'plain' | 'capped' | 'timeseries' | 'clustered'
  capped?: { size: number; max?: number }
  timeseries?: { timeField: string; metaField?: string; granularity?: 'seconds' | 'minutes' | 'hours'; expireAfterSeconds?: number }
  clustered?: { expireAfterSeconds?: number }
  validator?: JsonObject
  validationLevel?: ValidationLevel
  validationAction?: ValidationAction
  collation?: JsonObject
}

export type DatabaseInfo = {
  stats: DetailItem[]
  collections: { name: string; kind: CollectionKind | 'bucket' }[]
  /** Documents in the database (dbStats), for confirmations; null when the user can't read it. */
  documents: number | null
}

export type ProfilerStatus = { level: number; slowms: number; sampleRate: number; filter?: string; note?: string }
export type ProfileFilter = { op?: string; minMs?: number; ns?: string }
export type ProfileEntry = {
  key: string
  at: number
  op: string
  ns: string
  ms: number
  plan?: string
  docsExamined?: number
  keysExamined?: number
  returned?: number
  user?: string
  app?: string
  /** The command, short, on one line. */
  command: string
  /** The whole entry, relaxed Extended JSON (cut when very long). */
  raw: string
}

export type RoleRef = { role: string; db: string }
export type UserInfo = { user: string; db: string; roles: RoleRef[]; mechanisms: string[]; customData?: string }
export type RoleInfo = { role: string; db: string; roles: RoleRef[]; privileges: JsonObject[]; builtin: boolean }
export type UsersState = { users: UserInfo[]; roles: RoleInfo[]; builtinRoles: string[] }
export type UserDraft = {
  user: string
  /** Set to create the user or change its password; never sent back. */
  password?: string
  roles: RoleRef[]
  /** Shell syntax document, or empty. */
  customData?: JsonObject | null
  mechanisms?: string[]
}
export type RoleDraft = { role: string; privileges: JsonObject[]; roles: RoleRef[] }

export type ServerStatus = {
  at: number
  /** Grouped name/value pairs. */
  sections: { title: string; items: DetailItem[] }[]
  /** Counters for rates: opcounters, network, … */
  counters: Record<string, number>
  members?: { name: string; state: string; health: number; lagSecs?: number; self?: boolean }[]
  ms: number
}
export type CurrentOp = {
  opid: string
  /** The opid as the server gives it (a number, or "shard:number"). */
  opidValue: JsonValue
  op: string
  ns: string
  secs: number
  active: boolean
  client?: string
  app?: string
  desc?: string
  user?: string
  plan?: string
  waitingForLock?: boolean
  /** The command, short, on one line. */
  command: string
  raw: string
}
export type CurrentOpsFilter = { idle: boolean; system: boolean; minSecs?: number; ns?: string }

// ---- Data movement ----

/** Where data comes from: text the panel sent in pieces (`import.upload`), or a file or folder the
 *  worker reads. */
export type DataSource = { kind: 'upload'; uploadId: string } | { kind: 'path'; path: string }
export type ImportFormat = 'json' | 'csv' | 'tsv' | 'bson'
/** insert: new documents only (a taken `_id` is an error); upsert: replace by `_id`; merge: set the
 *  file's fields on the document with that `_id`. Documents without `_id` are inserted. */
export type WriteMode = 'insert' | 'upsert' | 'merge'
export type ImportOptions = {
  /** `auto`: from the file name, then the content. */
  format: ImportFormat | 'auto'
  csv?: { delimiter: string; header: boolean; ignoreEmpty: boolean; columns?: CsvColumn[] }
  mode: WriteMode
  /** Drop the target collection first. */
  drop: boolean
  stopOnError: boolean
  /** BSON: create the indexes of the `.metadata.json` next to the file (or in the folder). */
  indexes: boolean
}
export type ImportPreview = {
  /** Canonical Extended JSON, shrunk like a page. */
  docs: JsonObject[]
  /** CSV: the columns as read, with inferred types and a few values each. */
  columns?: (CsvColumn & { samples: string[] })[]
  notes: string[]
  errors: { record: number; message: string }[]
  /** Bytes of the source, when known. */
  bytes?: number
  /** A folder of a dump: the collections it holds. */
  folder?: { name: string; file: string; bytes: number; metadata: boolean }[]
  /** The format read (`auto` resolved). */
  format: ImportFormat
  gzip?: boolean
}

export type JobKind = 'import' | 'export' | 'copy' | 'compare' | 'sync' | 'gridfs-upload' | 'gridfs-download'
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled'
export type JobError = { record?: number; ns?: string; message: string }

export type ImportResult = { kind: 'import'; read: number; inserted: number; updated: number; failed: number; collections: string[] }
export type ExportResult = {
  kind: 'export'
  docs: number
  collections: number
  /** Bytes written: to the download, the path, or the target collection (BSON size). */
  bytes: number
  /** Ready to fetch with `job.read`, for the save dialog. */
  download?: { name: string; mimeType: string; size: number }
  /** Files written by the worker. */
  written?: string[]
  /** Copies into a collection. */
  inserted?: number
  updated?: number
  failed?: number
  indexes?: number
}
export type CompareResult = {
  kind: 'compare'
  same: number
  differ: number
  onlyA: number
  onlyB: number
  /** `_id`s (canonical) of each kind, at most COMPARE_ID_MAX each. */
  ids: { differ: JsonValue[]; onlyA: JsonValue[]; onlyB: JsonValue[] }
  capped: boolean
}
export type SyncResult = { kind: 'sync'; inserted: number; replaced: number; deleted: number; failed: number }
export type GridUploadResult = { kind: 'gridfs-upload'; id: JsonValue; bytes: number }
export type JobResult = ImportResult | ExportResult | CompareResult | SyncResult | GridUploadResult

export type JobState = {
  jobId: string
  kind: JobKind
  status: JobStatus
  /** Rises with each change; `job.poll` waits for a higher one. */
  version: number
  /** What it is doing now, in words. */
  phase: string
  done: number
  /** Documents (or bytes, for GridFS) to go, when known. */
  total: number | null
  unit: 'documents' | 'bytes'
  /** The first errors, and how many there were. */
  errors: JobError[]
  errorCount: number
  result?: JobResult
  /** Why it failed. */
  message?: string
  started: number
  ms: number
}

/** A find, or a pipeline, on one collection; or every collection of a database. */
export type ExportSource =
  | { kind: 'query'; ns: Namespace; spec: QuerySpec }
  | { kind: 'pipeline'; ns: Namespace; pipeline: JsonObject[]; options: AggOptions }
  | { kind: 'database'; connectionId: string; db: string; collections?: string[] }
export type ExportFormat = 'json' | 'csv' | 'bson' | 'collection'
export type ExportOptions = {
  format: ExportFormat
  json?: { layout: 'lines' | 'array'; relaxed: boolean; pretty: boolean }
  csv?: { fields: string[]; delimiter: string; header: boolean }
  /** BSON to a path: write `<name>.metadata.json` (indexes and options) as mongodump does. */
  bson?: { metadata: boolean }
  /** Copy into a collection, on any saved connection. A database source copies each collection
   *  into `db`, keeping its name; `collection` is for one source collection. */
  collection?: { connectionId: string; db: string; collection?: string; mode: WriteMode | 'replace'; indexes: boolean; options: boolean }
}
/** download: kept in the worker for the save dialog (64 MiB at most); path: a file, or a folder
 *  for a database. */
export type ExportDestination = { kind: 'download' } | { kind: 'path'; path: string; overwrite: boolean }

export type GridFile = {
  /** Canonical Extended JSON of the file's `_id`. */
  id: JsonValue
  filename: string
  length: number
  chunkSize: number
  uploadDate: number
  contentType?: string
  /** Relaxed Extended JSON, short. */
  metadata?: string
}
export type GridRef = DbRef & { bucket: string }
export type GridPreview = { text?: string; cut: boolean; binary: boolean; length: number; chunks: number; expectedChunks: number }

// ---- Saved tasks ----

export type TasksState = { tasks: Task[] }

declare module 'orca' {
  interface PluginRequests {
    'tasks.list': { output: TasksState }
    /** Saves a new task, or (with `id`) changes one. Answers the task's id. */
    'tasks.save': { input: { id?: string; name: string; request: TaskRequest }; output: TasksState & { id: string } }
    'tasks.rename': { input: { id: string; name: string }; output: TasksState }
    'tasks.duplicate': { input: { id: string }; output: TasksState & { id: string } }
    'tasks.delete': { input: { id: string }; output: TasksState }
    /** Starts the task's job; its outcome is kept as the task's last run. */
    'tasks.run': { input: { id: string }; output: { jobId: string } }
  }
  interface PluginPanelEvents {
    /** Tasks were saved, changed, deleted, or one finished a run. */
    'tasks.changed': TasksState
  }
}

declare module 'orca' {
  interface PluginRequests {
    /** Text from the panel, in pieces under the request size. The first piece has no `uploadId`;
     *  uploads are dropped after 30 minutes. */
    'import.upload': { input: { uploadId?: string; chunk: string }; output: { uploadId: string; bytes: number } }
    'import.preview': { input: { source: DataSource; options: ImportOptions; size: number }; output: ImportPreview }
    /** Starts an import into `ns` (a folder: into `ns.db`, a collection per file). */
    'import.start': { input: { source: DataSource; options: ImportOptions; ns: Namespace }; output: { jobId: string } }
    'export.start': { input: { source: ExportSource; options: ExportOptions; destination: ExportDestination }; output: { jobId: string } }
    /** Dotted field names sampled from a collection (for CSV columns). */
    'export.fields': { input: { ns: Namespace; filter?: JsonObject }; output: { fields: string[] } }
    /** Whether a collection exists and how many documents it has (estimated), for confirmations. */
    'data.count': { input: { ns: Namespace }; output: { exists: boolean; count: number | null; kind?: CollectionKind } }
    /** Collections of a database, for pickers. */
    'data.collections': { input: DbRef; output: { names: string[] } }
    /** A job's state once its version passes `version`, or after `waitMs` (at most 20 s). */
    'job.poll': { input: { jobId: string; version: number; waitMs: number }; output: JobState }
    'job.cancel': { input: { jobId: string }; output: null }
    /** A piece of a finished download, as base64. */
    'job.read': { input: { jobId: string; offset: number; size: number }; output: { base64: string; total: number } }
    /** Frees a job's download. */
    'job.close': { input: { jobId: string }; output: null }
    'compare.start': { input: { a: Namespace; b: Namespace; filter?: JsonObject; rules: CompareRules }; output: { jobId: string } }
    'compare.diff': { input: { a: Namespace; b: Namespace; id: JsonValue; rules: CompareRules }; output: { a: JsonObject | null; b: JsonObject | null; diffs: FieldDiff[]; capped: boolean } }
    /** Makes `to` like `from` (each change optional). */
    'compare.sync': { input: { from: Namespace; to: Namespace; filter?: JsonObject; rules: CompareRules; insert: boolean; replace: boolean; remove: boolean }; output: { jobId: string } }
    'gridfs.list': { input: GridRef & { filename?: string; skip: number; limit: number }; output: { files: GridFile[]; total: number; ms: number } }
    'gridfs.preview': { input: GridRef & { id: JsonValue }; output: GridPreview }
    /** Starts a download: to the save dialog (`job.read`) or a path. */
    'gridfs.download': { input: GridRef & { id: JsonValue; destination: ExportDestination }; output: { jobId: string } }
    'gridfs.upload': { input: GridRef & { source: DataSource; filename: string; contentType?: string; metadata?: JsonObject }; output: { jobId: string } }
    'gridfs.rename': { input: GridRef & { id: JsonValue; filename: string }; output: null }
    'gridfs.delete': { input: GridRef & { id: JsonValue }; output: null }
  }
}

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
    'connections.export': { input: { ids?: string[]; tasks?: boolean }; output: { json: string; count: number; tasks: number } }
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
    /** Runs a pipeline and answers its first page. */
    'agg.run': { input: { ns: Namespace; pipeline: JsonObject[]; options: AggOptions; pageSize: number }; output: QueryPage }
    'agg.page': { input: { queryId: string; ns: Namespace; pipeline: JsonObject[]; options: AggOptions; offset: number; pageSize: number }; output: QueryPage }
    'agg.count': { input: { ns: Namespace; pipeline: JsonObject[]; options: AggOptions }; output: CountResult }
    /** A stage's input (`before`) and output (`before` + `stage`), `size` documents each. */
    'agg.preview': { input: { ns: Namespace; before: JsonObject[]; stage?: JsonObject; size: number; options: AggOptions }; output: PreviewResult }
    'agg.explain': { input: { ns: Namespace; pipeline: JsonObject[]; options: AggOptions; verbosity: ExplainVerbosity }; output: ExplainResult }
    'query.explain': { input: { ns: Namespace; spec: QuerySpec; verbosity: ExplainVerbosity }; output: ExplainResult }
    /** Creates a view on `ns` from a pipeline, in the same database. */
    'view.create': { input: { ns: Namespace; name: string; pipeline: JsonObject[] }; output: { name: string } }
    'pipelines.list': { input: { ns: Namespace }; output: { saved: SavedPipeline[] } }
    'pipelines.save': { input: { ns: Namespace; name: string; stages: StageText[] }; output: { saved: SavedPipeline[] } }
    'pipelines.delete': { input: { ns: Namespace; name: string }; output: { saved: SavedPipeline[] } }
    'favourites.toggle': { input: { key: string; label: string; kind: NodeKind; path: string }; output: { favourites: FavouriteNode[] } }
    /** Starts running statements in the calling editor's shell session. */
    'shell.run': { input: ShellRunInput; output: { runId: string } }
    /** Output after the first `after` entries; waits up to 20 s for more. */
    'shell.poll': { input: { runId: string; after: number }; output: ShellPoll }
    /** Stops a run; the session's variables are cleared. */
    'shell.cancel': { input: { runId: string }; output: null }
    /** Clears the calling editor's variables. */
    'shell.reset': { output: null }
    /** The newest run that produced results, for a panel that opens after it. */
    'shell.latest': { output: { run: ShellRunSummary | null } }
    'shell.page': { input: { runId: string; index: number; offset: number; pageSize: number }; output: QueryPage }
    'shell.databases': { input: { connectionId: string }; output: { names: string[] } }
    /** Names for autocomplete: collections of `db`, and fields sampled from `collection`. */
    'shell.complete': { input: { connectionId: string; db: string; collection?: string }; output: { collections: string[]; fields: string[] } }
    // ---- Administration ----
    'admin.indexes': { input: { ns: Namespace }; output: IndexList }
    'admin.createIndex': { input: { ns: Namespace; key: JsonObject; options: JsonObject }; output: { name: string } }
    'admin.dropIndex': { input: { ns: Namespace; name: string }; output: null }
    /** Hides or shows an index to the planner, or changes a TTL index's seconds (collMod). */
    'admin.modifyIndex': { input: { ns: Namespace; name: string; hidden?: boolean; expireAfterSeconds?: number }; output: null }
    'admin.collection': { input: { ns: Namespace }; output: CollectionInfo }
    'admin.setValidation': { input: { ns: Namespace; validator: JsonObject | null; level: ValidationLevel; action: ValidationAction }; output: null }
    /** Counts documents the validator would refuse (with a time limit). */
    'admin.checkValidation': { input: { ns: Namespace; validator: JsonObject }; output: ValidationCheck }
    'admin.renameCollection': { input: { ns: Namespace; to: string; toDb?: string; dropTarget: boolean }; output: null }
    'admin.dropCollection': { input: { ns: Namespace }; output: null }
    /** Deletes every document, keeping the collection, its indexes and options. */
    'admin.clearCollection': { input: { ns: Namespace }; output: { deleted: number } }
    'admin.convertToCapped': { input: { ns: Namespace; size: number }; output: null }
    'admin.database': { input: DbRef; output: DatabaseInfo }
    'admin.createCollection': { input: DbRef & { spec: CreateCollectionSpec }; output: null }
    'admin.dropDatabase': { input: DbRef; output: null }
    'profiler.status': { input: DbRef; output: ProfilerStatus }
    'profiler.set': { input: DbRef & { level: number; slowms: number; sampleRate: number }; output: ProfilerStatus }
    'profiler.entries': { input: DbRef & { filter: ProfileFilter; limit: number }; output: { entries: ProfileEntry[]; ms: number } }
    'users.list': { input: DbRef; output: UsersState }
    'users.save': { input: DbRef & { draft: UserDraft; isNew: boolean }; output: null }
    'users.drop': { input: DbRef & { user: string }; output: null }
    'roles.save': { input: DbRef & { draft: RoleDraft; isNew: boolean }; output: null }
    'roles.drop': { input: DbRef & { role: string }; output: null }
    /** With `waitMs`, waits that long first (live refresh without timers in the panel). */
    'server.status': { input: { connectionId: string; waitMs?: number }; output: ServerStatus }
    'server.ops': { input: { connectionId: string; filter: CurrentOpsFilter }; output: { ops: CurrentOp[]; capped: boolean; ms: number } }
    'server.killOp': { input: { connectionId: string; opid: JsonValue }; output: null }
    /** Samples documents and answers a SchemaReport as JSON text (one string is cheap in Orca's
     *  size measure, where a report's many small objects are not). */
    'schema.analyze': { input: { ns: Namespace; size: number; filter?: JsonObject }; output: { report: string } }
  }
  interface PluginPanelEvents {
    /** Saved connections, favourites or connection states changed. */
    'connections.changed': ConnectionsState
    /** A command from the palette: show this view. */
    'ui.navigate': { view: NavigateView }
    /** OIDC browser sign-in is waiting for the person to open this page. */
    'oidc.signIn': { connectionId: string; name: string; url: string }
    'oidc.done': { connectionId: string; ok: boolean; message?: string }
    /** A shell run finished with results to show. */
    'shell.results': ShellRunSummary
  }
}
