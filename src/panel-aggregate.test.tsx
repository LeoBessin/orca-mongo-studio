// Aggregation tabs and explain plans over a stand-in worker: building a pipeline stage by stage,
// the preview, running and paging, $out confirmation, text mode, views, saved pipelines, and the
// explain section on collection and aggregation tabs.
import { assert, describe, hostError, mockHost, mount, test, type MockRequests } from 'orca/testing'
import type { AggOptions, ConnectionsState, ExplainResult, Namespace, PreviewResult, QueryPage, SavedPipeline, ShellRunSummary } from './protocol'
import type { JsonObject } from './shared/ejson-view'
import { summarizeExplain } from './shared/explain'
import * as panel from './panel'
import { aggTabId } from './panel/aggregate-state'
import { tabIdFor } from './panel/collection-state'

const state: ConnectionsState = {
  connections: [{ id: 'c1', name: 'Local dev', group: '', subtitle: 'localhost', topology: 'replicaSet', connected: true, readOnly: false }],
  favourites: [],
  secretsProtection: 'os-keyring'
}

const ns: Namespace = { connectionId: 'c1', db: 'shop', collection: 'orders' }
const AGG = aggTabId(ns)
const int = (n: number) => ({ $numberInt: String(n) })
const docs = (n: number, from = 0): JsonObject[] => Array.from({ length: n }, (_, i) => ({ _id: int(from + i), status: i % 2 ? 'pending' : 'shipped' }))

const explainAnswer = (kind: 'find' | 'aggregate'): ExplainResult => ({
  summary: summarizeExplain(
    {
      queryPlanner: { namespace: 'shop.orders', winningPlan: { stage: 'COLLSCAN', filter: { status: { $eq: 'shipped' } }, direction: 'forward' }, rejectedPlans: [] },
      executionStats: { executionSuccess: true, nReturned: 10, executionTimeMillis: 4, totalKeysExamined: 0, totalDocsExamined: 20000, executionStages: { stage: 'COLLSCAN', nReturned: 10, executionTimeMillisEstimate: 3, docsExamined: 20000, filter: { status: { $eq: 'shipped' } } } }
    },
    kind
  ),
  raw: '{\n  "queryPlanner": {}\n}',
  rawCut: false,
  verbosity: 'executionStats',
  ms: 7
})

type Calls = {
  previews: { before: JsonObject[]; stage?: JsonObject; size: number; options: AggOptions }[]
  runs: { pipeline: JsonObject[]; options: AggOptions; pageSize: number }[]
  pages: { queryId: string; offset: number; pipeline: JsonObject[] }[]
  counts: JsonObject[][]
  explains: { kind: 'find' | 'agg'; input: unknown }[]
  views: { name: string; pipeline: JsonObject[] }[]
  saves: { name: string; stages: unknown }[]
}

function setup(extra: MockRequests = {}) {
  const calls: Calls = { previews: [], runs: [], pages: [], counts: [], explains: [], views: [], saves: [] }
  let saved: SavedPipeline[] = []
  const host = mockHost({
    requests: {
      'connections.state': state,
      'data.count': { exists: true, count: 120, kind: 'collection' },
      'tree.children': ({ key }) =>
        key === 'conn:c1'
          ? { nodes: [{ key: 'conn:c1/db:shop', kind: 'db', label: 'shop', hasChildren: true }] }
          : { nodes: [{ key: 'conn:c1/db:shop/coll:orders', kind: 'coll', label: 'orders', hasChildren: true }] },
      'tree.details': { title: 'orders', subtitle: 'Collection', items: [] },
      'query.run': (): QueryPage => ({ queryId: 'q1', offset: 0, docs: docs(3), truncated: [], hasMore: false, stoppedForSize: false, ms: 1 }),
      'query.count': { count: 3, approximate: false, ms: 1 },
      'query.close': null,
      'history.list': { history: [], saved: [] },
      'agg.preview': ({ ns: _ns, ...input }): PreviewResult => {
        calls.previews.push(input)
        return { input: { docs: docs(2), truncated: [], more: true, stoppedForSize: false }, ...(input.stage ? { output: { docs: [{ _id: 'shipped', n: int(5) }], truncated: [], more: false, stoppedForSize: false } } : {}), ms: 2 }
      },
      'agg.run': ({ ns: _ns, ...input }): QueryPage => {
        calls.runs.push(input)
        const out = JSON.stringify(input.pipeline).includes('$out')
        return { queryId: 'a1', offset: 0, docs: out ? [] : docs(20), truncated: [], hasMore: !out, stoppedForSize: false, ms: 3 }
      },
      'agg.page': (input): QueryPage => {
        calls.pages.push(input)
        return { queryId: input.queryId, offset: input.offset, docs: docs(5, input.offset), truncated: [], hasMore: false, stoppedForSize: false, ms: 1 }
      },
      'agg.count': ({ pipeline }) => {
        calls.counts.push(pipeline)
        return { count: 25, approximate: false, ms: 1 }
      },
      'agg.explain': (input) => {
        calls.explains.push({ kind: 'agg', input })
        return explainAnswer('aggregate')
      },
      'query.explain': (input) => {
        calls.explains.push({ kind: 'find', input })
        return explainAnswer('find')
      },
      'view.create': ({ name, pipeline }) => {
        calls.views.push({ name, pipeline })
        if (name === 'taken') throw hostError('conflict', 'shop.taken already exists. Choose another name.')
        return { name: name.trim() }
      },
      'pipelines.list': () => ({ saved }),
      'pipelines.save': ({ name, stages }) => {
        calls.saves.push({ name, stages })
        saved = [{ name, at: 1_794_832_496_789, stages }]
        return { saved }
      },
      'pipelines.delete': ({ name }) => {
        saved = saved.filter((s) => s.name !== name)
        return { saved }
      },
      ...extra
    }
  })
  return { host, calls }
}

async function openAggregation(host: ReturnType<typeof setup>['host']) {
  const view = await mount(panel, { host })
  const tree = { type: 'Tree', label: 'Connections' }
  await view.expand(tree, 'conn:c1')
  await view.expand(tree, 'conn:c1/db:shop')
  await view.selectItem(tree, 'conn:c1/db:shop/coll:orders')
  await view.press({ text: 'Aggregate' })
  return view
}

const stages = { type: 'Table', label: 'Stages' }
const value = { type: 'Textarea', label: 'Value' }

describe('aggregation tabs', () => {
  test('Aggregate in the tree opens a tab with one $match stage, previewed', async () => {
    const { host, calls } = setup()
    const view = await openAggregation(host)
    assert.equal(view.valueOf({ type: 'Tabs' }), AGG)
    assert.ok(view.find({ text: 'shop.orders · aggregation' }))
    assert.equal(view.rowsOf(stages).length, 1)
    assert.equal(view.valueOf(value), '{ }')
    assert.deepEqual(calls.previews, [{ before: [], stage: { $match: {} }, size: 10, options: {} }])
    assert.equal(view.find({ type: 'CodeView', label: 'Stage output' })!.props.code, "[\n  {\n    _id: 'shipped',\n    n: 5\n  }\n]")
    assert.ok(view.find({ text: 'Output: 1 document.' }))
    await view.press({ text: 'Input' })
    assert.ok(view.find({ text: 'Input: the first 2 documents.' }))
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  })

  test('stages are added after the selected one, moved, turned off, duplicated and removed', async () => {
    const { host, calls } = setup()
    const view = await openAggregation(host)
    await view.type(value, "{ status: 'shipped' }", { replace: true })
    await view.select({ label: 'Add a stage' }, '$group')
    assert.equal(view.valueOf(value), "{ _id: '$field', count: { $sum: 1 } }", 'a new stage starts from its template')
    assert.deepEqual(calls.previews.at(-1), { before: [{ $match: { status: 'shipped' } }], stage: { $group: { _id: '$field', count: { $sum: int(1) } } }, size: 10, options: {} })
    await view.type(value, "{ _id: '$status', n: { $sum: 1 } }", { replace: true })
    await view.select({ label: 'Add a stage' }, '$limit')
    const rows = () => (view.find(stages)!.props.rows as { cells: Record<string, string> }[]).map((r) => `${r.cells.n} ${r.cells.op} ${r.cells.body}`)
    assert.deepEqual(rows(), ["1 $match { status: 'shipped' }", "2 $group { _id: '$status', n: { $sum: 1 } }", '3 $limit 10'])
    await view.press({ text: 'Up' })
    assert.deepEqual(rows().map((r) => r.split(' ')[1]), ['$match', '$limit', '$group'])
    await view.press({ label: 'Turn the stage off' })
    assert.ok(rows()[1]!.startsWith('2 $limit (off)'))
    assert.deepEqual(calls.previews.at(-1)!.stage, undefined, 'an off stage previews only its input')
    assert.ok(view.find({ text: 'This stage is off, so its output is its input.' }))
    await view.press({ label: 'Duplicate the stage' })
    assert.deepEqual(rows().map((r) => r.split(' ').slice(1, 3).join(' ')), ['$match {', '$limit (off)', '$limit (off)', '$group {'])
    await view.press({ label: 'Remove the stage' })
    assert.deepEqual(rows().map((r) => r.split(' ')[1]), ['$match', '$limit', '$group'], 'the copy is removed')
    const keys = (view.find(stages)!.props.rows as { key: string }[]).map((r) => r.key)
    assert.deepEqual(view.find(stages)!.props.selected, [keys[2]], 'the next stage is selected')
    await view.selectRows(stages, [keys[1]!])
    await view.press({ label: 'Remove the stage' })
    assert.deepEqual(rows().map((r) => r.split(' ')[1]), ['$match', '$group'])
    assert.ok(view.find({ text: '2 of 2 stages on' }))
    // Changing the operator keeps what was typed.
    await view.select({ label: 'Stage' }, '$project')
    assert.equal(view.valueOf(value), "{ _id: '$status', n: { $sum: 1 } }")
    assert.deepEqual(view.errors, [])
  })

  test('a stage that does not parse is marked, and nothing previews or runs', async () => {
    const { host, calls } = setup()
    const view = await openAggregation(host)
    await view.type(value, '{ status: ', { replace: true, submit: true })
    assert.ok(view.find({ text: /This stage does not parse/ }))
    assert.equal(calls.previews.length, 1)
    await view.press({ text: 'Run' })
    assert.equal(calls.runs.length, 0)
    assert.ok(view.find({ text: /Stage 1 \(\$match\) does not parse/ }))
    assert.ok((view.find(stages)!.props.rows as { cells: { n: string } }[])[0]!.cells.n.endsWith('⚠'))
  })

  test('Run pages the results from the pipeline, counts them, and sorting asks for a $sort stage', async () => {
    const { host, calls } = setup()
    const view = await openAggregation(host)
    await view.type(value, "{ status: 'shipped' }", { replace: true })
    await view.toggle({ label: 'Allow disk use (for big $group and $sort stages)' })
    await view.press({ text: 'Run' })
    assert.deepEqual(calls.runs, [{ pipeline: [{ $match: { status: 'shipped' } }], options: { allowDiskUse: true }, pageSize: 50 }])
    assert.deepEqual(calls.counts, [[{ $match: { status: 'shipped' } }]])
    const table = { type: 'Table', label: 'Documents' }
    assert.equal(view.rowsOf(table).length, 20)
    assert.ok(view.find({ text: '1–20 of 25' }))
    await view.press({ label: 'Next page' })
    assert.deepEqual(calls.pages.at(-1), { queryId: 'a1', ns, pipeline: [{ $match: { status: 'shipped' } }], options: { allowDiskUse: true }, offset: 20, pageSize: 50 })
    // What runs is what was typed when Run was pressed.
    await view.type(value, "{ status: 'pending' }", { replace: true })
    await view.press({ label: 'Previous page' })
    assert.deepEqual(calls.pages.at(-1)!.pipeline, [{ $match: { status: 'shipped' } }])
    await view.sort(table, 'status')
    assert.ok(view.find({ text: /Add a \$sort stage/ }))
    assert.equal(calls.runs.length, 1)
    assert.deepEqual(view.errors, [])
  })

  test('$out asks first, names the target, and writes once', async () => {
    const { host, calls } = setup()
    const view = await openAggregation(host)
    await view.select({ label: 'Add a stage' }, '$out')
    await view.type(value, "'shipped_copy'", { replace: true })
    assert.ok(view.find({ text: /\$out writes to a collection, so it runs only when you run the whole pipeline/ }))
    assert.equal(calls.previews.at(-1)!.stage, undefined)
    await view.press({ text: 'Run' })
    assert.equal(calls.runs.length, 0)
    assert.ok(view.find({ type: 'Callout', text: /^Run \$out into shop\.shipped_copy\?/ }))
    assert.ok(view.find({ text: /It holds 120 documents now, all replaced\./ }), 'the confirmation counts the target')
    await view.press({ text: 'Cancel' })
    assert.equal(view.find({ type: 'Callout', text: /^Run \$out into/ }), null)
    await view.press({ text: 'Run' })
    await view.press({ text: 'Run and write' })
    assert.equal(calls.runs.length, 1)
    assert.deepEqual(calls.counts, [], 'a write is not counted')
    assert.ok(view.find({ text: 'Ran the pipeline: $out wrote its results to shop.shipped_copy.' }))
  })

  test('text mode shows the pipeline, and applying it replaces the stages', async () => {
    const { host, calls } = setup()
    const view = await openAggregation(host)
    await view.type(value, "{ status: 'shipped' }", { replace: true })
    await view.press({ text: 'Edit as text' })
    const text = { type: 'Textarea', label: 'Pipeline' }
    assert.equal(view.valueOf(text), "[\n  {\n    $match: {\n      status: 'shipped'\n    }\n  }\n]")
    await view.type(text, '[{ $match: { a: 1 } }, { $count: ', { replace: true })
    await view.press({ text: 'Apply' })
    assert.ok(view.find({ type: 'Text', text: /line 1/i }))
    await view.type(text, "[{ $match: { a: 1 } }, { $count: 'n' }]", { replace: true, submit: true })
    assert.equal(view.find(text), null)
    assert.equal(view.rowsOf(stages).length, 2)
    assert.deepEqual(calls.previews.at(-1), { before: [], stage: { $match: { a: int(1) } }, size: 10, options: {} })
  })

  test('creates a view from the pipeline and offers to open it', async () => {
    const { host, calls } = setup({ 'query.run': (): QueryPage => ({ queryId: 'v1', offset: 0, docs: docs(1), truncated: [], hasMore: false, stoppedForSize: false, ms: 1 }) })
    const view = await openAggregation(host)
    await view.type(value, "{ status: 'shipped' }", { replace: true })
    await view.toggle({ label: 'Create a view' })
    await view.type({ label: 'View name' }, 'taken', { replace: true })
    await view.press({ text: 'Create view' })
    assert.ok(view.find({ text: 'shop.taken already exists. Choose another name.' }))
    await view.type({ label: 'View name' }, 'shipped_orders', { replace: true, submit: true })
    assert.deepEqual(calls.views.at(-1), { name: 'shipped_orders', pipeline: [{ $match: { status: 'shipped' } }] })
    assert.ok(view.find({ text: 'Created the view shop.shipped_orders on orders, with 1 stage.' }))
    await view.press({ text: 'Open the view' })
    assert.equal(view.valueOf({ type: 'Tabs' }), tabIdFor({ connectionId: 'c1', db: 'shop', collection: 'shipped_orders' }))
    assert.ok(view.find({ text: 'View · read only' }))
  })

  test('saved pipelines keep each stage as typed, off ones too', async () => {
    const { host, calls } = setup()
    const view = await openAggregation(host)
    await view.type(value, "{ status: 'shipped' }", { replace: true })
    await view.select({ label: 'Add a stage' }, '$limit')
    await view.press({ label: 'Turn the stage off' })
    await view.toggle({ label: 'Saved pipelines' })
    await view.type({ label: 'Save this pipeline as' }, 'Shipped', { replace: true, submit: true })
    assert.deepEqual(calls.saves, [{ name: 'Shipped', stages: [{ op: '$match', body: "{ status: 'shipped' }", enabled: true }, { op: '$limit', body: '10', enabled: false }] }])
    await view.press({ label: 'Remove the stage' })
    await view.press({ label: 'Remove the stage' })
    assert.equal(view.rowsOf(stages).length, 0)
    await view.activateRow({ type: 'Table', label: 'Saved pipelines' }, 'p:Shipped')
    assert.equal(view.rowsOf(stages).length, 2)
    assert.ok(view.find({ text: 'Loaded "Shipped". Run it to see its results.' }))
    await view.selectRows({ type: 'Table', label: 'Saved pipelines' }, ['p:Shipped'])
    await view.press({ text: 'Delete' })
    assert.equal(view.rowsOf({ type: 'Table', label: 'Saved pipelines' }).length, 0)
  })

  test('a collection tab opens its query in the aggregation editor', async () => {
    const { host, calls } = setup()
    const view = await mount(panel, { host })
    const tree = { type: 'Tree', label: 'Connections' }
    await view.expand(tree, 'conn:c1')
    await view.expand(tree, 'conn:c1/db:shop')
    await view.activateItem(tree, 'conn:c1/db:shop/coll:orders')
    await view.type({ label: 'Filter' }, "{ status: 'shipped' }", { replace: true })
    await view.type({ label: 'Sort' }, '{ _id: -1 }', { replace: true })
    await view.press({ label: 'Open in the aggregation editor' })
    assert.equal(view.valueOf({ type: 'Tabs' }), AGG)
    assert.deepEqual((view.find(stages)!.props.rows as { cells: { op: string; body: string } }[]).map((r) => `${r.cells.op} ${r.cells.body}`), ["$match { status: 'shipped' }", '$sort { _id: -1 }'])
    assert.ok(view.find({ text: 'Started from the query bar.' }))
    assert.equal(calls.previews.length, 1)
    assert.equal(view.findAll({ type: 'Tab' }).length, 3)
  })

  test('the Shell tab opens an aggregate in the aggregation editor', async () => {
    const run: ShellRunSummary = {
      runId: 'r1',
      connectionId: 'c1',
      connectionName: 'Local dev',
      db: 'shop',
      at: 1,
      results: [{ index: 0, title: '', line: 3, kind: 'cursor', op: { kind: 'aggregate', db: 'shop', collection: 'orders', pipeline: [{ $match: { a: int(1) } }, { $limit: int(5) }] } }]
    }
    const { host } = setup({ 'shell.page': (): QueryPage => ({ queryId: 'r1:0', offset: 0, docs: docs(1), truncated: [], hasMore: false, stoppedForSize: false, ms: 1 }) })
    const view = await mount(panel, { host })
    await view.post('shell.results', run)
    await view.press({ text: 'Open in the aggregation editor' })
    assert.equal(view.valueOf({ type: 'Tabs' }), AGG)
    assert.deepEqual(view.rowsOf(stages).length, 2)
    assert.ok(view.find({ text: 'Started from the shell (line 3).' }))
  })
})

describe('explain', () => {
  test('a collection tab explains the typed query: summary, warnings, tree and raw', async () => {
    const { host, calls } = setup()
    const view = await mount(panel, { host })
    const tree = { type: 'Tree', label: 'Connections' }
    await view.expand(tree, 'conn:c1')
    await view.expand(tree, 'conn:c1/db:shop')
    await view.activateItem(tree, 'conn:c1/db:shop/coll:orders')
    await view.type({ label: 'Filter' }, "{ status: 'shipped' }", { replace: true })
    await view.press({ label: 'Explain the query' })
    assert.deepEqual(calls.explains, [{ kind: 'find', input: { ns, spec: { filter: { status: 'shipped' }, skip: 0, limit: 0 }, verbosity: 'executionStats' } }])
    const kv = view.find({ type: 'KeyValue', label: 'Explain summary' })!.props.items as { label: string; value: unknown }[]
    assert.deepEqual(kv.slice(0, 4).map((i) => [i.label, i.value]), [['Plan', 'Collection scan'], ['Returned', '10'], ['Index keys examined', '0'], ['Documents examined', '20,000']])
    assert.ok(view.find({ type: 'Callout', text: /A collection scan reads every document/ }))
    assert.ok(view.find({ type: 'Callout', text: /examined 20,000 documents to return 10/ }))
    const plan = { type: 'Tree', label: 'Plan stages' }
    await view.selectItem(plan, 'n0')
    assert.ok(view.find({ type: 'KeyValue', label: 'COLLSCAN details' }))
    await view.press({ text: 'Raw' })
    assert.equal(view.find({ type: 'CodeView', label: 'Explain output' })!.props.code, '{\n  "queryPlanner": {}\n}')
    await view.select({ label: 'Verbosity' }, 'queryPlanner')
    await view.press({ text: 'Explain again' })
    assert.equal((calls.explains.at(-1)!.input as { verbosity: string }).verbosity, 'queryPlanner')
    assert.deepEqual(view.errors, [])
  })

  test('a query that does not parse is not explained', async () => {
    const { host, calls } = setup()
    const view = await mount(panel, { host })
    await view.expand({ type: 'Tree' }, 'conn:c1')
    await view.expand({ type: 'Tree' }, 'conn:c1/db:shop')
    await view.activateItem({ type: 'Tree' }, 'conn:c1/db:shop/coll:orders')
    await view.type({ label: 'Filter' }, '{ status: ', { replace: true })
    await view.press({ label: 'Explain the query' })
    assert.equal(calls.explains.length, 0)
    assert.ok(view.find({ type: 'Callout', text: /Fix the query first: a field above does not parse\./ }))
  })

  test('an aggregation tab explains its enabled stages', async () => {
    const { host, calls } = setup()
    const view = await openAggregation(host)
    await view.type(value, "{ status: 'shipped' }", { replace: true })
    await view.select({ label: 'Add a stage' }, '$limit')
    await view.press({ label: 'Turn the stage off' })
    await view.press({ text: 'Explain' })
    assert.deepEqual(calls.explains, [{ kind: 'agg', input: { ns, pipeline: [{ $match: { status: 'shipped' } }], options: {}, verbosity: 'executionStats' } }])
    assert.ok(view.find({ type: 'Tree', label: 'Plan stages' }))
    assert.deepEqual(view.errors, [])
  })
})
