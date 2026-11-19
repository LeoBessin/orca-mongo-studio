// The Settings tab: Mongo Studio's preferences, grouped by area, kept across reloads and restarts,
// with "Reset to defaults". Orca shows the same settings under the plugin in its own Settings.
// Changes apply at once; views and sizes apply to tabs and documents opened from then on, while
// tabs already open keep their own.
import { Box, Button, Callout, Card, Checkbox, IconButton, read, Row, Select, Stack, Text, type OrcaNode } from 'orca'
import { DOC_VIEWS, RESULT_VIEWS } from './collection-state'
import { DOC_VIEW_KEYS, isDefault, oneOf, PAGE_SIZES, RESULT_VIEW_KEYS, type FlagKey, type Settings } from '../shared/settings'
import { changeSettings, closeSettings, resetSettings, settings, settingsError } from './settings-state'

const LAST = { value: 'last', label: 'Last used' }

function choices(labels: Record<string, string>): { value: string; label: string }[] {
  return [LAST, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]
}

function Toggle({ s, name, label, description }: { s: Settings; name: FlagKey; label: string; description: string }): OrcaNode {
  return <Checkbox label={label} description={description} checked={s[name]} onChange={(on) => void changeSettings({ [name]: on })} />
}

export function SettingsView(): OrcaNode {
  const s = settings()
  const error = read(settingsError)
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold">Settings</Text>
          <Text size="xs" muted>Kept across reloads and restarts, apart from your saved connections, which never change here. Orca's Settings shows them under Mongo Studio too.</Text>
        </Box>
        <IconButton icon="close" label="Close settings" variant="ghost" size="sm" onPress={closeSettings} />
      </Row>
      {error ? <Callout tone="danger" icon="error" title="Setting not saved">{error}</Callout> : null}
      <Card title="Results" description="How new tabs, opened documents and new JSON exports start. Tabs already open keep their own.">
        <Stack gap="sm">
          <Select label="Results view" value={s.resultView} options={choices(RESULT_VIEWS)} onChange={(v) => void changeSettings({ resultView: oneOf(v, ['last', ...RESULT_VIEW_KEYS], s.resultView) })} />
          <Select label="Document view" value={s.docView} options={choices(DOC_VIEWS)} onChange={(v) => void changeSettings({ docView: oneOf(v, ['last', ...DOC_VIEW_KEYS], s.docView) })} />
          <Select
            label="Page size"
            value={String(s.pageSize)}
            options={[LAST, ...PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} per page` }))]}
            onChange={(v) => void changeSettings({ pageSize: v === 'last' ? 'last' : oneOf(Number(v), PAGE_SIZES, s.pageSize === 'last' ? PAGE_SIZES[1] : s.pageSize) })}
          />
          <Select
            label="Extended JSON"
            value={s.ejson}
            options={[
              { value: 'relaxed', label: 'Relaxed: numbers and dates as plain JSON' },
              { value: 'canonical', label: 'Canonical: every BSON type exact' }
            ]}
            onChange={(v) => void changeSettings({ ejson: oneOf(v, ['relaxed', 'canonical'] as const, s.ejson) })}
          />
          <Text size="xs" muted>Extended JSON applies to result and document JSON views, shell results, and the Relaxed option of new JSON exports.</Text>
        </Stack>
      </Card>
      <Card title="Query bar">
        <Stack gap="sm">
          <Toggle s={s} name="liveCheck" label="Check fields as you type" description="Say what doesn't parse while it is typed. Off, errors wait for Run." />
          <Toggle s={s} name="formatButtons" label="Format buttons" description="Format a filter, projection, sort or collation onto several lines." />
        </Stack>
      </Card>
      <Card title="Confirmations" description="Read-only connections refuse every write whatever these say.">
        <Stack gap="sm">
          <Toggle s={s} name="confirmDeleteDocs" label="Ask before deleting documents" description="The selected rows, or the open document." />
          <Toggle s={s} name="confirmDrop" label="Ask before dropping collections and indexes" description="Dropping a collection, a view or an index, or deleting all of a collection's documents." />
          <Toggle s={s} name="confirmByName" label="Type the name to confirm" description="Before dropping a database, or updating every document of a collection." />
          <Text size="xs" muted>
            These always ask: deleting a saved connection, dropping a user or a role, deleting a GridFS file, killing an operation, $out and $merge, and imports, copies, renames and tasks that drop or replace a collection.
          </Text>
        </Stack>
      </Card>
      <Row>
        <Button icon="refresh" variant="ghost" disabled={isDefault(s)} onPress={() => void resetSettings()}>Reset to defaults</Button>
      </Row>
    </Box>
  )
}
