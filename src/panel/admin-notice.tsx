// The notice line of an administration tab: what the last action did, or why it failed.
import { update, type OrcaNode } from 'orca'
import { adminTabs } from './admin-state'
import type { TabNotice } from './collection-state'
import { NoticeCallout } from './notice-view'

export function NoticeBar({ id, notice }: { id: string; notice: TabNotice | undefined }): OrcaNode {
  if (!notice) return null
  return <NoticeCallout notice={notice} onDismiss={() => update(adminTabs, (prev) => (prev[id] ? { ...prev, [id]: { ...prev[id]!, notice: undefined } } : prev))} />
}
