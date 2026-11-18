// The line under a tab's title that says where the tab works: the connection, and the database
// (and collection) when the title doesn't already name them. Tabs that write somewhere else than
// they read (a copy, an import, a sync) name each side. A side the tab writes to on a read-only
// connection carries a Read only badge, placed first so a narrow panel never cuts it.
import { Badge, read, Row, Text, type OrcaNode } from 'orca'
import { connections } from './state'

export type Place = {
  connectionId: string
  db?: string
  collection?: string
  /** Names the side when a tab has more than one: "A", "B", "From", "Into". */
  label?: string
  /** The tab writes here, so a read-only connection refuses it. */
  writes?: boolean
}

/** One place as text: `Local dev › shop.orders`, `B: Staging › shop.orders`. Empty names are left out. */
export function placeText(p: Place, name: string): string {
  const db = p.db?.trim()
  const coll = p.collection?.trim()
  const where = db ? ` › ${db}${coll ? `.${coll}` : ''}` : ''
  return `${p.label ? `${p.label}: ` : ''}${name}${where}`
}

export function PlaceLine({ places, detail }: { places: Place[]; detail?: string }): OrcaNode {
  // One pass over the connections for the whole line, not one per place and per question.
  const byId = new Map((read(connections)?.connections ?? []).map((c) => [c.id, c]))
  const locked = places.filter((p) => p.writes && byId.get(p.connectionId)?.readOnly)
  const text = places.map((p) => placeText(p, byId.get(p.connectionId)?.name ?? 'Connection')).join(' · ')
  return (
    <Row gap="xs" align="center">
      {locked.map((p) => (
        <Badge key={`${p.label ?? ''}${p.connectionId}`} tone="warning">{p.label ? `${p.label} read only` : 'Read only'}</Badge>
      ))}
      <Text size="xs" muted truncate>{detail ? `${text} · ${detail}` : text}</Text>
    </Row>
  )
}
