// Explain plans on a tab: the find in a collection tab's query bar, or an aggregation tab's
// pipeline. The worker reads the server's answer into a summary and a stage tree.
import { atom, plugin, read, set } from 'orca'
import { allNodeKeys, type ExplainVerbosity } from '../shared/explain'
import { pipelineOf } from '../shared/pipeline'
import { change, specFromText, tab, type ExplainState } from './collection-state'
import { errorText } from './state'

/** The verbosity the person last chose, for new tabs. */
export const explainVerbosity = atom<ExplainVerbosity>('mongo-studio.explainVerbosity', 'executionStats', { persist: 'plugin' })

export function explainOf(id: string): ExplainState {
  return tab(id)?.explain ?? { open: false, verbosity: read(explainVerbosity), loading: false, mode: 'visual', expanded: [], token: 0 }
}

export function changeExplain(id: string, values: Partial<ExplainState>): void {
  change(id, (t) => ({ explain: { ...(t.explain ?? explainOf(id)), ...values } }))
}

export function setVerbosity(id: string, verbosity: ExplainVerbosity): void {
  set(explainVerbosity, verbosity)
  changeExplain(id, { verbosity })
}

/** Explains what the tab holds now: the typed query, or the enabled stages. */
export async function runExplain(id: string): Promise<void> {
  const t = tab(id)
  if (!t) return
  const ex = explainOf(id)
  const token = ex.token + 1
  let request: () => Promise<import('../protocol').ExplainResult>
  if (t.agg) {
    const { pipeline, errors } = pipelineOf(t.agg.stages)
    if (!pipeline) {
      change(id, (x) => ({ agg: { ...x.agg!, errors } }))
      changeExplain(id, { open: true, error: 'Fix the stages marked with an error first.', result: undefined, token })
      return
    }
    const options = t.agg.allowDiskUse ? { allowDiskUse: true } : {}
    request = () => plugin.request('agg.explain', { ns: t.ns, pipeline, options, verbosity: ex.verbosity }, { timeoutMs: 120000 })
  } else {
    const { spec, errors } = specFromText(t.text)
    if (!spec) {
      change(id, () => ({ fieldErrors: errors }))
      changeExplain(id, { open: true, error: 'Fix the query first: a field above does not parse.', result: undefined, token })
      return
    }
    request = () => plugin.request('query.explain', { ns: t.ns, spec, verbosity: ex.verbosity }, { timeoutMs: 120000 })
  }
  changeExplain(id, { open: true, loading: true, error: undefined, token })
  try {
    const result = await request()
    if (explainOf(id).token !== token) return
    changeExplain(id, { loading: false, result, expanded: allNodeKeys(result.summary.stages), selected: undefined })
  } catch (error) {
    if (explainOf(id).token === token) changeExplain(id, { loading: false, error: errorText(error), result: undefined })
  }
}

export function toggleNode(id: string, key: string, open: boolean): void {
  const ex = explainOf(id)
  changeExplain(id, { expanded: open ? [...new Set([...ex.expanded, key])] : ex.expanded.filter((k) => k !== key && !k.startsWith(`${key}-`)) })
}
