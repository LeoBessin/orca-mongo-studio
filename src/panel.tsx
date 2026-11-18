// Mongo Studio's right-sidebar panel. Connections, the connection editor, import/export and each
// open collection are tabs, and so is each administration view (collection, database, users,
// server, schema). Everything is drawn with Orca's
// own components, so every Orca theme applies.
import { Badge, Box, plugin, read, Row, set, Tab, Tabs, Text, type IconName, type OrcaNode, type PanelContext } from 'orca'
import { collTabs, tabOrder } from './panel/collection-state'
import { adminTabs, connectionName, type AdminTab } from './panel/admin-state'
import { ADMIN_ICONS, AdminTabView } from './panel/admin-view'
import { AggregationTab } from './panel/aggregate-view'
import { CollectionTab } from './panel/collection-view'
import { ConnectionForm } from './panel/connection-form'
import {
  connections,
  errorText,
  expanded,
  formDef,
  formIsNew,
  notice,
  oidc,
  openNewConnection,
  refreshExport,
  refreshState,
  selected,
  setConnections,
  view,
  type View
} from './panel/state'
import { restoreLayout, resetLayoutRun, scheduleLayoutSave } from './panel/layout-state'
import { TransferView } from './panel/transfer-view'
import { loadLatestRun, SHELL_TAB, shellRun, showRun } from './panel/shell-state'
import { ShellTab } from './panel/shell-view'
import { TreeView } from './panel/tree-view'
import { openTasks, setTasks, TASKS_TAB, tasksOpen } from './panel/tasks-state'
import { TasksView } from './panel/tasks-view'

export function setup(ctx: PanelContext): void {
  resetLayoutRun()
  ctx.subscriptions.push(
    plugin.on('connections.changed', (state) => setConnections(state)),
    plugin.on('ui.navigate', ({ view: target }) => {
      if (target === 'new') openNewConnection()
      else if (target === 'tasks') openTasks()
      else if (target === 'shell') {
        if (read(shellRun)) set(view, SHELL_TAB)
      }
      else if (target === 'import' || target === 'export') {
        set(view, 'transfer')
        void refreshExport()
      } else set(view, 'tree')
    }),
    plugin.on('oidc.signIn', (payload) => set(oidc, payload)),
    plugin.on('oidc.done', () => set(oidc, null)),
    plugin.on('shell.results', (run) => void showRun(run, true)),
    plugin.on('tasks.changed', (state) => setTasks(state))
  )
  void loadLatestRun()
  // Orca ends the panel's run on every switch to another sidebar tab; this brings back what was
  // open. It waits for the connections' state, to know which ones are still open.
  refreshState()
    .catch((error) => set(notice, { tone: 'danger', text: `Mongo Studio could not start: ${errorText(error)}` }))
    .finally(() => void restoreLayout())
}

function changeView(next: string): void {
  const v: View = next
  set(view, v)
  if (v === 'transfer') void refreshExport()
}

const TAB_ICONS: Record<string, IconName> = { view: 'filter', timeseries: 'activity' }

/** A line over every tab of a read-only connection. */
/** Where a tab works: the connection and database its reads and writes go to. */
type Place = { connectionId: string; db?: string }

/** The places an administration tab works on: a Compare tab has two sides, a Server tab no database. */
function adminPlaces(a: AdminTab): Place[] {
  switch (a.kind) {
    case 'manage':
    case 'schema':
      return [a.ns]
    case 'compare':
      return [a.a, a.b]
    case 'export':
      return [a.from.kind === 'database' ? a.from : a.from.ns]
    case 'server':
      return [{ connectionId: a.connectionId }]
    default:
      return [{ connectionId: a.connectionId, db: a.db }]
  }
}

function placeText(p: Place): string {
  return p.db ? `${connectionName(p.connectionId)} › ${p.db}` : connectionName(p.connectionId)
}

/** Puts the tab's connection and database above its content, so it is plain which server a query
 *  or a write goes to, with a Read only badge on connections Mongo Studio keeps from writing. */
function withPlace(places: Place[], content: OrcaNode): OrcaNode {
  const all = read(connections)?.connections ?? []
  const readOnly = places.some((p) => all.find((c) => c.id === p.connectionId)?.readOnly)
  const sides = places.map(placeText)
  const text = sides.length === 2 && sides[0] !== sides[1] ? `${sides[0]} ⇄ ${sides[1]}` : sides[0]!
  return (
    <Box gap="sm">
      <Row gap="xs" align="center">
        {readOnly ? <Badge tone="warning">Read only</Badge> : null}
        <Text size="xs" muted truncate>{readOnly ? `${text} · changes are refused` : text}</Text>
      </Row>
      {content}
    </Box>
  )
}

export default function Panel(): OrcaNode {
  const current = read(view)
  const def = read(formDef)
  // Read so that opening or selecting in the tree, and connecting, also save the layout.
  read(expanded)
  read(selected)
  read(connections)
  scheduleLayoutSave()
  return (
    <Tabs label="Mongo Studio" value={current} onChange={changeView}>
      <Tab value="tree" label="Connections" icon="database">
        <TreeView />
      </Tab>
      {def ? (
        <Tab value="form" label={read(formIsNew) ? 'New connection' : def.name || 'Connection'} icon="edit">
          <ConnectionForm />
        </Tab>
      ) : null}
      {current === 'transfer' ? (
        <Tab value="transfer" label="Import / export" icon="upload">
          <TransferView />
        </Tab>
      ) : null}
      {read(tasksOpen) ? (
        <Tab value={TASKS_TAB} label="Tasks" icon="rocket">
          <TasksView />
        </Tab>
      ) : null}
      {read(shellRun) ? (
        <Tab value={SHELL_TAB} label="Shell" icon="terminal">
          <ShellTab />
        </Tab>
      ) : null}
      {read(tabOrder).map((id) => {
        const t = read(collTabs)[id]
        if (t) {
          return (
            <Tab key={id} value={id} label={t.title} icon={t.agg ? 'layers' : TAB_ICONS[t.kind] ?? 'file-text'}>
              {withPlace([t.ns], t.agg ? <AggregationTab id={id} /> : <CollectionTab id={id} />)}
            </Tab>
          )
        }
        const a = read(adminTabs)[id]
        return a ? (
          <Tab key={id} value={id} label={a.title} icon={ADMIN_ICONS[a.kind]}>
            {withPlace(adminPlaces(a), <AdminTabView id={id} />)}
          </Tab>
        ) : null
      })}
    </Tabs>
  )
}
