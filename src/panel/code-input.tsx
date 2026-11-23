// A query text field (filter, projection, sort, collation): Orca's CodeInput where this Orca has
// it, with highlighting, suggestions and the problem underlined; otherwise the plain Input or
// Textarea the panel used before. CodeInput is created by name with `h`, never imported: a named
// import that an older Orca lacks fails the whole panel module.
import { h, Input, Textarea, ui, type OrcaNode } from 'orca'
import { queryCompletions, queryDiagnostics, type CodeCompletion, type CodeDiagnostic, type QueryInputKind } from '../shared/query-completions'

export type CodeBox = {
  label: string
  labelHidden?: boolean
  value: string
  placeholder?: string
  invalid?: boolean
  onChange: (value: string) => void
  onSubmit?: () => void
}

/** Orca's CodeInputProps (catalog 5), declared here since older typings lack it. */
type CodeInputProps = Omit<CodeBox, 'onSubmit'> & {
  language?: string
  rows?: number
  maxRows?: number
  completions?: CodeCompletion[]
  quotes?: string
  diagnostics?: CodeDiagnostic[]
  onSubmit?: (value: string) => void
}

/** Whether this Orca draws CodeInput, so the query fields can highlight and suggest. */
export function hasCodeInput(): boolean {
  return ui.has('CodeInput')
}

// The vocabulary only changes with the collection's sampled fields; reusing the array keeps each
// render from rebuilding a few hundred suggestions.
const cache = new Map<string, { fields: readonly string[]; items: CodeCompletion[] }>()
function completionsFor(kind: QueryInputKind, fields: readonly string[]): CodeCompletion[] {
  const hit = cache.get(kind)
  if (hit && hit.fields.length === fields.length && hit.fields.every((f, i) => f === fields[i])) return hit.items
  const items = queryCompletions(kind, fields)
  cache.set(kind, { fields: [...fields], items })
  return items
}

/**
 * One query field. `multi` is the box Format opens (3 to 12 lines, Cmd/Ctrl+Enter runs); otherwise
 * one line, where Enter runs. `error` is the message shown under it; where the text stops parsing
 * is underlined.
 */
export function QueryCodeInput({ box, kind, multi, fields = [], error }: { box: CodeBox; kind: QueryInputKind; multi: boolean; fields?: readonly string[]; error?: string | undefined }): OrcaNode {
  const { onSubmit, ...rest } = box
  if (!hasCodeInput()) {
    const submit = onSubmit ? { onSubmit: () => onSubmit() } : {}
    return multi ? <Textarea {...rest} {...submit} rows={Math.min(12, Math.max(3, box.value.split('\n').length))} /> : <Input {...rest} {...submit} />
  }
  const props: CodeInputProps = {
    ...rest,
    language: 'javascript',
    rows: multi ? 3 : 1,
    // One line wraps and grows with a long query rather than hiding it.
    maxRows: multi ? 12 : 4,
    completions: completionsFor(kind, fields),
    // Nothing to suggest inside a string; keys, operators, helpers and booleans everywhere else.
    quotes: `'"\``,
    diagnostics: error ? queryDiagnostics(kind, box.value, error) : [],
    ...(onSubmit ? { onSubmit: () => onSubmit() } : {})
  }
  return h('CodeInput', props)
}
