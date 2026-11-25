// The choice a shell statement typed as a query or pipeline asks for: open the collection it
// names or use this tab's, or take it to the Mongo Shell (or Update many) when the query bar
// doesn't run it.
import { Box, Button, Callout, Row, Text, type OrcaNode } from 'orca'
import { nsLabel, type CollTab } from './collection-state'
import { guard } from './guard'
import { canOfferUpdateMany, connectionReadOnly, copyForShell, dismissStatement, openElsewhere, openInUpdateMany, useHere } from './statement-state'

const WHAT: Record<string, string> = { find: 'a find', aggregate: 'an aggregation', count: 'a count', distinct: 'a distinct' }

export function StatementOfferView({ t }: { t: CollTab }): OrcaNode {
  const s = t.statement
  if (!s) return null
  if (s.kind === 'elsewhere') {
    const what = WHAT[s.read.kind] ?? 'a query'
    const pipeline = s.read.kind === 'aggregate'
    return (
      <Callout tone="warning" icon="warning" title={`This statement is on ${nsLabel(s.target)}`}>
        <Box gap="sm">
          <Text>{`It runs ${what} on ${nsLabel(s.target)}, and this tab is ${nsLabel(t.ns)}. Open ${s.target.collection}${pipeline ? "'s aggregation" : ''}, or run it here on ${t.ns.collection}.`}</Text>
          <Row gap="xs" wrap>
            <Button size="sm" variant="solid" tone="accent" onPress={guard(t.id, () => openElsewhere(t.id))}>{`Open ${nsLabel(s.target)}`}</Button>
            <Button size="sm" variant="outline" onPress={guard(t.id, () => useHere(t.id))}>{`Use ${t.ns.collection}`}</Button>
            <Button size="sm" variant="ghost" onPress={() => dismissStatement(t.id)}>Cancel</Button>
          </Row>
        </Box>
      </Callout>
    )
  }
  const blocked = s.writes && connectionReadOnly(t.ns)
  return (
    <Callout tone="warning" icon="warning" title="This statement runs in the Mongo Shell">
      <Box gap="sm">
        <Text>{s.reason}</Text>
        {blocked ? <Text size="xs" muted>This connection is read-only, so the Mongo Shell would refuse it too.</Text> : null}
        <Row gap="xs" wrap>
          <Button size="sm" variant="solid" tone="accent" icon="copy" disabled={blocked} onPress={guard(t.id, () => copyForShell(t.id))}>Copy for the Mongo Shell</Button>
          {canOfferUpdateMany(t) ? <Button size="sm" variant="outline" icon="edit" onPress={guard(t.id, () => openInUpdateMany(t.id))}>Open in Update many</Button> : null}
          <Button size="sm" variant="ghost" onPress={() => dismissStatement(t.id)}>Cancel</Button>
        </Row>
      </Box>
    </Callout>
  )
}
