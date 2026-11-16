// The Shell tab, and the Code section shared with collection tabs.
import { Badge, Box, Button, Callout, CodeView, Collapsible, IconButton, read, RelativeTime, Row, Select, set, Text, Toolbar, type OrcaNode } from 'orca'
import { CODE_LANGUAGES, generateCode, type CodeLanguage } from '../shared/codegen'
import type { Operation } from '../shared/operation'
import { change, collTabs, specFromText, type CollTab } from './collection-state'
import { guard } from './guard'
import { Results } from './results-view'
import { closeShell, codeLanguage, openAsPipeline, openAsQuery, resultOptions, selectResult, SHELL_TAB, shellRun } from './shell-state'

/** Driver code for an operation, in the language the person last picked. */
export function CodeSection({ op, description, emptyText }: { op: Operation | undefined; description: string; emptyText?: string }): OrcaNode {
  const lang = read(codeLanguage)
  return (
    <Collapsible title="Code" description={description}>
      <Box gap="xs">
        <Select label="Language" value={lang} options={CODE_LANGUAGES} onChange={(v) => set(codeLanguage, v as CodeLanguage)} />
        {op ? <CodeView code={generateCode(op, lang)} label={`${lang} code`} maxHeight="md" /> : <Text muted size="xs">{emptyText ?? 'Run a query first: its code appears here.'}</Text>}
      </Box>
    </Collapsible>
  )
}

/** The query a collection tab ran, as an operation. */
export function tabOperation(t: CollTab): Operation | undefined {
  const { spec } = specFromText(t.text)
  if (!spec) return undefined
  return { kind: 'find', db: t.ns.db, collection: t.ns.collection, ...spec }
}

export function ShellTab(): OrcaNode {
  const run = read(shellRun)
  const t = read(collTabs)[SHELL_TAB]
  if (!run || !t?.shell) return null
  const info = run.results[t.shell.index]
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold" truncate>Shell results</Text>
          <Row gap="xs" align="center">
            <Text size="xs" muted truncate>{`${run.connectionName} › ${run.db} ·`}</Text>
            <RelativeTime at={run.at} muted />
          </Row>
        </Box>
        <IconButton icon="close" label="Close the shell results" variant="ghost" size="sm" onPress={closeShell} />
      </Row>
      {run.results.length > 1 ? (
        <Select label="Result" value={String(t.shell.index)} options={resultOptions(run)} onChange={(v) => void guard(SHELL_TAB, () => selectResult(Number(v)))()} />
      ) : null}
      {info ? (
        <Toolbar label="Result actions" gap="xs">
          <Badge tone="neutral">{info.op ? `${info.op.kind} on ${info.op.db}.${info.op.collection}` : info.kind === 'cursor' ? 'cursor' : 'documents'}</Badge>
          {info.op?.kind === 'find' ? (
            <Button size="sm" icon="open-external" variant="ghost" onPress={guard(SHELL_TAB, () => openAsQuery(info))}>
              Open as query
            </Button>
          ) : null}
          {info.op?.kind === 'aggregate' ? (
            <Button size="sm" icon="layers" variant="ghost" onPress={guard(SHELL_TAB, () => openAsPipeline(info))}>
              Open in the aggregation editor
            </Button>
          ) : null}
        </Toolbar>
      ) : null}
      {t.notice ? (
        <Callout tone={t.notice.tone} icon={t.notice.tone === 'danger' ? 'error' : 'info'}>
          <Row justify="between" align="center">
            <Text>{t.notice.text}</Text>
            <IconButton icon="close" label="Dismiss" variant="ghost" size="xs" onPress={() => change(SHELL_TAB, () => ({ notice: undefined }))} />
          </Row>
        </Callout>
      ) : null}
      {t.error ? <Callout tone="danger" icon="error" title="Could not read the results">{t.error}</Callout> : null}
      <Results t={t} />
      {info?.op ? <CodeSection op={info.op} description="This result's find or aggregate as driver code." /> : null}
    </Box>
  )
}
