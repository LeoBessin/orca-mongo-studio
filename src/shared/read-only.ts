// Read-only connections: what Mongo Studio lets through to the server. Commands are checked
// against a list of ones that only read, so a command this file does not know is refused rather
// than let through. Pure, so the worker (requests and the shell) and tests share it.

/** Commands that read, by lowercased name. `aggregate`, `explain`, `mapReduce` and `profile` are
 *  read only in some forms and are looked at more closely. */
const READ_COMMANDS = new Set([
  'aggregate',
  'balancerstatus',
  'buildinfo',
  'collstats',
  'connectionstatus',
  'connpoolstats',
  'count',
  'currentop',
  'datasize',
  'dbhash',
  'dbstats',
  'distinct',
  'endsessions',
  'explain',
  'features',
  'filemd5',
  'find',
  'getclusterparameter',
  'getcmdlineopts',
  'getdefaultrwconcern',
  'getlog',
  'getmore',
  'getparameter',
  'getshardmap',
  'getshardversion',
  'hello',
  'hostinfo',
  'isdbgrid',
  'ismaster',
  'killcursors',
  'listcollections',
  'listcommands',
  'listdatabases',
  'listindexes',
  'listshards',
  'lockinfo',
  'mapreduce',
  'ping',
  'profile',
  'replsetgetconfig',
  'replsetgetstatus',
  'rolesinfo',
  'serverstatus',
  'shardconnpoolstats',
  'shardingstate',
  'top',
  'usersinfo',
  'whatsmyuri'
])

/** Commands `explain` may wrap: explaining a write plans it and never applies it. */
const EXPLAINED_WRITES = new Set(['update', 'delete', 'findandmodify'])

const WRITE_STAGES = new Set(['$out', '$merge'])

type Doc = Record<string, unknown>

function isDoc(v: unknown): v is Doc {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A plain number from a JavaScript number or a BSON Int32, Long or Double. */
function numberOf(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (isDoc(v) && typeof (v as { toNumber?: unknown }).toNumber === 'function') return (v as { toNumber(): number }).toNumber()
  if (isDoc(v) && typeof (v as { valueOf?: unknown }).valueOf === 'function') {
    const n = Number((v as { valueOf(): unknown }).valueOf())
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** The write stage of a pipeline (`$out` or `$merge`), wherever it stands. */
export function writeStageOf(pipeline: unknown): '$out' | '$merge' | undefined {
  if (!Array.isArray(pipeline)) return undefined
  for (const stage of pipeline) {
    if (!isDoc(stage)) continue
    const op = Object.keys(stage)[0]
    if (op && WRITE_STAGES.has(op)) return op as '$out' | '$merge'
  }
  return undefined
}

/**
 * Why a command would change something, or `undefined` when it only reads. The answer names the
 * command (or stage) for the message.
 */
export function commandWrites(command: unknown): string | undefined {
  if (!isDoc(command)) return 'an unknown command'
  const name = Object.keys(command)[0]
  if (!name) return 'an empty command'
  const lower = name.toLowerCase()
  if (!READ_COMMANDS.has(lower)) return name
  if (lower === 'aggregate') return writeStageOf(command.pipeline)
  if (lower === 'mapreduce') {
    const out = command.out
    return isDoc(out) && numberOf(out.inline) === 1 ? undefined : 'mapReduce with an output collection'
  }
  if (lower === 'profile') return numberOf(command[name]) === -1 ? undefined : 'profile (changing the profiler)'
  if (lower === 'explain') {
    const inner = command[name]
    if (!isDoc(inner)) return 'explain of an unknown command'
    const innerName = (Object.keys(inner)[0] ?? '').toLowerCase()
    if (EXPLAINED_WRITES.has(innerName) || innerName === 'aggregate') return undefined
    const why = commandWrites(inner)
    return why === undefined ? undefined : `explain of ${why}`
  }
  return undefined
}

/** Collection methods the shell sends that only read. */
const SHELL_COLLECTION_READS = new Set(['findOne', 'countDocuments', 'estimatedDocumentCount', 'distinct', 'indexes', 'isCapped', 'stats'])
/** Database methods the shell sends that only read (`command` is looked at). */
const SHELL_DATABASE_READS = new Set(['collectionNames', 'collectionInfos', 'listDatabases'])

/**
 * Why a call from the shell's script thread would change something, or `undefined`. `method` and
 * `args` are as the thread sends them (see `ShellService.dispatch`).
 */
export function shellCallWrites(method: string, args: readonly unknown[]): string | undefined {
  switch (method) {
    case 'find.open':
    case 'cursor.next':
    case 'cursor.close':
      return undefined
    case 'aggregate.open':
      return writeStageOf(args[1])
    case 'collection': {
      const m = String(args[1])
      return SHELL_COLLECTION_READS.has(m) ? undefined : m
    }
    case 'database': {
      const m = String(args[1])
      if (m === 'command') return commandWrites((args[2] as unknown[] | undefined)?.[0])
      return SHELL_DATABASE_READS.has(m) ? undefined : m
    }
    default:
      return method
  }
}

/** The sentence a refused change shows. */
export function readOnlyMessage(connectionName: string, action: string): string {
  return `"${connectionName}" is read only, so Mongo Studio refuses ${action}. Turn off "Read only" in the connection's settings to allow changes.`
}
