// The Server tab: status sections, rates, replica set members, and current operations with a
// confirmation before stopping one.
import {
  Box,
  Button,
  Callout,
  Checkbox,
  CodeView,
  Collapsible,
  Grid,
  IconButton,
  Input,
  KeyValue,
  read,
  RelativeTime,
  Row,
  Skeleton,
  Switch,
  Table,
  Text,
  Toolbar,
  type OrcaNode
} from 'orca'
import { formatBytes } from '../shared/nodes'
import { adminTabs, aguard, changeAdmin, closeAdmin, connectionName, numberText, type ServerTab } from './admin-state'
import { NoticeBar } from './admin-notice'
import { killConfirmed, LIVE_MS, loadOps, loadStatus, rates, setLive } from './server-state'

function rateText(n: number): string {
  return n >= 100 ? numberText(Math.round(n)) : String(Math.round(n * 10) / 10)
}

function Rates({ t }: { t: ServerTab }): OrcaNode {
  const r = rates(t)
  if (!r) return <Text size="xs" muted>Rates show after a second reading: refresh, or turn on live.</Text>
  const ops = ['insert', 'query', 'update', 'delete', 'getmore', 'command'].map((k) => `${k} ${rateText(r[`op.${k}`] ?? 0)}`).join(' · ')
  const net = r['net.in'] !== undefined ? ` · in ${formatBytes(r['net.in'])}/s · out ${formatBytes(r['net.out'] ?? 0)}/s` : ''
  return <Text size="xs">{`Per second: ${ops}${net}`}</Text>
}

function Ops({ t }: { t: ServerTab }): OrcaNode {
  const f = t.opsFilter
  const sel = t.ops?.find((o) => o.opid === t.opSelected)
  const kill = t.ops?.find((o) => o.opid === t.confirmKill)
  const setFilter = (change: Partial<ServerTab['opsFilter']>) => changeAdmin(t.id, 'server', (x) => ({ opsFilter: { ...x.opsFilter, ...change } }))
  return (
    <Collapsible title="Current operations" description={t.ops ? `${numberText(t.ops.length)}${t.opsCapped ? '+' : ''} shown` : 'What the server is doing now'} open={t.opsOpen} onChange={(open) => changeAdmin(t.id, 'server', () => ({ opsOpen: open }))}>
      <Box gap="sm">
        <Row gap="xs" align="end">
          <Input label="Namespace has" placeholder="shop.orders" value={f.nsText} onChange={(nsText) => setFilter({ nsText })} onSubmit={() => void aguard(t.id, () => loadOps(t.id))()} />
          <Input label="Running at least (s)" placeholder="0" value={f.minText} onChange={(minText) => setFilter({ minText })} onSubmit={() => void aguard(t.id, () => loadOps(t.id))()} />
        </Row>
        <Row gap="sm" align="center" justify="between" wrap>
          <Row gap="sm" wrap>
            <Checkbox label="Idle connections" checked={f.idle} onChange={(idle) => setFilter({ idle })} />
            <Checkbox label="Server's own work" checked={f.system} onChange={(system) => setFilter({ system })} />
          </Row>
          <Button size="sm" icon="refresh" disabled={t.opsLoading} onPress={aguard(t.id, () => loadOps(t.id))}>{t.opsLoading ? 'Reading…' : 'Refresh'}</Button>
        </Row>
        {t.opsError ? <Callout tone="danger" icon="error" title="Could not read current operations">{t.opsError}</Callout> : null}
        {t.ops ? (
          <Table
            label="Current operations"
            columns={[
              { key: 'opid', label: 'Op', width: 'sm' },
              { key: 'op', label: 'Kind', width: 'sm' },
              { key: 'ns', label: 'Namespace', minWidth: 'sm' },
              { key: 'secs', label: 'Seconds', width: 'xs', align: 'end' },
              { key: 'client', label: 'Client', hideBelow: 'md' }
            ]}
            rows={t.ops.map((o) => ({ key: o.opid, cells: { opid: o.opid, op: o.waitingForLock ? `${o.op} (waiting)` : o.op, ns: o.ns, secs: o.secs, client: o.app ? `${o.app} · ${o.client ?? ''}` : o.client ?? o.desc ?? '' } }))}
            selectionMode="single"
            selected={sel ? [sel.opid] : []}
            emptyText="Nothing running that matches."
            maxHeight="md"
            onSelectionChange={({ keys }) => changeAdmin(t.id, 'server', () => ({ opSelected: keys[0], confirmKill: undefined }))}
          />
        ) : !t.opsError ? (
          <Skeleton lines={3} label="Reading current operations" />
        ) : null}
        {t.opsCapped ? <Text size="xs" muted>Only the 200 longest-running are shown. Narrow the filter to see others.</Text> : null}
        {sel ? (
          <Box gap="xs">
            <KeyValue
              label={`Operation ${sel.opid}`}
              items={[
                { label: 'Operation', value: `${sel.op}${sel.active ? '' : ' (idle)'}` },
                ...(sel.ns ? [{ label: 'Namespace', value: sel.ns, code: true }] : []),
                { label: 'Running for', value: `${numberText(sel.secs)} s` },
                ...(sel.client ? [{ label: 'Client', value: sel.client, code: true }] : []),
                ...(sel.app ? [{ label: 'Application', value: sel.app }] : []),
                ...(sel.user ? [{ label: 'User', value: sel.user }] : []),
                ...(sel.plan ? [{ label: 'Plan', value: sel.plan }] : []),
                ...(sel.waitingForLock ? [{ label: 'Waiting for a lock', value: true, tone: 'warning' as const }] : [])
              ]}
            />
            {sel.command && sel.command !== '{}' ? <CodeView label="Command" code={sel.command} language="json" wrap maxHeight="sm" /> : null}
            <Collapsible title="Everything the server says about it">
              <CodeView label="Operation" code={sel.raw} language="json" maxHeight="md" />
            </Collapsible>
            <Row gap="xs">
              <Button size="sm" icon="stop" variant="ghost" tone="danger" onPress={() => changeAdmin(t.id, 'server', () => ({ confirmKill: sel.opid }))}>Stop operation</Button>
            </Row>
          </Box>
        ) : null}
        {kill ? (
          <Callout tone="danger" icon="warning" title={`Stop operation ${kill.opid}?`}>
            <Box gap="sm">
              <Text>{`${kill.op}${kill.ns ? ` on ${kill.ns}` : ''}, running for ${numberText(kill.secs)} s${kill.client ? `, from ${kill.client}` : ''}. Its client gets an error; a write stops part way, and what it did stays done.`}</Text>
              <Row gap="xs">
                <Button variant="solid" tone="danger" onPress={aguard(t.id, () => killConfirmed(t.id))}>Stop it</Button>
                <Button variant="ghost" onPress={() => changeAdmin(t.id, 'server', () => ({ confirmKill: undefined }))}>Cancel</Button>
              </Row>
            </Box>
          </Callout>
        ) : null}
      </Box>
    </Collapsible>
  )
}

export function ServerTabView({ id }: { id: string }): OrcaNode {
  const t = read(adminTabs)[id]
  if (!t || t.kind !== 'server') return null
  const s = t.status
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold" truncate>{`Server: ${connectionName(t.connectionId)}`}</Text>
          {s ? (
            <Row gap="xs" align="center">
              <Text size="xs" muted>Read</Text>
              <RelativeTime at={s.at} muted />
            </Row>
          ) : null}
        </Box>
        <IconButton icon="close" label="Close the server status" variant="ghost" size="sm" onPress={() => closeAdmin(t.id)} />
      </Row>
      <Row gap="xs" align="center" justify="between" wrap>
        <Toolbar label="Server actions" gap="xs">
          <Button size="sm" icon="refresh" variant="ghost" disabled={t.loading || t.live} onPress={aguard(t.id, () => loadStatus(t.id))}>Refresh</Button>
        </Toolbar>
        <Switch label={`Live, every ${LIVE_MS / 1000} s`} checked={t.live} onChange={(on) => void aguard(t.id, () => setLive(t.id, on))()} />
      </Row>
      <NoticeBar id={t.id} notice={t.notice} />
      {t.statusError ? <Callout tone="danger" icon="error" title="Could not read the server status">{t.statusError}</Callout> : null}
      {!s && !t.statusError ? <Skeleton lines={6} label="Reading the server status" /> : null}
      {s ? (
        <Box gap="sm">
          <Rates t={t} />
          <Grid minItemWidth="md" gap="sm">
            {s.sections.map((sec) => (
              <Box key={sec.title} gap="xs" padding="sm" border radius="md">
                <Text weight="semibold" size="sm">{sec.title}</Text>
                <KeyValue label={sec.title} items={sec.items} />
              </Box>
            ))}
          </Grid>
          {s.members?.length ? (
            <Table
              label="Replica set members"
              columns={[
                { key: 'name', label: 'Member' },
                { key: 'state', label: 'State', width: 'sm' },
                { key: 'lag', label: 'Behind', width: 'sm', align: 'end' }
              ]}
              rows={s.members.map((m) => ({ key: m.name, cells: { name: m.self ? `${m.name} (this one)` : m.name, state: m.health ? m.state : `${m.state} (down)`, lag: m.lagSecs !== undefined ? `${m.lagSecs} s` : '' } }))}
              maxHeight="sm"
            />
          ) : null}
        </Box>
      ) : null}
      <Ops t={t} />
    </Box>
  )
}
