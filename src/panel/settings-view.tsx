// The Settings tab: Mongo Studio's preferences, grouped by area, kept across reloads and restarts,
// with "Reset to defaults". Changes apply at once; views and sizes apply to tabs and documents
// opened from then on, while tabs already open keep their own.
import { Box, Button, Card, Checkbox, IconButton, Row, Select, Stack, Text, type OrcaNode } from 'orca'
import { DOC_VIEWS, PAGE_SIZE_OPTIONS, RESULT_VIEWS } from './collection-state'
import { isDefault, type Settings } from '../shared/settings'
import { changeSettings, closeSettings, resetSettings, settings } from './settings-state'

const LAST = { value: 'last', label: 'Last used' }

function choices(labels: Record<string, string>): { value: string; label: string }[] {
  return [LAST, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]
}

function Toggle({ s, name, label, description }: { s: Settings; name: 'liveCheck' | 'formatButtons' | 'confirmDeleteDocs' | 'confirmDrop' | 'confirmByName'; label: string; description: string }): OrcaNode {
  return <Checkbox label={label} description={description} checked={s[name]} onChange={(on) => changeSettings({ [name]: on })} />
}

export function SettingsView(): OrcaNode {
  const s = settings()
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold">Settings</Text>
          <Text size="xs" muted>Kept on this computer across reloads and restarts. Saved connections are kept apart and never change here.</Text>
        </Box>
        <IconButton icon="close" label="Close settings" variant="ghost" size="sm" onPress={closeSettings} />
      </Row>
      <Card title="Results" description="How new tabs and opened documents start. Tabs already open keep their own.">
        <Stack gap="sm">
          <Select label="Results view" value={s.resultView} options={choices(RESULT_VIEWS)} onChange={(v) => changeSettings({ resultView: v as Settings['resultView'] })} />
          <Select label="Document view" value={s.docView} options={choices(DOC_VIEWS)} onChange={(v) => changeSettings({ docView: v as Settings['docView'] })} />
          <Select
            label="Page size"
            value={String(s.pageSize)}
            options={[LAST, ...PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: `${n} per page` }))]}
            onChange={(v) => changeSettings({ pageSize: v === 'last' ? 'last' : Number(v) })}
          />
          <Select
            label="Extended JSON"
            value={s.ejson}
            options={[
              { value: 'relaxed', label: 'Relaxed: numbers and dates as plain JSON' },
              { value: 'canonical', label: 'Canonical: every BSON type exact' }
            ]}
            onChange={(v) => changeSettings({ ejson: v as Settings['ejson'] })}
          />
        </Stack>
      </Card>
      <Card title="Query bar">
        <Stack gap="sm">
          <Toggle s={s} name="liveCheck" label="Check fields as you type" description="Say what doesn't parse while it is typed. Off, errors wait for Run." />
          <Toggle s={s} name="formatButtons" label="Format buttons" description="Format a filter, projection, sort or collation onto several lines." />
        </Stack>
      </Card>
      <Card title="Confirmations" description="Read-only connections refuse every write whatever these say. Deleting a connection, $out and $merge, and copies, renames and tasks that replace a collection always ask.">
        <Stack gap="sm">
          <Toggle s={s} name="confirmDeleteDocs" label="Ask before deleting documents" description="The selected rows, or the open document." />
          <Toggle s={s} name="confirmDrop" label="Ask before dropping" description="A collection, a view or an index, or deleting all of a collection's documents." />
          <Toggle s={s} name="confirmByName" label="Type the name to confirm" description="Before dropping a database, or updating every document of a collection." />
        </Stack>
      </Card>
      <Row>
        <Button icon="refresh" variant="ghost" disabled={isDefault(s)} onPress={resetSettings}>Reset to defaults</Button>
      </Row>
    </Box>
  )
}
