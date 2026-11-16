// Mongo Studio's right-sidebar panel. Connections, the connection editor, import/export and each
// open collection are tabs; later phases add admin tabs here. Everything is drawn with Orca's
// own components, so every Orca theme applies.
import { plugin, read, set, Tab, Tabs, type IconName, type OrcaNode, type PanelContext } from 'orca'
import { collTabs, tabOrder } from './panel/collection-state'
import { CollectionTab } from './panel/collection-view'
import { ConnectionForm } from './panel/connection-form'
import {
  errorText,
  formDef,
  formIsNew,
  notice,
  oidc,
  openNewConnection,
  refreshExport,
  refreshState,
  setConnections,
  view,
  type View
} from './panel/state'
import { TransferView } from './panel/transfer-view'
import { loadLatestRun, SHELL_TAB, shellRun, showRun } from './panel/shell-state'
import { ShellTab } from './panel/shell-view'
import { TreeView } from './panel/tree-view'

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('connections.changed', (state) => setConnections(state)),
    plugin.on('ui.navigate', ({ view: target }) => {
      if (target === 'new') openNewConnection()
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
    plugin.on('shell.results', (run) => void showRun(run, true))
  )
  void loadLatestRun()
  refreshState().catch((error) => set(notice, { tone: 'danger', text: `Mongo Studio could not start: ${errorText(error)}` }))
}

function changeView(next: string): void {
  const v: View = next
  set(view, v)
  if (v === 'transfer') void refreshExport()
}

const TAB_ICONS: Record<string, IconName> = { view: 'filter', timeseries: 'activity' }

export default function Panel(): OrcaNode {
  const current = read(view)
  const def = read(formDef)
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
      {read(shellRun) ? (
        <Tab value={SHELL_TAB} label="Shell" icon="terminal">
          <ShellTab />
        </Tab>
      ) : null}
      {read(tabOrder).map((id) => {
        const t = read(collTabs)[id]
        return t ? (
          <Tab key={id} value={id} label={t.title} icon={TAB_ICONS[t.kind] ?? 'file-text'}>
            <CollectionTab id={id} />
          </Tab>
        ) : null
      })}
    </Tabs>
  )
}
