// Deterministic fake data for Mongo Studio development. Covers every BSON type the editors handle,
// nested docs and arrays, views, time-series, capped and clustered collections, validators, every
// index kind, GridFS, users and roles. Re-running drops and recreates the demo databases.
/* global db, ObjectId, NumberDecimal, NumberLong, NumberInt, Timestamp, BinData, UUID, MinKey, MaxKey, ISODate, Code, print */

let seed = 20261116
// mulberry32: 32-bit integer maths via Math.imul, so the sequence is well spread and repeatable.
function rnd() {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1))
const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
const money = (a, b) => NumberDecimal((a + rnd() * (b - a)).toFixed(2))
const day = 86400000
const base = Date.UTC(2026, 10, 16)
const daysAgo = (n) => new Date(base - n * day - int(0, day))

const first = ['Ada', 'Grace', 'Linus', 'Margaret', 'Ken', 'Barbara', 'Dennis', 'Frances', 'Alan', 'Radia', 'Tim', 'Katherine', 'Edsger', 'Hedy', 'Bjarne', 'Sophie', 'Yukihiro', 'Anita', 'Guido', 'Jean']
const last = ['Lovelace', 'Hopper', 'Torvalds', 'Hamilton', 'Thompson', 'Liskov', 'Ritchie', 'Allen', 'Turing', 'Perlman', 'Berners-Lee', 'Johnson', 'Dijkstra', 'Lamarr', 'Stroustrup', 'Wilson', 'Matsumoto', 'Borg', 'van Rossum', 'Sammet']
const cities = [
  { city: 'Paris', country: 'FR', loc: [2.3522, 48.8566] }, { city: 'Lyon', country: 'FR', loc: [4.8357, 45.764] },
  { city: 'Berlin', country: 'DE', loc: [13.405, 52.52] }, { city: 'Madrid', country: 'ES', loc: [-3.7038, 40.4168] },
  { city: 'London', country: 'GB', loc: [-0.1276, 51.5072] }, { city: 'New York', country: 'US', loc: [-74.006, 40.7128] },
  { city: 'Tokyo', country: 'JP', loc: [139.6917, 35.6895] }, { city: 'Montreal', country: 'CA', loc: [-73.5674, 45.5019] }
]
const categories = ['books', 'electronics', 'garden', 'kitchen', 'toys', 'sports', 'music', 'office']
const adjectives = ['Compact', 'Deluxe', 'Eco', 'Pro', 'Classic', 'Smart', 'Mini', 'Ultra', 'Vintage', 'Wireless']
const nouns = ['Kettle', 'Lamp', 'Notebook', 'Headphones', 'Backpack', 'Drone', 'Planter', 'Keyboard', 'Skillet', 'Football', 'Ukulele', 'Stapler']
const statuses = ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']

function batchInsert(coll, n, make) {
  let buf = []
  for (let i = 0; i < n; i++) {
    buf.push(make(i))
    if (buf.length === 1000) { coll.insertMany(buf, { ordered: false }); buf = [] }
  }
  if (buf.length) coll.insertMany(buf, { ordered: false })
}

// mongosh's createIndexes takes key patterns only; full specs need the raw command.
function ix(coll, indexes) {
  coll.getDB().runCommand({ createIndexes: coll.getName(), indexes: indexes.map((i) => ({ name: i.name || Object.keys(i.key).join('_'), ...i })) })
}

for (const name of ['shop', 'blog', 'analytics', 'types_zoo']) db.getSiblingDB(name).dropDatabase()

// ---------- shop ----------
const shop = db.getSiblingDB('shop')
shop.createCollection('customers', {
  validator: { $jsonSchema: {
    bsonType: 'object', required: ['email', 'name', 'createdAt'],
    properties: {
      email: { bsonType: 'string', pattern: '^.+@.+$' },
      name: { bsonType: 'object', required: ['first', 'last'] },
      tier: { enum: ['free', 'silver', 'gold', 'platinum'] },
      loyaltyPoints: { bsonType: ['int', 'long'], minimum: 0 }
    }
  } },
  validationLevel: 'moderate', validationAction: 'error'
})
const customerIds = []
batchInsert(shop.customers, 2000, (i) => {
  const f = pick(first), l = pick(last), c = pick(cities), _id = new ObjectId()
  customerIds.push(_id)
  const doc = {
    _id, email: `${f}.${l}.${i}@example.test`.toLowerCase().replace(/ /g, ''),
    name: { first: f, last: l }, tier: pick(['free', 'free', 'free', 'silver', 'silver', 'gold', 'platinum']),
    address: { street: `${int(1, 220)} ${pick(['Main', 'Oak', 'Rue de la Paix', 'Elm', 'Station'])} St`, city: c.city, country: c.country, zip: String(int(10000, 99999)) },
    location: { type: 'Point', coordinates: [c.loc[0] + (rnd() - 0.5) / 5, c.loc[1] + (rnd() - 0.5) / 5] },
    loyaltyPoints: NumberInt(int(0, 25000)), lifetimeValue: money(0, 9000),
    marketingOptIn: rnd() > 0.4, tags: Array.from({ length: int(0, 3) }, () => pick(['vip', 'b2b', 'newsletter', 'returning', 'churn-risk'])),
    createdAt: daysAgo(int(30, 1500)), externalId: UUID()
  }
  if (rnd() > 0.7) doc.phone = `+33 6 ${int(10, 99)} ${int(10, 99)} ${int(10, 99)} ${int(10, 99)}`
  if (rnd() > 0.9) doc.deletedAt = null
  return doc
})
ix(shop.customers, [
  { key: { email: 1 }, name: 'email_unique', unique: true },
  { key: { 'address.country': 1, tier: 1, createdAt: -1 }, name: 'country_tier_created' },
  { key: { location: '2dsphere' }, name: 'location_2dsphere' },
  { key: { externalId: 'hashed' }, name: 'externalId_hashed' },
  { key: { phone: 1 }, name: 'phone_partial', partialFilterExpression: { phone: { $exists: true } } },
  { key: { 'name.last': 1 }, name: 'lastname_ci', collation: { locale: 'fr', strength: 2 } },
  { key: { tags: 1 }, name: 'tags_hidden', hidden: true }
])

const productIds = []
batchInsert(shop.products, 300, (i) => {
  const _id = new ObjectId(); productIds.push(_id)
  const cat = pick(categories)
  return {
    _id, sku: `SKU-${String(i).padStart(5, '0')}`, name: `${pick(adjectives)} ${pick(nouns)}`, category: cat,
    description: `A ${pick(['durable', 'lightweight', 'award-winning', 'handmade', 'refurbished'])} item for ${cat} lovers.`,
    price: money(3, 900), currency: 'EUR', stock: NumberInt(int(0, 500)), rating: Math.round(rnd() * 50) / 10,
    attributes: cat === 'electronics' ? { voltage: pick([110, 230]), warrantyMonths: NumberInt(pick([12, 24, 36])) } : { material: pick(['wood', 'steel', 'cotton', 'plastic']) },
    variants: Array.from({ length: int(1, 4) }, () => ({ color: pick(['red', 'black', 'white', 'blue', 'green']), size: pick(['S', 'M', 'L', null]), extraPrice: money(0, 20) })),
    active: rnd() > 0.08, createdAt: daysAgo(int(10, 900))
  }
})
ix(shop.products, [
  { key: { sku: 1 }, unique: true, name: 'sku_unique' },
  { key: { name: 'text', description: 'text' }, name: 'product_text', weights: { name: 5 } },
  { key: { category: 1, price: -1 }, name: 'category_price' },
  { key: { 'attributes.$**': 1 }, name: 'attributes_wildcard' }
])

batchInsert(shop.orders, 20000, (i) => {
  const items = Array.from({ length: int(1, 5) }, () => {
    const qty = int(1, 4), unit = (3 + rnd() * 300)
    return { productId: pick(productIds), qty: NumberInt(qty), unitPrice: NumberDecimal(unit.toFixed(2)) }
  })
  const total = items.reduce((s, it) => s + Number(it.unitPrice.toString()) * it.qty, 0)
  const status = pick(statuses), created = daysAgo(int(0, 720))
  return {
    orderNo: NumberLong(String(1000000 + i)), customerId: pick(customerIds), status, items,
    total: NumberDecimal(total.toFixed(2)), shippingCost: rnd() > 0.5 ? 0 : 4.99,
    payment: { method: pick(['card', 'paypal', 'transfer', 'giftcard']), last4: String(int(1000, 9999)) },
    history: [{ status: 'pending', at: created }].concat(status !== 'pending' ? [{ status, at: new Date(created.getTime() + int(1, 10) * day) }] : []),
    createdAt: created, notes: rnd() > 0.95 ? 'Leave at the door' : undefined
  }
})
ix(shop.orders, [
  { key: { customerId: 1, createdAt: -1 }, name: 'customer_created' },
  { key: { status: 1 }, name: 'status' },
  { key: { orderNo: 1 }, unique: true, name: 'orderNo_unique' }
])
shop.createCollection('sessions')
batchInsert(shop.sessions, 500, () => ({ customerId: pick(customerIds), token: UUID(), lastSeen: daysAgo(int(0, 2)) }))
shop.sessions.createIndex({ lastSeen: 1 }, { name: 'ttl_lastSeen', expireAfterSeconds: 7 * 86400 })

shop.createCollection('events_log', { capped: true, size: 1024 * 1024, max: 5000 })
batchInsert(shop.events_log, 3000, (i) => ({ level: pick(['info', 'info', 'warn', 'error']), msg: `event ${i}`, at: daysAgo(int(0, 30)) }))

shop.createCollection('audit', { clusteredIndex: { key: { _id: 1 }, unique: true, name: 'audit_clustered' } })
batchInsert(shop.audit, 1000, (i) => ({ _id: new Date(base - i * 60000), actor: pick(customerIds), action: pick(['login', 'update', 'export']) }))

shop.createView('order_totals_by_month', 'orders', [
  { $match: { status: { $nin: ['cancelled', 'refunded'] } } },
  { $group: { _id: { $dateTrunc: { date: '$createdAt', unit: 'month' } }, orders: { $sum: 1 }, revenue: { $sum: '$total' } } },
  { $sort: { _id: -1 } }
])
shop.createView('gold_customers', 'customers', [{ $match: { tier: { $in: ['gold', 'platinum'] } } }, { $project: { email: 1, name: 1, tier: 1, lifetimeValue: 1 } }])

// GridFS bucket "attachments": fs-style files and chunks written by hand (no driver bucket in mongosh).
const files = [['invoice-2026-001.txt', 'text/plain', 'Invoice 2026-001\nTotal: 129.90 EUR\n'], ['readme.md', 'text/markdown', '# Attachments\nDemo GridFS bucket.\n'], ['big.csv', 'text/csv', 'id,value\n' + Array.from({ length: 30000 }, (_, i) => `${i},${int(0, 999)}`).join('\n')]]
for (const [filename, contentType, text] of files) {
  const fileId = new ObjectId(), chunkSize = 255 * 1024, bytes = Buffer.from(text, 'utf8')
  for (let n = 0, off = 0; off < bytes.length; n++, off += chunkSize) {
    shop.getCollection('attachments.chunks').insertOne({ files_id: fileId, n: NumberInt(n), data: BinData(0, bytes.subarray(off, off + chunkSize).toString('base64')) })
  }
  shop.getCollection('attachments.files').insertOne({ _id: fileId, length: NumberLong(String(bytes.length)), chunkSize: NumberInt(chunkSize), uploadDate: daysAgo(int(0, 60)), filename, metadata: { contentType } })
}
shop.getCollection('attachments.chunks').createIndex({ files_id: 1, n: 1 }, { unique: true })
shop.getCollection('attachments.files').createIndex({ filename: 1, uploadDate: 1 })

// ---------- blog ----------
const blog = db.getSiblingDB('blog')
const authorIds = []
batchInsert(blog.authors, 40, (i) => { const _id = new ObjectId(); authorIds.push(_id); return { _id, handle: `${pick(first).toLowerCase()}${i}`, bio: 'Writes about databases.', joined: daysAgo(int(100, 2000)) } })
const words = 'mongodb index query shard replica aggregate pipeline schema cursor document field collection latency throughput backup'.split(' ')
const postIds = []
batchInsert(blog.posts, 800, (i) => {
  const _id = new ObjectId(); postIds.push(_id)
  return { _id, slug: `post-${i}`, title: `On ${pick(words)} and ${pick(words)}`, authorId: pick(authorIds), body: Array.from({ length: 60 }, () => pick(words)).join(' '),
    tags: Array.from({ length: int(1, 4) }, () => pick(words)), published: rnd() > 0.2, publishedAt: daysAgo(int(0, 900)), stats: { views: NumberLong(String(int(0, 200000))), likes: NumberInt(int(0, 3000)) } }
})
batchInsert(blog.comments, 6000, () => ({ postId: pick(postIds), author: pick(first), text: `Great point about ${pick(words)}!`, at: daysAgo(int(0, 900)), replies: rnd() > 0.8 ? [{ author: pick(first), text: 'Agreed.', at: daysAgo(int(0, 100)) }] : [] }))
blog.posts.createIndex({ slug: 1 }, { unique: true })
blog.comments.createIndex({ postId: 1, at: -1 })

// ---------- analytics (time-series) ----------
const analytics = db.getSiblingDB('analytics')
analytics.createCollection('pageviews', { timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'minutes' }, expireAfterSeconds: 400 * 86400 })
batchInsert(analytics.pageviews, 50000, (i) => ({ ts: new Date(base - i * 37000), meta: { site: pick(['shop', 'blog']), country: pick(cities).country }, path: pick(['/', '/cart', '/p/123', '/blog/post-1', '/checkout']), durationMs: int(50, 30000) }))

// ---------- types_zoo: one document per BSON type, for the type-aware editors ----------
const zoo = db.getSiblingDB('types_zoo').everything
zoo.insertMany([
  { _id: 'all-types', double: 3.14159, string: 'héllo wörld', object: { nested: { deep: [1, { x: 2 }] } }, array: [1, 'two', 3.0, null, [4]],
    binary: BinData(0, 'SGVsbG8='), uuid: UUID('3b241101-e2bb-4255-8caf-4136c566a962'), objectId: ObjectId('6542f1a2b3c4d5e6f7a8b9c0'),
    bool: true, date: ISODate('2026-11-16T12:34:56.789Z'), null: null, regex: /^mongo.*$/i, code: Code('function () { return 1 }'),
    int32: NumberInt(42), timestamp: Timestamp({ t: 1794835766, i: 7 }), int64: NumberLong('9007199254740993'), decimal128: NumberDecimal('0.1000000000000000000000000000000001'),
    minKey: MinKey(), maxKey: MaxKey(), emptyObject: {}, emptyArray: [], 'dotted.key': 'needs bracket access', $unicode: '日本語 ✓' },
  { _id: 'edge-numbers', nan: NaN, inf: Infinity, negZero: -0, maxInt: NumberInt(2147483647), minLong: NumberLong('-9223372036854775808') },
  { _id: 'big-array', values: Array.from({ length: 2000 }, (_, i) => i) }
])

// ---------- users and a custom role (auth is off locally; these are for the user/role manager) ----------
const admin = db.getSiblingDB('admin')
try { admin.dropRole('shopReporter') } catch (e) {}
for (const u of ['reporter', 'app']) { try { shop.dropUser(u) } catch (e) {} }
admin.createRole({ role: 'shopReporter', privileges: [{ resource: { db: 'shop', collection: 'orders' }, actions: ['find'] }, { resource: { db: 'shop', collection: 'order_totals_by_month' }, actions: ['find'] }], roles: [] })
shop.createUser({ user: 'reporter', pwd: 'reporter-dev-only', roles: [{ role: 'shopReporter', db: 'admin' }] })
shop.createUser({ user: 'app', pwd: 'app-dev-only', roles: [{ role: 'readWrite', db: 'shop' }] })

for (const name of ['shop', 'blog', 'analytics', 'types_zoo']) {
  const d = db.getSiblingDB(name)
  print(`${name}: ` + d.getCollectionInfos().map((c) => `${c.name}(${c.type === 'view' ? 'view' : d.getCollection(c.name).estimatedDocumentCount()})`).join(', '))
}
