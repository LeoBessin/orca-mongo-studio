// Import and export of connection definitions. Exports never include passwords, keys or pasted
// certificates; the file is offered through Orca's save dialog, so the plugin never sees a path.
import { Box, Button, Callout, Checkbox, files, Heading, read, Row, set, Text, Textarea, type OrcaNode } from 'orca'
import { connections, exportJson, exportSelection, importResult, importText, refreshExport, runImport, view } from './state'

function importSection(): OrcaNode {
  const result = read(importResult)
  return (
    <Box gap="sm">
      <Heading level={3}>Import</Heading>
      <Textarea
        label="Connection strings or an export file's JSON"
        rows={6}
        value={read(importText)}
        placeholder={'mongodb://alice@db1.example.com:27017/?authSource=admin\nmongodb+srv://cluster0.abcde.mongodb.net'}
        onChange={(v) => set(importText, v)}
        onSubmit={() => void runImport()}
      />
      <Text muted size="sm">One connection string per line, or the JSON of a Mongo Studio or MongoDB Compass export. Passwords in connection strings are saved encrypted.</Text>
      <Row gap="xs">
        <Button variant="solid" tone="accent" icon="upload" disabled={!read(importText).trim()} onPress={runImport}>Import</Button>
      </Row>
      {result ? (
        <Callout tone={result.errors.length ? (result.imported.length ? 'warning' : 'danger') : 'success'} icon={result.errors.length ? 'warning' : 'check'} title={`Imported ${result.imported.length} connection${result.imported.length === 1 ? '' : 's'}`}>
          <Box gap="xs">
            {result.imported.flatMap((i) => i.warnings.map((w) => <Text key={`${i.id}:${w}`} size="sm">{i.name}: {w}</Text>))}
            {result.errors.map((e) => <Text key={e} size="sm" tone="danger">{e}</Text>)}
          </Box>
        </Callout>
      ) : null}
    </Box>
  )
}

function exportSection(): OrcaNode {
  const state = read(connections)
  const all = state?.connections ?? []
  const chosen = read(exportSelection) ?? all.map((c) => c.id)
  const prepared = read(exportJson)
  const toggle = (id: string, on: boolean): void => {
    set(exportSelection, on ? [...new Set([...chosen, id])] : chosen.filter((x) => x !== id))
    void refreshExport()
  }
  return (
    <Box gap="sm">
      <Heading level={3}>Export</Heading>
      {all.length === 0 ? (
        <Text muted>There are no connections to export yet.</Text>
      ) : (
        <Box gap="xs">
          {all.map((c) => (
            <Checkbox key={c.id} label={c.name} description={c.group ? `${c.group} · ${c.subtitle}` : c.subtitle} checked={chosen.includes(c.id)} onChange={(on) => toggle(c.id, on)} />
          ))}
        </Box>
      )}
      <Callout tone="neutral" icon="info">Passwords, keys and pasted certificates are never exported. Whoever imports the file enters them again.</Callout>
      <Row gap="xs">
        <Button
          variant="solid"
          tone="accent"
          icon="download"
          disabled={!prepared || prepared.count === 0}
          onPress={async () => {
            if (!prepared) return
            await files.saveAs({ suggestedName: 'mongo-studio-connections.json', mimeType: 'application/json', data: prepared.json })
          }}
        >
          Save {prepared?.count ?? 0} as JSON…
        </Button>
      </Row>
    </Box>
  )
}

export function TransferView(): OrcaNode {
  return (
    <Box gap="lg">
      {importSection()}
      {exportSection()}
      <Row>
        <Button variant="ghost" onPress={() => set(view, 'tree')}>Back to connections</Button>
      </Row>
    </Box>
  )
}
