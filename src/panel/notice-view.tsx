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

/** The places a collection tab and an aggregation tab draw notices, besides `top`. */
export const COLLECTION_PLACES: readonly NoticeAt[] = ['builder', 'results', 'library']
export const AGGREGATION_PLACES: readonly NoticeAt[] = ['results', 'view', 'library']

/** Where a tab that draws `places` shows this notice: its own place when the tab draws it, else
 *  `top`, so a notice is never lost (an aggregation tab has no Query Builder, for one). */
export function noticePlace(notice: Pick<TabNotice, 'at'>, places: readonly NoticeAt[]): NoticeAt {
  const at = notice.at ?? 'top'
  return places.includes(at) ? at : 'top'
}

/** A collection or aggregation tab's notice, drawn only at `at` among the tab's `places`, or
 *  wherever it is when `at` is left out (a document, the Shell tab). */
export function TabNoticeView({ id, at, places = [] }: { id: string; at?: NoticeAt; places?: readonly NoticeAt[] }): OrcaNode {
  const notice = read(collTabs)[id]?.notice
  if (!notice || (at && noticePlace(notice, places) !== at)) return null
  return <NoticeCallout notice={notice} onDismiss={() => change(id, () => ({ notice: undefined }))} />
}
