// One document on its own, read whole from the server: as a Tree, Extended JSON or shell syntax,
// with its edit, clone and delete actions. It covers a collection tab's results when opened from
// them ("Open"), and is the whole of a document tab ("Open in a tab").
import { Badge, Box, Button, Callout, CodeView, EmptyState, IconButton, Row, Skeleton, Switch, Text, Toolbar, Tree, type OrcaNode, type TreeItem } from 'orca'
import { BSON_TYPE_LABELS, bsonType, isContainer, toJsonText, toShell, toShellInline, valueAt, valueText, type JsonObject, type JsonValue } from '../shared/ejson-view'
import {
  addField,
  askDeleteFocused,
  cloneDocument,
  closeDocument,
  closeTab,
  DOC_VIEWS,
  editDocument,
  editField,
  loadFocus,
  nsLabel,
  openDocumentTab,
  parseTreeKey,
  setDocView,
  setFocus,
  treeKey,
  type CollTab,
  type DocFocus,
  type DocView,
  type Path
} from './collection-state'
import { guard } from './guard'

const VIEWS = Object.entries(DOC_VIEWS).map(([value, label]) => ({ value: value as DocView, label }))

function entries(v: JsonValue): [string | number, JsonValue][] {
  return Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v as JsonObject)
}

function fieldItem(path: Path, v: JsonValue, expanded: Set<string>): TreeItem {
  const key = treeKey(0, path)
  const name = path[path.length - 1]!
  const item: TreeItem = {
    key,
    label: `${typeof name === 'number' ? `[${name}]` : name}: ${valueText(v, 120)}`,
    description: BSON_TYPE_LABELS[bsonType(v)],
    icon: isContainer(v) ? (Array.isArray(v) ? 'layers' : 'folder') : 'file'
  }
  if (isContainer(v) && entries(v).length) {
    if (expanded.has(key)) item.children = entries(v).map(([k, x]) => fieldItem([...path, k], x, expanded))
    else item.hasChildren = true
  }
  return item
}

function DocTree({ t, f, doc }: { t: CollTab; f: DocFocus; doc: JsonObject }): OrcaNode {
  const expanded = new Set(f.expanded)
  const items = Object.entries(doc).map(([k, v]) => fieldItem([k], v, expanded))
  const selected = f.selected ? parseTreeKey(f.selected).path : undefined
  const value = selected?.length ? valueAt(doc, selected) : undefined
  const canEdit = !t.readOnly && selected?.length && selected[0] !== '_id'
  return (
    <Box gap="xs">
      <Tree
        label="Fields"
        items={items}
        expanded={f.expanded}
        {...(f.selected ? { selected: f.selected } : {})}
        maxHeight="lg"
        onToggle={({ key, expanded: open }) => setFocus(t.id, { expanded: open ? [...new Set([...f.expanded, key])] : f.expanded.filter((k) => k !== key && !k.startsWith(`${key}/`)) })}
        onSelect={({ key }) => setFocus(t.id, { selected: key })}
        onAction={({ key }) => {
          const { path } = parseTreeKey(key)
          if (!t.readOnly && path.length && path[0] !== '_id') void guard(t.id, () => editField(t.id, f.id, path))()
        }}
      />
      {selected?.length ? (
        <Toolbar label="Field actions" gap="xs">
          {canEdit ? <Button size="sm" icon="edit" onPress={guard(t.id, () => editField(t.id, f.id, selected))}>Edit field</Button> : null}
          {value !== undefined ? <Badge>{BSON_TYPE_LABELS[bsonType(value)]}</Badge> : null}
        </Toolbar>
      ) : (
        <Text size="xs" muted>{t.readOnly ? 'Select a field to see its type.' : 'Select a field to edit it. Enter edits.'}</Text>
      )}
    </Box>
  )
}

function DocBody({ t, f, doc }: { t: CollTab; f: DocFocus; doc: JsonObject }): OrcaNode {
  if (f.view === 'tree') return <DocTree t={t} f={f} doc={doc} />
  if (f.view === 'shell') return <CodeView label="Document in shell syntax" code={toShell(doc)} language="javascript" lineNumbers maxHeight="lg" />
  return (
    <Box gap="xs">
      <Switch label="Relaxed Extended JSON" checked={f.relaxed} onChange={(relaxed) => setFocus(t.id, { relaxed })} />
      <CodeView label="Document as Extended JSON" code={toJsonText(doc, f.relaxed)} language="json" lineNumbers maxHeight="lg" />
    </Box>
  )
}

export function DocumentView({ t }: { t: CollTab }): OrcaNode {
  const f = t.focus
  if (!f) return null
  const inTab = Boolean(t.docTab)
  const doc = f.doc
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold" truncate>{toShellInline(f.id)}</Text>
          <Text size="xs" muted truncate>{`${nsLabel(t.ns)}${doc ? ` · ${Object.keys(doc).length} fields` : ''}`}</Text>
        </Box>
        <Toolbar label="Open document" gap="xs">
          <IconButton icon="refresh" label="Read the document again" variant="ghost" size="sm" disabled={f.loading || f.deleted} onPress={guard(t.id, () => loadFocus(t.id))} />
          {!inTab ? <IconButton icon="file-text" label="Open in a tab" variant="ghost" size="sm" disabled={f.deleted} onPress={guard(t.id, () => openDocumentTab(t.id, f.id))} /> : null}
          {inTab ? (
            <IconButton icon="close" label={`Close ${t.title}`} variant="ghost" size="sm" onPress={() => closeTab(t.id)} />
          ) : (
            <Button size="sm" icon="close" variant="ghost" onPress={() => closeDocument(t.id)}>Back to results</Button>
          )}
        </Toolbar>
      </Row>
      {f.deleted ? (
        <EmptyState icon="delete" title="Document deleted" description={`${toShellInline(f.id)} is no longer in ${nsLabel(t.ns)}.`} />
      ) : f.error ? (
        <Callout tone="danger" icon="error" title="Could not read the document">{f.error}</Callout>
      ) : !doc ? (
        <Skeleton lines={8} label="Reading the document" />
      ) : (
        <Box gap="sm">
          <Row gap="xs" align="center" justify="between" wrap>
            <Toolbar label="Show the document as" gap="xs">
              {VIEWS.map((v) => (
                <Button key={v.value} size="sm" variant={f.view === v.value ? 'solid' : 'ghost'} tone={f.view === v.value ? 'accent' : 'neutral'} onPress={() => setDocView(t.id, v.value)}>
                  {v.label}
                </Button>
              ))}
            </Toolbar>
            {t.readOnly ? <Badge tone="warning">Read only</Badge> : null}
          </Row>
          <DocBody t={t} f={f} doc={doc} />
          {!t.readOnly ? (
            <Toolbar label="Document actions" gap="xs">
              <Button size="sm" icon="edit" onPress={guard(t.id, () => editDocument(t.id, f.id))}>Edit document</Button>
              <Button size="sm" icon="add" variant="ghost" onPress={() => addField(t.id, f.id)}>Add field</Button>
              <Button size="sm" icon="copy" variant="ghost" onPress={guard(t.id, () => cloneDocument(t.id, f.id))}>Clone</Button>
              <Button size="sm" icon="delete" variant="ghost" tone="danger" onPress={() => askDeleteFocused(t.id)}>Delete</Button>
            </Toolbar>
          ) : null}
        </Box>
      )}
    </Box>
  )
}
