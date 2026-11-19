// The switch under a code view whose long strings are shortened for display (see
// shortenLongStrings): it says how many, and shows them whole on demand.
import { Box, Switch, Text, type OrcaNode } from 'orca'

export function LongValues({ count, full, onChange }: { count: number; full: boolean; onChange: (full: boolean) => void }): OrcaNode {
  if (count === 0) return null
  const n = count.toLocaleString('en-US')
  return (
    <Box gap="xs">
      <Switch label="Show long values in full" checked={full} onChange={onChange} />
      <Text size="xs" muted>
        {full
          ? `${n} long value${count === 1 ? ' is' : 's are'} shown in full. The highlighting stops after the first of them, as Orca does not colour a line past 1,000 characters.`
          : `${n} long value${count === 1 ? ' is' : 's are'} shortened here so the rest stays highlighted. Copy as JSON copies ${count === 1 ? 'it' : 'them'} whole.`}
      </Text>
    </Box>
  )
}
