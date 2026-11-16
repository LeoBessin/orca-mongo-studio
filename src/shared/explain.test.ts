// Reading explain answers: the classic engine, the slot-based engine, pipelines with and without
// a $cursor stage, sharded finds and pipelines, and plan-only answers. The fixtures are trimmed
// from what MongoDB 8 answers (relaxed Extended JSON), plus the sharded shapes from its docs.
import { assert, describe, test } from 'orca/testing'
import { allNodeKeys, brief, findNode, nodeLabel, nodeStats, num, summarizeExplain, type PlanNode } from './explain'

const ixscan = { stage: 'IXSCAN', keyPattern: { status: 1 }, indexName: 'status', isMultiKey: false, multiKeyPaths: { status: [] }, direction: 'forward', indexBounds: { status: ['["shipped", "shipped"]'] } }

const classicFind = {
  explainVersion: '1',
  queryPlanner: {
    namespace: 'shop.orders',
    parsedQuery: { status: { $eq: 'shipped' } },
    winningPlan: { isCached: false, stage: 'SORT', sortPattern: { total: -1 }, memLimit: 104857600, limitAmount: 5, type: 'simple', inputStage: { stage: 'FETCH', inputStage: ixscan } },
    rejectedPlans: [{ stage: 'COLLSCAN' }]
  },
  executionStats: {
    executionSuccess: true,
    nReturned: 5,
    executionTimeMillis: 9,
    totalKeysExamined: 3378,
    totalDocsExamined: 3378,
    executionStages: {
      stage: 'SORT',
      nReturned: 5,
      executionTimeMillisEstimate: 4,
      works: 3385,
      sortPattern: { total: -1 },
      memLimit: 104857600,
      limitAmount: 5,
      usedDisk: false,
      inputStage: {
        stage: 'FETCH',
        nReturned: 3378,
        executionTimeMillisEstimate: 4,
        docsExamined: 3378,
        inputStage: { ...ixscan, nReturned: 3378, executionTimeMillisEstimate: 0, keysExamined: 3378, seeks: 1 }
      }
    }
  },
  serverInfo: { host: 'h', port: 27017, version: '8.3.17' },
  ok: 1
}

const sbeAggregate = {
  explainVersion: '2',
  queryPlanner: {
    namespace: 'shop.orders',
    winningPlan: {
      isCached: false,
      queryPlan: { stage: 'GROUP', planNodeId: 4, inputStage: { stage: 'FETCH', planNodeId: 2, inputStage: { ...ixscan, planNodeId: 1 } } },
      slotBasedPlan: { slots: '…', stages: '…' }
    },
    rejectedPlans: []
  },
  executionStats: {
    executionSuccess: true,
    nReturned: 1630,
    executionTimeMillis: 27,
    totalKeysExamined: 3378,
    totalDocsExamined: 3378,
    executionStages: {
      stage: 'project',
      planNodeId: 4,
      nReturned: 1630,
      executionTimeMillisEstimate: 3,
      inputStage: {
        stage: 'group',
        planNodeId: 4,
        nReturned: 1630,
        executionTimeMillisEstimate: 2,
        inputStage: {
          stage: 'fetch',
          planNodeId: 2,
          nReturned: 3378,
          executionTimeMillisEstimate: 1,
          numReads: 3378,
          inputStage: { stage: 'ixseek', planNodeId: 1, nReturned: 3378, executionTimeMillisEstimate: 0, indexName: 'status', keysExamined: 3378, numReads: 3379 }
        }
      }
    }
  }
}

const cursorPipeline = {
  explainVersion: '1',
  stages: [
    {
      $cursor: {
        queryPlanner: {
          namespace: 'shop.orders',
          winningPlan: { stage: 'COUNT_SCAN', keyPattern: { status: 1 }, indexName: 'status', indexBounds: { startKey: { status: 'shipped' } } },
          rejectedPlans: []
        },
        executionStats: { executionSuccess: true, nReturned: 3378, executionTimeMillis: 2, totalKeysExamined: 3379, totalDocsExamined: 0, executionStages: { stage: 'COUNT_SCAN', nReturned: 3378, executionTimeMillisEstimate: 0, keysExamined: 3379, indexName: 'status', keyPattern: { status: 1 } } }
      },
      nReturned: { $numberLong: '3378' },
      executionTimeMillisEstimate: { $numberLong: '1' }
    },
    { $addFields: { x: { $const: 1 } }, nReturned: 3378, executionTimeMillisEstimate: 1 },
    { $sort: { sortKey: { n: -1 } }, nReturned: 3378, executionTimeMillisEstimate: 2, usedDisk: true },
    { $facet: { a: [{ $group: { _id: null } }] }, nReturned: 1, executionTimeMillisEstimate: 3 }
  ],
  serverInfo: { version: '8.3.17' }
}

const shardedFind = {
  queryPlanner: {
    winningPlan: {
      stage: 'SHARD_MERGE',
      shards: [
        { shardName: 'rs0', connectionString: 'rs0/a:27018', winningPlan: { stage: 'FETCH', inputStage: ixscan }, rejectedPlans: [{}] },
        { shardName: 'rs1', connectionString: 'rs1/b:27018', winningPlan: { stage: 'COLLSCAN', filter: { status: { $eq: 'shipped' } }, direction: 'forward' }, rejectedPlans: [] }
      ]
    }
  },
  executionStats: {
    nReturned: 30,
    executionTimeMillis: 12,
    totalKeysExamined: 10,
    totalDocsExamined: 5000,
    executionStages: {
      stage: 'SHARD_MERGE',
      nReturned: 30,
      executionTimeMillis: 12,
      shards: [
        { shardName: 'rs0', nReturned: 10, executionTimeMillis: 3, totalKeysExamined: 10, totalDocsExamined: 10, executionStages: { stage: 'FETCH', nReturned: 10, docsExamined: 10, inputStage: { ...ixscan, nReturned: 10, keysExamined: 10 } } },
        { shardName: 'rs1', nReturned: 20, executionTimeMillis: 12, totalKeysExamined: 0, totalDocsExamined: 4990, executionStages: { stage: 'COLLSCAN', nReturned: 20, docsExamined: 4990, filter: { status: { $eq: 'shipped' } } } }
      ]
    }
  }
}

const shardedPipeline = {
  mergeType: 'mongos',
  splitPipeline: { shardsPart: [{ $match: { status: 'shipped' } }], mergerPart: [{ $mergeCursors: {} }, { $limit: 3 }] },
  shards: {
    rs0: { host: 'a:27018', stages: [{ $cursor: { queryPlanner: { namespace: 'shop.orders', winningPlan: { stage: 'FETCH', inputStage: ixscan }, rejectedPlans: [] } } }] },
    rs1: { host: 'b:27018', queryPlanner: { namespace: 'shop.orders', winningPlan: { queryPlan: { stage: 'COLLSCAN', planNodeId: 1 } }, rejectedPlans: [] } }
  }
}

function names(nodes: readonly PlanNode[]): string[] {
  const out: string[] = []
  const walk = (n: PlanNode): void => {
    out.push(n.stage)
    n.children.forEach(walk)
  }
  nodes.forEach(walk)
  return out
}

describe('explain: classic engine', () => {
  const s = summarizeExplain(classicFind, 'find')

  test('the summary', () => {
    assert.equal(s.kind, 'find')
    assert.equal(s.namespace, 'shop.orders')
    assert.equal(s.hasStats, true)
    assert.equal(s.nReturned, 5)
    assert.equal(s.timeMs, 9)
    assert.equal(s.keysExamined, 3378)
    assert.equal(s.docsExamined, 3378)
    assert.deepEqual(s.indexes, ['status'])
    assert.equal(s.collectionScan, false, 'a rejected COLLSCAN is not the plan')
    assert.equal(s.inMemorySort, true)
    assert.equal(s.rejectedPlans, 1)
    assert.equal(s.sharded, false)
    assert.equal(s.serverVersion, '8.3.17')
    assert.equal(s.warnings.length, 2)
    assert.match(s.warnings[0]!, /sorted in memory/)
    assert.match(s.warnings[1]!, /examined 3,378 documents to return 5/)
  })

  test('the tree has each stage with its own numbers and details', () => {
    assert.deepEqual(names(s.stages), ['SORT', 'FETCH', 'IXSCAN'])
    const sort = s.stages[0]!
    assert.equal(sort.key, 'n0')
    assert.equal(sort.detail, 'by { total: -1 }')
    assert.equal(sort.warning, 'Sorts in memory')
    assert.equal(nodeStats(sort), '5 out · 4 ms · Sorts in memory')
    const ix = findNode(s.stages, 'n0-0-0')!
    assert.equal(nodeLabel(ix), 'IXSCAN  status { status: 1 }')
    assert.equal(ix.keysExamined, 3378)
    assert.deepEqual(ix.attrs.map((a) => a.label), ['keyPattern', 'indexName', 'isMultiKey', 'direction', 'indexBounds', 'seeks'])
    assert.equal(ix.attrs.find((a) => a.label === 'indexBounds')!.value, '{ status: ["[\\"shipped\\", \\"shipped\\"]"] }')
    assert.deepEqual(allNodeKeys(s.stages), ['n0', 'n0-0'])
  })

  test('plan only: no numbers, and the plan from winningPlan', () => {
    const plan = summarizeExplain({ queryPlanner: { namespace: 'shop.orders', winningPlan: { stage: 'COLLSCAN', filter: { 'payment.method': { $eq: 'card' } }, direction: 'forward' }, rejectedPlans: [] } }, 'find')
    assert.equal(plan.hasStats, false)
    assert.equal(plan.nReturned, undefined)
    assert.equal(plan.docsExamined, undefined)
    assert.equal(plan.collectionScan, true)
    assert.deepEqual(plan.indexes, [])
    assert.equal(plan.stages[0]!.detail, '{ "payment.method": { $eq: "card" } }')
    assert.deepEqual(plan.warnings.map((w) => w.slice(0, 23)), ['A collection scan reads'])
  })

  test('an _id lookup counts as using the _id index', () => {
    const r = summarizeExplain({ queryPlanner: { winningPlan: { stage: 'EXPRESS_IXSCAN', keyPattern: '{ _id: 1 }', indexName: '_id_' }, rejectedPlans: [] } }, 'find')
    assert.deepEqual(r.indexes, ['_id_'])
    const old = summarizeExplain({ queryPlanner: { winningPlan: { stage: 'IDHACK' }, rejectedPlans: [] } }, 'find')
    assert.deepEqual(old.indexes, ['_id_'])
  })

  test('a failed run is a warning', () => {
    const r = summarizeExplain({ queryPlanner: { winningPlan: { stage: 'COLLSCAN' } }, executionStats: { executionSuccess: false, errorMessage: 'operation exceeded time limit', nReturned: 0 } }, 'find')
    assert.match(r.warnings[0]!, /^The plan stopped: operation exceeded time limit/)
  })
})

describe('explain: slot-based engine', () => {
  test('the plan comes from queryPlan, its numbers from SBE stages by planNodeId', () => {
    const s = summarizeExplain(sbeAggregate, 'aggregate')
    assert.deepEqual(names(s.stages), ['GROUP', 'FETCH', 'IXSCAN'])
    const [group, fetch, ix] = [s.stages[0]!, s.stages[0]!.children[0]!, s.stages[0]!.children[0]!.children[0]!]
    assert.equal(group.nReturned, 1630, 'the outermost SBE stage of a node gives its output')
    assert.equal(group.timeMs, 3)
    assert.equal(fetch.nReturned, 3378)
    assert.equal(fetch.docsExamined, 3378)
    assert.equal(ix.keysExamined, 3378)
    assert.equal(ix.docsExamined, undefined)
    assert.equal(s.nReturned, 1630)
    assert.equal(s.timeMs, 27)
    assert.deepEqual(s.indexes, ['status'])
    assert.ok(!s.stages[0]!.attrs.some((a) => a.label === 'planNodeId'))
  })
})

describe('explain: pipelines', () => {
  test('a $cursor stage holds the query plan; later stages keep their own numbers', () => {
    const s = summarizeExplain(cursorPipeline, 'aggregate')
    assert.deepEqual(s.stages.map((n) => n.stage), ['$cursor', '$addFields', '$sort', '$facet'])
    const cursor = s.stages[0]!
    assert.equal(cursor.detail, 'COUNT_SCAN status { status: 1 }')
    assert.equal(cursor.nReturned, 3378, '$numberLong wrappers read as numbers')
    assert.equal(cursor.children[0]!.key, 'n0-0')
    assert.equal(s.stages[1]!.detail, '{ x: { $const: 1 } }')
    assert.equal(s.stages[2]!.warning, 'Sorts in memory, and spilled to disk')
    assert.equal(s.stages[2]!.attrs.find((a) => a.label === 'usedDisk')!.value, 'true')
    assert.equal(s.nReturned, 1, 'the last stage gives what the pipeline returned')
    assert.equal(s.timeMs, 3)
    assert.equal(s.keysExamined, 3379)
    assert.equal(s.docsExamined, 0)
    assert.deepEqual(s.indexes, ['status'])
    assert.equal(s.inMemorySort, true)
    assert.ok(s.warnings.some((w) => /spilled to disk/.test(w)))
  })

  test('$lookup pushed down names the foreign index without counting it as the plan', () => {
    const s = summarizeExplain({ queryPlanner: { winningPlan: { queryPlan: { stage: 'EQ_LOOKUP', planNodeId: 2, foreignCollection: 'shop.customers', indexName: '_id_', strategy: 'IndexedLoopJoin', inputStage: { stage: 'COLLSCAN', planNodeId: 1 } } }, rejectedPlans: [] } }, 'aggregate')
    assert.equal(s.stages[0]!.detail, '_id_')
    assert.deepEqual(s.indexes, [])
    assert.equal(s.collectionScan, true)
  })
})

describe('explain: sharded', () => {
  test('a find: one node per shard, each with its plan and numbers', () => {
    const s = summarizeExplain(shardedFind, 'find')
    assert.equal(s.sharded, true)
    assert.deepEqual(names(s.stages), ['SHARD_MERGE', 'Shard rs0', 'FETCH', 'IXSCAN', 'Shard rs1', 'COLLSCAN'])
    const rs1 = findNode(s.stages, 'n0-1')!
    assert.equal(rs1.stage, 'Shard rs1')
    assert.equal(rs1.docsExamined, 4990)
    assert.equal(rs1.timeMs, 12)
    const planned = summarizeExplain({ queryPlanner: shardedFind.queryPlanner }, 'find')
    assert.equal(findNode(planned.stages, 'n0-1')!.attrs[0]!.value, 'rs1/b:27018')
    assert.equal(s.collectionScan, true)
    assert.deepEqual(s.indexes, ['status'])
    assert.equal(s.docsExamined, 5000)
    assert.equal(s.rejectedPlans, 0, 'rejected plans are counted where the top-level planner lists them')
  })

  test('a pipeline: each shard\'s part, then the merging stages', () => {
    const s = summarizeExplain(shardedPipeline, 'aggregate')
    assert.equal(s.sharded, true)
    assert.deepEqual(s.stages.map((n) => n.stage), ['Shards', '$mergeCursors', '$limit'])
    assert.equal(s.stages[0]!.detail, '2 shards')
    assert.deepEqual(names([s.stages[0]!]), ['Shards', 'Shard rs0', '$cursor', 'FETCH', 'IXSCAN', 'Shard rs1', 'COLLSCAN'])
    assert.deepEqual(s.stages[2]!.attrs, [{ label: 'runs on', value: 'mongos' }])
    assert.equal(s.hasStats, false)
    assert.deepEqual(s.indexes, ['status'])
    assert.equal(s.collectionScan, true)
    const keys = new Set<string>()
    const walk = (n: PlanNode): void => {
      assert.ok(!keys.has(n.key), `duplicate key ${n.key}`)
      keys.add(n.key)
      assert.match(n.key, /^[a-z0-9-]+$/)
      n.children.forEach(walk)
    }
    s.stages.forEach(walk)
  })
})

describe('explain: helpers', () => {
  test('numbers and short text', () => {
    assert.equal(num(3), 3)
    assert.equal(num({ $numberLong: '12' }), 12)
    assert.equal(num({ $numberDouble: 'x' }), undefined)
    assert.equal(num('3'), undefined)
    assert.equal(brief({ a: 1, 'b.c': [true, null], d: { $oid: '6542f1a2b3c4d5e6f7a8b900' } }), '{ a: 1, "b.c": [true, null], d: ObjectId(\'6542f1a2b3c4d5e6f7a8b900\') }')
    assert.equal(brief('x'.repeat(300), 10), '"xxxxxxxx…')
  })

  test('an answer with nothing to show', () => {
    const s = summarizeExplain({ ok: 1 }, 'find')
    assert.deepEqual(s.stages, [])
    assert.deepEqual(s.warnings, [])
    assert.equal(s.hasStats, false)
  })
})
