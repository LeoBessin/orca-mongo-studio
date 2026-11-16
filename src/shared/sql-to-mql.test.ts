// SQL → MQL goldens: every expected operation is written in shell syntax and read with parseShell,
// so it is canonical Extended JSON exactly as the translator must produce it.
import { assert, describe, test } from 'orca/testing'
import { SqlError, sqlToMql } from './sql-to-mql'
import { parseShell } from './shell-parse'
import type { JsonObject } from './ejson-view'

const doc = (text: string): JsonObject => parseShell(text) as JsonObject
const run = (sql: string) => sqlToMql(sql, 'shop')

function find(sql: string, collection: string, parts: { filter?: string; projection?: string; sort?: string; skip?: number; limit?: number }): void {
  const expected: JsonObject = { kind: 'find', db: 'shop', collection, filter: doc(parts.filter ?? '{}') }
  if (parts.projection) expected.projection = doc(parts.projection)
  if (parts.sort) expected.sort = doc(parts.sort)
  if (parts.skip !== undefined) expected.skip = parts.skip
  if (parts.limit !== undefined) expected.limit = parts.limit
  assert.deepEqual(run(sql).op, expected, sql)
}

function agg(sql: string, collection: string, pipeline: string): void {
  assert.deepEqual(run(sql).op, { kind: 'aggregate', db: 'shop', collection, pipeline: parseShell(pipeline) }, sql)
}

function fails(sql: string, message: RegExp, line: number, column: number): void {
  let error: unknown
  try {
    run(sql)
  } catch (e) {
    error = e
  }
  assert.ok(error instanceof SqlError, `${sql} throws SqlError`)
  assert.match(error.message, message)
  assert.match(error.message, new RegExp(`\\(line ${line}, column ${column}\\)$`))
  assert.deepEqual([error.line, error.column], [line, column], `${sql}: ${error.message}`)
}

describe('SQL → find', () => {
  test('SELECT * with equality, range, sort and limit', () => {
    find("SELECT * FROM orders WHERE status = 'shipped' AND total >= 100 ORDER BY createdAt DESC LIMIT 10", 'orders', {
      filter: "{ status: 'shipped', total: { $gte: 100 } }",
      sort: '{ createdAt: -1 }',
      limit: 10
    })
  })

  test('column list becomes a projection without _id; dotted paths stay paths', () => {
    find('SELECT name, address.city FROM customers', 'customers', { projection: "{ _id: 0, name: 1, 'address.city': 1 }" })
    find('SELECT _id, name FROM customers', 'customers', { projection: '{ _id: 1, name: 1 }' })
  })

  test('keywords in any case, comments, quoted names and a trailing semicolon', () => {
    find(
      `select "first name", \`address\`.zip -- the columns
       FROM "my-customers" /* a block
       comment */ where "first name" = 'O''Brien';`,
      'my-customers',
      { filter: "{ 'first name': \"O'Brien\" }", projection: "{ _id: 0, 'first name': 1, 'address.zip': 1 }" }
    )
  })

  test('a table alias qualifies columns of a plain query', () => {
    find('SELECT o.total FROM orders AS o WHERE o.status = 1 ORDER BY o.total', 'orders', {
      filter: '{ status: 1 }',
      projection: '{ _id: 0, total: 1 }',
      sort: '{ total: 1 }'
    })
    find('SELECT orders.total FROM orders', 'orders', { projection: '{ _id: 0, total: 1 }' })
  })

  test('numbers: int32, large integers and decimals are doubles, negatives', () => {
    find('SELECT * FROM t WHERE a = 5 AND b = 3000000000 AND c = 2.5 AND d = 1e3 AND e = -7 AND f = 3.0', 't', {
      filter: '{ a: 5, b: 3000000000, c: 2.5, d: 1000.0, e: -7, f: 3.0 }'
    })
    const op = run('SELECT * FROM t WHERE a = 5 AND b = 3000000000 AND f = 3.0').op
    assert.deepEqual(op.kind === 'find' && op.filter, { a: { $numberInt: '5' }, b: { $numberDouble: '3000000000.0' }, f: { $numberDouble: '3.0' } })
  })

  test('TRUE, FALSE, strings, DATE and TIMESTAMP literals (UTC)', () => {
    find("SELECT * FROM t WHERE ok = TRUE AND gone = false AND d >= DATE '2024-01-15' AND ts < TIMESTAMP '2024-01-15 10:30:00'", 't', {
      filter: "{ ok: true, gone: false, d: { $gte: ISODate('2024-01-15T00:00:00Z') }, ts: { $lt: ISODate('2024-01-15T10:30:00Z') } }"
    })
    assert.ok(run("SELECT * FROM t WHERE d = DATE '2024-01-15'").notes.includes('DATE and TIMESTAMP literals are read as UTC.'))
  })

  test('<, <=, >, >=, !=, <> and a value on the left', () => {
    find('SELECT * FROM t WHERE a < 1 AND b <= 2 AND c > 3 AND d >= 4 AND e != 5 AND f <> 6 AND 10 > g', 't', {
      filter: '{ a: { $lt: 1 }, b: { $lte: 2 }, c: { $gt: 3 }, d: { $gte: 4 }, e: { $ne: 5 }, f: { $ne: 6 }, g: { $lt: 10 } }'
    })
  })

  test('conditions on one field merge; clashes use $and', () => {
    find('SELECT * FROM t WHERE a > 1 AND a < 5 AND a <> 3', 't', { filter: '{ a: { $gt: 1, $lt: 5, $ne: 3 } }' })
    find('SELECT * FROM t WHERE a = 1 AND a > 0', 't', { filter: '{ a: { $eq: 1, $gt: 0 } }' })
    find('SELECT * FROM t WHERE a > 1 AND a > 2', 't', { filter: '{ $and: [{ a: { $gt: 1 } }, { a: { $gt: 2 } }] }' })
  })

  test('OR, nested parentheses and AND inside OR', () => {
    find("SELECT * FROM t WHERE status = 'A' OR (qty < 30 AND (price > 10 OR price IS NULL)) OR status = 'B'", 't', {
      filter: "{ $or: [{ status: 'A' }, { qty: { $lt: 30 }, $or: [{ price: { $gt: 10 } }, { price: null }] }, { status: 'B' }] }"
    })
  })

  test('NOT is pushed down to the conditions', () => {
    find('SELECT * FROM t WHERE NOT (a = 1 OR b < 2) AND NOT c IS NULL AND NOT NOT d = 4', 't', {
      filter: '{ a: { $ne: 1 }, b: { $gte: 2 }, c: { $ne: null }, d: 4 }'
    })
    find('SELECT * FROM t WHERE NOT (a > 1 AND b IN (1, 2))', 't', { filter: '{ $or: [{ a: { $lte: 1 } }, { b: { $nin: [1, 2] } }] }' })
  })

  test('IN and NOT IN', () => {
    find("SELECT * FROM t WHERE status IN ('A', 'B') AND n NOT IN (1, 2.5)", 't', { filter: "{ status: { $in: ['A', 'B'] }, n: { $nin: [1, 2.5] } }" })
  })

  test('BETWEEN and NOT BETWEEN', () => {
    find('SELECT * FROM t WHERE age BETWEEN 18 AND 30', 't', { filter: '{ age: { $gte: 18, $lte: 30 } }' })
    find('SELECT * FROM t WHERE age NOT BETWEEN 18 AND 30 AND ok = TRUE', 't', { filter: '{ $or: [{ age: { $lt: 18 } }, { age: { $gt: 30 } }], ok: true }' })
  })

  test('LIKE: anchors, wildcards, escaped regex characters', () => {
    find("SELECT * FROM t WHERE a LIKE 'Jo%' AND b LIKE '%son' AND c LIKE '%mid%' AND d LIKE 'a_c' AND e LIKE '1.5+%x(y)'", 't', {
      filter: '{ a: /^Jo/, b: /son$/, c: /mid/, d: /^a.c$/s, e: /^1\\.5\\+.*x\\(y\\)$/s }'
    })
    find("SELECT * FROM t WHERE a LIKE '%' AND b LIKE 'abc'", 't', { filter: "{ a: /^/, b: 'abc' }" })
    const notes = run("SELECT * FROM t WHERE a LIKE 'x%'").notes
    assert.ok(notes.some((n) => n.startsWith('LIKE is case-sensitive, as in SQL')))
  })

  test('NOT LIKE, ILIKE and ESCAPE', () => {
    find("SELECT * FROM t WHERE a NOT LIKE '%x%' AND b ILIKE 'jo%' AND c LIKE '100!%%' ESCAPE '!'", 't', {
      filter: '{ a: { $not: /x/ }, b: /^jo/i, c: /^100%/ }'
    })
  })

  test('IS NULL and IS NOT NULL', () => {
    find('SELECT * FROM t WHERE a IS NULL AND b IS NOT NULL', 't', { filter: '{ a: null, b: { $ne: null } }' })
    assert.ok(run('SELECT * FROM t WHERE a IS NULL').notes.includes('IS NULL also matches documents where the field is missing.'))
  })

  test('array index paths', () => {
    find('SELECT items.0.sku FROM orders WHERE items.0.qty > 1', 'orders', { filter: "{ 'items.0.qty': { $gt: 1 } }", projection: "{ _id: 0, 'items.0.sku': 1 }" })
  })

  test('LIMIT, OFFSET, OFFSET before LIMIT and MySQL LIMIT off, n', () => {
    find('SELECT * FROM t LIMIT 5 OFFSET 10', 't', { skip: 10, limit: 5 })
    find('SELECT * FROM t OFFSET 10 ROWS LIMIT 5', 't', { skip: 10, limit: 5 })
    find('SELECT * FROM t LIMIT 10, 5', 't', { skip: 10, limit: 5 })
    find('SELECT * FROM t OFFSET 3', 't', { skip: 3 })
  })

  test('ORDER BY several columns, ASC and DESC, by position', () => {
    find('SELECT a, b FROM t ORDER BY a ASC, b DESC', 't', { projection: '{ _id: 0, a: 1, b: 1 }', sort: '{ a: 1, b: -1 }' })
    find('SELECT a, b FROM t ORDER BY 2 DESC', 't', { projection: '{ _id: 0, a: 1, b: 1 }', sort: '{ b: -1 }' })
  })
})

describe('SQL → aggregate', () => {
  test('column aliases make a final $project', () => {
    agg('SELECT name AS n, address.city AS city, age FROM customers WHERE age > 30 ORDER BY n LIMIT 3', 'customers', `[
      { $match: { age: { $gt: 30 } } },
      { $sort: { name: 1 } },
      { $limit: 3 },
      { $project: { _id: 0, n: '$name', city: '$address.city', age: 1 } }
    ]`)
  })

  test('comparing two columns uses $expr', () => {
    agg('SELECT * FROM t WHERE a = b AND c > 1', 't', "[{ $match: { $expr: { $eq: ['$a', '$b'] }, c: { $gt: 1 } } }]")
    agg('SELECT * FROM t WHERE NOT a < b', 't', "[{ $match: { $expr: { $gte: ['$a', '$b'] } } }]")
  })

  test('INNER JOIN on one key: $lookup with localField / foreignField, then $unwind', () => {
    agg('SELECT o.total, c.name FROM orders o INNER JOIN customers c ON o.customerId = c._id', 'orders', `[
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $project: { _id: 0, total: 1, 'c.name': 1 } }
    ]`)
  })

  test('LEFT JOIN keeps unmatched rows; WHERE on the base collection runs before $lookup', () => {
    agg("SELECT * FROM orders o LEFT OUTER JOIN customers c ON c._id = o.customerId WHERE o.status = 'A'", 'orders', `[
      { $match: { status: 'A' } },
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: { path: '$c', preserveNullAndEmptyArrays: true } }
    ]`)
    const notes = run('SELECT * FROM orders o LEFT JOIN customers c ON c._id = o.customerId').notes
    assert.ok(notes.some((n) => n.startsWith('LEFT JOIN customers becomes $lookup + $unwind')))
  })

  test('WHERE on a joined collection runs after the joins; base conditions still run first', () => {
    agg("SELECT o._id FROM orders o JOIN customers c ON o.customerId = c._id WHERE o.total > 10.5 AND c.country = 'FR' AND (c.vip = TRUE OR o.total > 1000)", 'orders', `[
      { $match: { total: { $gt: 10.5 } } },
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $match: { 'c.country': 'FR', $or: [{ 'c.vip': true }, { total: { $gt: 1000 } }] } },
      { $project: { _id: 1 } }
    ]`)
  })

  test('JOIN on several keys uses let and a pipeline', () => {
    agg('SELECT * FROM stock s JOIN prices p ON s.sku = p.sku AND p.region = s.warehouse.region', 'stock', `[
      { $lookup: {
          from: 'prices',
          let: { sku: '$sku', warehouse_region: '$warehouse.region' },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$sku', '$$sku'] }, { $eq: ['$region', '$$warehouse_region'] }] } } }],
          as: 'p'
      } },
      { $unwind: '$p' }
    ]`)
  })

  test('several joins: later joins read fields of earlier ones under their alias', () => {
    agg(`SELECT o._id, c.name, a.city AS city FROM orders o
         JOIN customers c ON o.customerId = c._id
         LEFT JOIN addresses a ON a._id = c.addressId
         ORDER BY a.city DESC`, 'orders', `[
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $lookup: { from: 'addresses', localField: 'c.addressId', foreignField: '_id', as: 'a' } },
      { $unwind: { path: '$a', preserveNullAndEmptyArrays: true } },
      { $sort: { 'a.city': -1 } },
      { $project: { _id: 1, 'c.name': 1, city: '$a.city' } }
    ]`)
  })

  test('a joined collection without an alias is named after the collection', () => {
    agg('SELECT orders.total, customers.name FROM orders JOIN customers ON orders.customerId = customers._id', 'orders', `[
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customers' } },
      { $unwind: '$customers' },
      { $project: { _id: 0, total: 1, 'customers.name': 1 } }
    ]`)
  })

  test('GROUP BY with COUNT, SUM, AVG, MIN, MAX', () => {
    agg('SELECT status, COUNT(*), SUM(total), AVG(total) AS avgTotal, MIN(createdAt), MAX(items.qty) FROM orders GROUP BY status', 'orders', `[
      { $group: {
          _id: { status: '$status' },
          count: { $sum: 1 },
          sum_total: { $sum: '$total' },
          avgTotal: { $avg: '$total' },
          min_createdAt: { $min: '$createdAt' },
          max_items_qty: { $max: '$items.qty' }
      } },
      { $project: { _id: 0, status: '$_id.status', count: 1, sum_total: 1, avgTotal: 1, min_createdAt: 1, max_items_qty: 1 } }
    ]`)
    const notes = run('SELECT status, COUNT(*) FROM orders GROUP BY status').notes
    assert.ok(notes.some((n) => n.startsWith('GROUP BY becomes $group')))
  })

  test('GROUP BY several columns (dotted and aliased), HAVING on alias and aggregate, ORDER BY aggregate', () => {
    agg(`SELECT address.country AS country, address.city, COUNT(*) AS n FROM customers
         WHERE active = TRUE GROUP BY address.country, address.city
         HAVING n > 5 AND AVG(age) < 40 ORDER BY COUNT(*) DESC, country LIMIT 10`, 'customers', `[
      { $match: { active: true } },
      { $group: { _id: { country: '$address.country', address_city: '$address.city' }, n: { $sum: 1 }, avg_age: { $avg: '$age' } } },
      { $match: { n: { $gt: 5 }, avg_age: { $lt: 40 } } },
      { $sort: { n: -1, '_id.country': 1 } },
      { $limit: 10 },
      { $project: { _id: 0, country: '$_id.country', 'address.city': '$_id.address_city', n: 1 } }
    ]`)
  })

  test('HAVING on a group column and comparing two aggregates', () => {
    agg("SELECT status, MAX(total) AS top FROM orders GROUP BY status HAVING status <> 'X' OR MAX(total) > MIN(total)", 'orders', `[
      { $group: { _id: { status: '$status' }, top: { $max: '$total' }, min_total: { $min: '$total' } } },
      { $match: { $or: [{ '_id.status': { $ne: 'X' } }, { $expr: { $gt: ['$top', '$min_total'] } }] } },
      { $project: { _id: 0, status: '$_id.status', top: 1 } }
    ]`)
  })

  test('GROUP BY by alias and by position', () => {
    const expected = `[
      { $group: { _id: { s: '$status' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $project: { _id: 0, s: '$_id.s', count: 1 } }
    ]`
    agg('SELECT status AS s, COUNT(*) FROM orders GROUP BY s ORDER BY 2 DESC', 'orders', expected)
    agg('SELECT status AS s, COUNT(*) FROM orders GROUP BY 1 ORDER BY count(*) DESC', 'orders', expected)
  })

  test('aggregates without GROUP BY group everything', () => {
    agg("SELECT COUNT(*) AS n, SUM(total) AS revenue FROM orders WHERE status = 'shipped'", 'orders', `[
      { $match: { status: 'shipped' } },
      { $group: { _id: null, n: { $sum: 1 }, revenue: { $sum: '$total' } } },
      { $project: { _id: 0, n: 1, revenue: 1 } }
    ]`)
    assert.ok(run('SELECT COUNT(*) FROM orders').notes.some((n) => n.startsWith('With no matching documents the aggregation returns no row')))
  })

  test('COUNT(col) counts non-null values; COUNT(DISTINCT col) leaves nulls out', () => {
    agg('SELECT COUNT(email), COUNT(DISTINCT city) AS cities FROM customers', 'customers', `[
      { $group: {
          _id: null,
          count_email: { $sum: { $cond: [{ $gt: ['$email', null] }, 1, 0] } },
          cities: { $addToSet: '$city' }
      } },
      { $set: { cities: { $size: { $filter: { input: '$cities', cond: { $ne: ['$$this', null] } } } } } },
      { $project: { _id: 0, count_email: 1, cities: 1 } }
    ]`)
  })

  test('DISTINCT on one and several columns', () => {
    agg('SELECT DISTINCT status FROM orders', 'orders', `[
      { $group: { _id: { status: '$status' } } },
      { $project: { _id: 0, status: '$_id.status' } }
    ]`)
    agg('SELECT DISTINCT status, address.city AS city FROM orders ORDER BY city LIMIT 2', 'orders', `[
      { $group: { _id: { status: '$status', city: '$address.city' } } },
      { $sort: { '_id.city': 1 } },
      { $limit: 2 },
      { $project: { _id: 0, status: '$_id.status', city: '$_id.city' } }
    ]`)
  })

  test('GROUP BY with a JOIN, SKIP and LIMIT', () => {
    agg(`SELECT c.country, SUM(o.total) AS revenue FROM orders o JOIN customers c ON o.customerId = c._id
         GROUP BY c.country ORDER BY revenue DESC LIMIT 5 OFFSET 5`, 'orders', `[
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $group: { _id: { c_country: '$c.country' }, revenue: { $sum: '$total' } } },
      { $sort: { revenue: -1 } },
      { $skip: 5 },
      { $limit: 5 },
      { $project: { _id: 0, 'c.country': '$_id.c_country', revenue: 1 } }
    ]`)
  })

  test('a group column named _id keeps the _id output', () => {
    agg('SELECT _id, COUNT(*) AS n FROM t GROUP BY _id', 't', `[
      { $group: { _id: { _id: '$_id' }, n: { $sum: 1 } } },
      { $project: { _id: '$_id._id', n: 1 } }
    ]`)
  })
})

describe('shell text and notes', () => {
  test('a find', () => {
    assert.equal(
      run("SELECT name, age FROM customers WHERE age >= 21 AND name LIKE 'A%' ORDER BY age DESC LIMIT 20 OFFSET 40").shell,
      "db.customers.find({ age: { $gte: 21 }, name: /^A/ }, { _id: 0, name: 1, age: 1 })\n  .sort({ age: -1 })\n  .skip(40)\n  .limit(20)"
    )
  })

  test('a short aggregation stays on one line', () => {
    assert.equal(run('SELECT * FROM t WHERE a = b').shell, "db.t.aggregate([{ $match: { $expr: { $eq: ['$a', '$b'] } } }])")
  })

  test('a long aggregation is indented, and odd collection names use getCollection', () => {
    assert.equal(
      run('SELECT status, COUNT(*) AS n FROM "order-lines" GROUP BY status').shell,
      `db.getCollection('order-lines').aggregate([
  {
    $group: {
      _id: {
        status: '$status'
      },
      n: {
        $sum: 1
      }
    }
  },
  {
    $project: {
      _id: 0,
      status: '$_id.status',
      n: 1
    }
  }
])`
    )
  })

  test('the database comes from the caller; a plain query has no notes', () => {
    const r = sqlToMql('SELECT * FROM t', 'analytics')
    assert.deepEqual(r.op, { kind: 'find', db: 'analytics', collection: 't', filter: {} })
    assert.equal(r.shell, 'db.t.find({})')
    assert.deepEqual(r.notes, [])
  })

  test('negations and unqualified columns in joins are noted', () => {
    assert.ok(run("SELECT * FROM t WHERE a <> 'x'").notes.some((n) => n.includes('missing or null')))
    assert.ok(run('SELECT * FROM o JOIN c ON customerId = c._id').notes.some((n) => n.startsWith('Unqualified columns are read from o')))
  })
})

describe('errors', () => {
  test('statements other than SELECT', () => {
    fails("UPDATE t SET a = 1", /Only SELECT statements can be translated, not UPDATE/, 1, 1)
    fails("  delete from t", /not DELETE/, 1, 3)
    fails('WITH x AS (SELECT 1) SELECT * FROM x', /WITH/, 1, 1)
    fails('', /empty/, 1, 1)
    fails('SELECT * FROM t; SELECT * FROM u', /Only one statement/, 1, 18)
  })

  test('subqueries, UNION and window functions', () => {
    fails('SELECT * FROM t WHERE a IN (SELECT b FROM u)', /Subqueries are not supported/, 1, 29)
    fails('SELECT * FROM (SELECT * FROM t) x', /Subqueries/, 1, 15)
    fails('SELECT * FROM t WHERE EXISTS (SELECT 1)', /EXISTS/, 1, 23)
    fails('SELECT a FROM t\nUNION SELECT a FROM u', /UNION is not supported/, 2, 1)
    fails('SELECT COUNT(*) OVER (PARTITION BY a) FROM t', /Window functions/, 1, 17)
  })

  test('functions, expressions and CASE', () => {
    fails('SELECT UPPER(name) FROM t', /The function UPPER\(\) is not supported/, 1, 8)
    fails('SELECT * FROM t WHERE a + 1 > 2', /Arithmetic/, 1, 25)
    fails("SELECT * FROM t WHERE a = 'x' || 'y'", /Arithmetic and string operators \("\|\|"\)/, 1, 31)
    fails('SELECT CASE WHEN a THEN 1 END FROM t', /CASE/, 1, 8)
    fails('SELECT SUM(DISTINCT a) FROM t', /only COUNT\(DISTINCT/, 1, 12)
    fails('SELECT SUM(*) FROM t', /SUM\(\*\)/, 1, 12)
    fails('SELECT COUNT(MAX(a)) FROM t', /nested/, 1, 14)
    fails('SELECT 1 FROM t', /Only columns and COUNT/, 1, 8)
  })

  test('joins that are not supported', () => {
    fails('SELECT * FROM a RIGHT JOIN b ON a.x = b.y', /RIGHT JOIN is not supported/, 1, 17)
    fails('SELECT * FROM a FULL OUTER JOIN b ON a.x = b.y', /FULL JOIN/, 1, 17)
    fails('SELECT * FROM a, b', /Comma joins/, 1, 16)
    fails('SELECT * FROM a JOIN b USING (x)', /USING/, 1, 24)
    fails('SELECT * FROM a JOIN b ON a.x > b.y', /only equalities between two columns/, 1, 31)
    fails("SELECT * FROM a JOIN b ON a.x = b.y AND b.z = 'q'", /only equalities/, 1, 45)
    fails('SELECT * FROM a JOIN b ON a.x = a.y', /a column of b with a column of an earlier collection/, 1, 31)
    fails('SELECT * FROM a JOIN b ON a.x = c.y JOIN c ON c.z = a.z', /c is not joined yet/, 1, 33)
    fails('SELECT * FROM a x JOIN b x ON x.p = x.q', /used for two collections/, 1, 24)
    fails('SELECT * FROM a JOIN fs.files ON a.f = fs.files._id', /Give the joined collection fs.files an alias/, 1, 22)
  })

  test('NULL, values and aggregates where they cannot go', () => {
    fails('SELECT * FROM t\nWHERE a = NULL', /use IS NULL/, 2, 9)
    fails('SELECT * FROM t WHERE a IN (1, NULL)', /NULL in an IN list/, 1, 32)
    fails('SELECT * FROM t WHERE 1 = 2', /comparing two values/, 1, 25)
    fails('SELECT * FROM t WHERE COUNT(*) > 1', /not allowed in WHERE; use HAVING/, 1, 23)
    fails('SELECT * FROM t WHERE active', /Expected a condition/, 1, 23)
    fails('SELECT * FROM t WHERE a IS TRUE', /Only IS NULL and IS NOT NULL/, 1, 28)
    fails("SELECT * FROM t WHERE a IN (b)", /IN lists take values/, 1, 29)
  })

  test('grouping mistakes', () => {
    fails('SELECT status, name, COUNT(*) FROM t GROUP BY status', /name must be in GROUP BY/, 1, 16)
    fails('SELECT * FROM t GROUP BY a', /SELECT \* cannot be used with GROUP BY/, 1, 8)
    fails('SELECT a FROM t HAVING a > 1', /HAVING needs GROUP BY/, 1, 26)
    fails('SELECT DISTINCT a, COUNT(*) FROM t', /DISTINCT together with/, 1, 17)
    fails('SELECT DISTINCT * FROM t', /SELECT DISTINCT \*/, 1, 17)
    fails('SELECT COUNT(*), COUNT(*) FROM t', /count is selected twice/, 1, 18)
    fails('SELECT a, a.b FROM t', /a and a.b overlap/, 1, 11)
    fails('SELECT a AS x, b AS x FROM t', /Two columns are named x/, 1, 16)
  })

  test('lexical and clause errors with positions', () => {
    fails("SELECT * FROM t WHERE a = 'open", /This string is never closed/, 1, 27)
    fails('SELECT * FROM t /* never', /comment is never closed/, 1, 17)
    fails('SELECT * FROM t WHERE a = ?', /Unexpected "\?"/, 1, 27)
    fails('SELECT a FROM t ORDER BY a WHERE a = 1', /WHERE is out of place/, 1, 28)
    fails('SELECT a FROM t LIMIT 0', /LIMIT 0/, 1, 17)
    fails('SELECT a FROM t LIMIT x', /LIMIT takes a whole number/, 1, 23)
    fails('SELECT a\nFROM', /Expected a collection name but the text ended/, 2, 5)
    fails('SELECT a FROM t WHERE (a = 1', /parenthesis is never closed/, 1, 23)
    fails('SELECT from FROM t', /keyword FROM; quote it/, 1, 8)
    fails("SELECT * FROM t WHERE d = DATE '2024-13-01'", /DATE takes 'YYYY-MM-DD'/, 1, 32)
    fails('SELECT o.* FROM orders o', /o\.\* is not supported/, 1, 8)
    fails('SELECT * FROM t WHERE $x = 1', /Unexpected "\$"/, 1, 23)
    fails('SELECT * FROM t WHERE "$x" = 1', /start with "\$"/, 1, 23)
  })
})
