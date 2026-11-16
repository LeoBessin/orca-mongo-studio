// The notice line of an administration tab: what the last action did, or why it failed.
import { Callout, IconButton, Row, Text, update, type OrcaNode } from 'orca'
import { adminTabs } from './admin-state'
import type { TabNotice } from './collection-state'

export function NoticeBar({ id, notice }: { id: string; notice: TabNotice | undefined }): OrcaNode {
  if (!notice) return null
  return (
    <Callout tone={notice.tone} icon={notice.tone === 'danger' ? 'error' : notice.tone === 'success' ? 'check' : 'info'}>
      <Row justify="between" align="center">
        <Text>{notice.text}</Text>
        <IconButton
          icon="close"
          label="Dismiss"
          variant="ghost"
          size="xs"
          onPress={() => update(adminTabs, (prev) => (prev[id] ? { ...prev, [id]: { ...prev[id]!, notice: undefined } } : prev))}
        />
      </Row>
    </Callout>
  )
}
