// A job's progress, errors and download, as each data tab shows it.
import { Box, Button, Callout, Progress, Row, Table, Text, type OrcaNode } from 'orca'
import { bytesText, progressPercent, progressText, type JobBox } from './data-state'

export function JobProgress({ box, what, onCancel, onSave }: { box: JobBox | undefined; what: string; onCancel: () => unknown; onSave?: () => unknown }): OrcaNode {
  if (!box) return null
  const s = box.state
  const d = box.download
  const pct = s ? progressPercent(s) : undefined
  return (
    <Box gap="sm">
      {s && s.status === 'running' ? (
        <Box gap="xs">
          <Progress label={`${s.phase} · ${progressText(s)}`} {...(pct !== undefined ? { value: pct } : {})} />
          <Row gap="xs" align="center" justify="between">
            <Text size="xs" muted>{`${Math.round(s.ms / 1000)} s`}</Text>
            <Button size="sm" icon="stop" variant="ghost" tone="danger" onPress={onCancel}>Cancel</Button>
          </Row>
        </Box>
      ) : null}
      {!s && !box.error ? <Progress label={`Starting ${what}…`} /> : null}
      {box.error ? <Callout tone="danger" icon="error" title={`Lost track of the ${what}`}>{box.error}</Callout> : null}
      {s?.status === 'failed' ? <Callout tone="danger" icon="error" title={`The ${what} failed`}>{s.message ?? 'No reason given.'}</Callout> : null}
      {s?.status === 'cancelled' ? <Callout tone="neutral" icon="info">{`The ${what} was cancelled after ${progressText(s)}.`}</Callout> : null}
      {d && !d.ready && !d.error ? <Progress label={`Fetching ${d.name}: ${bytesText(d.fetched)} of ${bytesText(d.size)}`} value={d.size ? Math.round((d.fetched / d.size) * 100) : 100} /> : null}
      {d?.error ? <Callout tone="danger" icon="error" title="Could not fetch the file">{d.error}</Callout> : null}
      {d?.ready && onSave ? (
        <Row gap="xs" align="center">
          <Button variant="solid" tone="accent" icon="download" onPress={onSave}>{`Save ${d.name} (${bytesText(d.size)})…`}</Button>
        </Row>
      ) : null}
      {s && s.errorCount > 0 ? (
        <Box gap="sm">
          <Text size="sm" tone="warning">{`${s.errorCount.toLocaleString('en-US')} error${s.errorCount === 1 ? '' : 's'}${s.errorCount > s.errors.length ? `; the first ${s.errors.length}:` : ':'}`}</Text>
          <Table
            label="Errors"
            columns={[
              { key: 'where', label: 'Where', width: 'sm' },
              { key: 'message', label: 'Error' }
            ]}
            rows={s.errors.map((e, i) => ({ key: `e${i}`, cells: { where: [e.ns, e.record ? `#${e.record}` : ''].filter(Boolean).join(' ') || '—', message: e.message } }))}
            maxHeight="sm"
          />
        </Box>
      ) : null}
    </Box>
  )
}
