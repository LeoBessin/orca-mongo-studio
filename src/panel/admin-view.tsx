// Draws an administration tab by its kind, and the icon its tab shows.
import { read, type IconName, type OrcaNode } from 'orca'
import { adminTabs, type AdminKind } from './admin-state'
import { DatabaseTabView } from './database-view'
import { ManageTabView } from './manage-view'
import { SchemaTabView } from './schema-view'
import { ServerTabView } from './server-view'
import { UsersTabView } from './users-view'
import { CompareTabView } from './compare-view'
import { ExportTabView } from './export-view'
import { GridfsTabView } from './gridfs-view'
import { ImportTabView } from './import-view'

// Import and export are drawn from the database's side: an import is data coming in (Orca's
// `download`, an arrow into a tray) and an export is data going out (`upload`). Every import and
// export button uses the same pair; GridFS downloads and uploads keep their literal icons.
export const ADMIN_ICONS: Record<AdminKind, IconName> = { manage: 'settings', database: 'layers', users: 'agent', server: 'gauge', schema: 'bar-chart-3', import: 'download', export: 'upload', compare: 'branch', gridfs: 'package' }

export function AdminTabView({ id }: { id: string }): OrcaNode {
  const t = read(adminTabs)[id]
  if (!t) return null
  switch (t.kind) {
    case 'manage':
      return <ManageTabView id={id} />
    case 'database':
      return <DatabaseTabView id={id} />
    case 'users':
      return <UsersTabView id={id} />
    case 'server':
      return <ServerTabView id={id} />
    case 'schema':
      return <SchemaTabView id={id} />
    case 'import':
      return <ImportTabView id={id} />
    case 'export':
      return <ExportTabView id={id} />
    case 'compare':
      return <CompareTabView id={id} />
    case 'gridfs':
      return <GridfsTabView id={id} />
  }
}
