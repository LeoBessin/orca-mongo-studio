// A notice: what the last action did, or why it failed, with a button to dismiss it.
// Orca draws a Callout without a title as a GitHub alert headed by its tone ("Tip" for success,
// "Caution" for danger), which read as advice rather than as an outcome. Each notice names what
// it is instead.
import { Box, Callout, IconButton, read, Row, Text, type OrcaNode } from 'orca'
import { change, collTabs, type NoticeAt, type TabNotice } from './collection-state'

const TITLES: Record<TabNotice['tone'], string> = { success: 'Done', danger: 'Error', neutral: 'Note' }
const ICONS = { success: 'check', danger: 'error', neutral: 'info' } as const

export function NoticeCallout({ notice, onDismiss }: { notice: Pick<TabNotice, 'tone' | 'text'>; onDismiss: () => void }): OrcaNode {
  return (
    <Callout tone={notice.tone} icon={ICONS[notice.tone]} title={TITLES[notice.tone]}>
      <Row justify="between" align="start" gap="xs">
        <Box grow>
          <Text>{notice.text}</Text>
        </Box>
        <IconButton icon="close" label="Dismiss" variant="ghost" size="xs" onPress={onDismiss} />
      </Row>
    </Callout>
  )
}

/** A collection or aggregation tab's notice, drawn only in its place (`top` when it names none),
 *  or wherever it is when `at` is left out. */
export function TabNoticeView({ id, at }: { id: string; at?: NoticeAt }): OrcaNode {
  const notice = read(collTabs)[id]?.notice
  if (!notice || (at && (notice.at ?? 'top') !== at)) return null
  return <NoticeCallout notice={notice} onDismiss={() => change(id, () => ({ notice: undefined }))} />
}
