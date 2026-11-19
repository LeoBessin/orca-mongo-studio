// The field editor (one value, with an input that fits its BSON type, and the type as its own
// choice) and the document editor (the whole document as shell syntax or Extended JSON).
import { Box, Button, Callout, Card, Input, RadioGroup, Row, Select, Text, Textarea, type OrcaNode } from 'orca'
import { BSON_TYPE_LABELS, bsonType, pathText, toShellInline } from '../shared/ejson-view'
import { changeType, draftHint, EDIT_TYPES, valueFromDraft, type EditType, type FieldDraft } from '../shared/field-edit'
import { shellProblem } from '../shared/shell-parse'
import {
  closeEditor,
  confirmDeletion,
  change,
  nsLabel,
  parseDocText,
  removeField,
  saveDocument,
  saveField,
  setDocSyntax,
  setDocText,
  setDraft,
  setNewFieldName,
  type CollTab,
  type DocEditor,
  type FieldEditor
} from './collection-state'
import { guardAt } from './guard'

// The editors open under the results: their errors show there too.
const guard = guardAt('results')

function ValueInputs({ t, draft }: { t: CollTab; draft: FieldDraft }): OrcaNode {
  const set = (values: Partial<FieldDraft>): void => setDraft(t.id, { ...draft, ...values })
  const result = valueFromDraft(draft)
  const invalid = !result.ok && draft.text !== ''
  switch (draft.type) {
    case 'null':
    case 'minKey':
    case 'maxKey':
      return <Text muted size="sm">{`This type has no value to enter.`}</Text>
    case 'bool':
      return <RadioGroup label="Value" orientation="horizontal" value={draft.text === 'true' ? 'true' : 'false'} options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]} onChange={(text) => set({ text })} />
    case 'object':
    case 'array':
    case 'javascript':
      return <Textarea label={draft.type === 'javascript' ? 'Code' : 'Value'} rows={8} value={draft.text} invalid={invalid} onChange={(text) => set({ text })} onSubmit={() => void guard(t.id, () => saveField(t.id))()} />
    case 'binData':
      return (
        <Box gap="xs">
          <Input label="Subtype (0 to 255)" value={draft.subtype} onChange={(subtype) => set({ subtype })} />
          <Textarea label="Data (base64)" rows={3} value={draft.text} invalid={invalid} onChange={(text) => set({ text })} />
        </Box>
      )
    case 'regex':
      return (
        <Row gap="xs" align="end">
          <Input label="Pattern" value={draft.text} invalid={invalid} onChange={(text) => set({ text })} onSubmit={() => void guard(t.id, () => saveField(t.id))()} />
          <Input label="Flags" value={draft.flags} placeholder="i, m, s, x, u" onChange={(flags) => set({ flags })} />
        </Row>
      )
    case 'timestamp':
      return (
        <Row gap="xs" align="end">
          <Input label="Seconds (t)" value={draft.t} onChange={(v) => set({ t: v })} />
          <Input label="Increment (i)" value={draft.i} onChange={(i) => set({ i })} />
        </Row>
      )
    default: {
      const labels: Partial<Record<EditType, string>> = { date: 'Date (UTC)', objectId: 'ObjectId (24 hex digits)', uuid: 'UUID' }
      return <Input label={labels[draft.type] ?? 'Value'} value={draft.text} invalid={invalid} onChange={(text) => set({ text })} onSubmit={() => void guard(t.id, () => saveField(t.id))()} />
    }
  }
}

function FieldEditorCard({ t, e }: { t: CollTab; e: FieldEditor }): OrcaNode {
  const result = valueFromDraft(e.draft)
  const unchanged = !e.adding && result.ok && e.original !== undefined && JSON.stringify(result.value) === JSON.stringify(e.original)
  const originalType = e.original === undefined ? undefined : bsonType(e.original)
  const title = e.adding ? 'Add a field' : `Edit ${pathText(e.path)}`
  return (
    <Card title={title} description={`Document ${toShellInline(e.id)} in ${nsLabel(t.ns)}`}>
      <Box gap="sm">
        {e.adding ? <Input label="Field name" placeholder="name, or a.b for a nested field" value={e.newName ?? ''} onChange={(v) => setNewFieldName(t.id, v)} /> : null}
        <Select
          label="Type"
          value={e.draft.type}
          options={EDIT_TYPES.map((o) => ({ value: o.value, label: originalType && o.value === originalType ? `${o.label} (current)` : o.label }))}
          onChange={(type) => setDraft(t.id, changeType(e.draft, type as EditType))}
        />
        {originalType && originalType !== e.draft.type && !(originalType === 'truncated') ? (
          <Text size="xs" tone="warning">{`Saving changes the type from ${BSON_TYPE_LABELS[originalType]} to ${EDIT_TYPES.find((o) => o.value === e.draft.type)!.label}.`}</Text>
        ) : null}
        <ValueInputs t={t} draft={e.draft} />
        {draftHint(e.draft) ? <Text size="xs" muted>{draftHint(e.draft)}</Text> : null}
        {!result.ok && (e.draft.text !== '' || e.error) ? <Text size="xs" tone="danger">{result.error}</Text> : null}
        {e.error ? <Callout tone="danger" icon="error">{e.error}</Callout> : null}
        <Row gap="xs" wrap>
          <Button variant="solid" tone="accent" icon="check" disabled={e.saving || unchanged} onPress={guard(t.id, () => saveField(t.id))}>
            {e.saving ? 'Saving…' : 'Save field'}
          </Button>
          <Button variant="ghost" onPress={() => closeEditor(t.id)}>Cancel</Button>
          {!e.adding ? (
            <Button variant="ghost" tone="danger" icon="delete" disabled={e.saving} onPress={guard(t.id, () => removeField(t.id))}>
              Remove field
            </Button>
          ) : null}
        </Row>
      </Box>
    </Card>
  )
}

function DocEditorCard({ t, e }: { t: CollTab; e: DocEditor }): OrcaNode {
  const problem = e.syntax === 'shell' ? shellProblem(e.text, 'document') : parseDocText(e.text).error
  const problemText = problem ? (typeof problem === 'string' ? problem : problem.message) : null
  const title = e.mode === 'edit' ? 'Edit document' : e.mode === 'clone' ? 'Clone document' : 'Insert document'
  const description =
    e.mode === 'edit' ? `Replaces ${toShellInline(e.id!)} in ${nsLabel(t.ns)}` : e.mode === 'clone' ? `A copy without its _id, inserted into ${nsLabel(t.ns)}` : `Into ${nsLabel(t.ns)}. Leave _id out to have one made.`
  return (
    <Card title={title} description={description}>
      <Box gap="sm">
        <Select
          label="Syntax"
          value={e.syntax}
          options={[
            { value: 'shell', label: 'Shell (ObjectId(...), ISODate(...))' },
            { value: 'ejson', label: 'Extended JSON (canonical)' }
          ]}
          onChange={(v) => setDocSyntax(t.id, v as 'shell' | 'ejson')}
        />
        <Textarea label="Document" rows={18} value={e.text} invalid={Boolean(problemText)} onChange={(v) => setDocText(t.id, v)} onSubmit={() => void guard(t.id, () => saveDocument(t.id))()} />
        {problemText ? <Text size="xs" tone="danger">{problemText}</Text> : <Text size="xs" muted>Ctrl+Enter saves.</Text>}
        {e.error ? <Callout tone="danger" icon="error">{e.error}</Callout> : null}
        <Row gap="xs">
          <Button variant="solid" tone="accent" icon="check" disabled={e.saving || Boolean(problemText)} onPress={guard(t.id, () => saveDocument(t.id))}>
            {e.saving ? 'Saving…' : e.mode === 'edit' ? 'Save document' : 'Insert'}
          </Button>
          <Button variant="ghost" onPress={() => closeEditor(t.id)}>Cancel</Button>
        </Row>
      </Box>
    </Card>
  )
}

export function Editors({ t }: { t: CollTab }): OrcaNode {
  const pending = t.confirmDelete
  return (
    <Box gap="sm">
      {pending ? (
        <Callout tone="danger" icon="warning" title={`Delete ${pending.ids.length.toLocaleString('en-US')} document${pending.ids.length === 1 ? '' : 's'} from ${nsLabel(t.ns)}?`}>
          <Box gap="sm">
            <Text>{`This removes ${pending.ids.length === 1 ? `the document ${toShellInline(pending.ids[0]!)}` : `the ${pending.ids.length} selected documents`}. It can't be undone.`}</Text>
            <Row gap="xs">
              <Button variant="solid" tone="danger" onPress={guard(t.id, () => confirmDeletion(t.id))}>
                {pending.ids.length === 1 ? 'Delete document' : `Delete ${pending.ids.length} documents`}
              </Button>
              <Button variant="ghost" onPress={() => change(t.id, () => ({ confirmDelete: undefined }))}>Cancel</Button>
            </Row>
          </Box>
        </Callout>
      ) : null}
      {t.editor?.kind === 'field' ? <FieldEditorCard t={t} e={t.editor} /> : null}
      {t.editor?.kind === 'doc' ? <DocEditorCard t={t} e={t.editor} /> : null}
    </Box>
  )
}

