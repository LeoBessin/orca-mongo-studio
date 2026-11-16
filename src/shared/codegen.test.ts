// Driver code generation goldens: whole snippets for every language, checked by hand against each
// driver's API (and, for Node.js, Python and Java, by running them against the real BSON encoders
// while writing them), plus focused tests for string escaping, key quoting and type pitfalls.
import { assert, describe, test } from 'orca/testing'
import { CODE_LANGUAGES, generateCode, type CodeLanguage } from './codegen'
import { operationToShell, type Operation } from './operation'
import { parseShell } from './shell-parse'
import type { JsonObject } from './ejson-view'

const f = (text: string): JsonObject => parseShell(text) as JsonObject

const FIND: Operation = {
  kind: 'find',
  db: 'shop',
  collection: 'orders',
  filter: f("{ status: 'shipped', total: { $gte: 100, $lt: 500.5 }, customerId: ObjectId('6542f1a2b3c4d5e6f7a8b9c0') }"),
  projection: f('{ _id: 0, name: 1, total: 1 }'),
  sort: f('{ total: -1, name: 1 }'),
  collation: f("{ locale: 'en', strength: 2 }"),
  skip: 10,
  limit: 20
}

const AGGREGATE: Operation = {
  kind: 'aggregate',
  db: 'shop',
  collection: 'orders',
  pipeline: [
    f("{ $match: { status: 'shipped', createdAt: { $gte: ISODate('2024-01-01T00:00:00Z') } } }"),
    f("{ $group: { _id: '$customerId', total: { $sum: '$total' }, orders: { $sum: 1 } } }"),
    f('{ $sort: { total: -1 } }')
  ]
}

/** Every BSON type; the last four have no shell syntax the parser reads, so they are written out. */
const ZOO: Operation = {
  kind: 'find',
  db: 'test',
  collection: 'types',
  filter: {
    ...f(`{
      int: 42, intMin: -2147483648, long: NumberLong('9007199254740993'), longMin: NumberLong('-9223372036854775808'),
      double: 3.0, frac: 0.1, big: 1e300, nan: NaN, inf: Infinity, ninf: -Infinity, negZero: -0.0, dec: NumberDecimal('123.4500'),
      oid: ObjectId('6542f1a2b3c4d5e6f7a8b9c0'), date: ISODate('2024-03-05T06:07:08.123Z'), before1970: new Date(-1), ancient: new Date(-62198755200000),
      re: /^ab+c/im, uuid: UUID('3b241101-e2bb-4255-8caf-4136c566a962'), bin: BinData(0, 'AQIDBA=='), custom: BinData(133, 'AQ=='),
      ts: Timestamp({ t: 1700000000, i: 7 }), min: MinKey(), max: MaxKey(), code: Code('function () { return 1 }'),
      str: 'it\\'s "q" \\\\ é', yes: true, nothing: null, arr: [1, 'two', [3.5]], sub: { x: { y: 1 } }, emptyDoc: {}, emptyArr: []
    }`),
    scope: { $code: 'x + y', $scope: { y: { $numberInt: '2' } } },
    undef: { $undefined: true },
    sym: { $symbol: 'sym' },
    ptr: { $dbPointer: { $ref: 'db.coll', $id: { $oid: '6542f1a2b3c4d5e6f7a8b9c0' } } }
  }
}

// Goldens are raw strings: what is between the backticks is exactly the generated code.

const FIND_CODE: Record<CodeLanguage, string> = {
  mongosh: String.raw`db.orders.find({
  status: 'shipped',
  total: {
    $gte: 100,
    $lt: 500.5
  },
  customerId: ObjectId('6542f1a2b3c4d5e6f7a8b9c0')
}, { _id: 0, name: 1, total: 1 })
  .sort({ total: -1, name: 1 })
  .collation({ locale: 'en', strength: 2 })
  .skip(10)
  .limit(20)`,
  node: String.raw`const { MongoClient, ObjectId } = require('mongodb');

async function run() {
  const client = new MongoClient('mongodb://localhost:27017');
  try {
    const collection = client.db('shop').collection('orders');

    const filter = {
      status: 'shipped',
      total: { $gte: 100, $lt: 500.5 },
      customerId: new ObjectId('6542f1a2b3c4d5e6f7a8b9c0')
    };
    const cursor = collection.find(filter, {
      projection: { _id: 0, name: 1, total: 1 },
      sort: { total: -1, name: 1 },
      collation: { locale: 'en', strength: 2 },
      skip: 10,
      limit: 20
    });
    for await (const doc of cursor) {
      console.log(doc);
    }
  } finally {
    await client.close();
  }
}

run().catch(console.error);
`,
  python: String.raw`from bson import ObjectId
from pymongo import MongoClient

client = MongoClient("mongodb://localhost:27017")
collection = client["shop"]["orders"]

query = {
    "status": "shipped",
    "total": {"$gte": 100, "$lt": 500.5},
    "customerId": ObjectId("6542f1a2b3c4d5e6f7a8b9c0"),
}

cursor = collection.find(
    query,
    projection={"_id": 0, "name": 1, "total": 1},
    sort=[("total", -1), ("name", 1)],
    collation={"locale": "en", "strength": 2},
    skip=10,
    limit=20,
)
for doc in cursor:
    print(doc)
`,
  java: String.raw`import com.mongodb.client.FindIterable;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.model.Collation;
import com.mongodb.client.model.CollationStrength;
import org.bson.Document;
import org.bson.types.ObjectId;

public class Main {
    public static void main(String[] args) {
        try (MongoClient client = MongoClients.create("mongodb://localhost:27017")) {
            MongoCollection<Document> collection = client.getDatabase("shop").getCollection("orders");

            Document filter = new Document()
                .append("status", "shipped")
                .append("total", new Document("$gte", 100).append("$lt", 500.5))
                .append("customerId", new ObjectId("6542f1a2b3c4d5e6f7a8b9c0"));
            FindIterable<Document> results = collection.find(filter)
                .projection(new Document("_id", 0).append("name", 1).append("total", 1))
                .sort(new Document("total", -1).append("name", 1))
                .collation(Collation.builder()
                    .locale("en")
                    .collationStrength(CollationStrength.SECONDARY)
                    .build())
                .skip(10)
                .limit(20);
            for (Document doc : results) {
                System.out.println(doc.toJson());
            }
        }
    }
}
`,
  csharp: String.raw`using System;
using MongoDB.Bson;
using MongoDB.Driver;

var client = new MongoClient("mongodb://localhost:27017");
var collection = client.GetDatabase("shop").GetCollection<BsonDocument>("orders");

var filter = new BsonDocument
{
    { "status", "shipped" },
    { "total", new BsonDocument { { "$gte", 100 }, { "$lt", 500.5 } } },
    { "customerId", new ObjectId("6542f1a2b3c4d5e6f7a8b9c0") }
};

var options = new FindOptions
{
    Collation = new Collation("en", strength: CollationStrength.Secondary)
};
var results = collection.Find(filter, options)
    .Project(new BsonDocument { { "_id", 0 }, { "name", 1 }, { "total", 1 } })
    .Sort(new BsonDocument { { "total", -1 }, { "name", 1 } })
    .Skip(10)
    .Limit(20);

foreach (var doc in results.ToEnumerable())
{
    Console.WriteLine(doc);
}
`,
  php: String.raw`<?php

require 'vendor/autoload.php';

use MongoDB\BSON\ObjectId;
use MongoDB\Client;

$client = new Client('mongodb://localhost:27017');
$collection = $client->selectCollection('shop', 'orders');

$filter = [
    'status' => 'shipped',
    'total' => ['$gte' => 100, '$lt' => 500.5],
    'customerId' => new ObjectId('6542f1a2b3c4d5e6f7a8b9c0'),
];

$cursor = $collection->find($filter, [
    'projection' => ['_id' => 0, 'name' => 1, 'total' => 1],
    'sort' => ['total' => -1, 'name' => 1],
    'collation' => ['locale' => 'en', 'strength' => 2],
    'skip' => 10,
    'limit' => 20,
]);

foreach ($cursor as $document) {
    echo json_encode($document), PHP_EOL;
}
`,
  ruby: String.raw`require 'mongo'

client = Mongo::Client.new('mongodb://localhost:27017', database: 'shop')
collection = client['orders']

filter = {
  'status' => 'shipped',
  'total' => { '$gte' => 100, '$lt' => 500.5 },
  'customerId' => BSON::ObjectId.from_string('6542f1a2b3c4d5e6f7a8b9c0')
}

cursor = collection.find(
  filter,
  projection: { '_id' => 0, 'name' => 1, 'total' => 1 },
  sort: { 'total' => -1, 'name' => 1 },
  collation: { 'locale' => 'en', 'strength' => 2 },
  skip: 10,
  limit: 20
)
cursor.each do |doc|
  puts doc
end
`,
}

const AGGREGATE_CODE: Record<CodeLanguage, string> = {
  mongosh: String.raw`db.orders.aggregate([
  {
    $match: {
      status: 'shipped',
      createdAt: {
        $gte: ISODate('2024-01-01T00:00:00Z')
      }
    }
  },
  {
    $group: {
      _id: '$customerId',
      total: {
        $sum: '$total'
      },
      orders: {
        $sum: 1
      }
    }
  },
  {
    $sort: {
      total: -1
    }
  }
])`,
  node: String.raw`const { MongoClient } = require('mongodb');

async function run() {
  const client = new MongoClient('mongodb://localhost:27017');
  try {
    const collection = client.db('shop').collection('orders');

    const pipeline = [
      {
        $match: {
          status: 'shipped',
          createdAt: { $gte: new Date('2024-01-01T00:00:00Z') }
        }
      },
      {
        $group: { _id: '$customerId', total: { $sum: '$total' }, orders: { $sum: 1 } }
      },
      { $sort: { total: -1 } }
    ];
    const cursor = collection.aggregate(pipeline);
    for await (const doc of cursor) {
      console.log(doc);
    }
  } finally {
    await client.close();
  }
}

run().catch(console.error);
`,
  python: String.raw`from datetime import datetime, timezone

from pymongo import MongoClient

client = MongoClient("mongodb://localhost:27017")
collection = client["shop"]["orders"]

pipeline = [
    {
        "$match": {
            "status": "shipped",
            "createdAt": {"$gte": datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)},
        },
    },
    {
        "$group": {
            "_id": "$customerId",
            "total": {"$sum": "$total"},
            "orders": {"$sum": 1},
        },
    },
    {"$sort": {"total": -1}},
]

cursor = collection.aggregate(pipeline)
for doc in cursor:
    print(doc)
`,
  java: String.raw`import com.mongodb.client.AggregateIterable;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
import java.time.Instant;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import org.bson.Document;

public class Main {
    public static void main(String[] args) {
        try (MongoClient client = MongoClients.create("mongodb://localhost:27017")) {
            MongoCollection<Document> collection = client.getDatabase("shop").getCollection("orders");

            List<Document> pipeline = Arrays.asList(
                new Document()
                    .append("$match", new Document()
                        .append("status", "shipped")
                        .append("createdAt", new Document("$gte", Date.from(Instant.parse("2024-01-01T00:00:00Z"))))),
                new Document()
                    .append("$group", new Document()
                        .append("_id", "$customerId")
                        .append("total", new Document("$sum", "$total"))
                        .append("orders", new Document("$sum", 1))),
                new Document("$sort", new Document("total", -1)));
            AggregateIterable<Document> results = collection.aggregate(pipeline);
            for (Document doc : results) {
                System.out.println(doc.toJson());
            }
        }
    }
}
`,
  csharp: String.raw`using System;
using MongoDB.Bson;
using MongoDB.Driver;

var client = new MongoClient("mongodb://localhost:27017");
var collection = client.GetDatabase("shop").GetCollection<BsonDocument>("orders");

var pipeline = new BsonDocument[]
{
    new BsonDocument
    {
        { "$match", new BsonDocument
        {
            { "status", "shipped" },
            { "createdAt", new BsonDocument
            {
                { "$gte", new DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc) }
            } }
        } }
    },
    new BsonDocument
    {
        { "$group", new BsonDocument
        {
            { "_id", "$customerId" },
            { "total", new BsonDocument("$sum", "$total") },
            { "orders", new BsonDocument("$sum", 1) }
        } }
    },
    new BsonDocument("$sort", new BsonDocument("total", -1))
};

var results = collection.Aggregate<BsonDocument>(pipeline);

foreach (var doc in results.ToEnumerable())
{
    Console.WriteLine(doc);
}
`,
  php: String.raw`<?php

require 'vendor/autoload.php';

use MongoDB\BSON\UTCDateTime;
use MongoDB\Client;

$client = new Client('mongodb://localhost:27017');
$collection = $client->selectCollection('shop', 'orders');

$pipeline = [
    [
        '$match' => [
            'status' => 'shipped',
            'createdAt' => [
                '$gte' => new UTCDateTime(new DateTimeImmutable('2024-01-01T00:00:00Z')),
            ],
        ],
    ],
    [
        '$group' => [
            '_id' => '$customerId',
            'total' => ['$sum' => '$total'],
            'orders' => ['$sum' => 1],
        ],
    ],
    ['$sort' => ['total' => -1]],
];

$cursor = $collection->aggregate($pipeline);

foreach ($cursor as $document) {
    echo json_encode($document), PHP_EOL;
}
`,
  ruby: String.raw`require 'mongo'

client = Mongo::Client.new('mongodb://localhost:27017', database: 'shop')
collection = client['orders']

pipeline = [
  {
    '$match' => {
      'status' => 'shipped',
      'createdAt' => { '$gte' => Time.utc(2024, 1, 1, 0, 0, 0) }
    }
  },
  {
    '$group' => {
      '_id' => '$customerId',
      'total' => { '$sum' => '$total' },
      'orders' => { '$sum' => 1 }
    }
  },
  { '$sort' => { 'total' => -1 } }
]

cursor = collection.aggregate(pipeline)
cursor.each do |doc|
  puts doc
end
`,
}

const ZOO_CODE: Record<CodeLanguage, string> = {
  mongosh: String.raw`db.types.find({
  int: 42,
  intMin: -2147483648,
  long: NumberLong('9007199254740993'),
  longMin: NumberLong('-9223372036854775808'),
  double: 3.0,
  frac: 0.1,
  big: 1e+300,
  nan: NaN,
  inf: Infinity,
  ninf: -Infinity,
  negZero: -0.0,
  dec: NumberDecimal('123.4500'),
  oid: ObjectId('6542f1a2b3c4d5e6f7a8b9c0'),
  date: ISODate('2024-03-05T06:07:08.123Z'),
  before1970: new Date(-1),
  ancient: new Date(-62198755200000),
  re: /^ab+c/im,
  uuid: UUID('3b241101-e2bb-4255-8caf-4136c566a962'),
  bin: BinData(0, 'AQIDBA=='),
  custom: BinData(133, 'AQ=='),
  ts: Timestamp({ t: 1700000000, i: 7 }),
  min: MinKey(),
  max: MaxKey(),
  code: Code('function () { return 1 }'),
  str: 'it\'s "q" \\ é',
  yes: true,
  nothing: null,
  arr: [
    1,
    'two',
    [
      3.5
    ]
  ],
  sub: {
    x: {
      y: 1
    }
  },
  emptyDoc: {},
  emptyArr: [],
  scope: {
    $code: 'x + y',
    $scope: {
      y: 2
    }
  },
  undef: {
    $undefined: true
  },
  sym: {
    $symbol: 'sym'
  },
  ptr: {
    $dbPointer: {
      $ref: 'db.coll',
      $id: ObjectId('6542f1a2b3c4d5e6f7a8b9c0')
    }
  }
})`,
  node: String.raw`const { BSONRegExp, BSONSymbol, Binary, Code, Decimal128, Double, Long, MaxKey, MinKey, MongoClient, ObjectId, Timestamp, UUID } = require('mongodb');

async function run() {
  const client = new MongoClient('mongodb://localhost:27017');
  try {
    const collection = client.db('test').collection('types');

    // Note: filter.undef: the Node.js driver cannot write BSON undefined (it writes null), so null is used
    // Note: filter.ptr: the Node.js driver cannot write a BSON DBPointer; a { $ref, $id } document is written instead
    const filter = {
      int: 42,
      intMin: -2147483648,
      long: Long.fromString('9007199254740993'),
      longMin: Long.fromString('-9223372036854775808'),
      double: new Double(3.0),
      frac: 0.1,
      big: new Double(1e+300),
      nan: NaN,
      inf: Infinity,
      ninf: -Infinity,
      negZero: new Double(-0.0),
      dec: Decimal128.fromString('123.4500'),
      oid: new ObjectId('6542f1a2b3c4d5e6f7a8b9c0'),
      date: new Date('2024-03-05T06:07:08.123Z'),
      before1970: new Date('1969-12-31T23:59:59.999Z'),
      ancient: new Date(-62198755200000),
      re: new BSONRegExp('^ab+c', 'im'),
      uuid: new UUID('3b241101-e2bb-4255-8caf-4136c566a962'),
      bin: Binary.createFromBase64('AQIDBA==', 0),
      custom: Binary.createFromBase64('AQ==', 133),
      ts: new Timestamp({ t: 1700000000, i: 7 }),
      min: new MinKey(),
      max: new MaxKey(),
      code: new Code('function () { return 1 }'),
      str: 'it\'s "q" \\ é',
      yes: true,
      nothing: null,
      arr: [1, 'two', [3.5]],
      sub: { x: { y: 1 } },
      emptyDoc: {},
      emptyArr: [],
      scope: new Code('x + y', { y: 2 }),
      undef: null,
      sym: new BSONSymbol('sym'),
      ptr: { $ref: 'db.coll', $id: new ObjectId('6542f1a2b3c4d5e6f7a8b9c0') }
    };
    const cursor = collection.find(filter);
    for await (const doc of cursor) {
      console.log(doc);
    }
  } finally {
    await client.close();
  }
}

run().catch(console.error);
`,
  python: String.raw`from base64 import b64decode
from datetime import datetime, timezone
from uuid import UUID

from bson import Binary, Code, Decimal128, Int64, MaxKey, MinKey, ObjectId, Regex, Timestamp
from bson.datetime_ms import DatetimeMS
from pymongo import MongoClient

client = MongoClient("mongodb://localhost:27017")
collection = client["test"]["types"]

# Note: query.undef: PyMongo cannot write BSON undefined, so None (null) is used
# Note: query.sym: PyMongo cannot write a BSON symbol, so a string is used
# Note: query.ptr: PyMongo cannot write a BSON DBPointer; a { $ref, $id } document is written instead
query = {
    "int": 42,
    "intMin": -2147483648,
    "long": Int64(9007199254740993),
    "longMin": Int64(-9223372036854775808),
    "double": 3.0,
    "frac": 0.1,
    "big": 1e+300,
    "nan": float("nan"),
    "inf": float("inf"),
    "ninf": float("-inf"),
    "negZero": -0.0,
    "dec": Decimal128("123.4500"),
    "oid": ObjectId("6542f1a2b3c4d5e6f7a8b9c0"),
    "date": datetime(2024, 3, 5, 6, 7, 8, 123000, tzinfo=timezone.utc),
    "before1970": datetime(1969, 12, 31, 23, 59, 59, 999000, tzinfo=timezone.utc),
    "ancient": DatetimeMS(-62198755200000),
    "re": Regex("^ab+c", "im"),
    "uuid": Binary.from_uuid(UUID("3b241101-e2bb-4255-8caf-4136c566a962")),
    "bin": Binary(b64decode("AQIDBA=="), 0),
    "custom": Binary(b64decode("AQ=="), 133),
    "ts": Timestamp(1700000000, 7),
    "min": MinKey(),
    "max": MaxKey(),
    "code": Code("function () { return 1 }"),
    "str": "it's \"q\" \\ é",
    "yes": True,
    "nothing": None,
    "arr": [1, "two", [3.5]],
    "sub": {"x": {"y": 1}},
    "emptyDoc": {},
    "emptyArr": [],
    "scope": Code("x + y", {"y": 2}),
    "undef": None,
    "sym": "sym",
    "ptr": {"$ref": "db.coll", "$id": ObjectId("6542f1a2b3c4d5e6f7a8b9c0")},
}

cursor = collection.find(query)
for doc in cursor:
    print(doc)
`,
  java: String.raw`import com.mongodb.client.FindIterable;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.Date;
import java.util.UUID;
import org.bson.BsonBinary;
import org.bson.BsonBinarySubType;
import org.bson.BsonDbPointer;
import org.bson.BsonRegularExpression;
import org.bson.BsonTimestamp;
import org.bson.BsonUndefined;
import org.bson.Document;
import org.bson.types.Binary;
import org.bson.types.Code;
import org.bson.types.CodeWithScope;
import org.bson.types.Decimal128;
import org.bson.types.MaxKey;
import org.bson.types.MinKey;
import org.bson.types.ObjectId;
import org.bson.types.Symbol;

public class Main {
    public static void main(String[] args) {
        try (MongoClient client = MongoClients.create("mongodb://localhost:27017")) {
            MongoCollection<Document> collection = client.getDatabase("test").getCollection("types");

            Document filter = new Document()
                .append("int", 42)
                .append("intMin", -2147483648)
                .append("long", 9007199254740993L)
                .append("longMin", -9223372036854775808L)
                .append("double", 3.0)
                .append("frac", 0.1)
                .append("big", 1e+300)
                .append("nan", Double.NaN)
                .append("inf", Double.POSITIVE_INFINITY)
                .append("ninf", Double.NEGATIVE_INFINITY)
                .append("negZero", -0.0)
                .append("dec", Decimal128.parse("123.4500"))
                .append("oid", new ObjectId("6542f1a2b3c4d5e6f7a8b9c0"))
                .append("date", Date.from(Instant.parse("2024-03-05T06:07:08.123Z")))
                .append("before1970", Date.from(Instant.parse("1969-12-31T23:59:59.999Z")))
                .append("ancient", new Date(-62198755200000L))
                .append("re", new BsonRegularExpression("^ab+c", "im"))
                .append("uuid", new BsonBinary(UUID.fromString("3b241101-e2bb-4255-8caf-4136c566a962")))
                .append("bin", new Binary(BsonBinarySubType.BINARY, Base64.getDecoder().decode("AQIDBA==")))
                .append("custom", new Binary((byte) 0x85, Base64.getDecoder().decode("AQ==")))
                .append("ts", new BsonTimestamp(1700000000, 7))
                .append("min", new MinKey())
                .append("max", new MaxKey())
                .append("code", new Code("function () { return 1 }"))
                .append("str", "it's \"q\" \\ \u00e9")
                .append("yes", true)
                .append("nothing", null)
                .append("arr", Arrays.asList(1, "two", Arrays.asList(3.5)))
                .append("sub", new Document("x", new Document("y", 1)))
                .append("emptyDoc", new Document())
                .append("emptyArr", Arrays.asList())
                .append("scope", new CodeWithScope("x + y", new Document("y", 2)))
                .append("undef", new BsonUndefined())
                .append("sym", new Symbol("sym"))
                .append("ptr", new BsonDbPointer("db.coll", new ObjectId("6542f1a2b3c4d5e6f7a8b9c0")));
            FindIterable<Document> results = collection.find(filter);
            for (Document doc : results) {
                System.out.println(doc.toJson());
            }
        }
    }
}
`,
  csharp: String.raw`using System;
using MongoDB.Bson;
using MongoDB.Driver;

var client = new MongoClient("mongodb://localhost:27017");
var collection = client.GetDatabase("test").GetCollection<BsonDocument>("types");

// Note: filter.ptr: the .NET driver cannot write a BSON DBPointer; a { $ref, $id } document is written instead
var filter = new BsonDocument
{
    { "int", 42 },
    { "intMin", -2147483648 },
    { "long", 9007199254740993L },
    { "longMin", -9223372036854775808L },
    { "double", 3.0 },
    { "frac", 0.1 },
    { "big", 1e+300 },
    { "nan", double.NaN },
    { "inf", double.PositiveInfinity },
    { "ninf", double.NegativeInfinity },
    { "negZero", -0.0 },
    { "dec", Decimal128.Parse("123.4500") },
    { "oid", new ObjectId("6542f1a2b3c4d5e6f7a8b9c0") },
    { "date", new DateTime(2024, 3, 5, 6, 7, 8, 123, DateTimeKind.Utc) },
    { "before1970", new DateTime(1969, 12, 31, 23, 59, 59, 999, DateTimeKind.Utc) },
    { "ancient", new BsonDateTime(-62198755200000) },
    { "re", new BsonRegularExpression("^ab+c", "im") },
    { "uuid", new BsonBinaryData(Guid.Parse("3b241101-e2bb-4255-8caf-4136c566a962"), GuidRepresentation.Standard) },
    { "bin", new BsonBinaryData(Convert.FromBase64String("AQIDBA=="), BsonBinarySubType.Binary) },
    { "custom", new BsonBinaryData(Convert.FromBase64String("AQ=="), (BsonBinarySubType)0x85) },
    { "ts", new BsonTimestamp(1700000000, 7) },
    { "min", BsonMinKey.Value },
    { "max", BsonMaxKey.Value },
    { "code", new BsonJavaScript("function () { return 1 }") },
    { "str", "it's \"q\" \\ é" },
    { "yes", true },
    { "nothing", BsonNull.Value },
    { "arr", new BsonArray { 1, "two", new BsonArray { 3.5 } } },
    { "sub", new BsonDocument("x", new BsonDocument("y", 1)) },
    { "emptyDoc", new BsonDocument() },
    { "emptyArr", new BsonArray() },
    { "scope", new BsonJavaScriptWithScope("x + y", new BsonDocument("y", 2)) },
    { "undef", BsonUndefined.Value },
    { "sym", BsonSymbolTable.Lookup("sym") },
    { "ptr", new BsonDocument
    {
        { "$ref", "db.coll" },
        { "$id", new ObjectId("6542f1a2b3c4d5e6f7a8b9c0") }
    } }
};

var results = collection.Find(filter);

foreach (var doc in results.ToEnumerable())
{
    Console.WriteLine(doc);
}
`,
  php: String.raw`<?php

require 'vendor/autoload.php';

use MongoDB\BSON\Binary;
use MongoDB\BSON\Decimal128;
use MongoDB\BSON\Int64;
use MongoDB\BSON\Javascript;
use MongoDB\BSON\MaxKey;
use MongoDB\BSON\MinKey;
use MongoDB\BSON\ObjectId;
use MongoDB\BSON\Regex;
use MongoDB\BSON\Timestamp;
use MongoDB\BSON\UTCDateTime;
use MongoDB\Client;

$client = new Client('mongodb://localhost:27017');
$collection = $client->selectCollection('test', 'types');

// Note: filter.undef: the PHP driver cannot write BSON undefined, so null is used
// Note: filter.sym: the PHP driver cannot write a BSON symbol, so a string is used
// Note: filter.ptr: the PHP driver cannot write a BSON DBPointer; a { $ref, $id } document is written instead
$filter = [
    'int' => 42,
    'intMin' => -2147483648,
    'long' => new Int64('9007199254740993'),
    'longMin' => new Int64('-9223372036854775808'),
    'double' => 3.0,
    'frac' => 0.1,
    'big' => 1e+300,
    'nan' => NAN,
    'inf' => INF,
    'ninf' => -INF,
    'negZero' => -0.0,
    'dec' => new Decimal128('123.4500'),
    'oid' => new ObjectId('6542f1a2b3c4d5e6f7a8b9c0'),
    'date' => new UTCDateTime(new DateTimeImmutable('2024-03-05T06:07:08.123Z')),
    'before1970' => new UTCDateTime(new DateTimeImmutable('1969-12-31T23:59:59.999Z')),
    'ancient' => new UTCDateTime(-62198755200000),
    're' => new Regex('^ab+c', 'im'),
    'uuid' => new Binary(hex2bin('3b241101e2bb42558caf4136c566a962'), Binary::TYPE_UUID),
    'bin' => new Binary(base64_decode('AQIDBA=='), Binary::TYPE_GENERIC),
    'custom' => new Binary(base64_decode('AQ=='), 133),
    'ts' => new Timestamp(increment: 7, timestamp: 1700000000),
    'min' => new MinKey(),
    'max' => new MaxKey(),
    'code' => new Javascript('function () { return 1 }'),
    'str' => 'it\'s "q" \\ é',
    'yes' => true,
    'nothing' => null,
    'arr' => [1, 'two', [3.5]],
    'sub' => ['x' => ['y' => 1]],
    'emptyDoc' => (object) [],
    'emptyArr' => [],
    'scope' => new Javascript('x + y', ['y' => 2]),
    'undef' => null,
    'sym' => 'sym',
    'ptr' => ['$ref' => 'db.coll', '$id' => new ObjectId('6542f1a2b3c4d5e6f7a8b9c0')],
];

$cursor = $collection->find($filter);

foreach ($cursor as $document) {
    echo json_encode($document), PHP_EOL;
}
`,
  ruby: String.raw`require 'mongo'

client = Mongo::Client.new('mongodb://localhost:27017', database: 'test')
collection = client['types']

filter = {
  'int' => 42,
  'intMin' => -2147483648,
  'long' => BSON::Int64.new(9007199254740993),
  'longMin' => BSON::Int64.new(-9223372036854775808),
  'double' => 3.0,
  'frac' => 0.1,
  'big' => 1e+300,
  'nan' => Float::NAN,
  'inf' => Float::INFINITY,
  'ninf' => -Float::INFINITY,
  'negZero' => -0.0,
  'dec' => BSON::Decimal128.new('123.4500'),
  'oid' => BSON::ObjectId.from_string('6542f1a2b3c4d5e6f7a8b9c0'),
  'date' => Time.utc(2024, 3, 5, 6, 7, 8, 123000),
  'before1970' => Time.utc(1969, 12, 31, 23, 59, 59, 999000),
  'ancient' => Time.utc(-1, 1, 1, 0, 0, 0),
  're' => BSON::Regexp::Raw.new('^ab+c', 'im'),
  'uuid' => BSON::Binary.from_uuid('3b241101-e2bb-4255-8caf-4136c566a962'),
  'bin' => BSON::Binary.new('AQIDBA=='.unpack1('m'), :generic),
  'custom' => BSON::Binary.new('AQ=='.unpack1('m'), 0x85),
  'ts' => BSON::Timestamp.new(1700000000, 7),
  'min' => BSON::MinKey.new,
  'max' => BSON::MaxKey.new,
  'code' => BSON::Code.new('function () { return 1 }'),
  'str' => 'it\'s "q" \\ é',
  'yes' => true,
  'nothing' => nil,
  'arr' => [1, 'two', [3.5]],
  'sub' => { 'x' => { 'y' => 1 } },
  'emptyDoc' => {},
  'emptyArr' => [],
  'scope' => BSON::CodeWithScope.new('x + y', { 'y' => 2 }),
  'undef' => BSON::Undefined.new,
  'sym' => BSON::Symbol::Raw.new('sym'),
  'ptr' => BSON::DbPointer.new('db.coll', BSON::ObjectId.from_string('6542f1a2b3c4d5e6f7a8b9c0'))
}

cursor = collection.find(filter)
cursor.each do |doc|
  puts doc
end
`,
}

function goldens(name: string, op: Operation, expected: Record<CodeLanguage, string>): void {
  describe(`golden: ${name}`, () => {
    for (const { value } of CODE_LANGUAGES) {
      test(value, () => {
        assert.equal(generateCode(op, value), expected[value])
      })
    }
  })
}

goldens('find with every option', FIND, FIND_CODE)
goldens('aggregate', AGGREGATE, AGGREGATE_CODE)
goldens('type zoo', ZOO, ZOO_CODE)

describe('languages', () => {
  test('the list and labels', () => {
    assert.deepEqual(
      CODE_LANGUAGES.map((l) => l.label),
      ['mongosh', 'Node.js', 'Python', 'Java', 'C#', 'PHP', 'Ruby']
    )
  })

  test('mongosh is the shell statement', () => {
    for (const op of [FIND, AGGREGATE, ZOO]) assert.equal(generateCode(op, 'mongosh'), operationToShell(op))
  })
})

/** One field holding a string with quotes, backslashes, controls, non-ASCII and interpolation. */
const TRICKY = 'q\' " \\ \n \t \u0001 é😀 \u2028 $x #{y}'

describe('string escaping', () => {
  const op: Operation = { kind: 'find', db: "it's", collection: 'a"b\\c', filter: { s: TRICKY } }
  const expected: Record<Exclude<CodeLanguage, 'mongosh'>, string[]> = {
    node: [String.raw`client.db('it\'s').collection('a"b\\c')`, String.raw`{ s: 'q\' " \\ \n \t \u0001 é😀 \u2028 $x #{y}' }`],
    python: [String.raw`client["it's"]["a\"b\\c"]`, String.raw`{"s": "q' \" \\ \n \t \x01 é😀 \u2028 $x #{y}"}`],
    // Octal for controls (a \u000a escape would end the line), \u for everything past ASCII.
    java: [String.raw`getDatabase("it's").getCollection("a\"b\\c")`, String.raw`.append("s", "q' \" \\ \n \t \001 \u00e9\ud83d\ude00 \u2028 $x #{y}")`],
    csharp: [String.raw`GetDatabase("it's").GetCollection<BsonDocument>("a\"b\\c")`, String.raw`new BsonDocument("s", "q' \" \\ \n \t \u0001 é😀 \u2028 $x #{y}")`],
    // Single quotes unless an escape is needed; then $ is escaped, and \u{} gives UTF-8.
    php: [String.raw`selectCollection('it\'s', 'a"b\\c')`, String.raw`['s' => "q' \" \\ \n \t \x01 é😀 \u{2028} \$x #{y}"]`],
    ruby: [String.raw`database: 'it\'s'`, String.raw`client['a"b\\c']`, String.raw`{ 's' => "q' \" \\ \n \t \u0001 é😀 \u2028 $x \#{y}" }`]
  }
  for (const [lang, parts] of Object.entries(expected)) {
    test(lang, () => {
      const code = generateCode(op, lang as CodeLanguage)
      for (const part of parts) assert.ok(code.includes(part), `missing ${part} in:\n${code}`)
    })
  }

  test('plain strings stay in single quotes in PHP and Ruby', () => {
    const plain: Operation = { kind: 'find', db: 'd', collection: 'c', filter: { s: "it's \\ fine" } }
    assert.ok(generateCode(plain, 'php').includes(String.raw`$filter = ['s' => 'it\'s \\ fine'];`))
    assert.ok(generateCode(plain, 'ruby').includes(String.raw`filter = { 's' => 'it\'s \\ fine' }`))
  })
})

describe('key quoting', () => {
  // JSON.parse, so `__proto__` is an own field as it is in data from the worker.
  const filter = JSON.parse('{"a b":1,"it\'s":2,"back\\\\slash":3,"$gt":4,"dot.ted":5,"__proto__":6,"é":7}') as JsonObject
  const op: Operation = { kind: 'find', db: 'd', collection: 'c', filter }
  const expected: Record<Exclude<CodeLanguage, 'mongosh'>, string> = {
    // `__proto__: 6` would set the prototype, so it is a computed key.
    node: String.raw`    const filter = {
      'a b': 1,
      'it\'s': 2,
      'back\\slash': 3,
      $gt: 4,
      'dot.ted': 5,
      ['__proto__']: 6,
      'é': 7
    };`,
    python: String.raw`query = {
    "a b": 1,
    "it's": 2,
    "back\\slash": 3,
    "$gt": 4,
    "dot.ted": 5,
    "__proto__": 6,
    "é": 7,
}`,
    java: String.raw`            Document filter = new Document()
                .append("a b", 1)
                .append("it's", 2)
                .append("back\\slash", 3)
                .append("$gt", 4)
                .append("dot.ted", 5)
                .append("__proto__", 6)
                .append("\u00e9", 7);`,
    csharp: String.raw`var filter = new BsonDocument
{
    { "a b", 1 },
    { "it's", 2 },
    { "back\\slash", 3 },
    { "$gt", 4 },
    { "dot.ted", 5 },
    { "__proto__", 6 },
    { "é", 7 }
};`,
    php: String.raw`$filter = [
    'a b' => 1,
    'it\'s' => 2,
    'back\\slash' => 3,
    '$gt' => 4,
    'dot.ted' => 5,
    '__proto__' => 6,
    'é' => 7,
];`,
    ruby: String.raw`filter = {
  'a b' => 1,
  'it\'s' => 2,
  'back\\slash' => 3,
  '$gt' => 4,
  'dot.ted' => 5,
  '__proto__' => 6,
  'é' => 7
}`
  }
  for (const [lang, block] of Object.entries(expected)) {
    test(lang, () => {
      const code = generateCode(op, lang as CodeLanguage)
      assert.ok(code.includes(block), `missing\n${block}\nin:\n${code}`)
    })
  }

})

describe('type pitfalls', () => {
  const one = (filter: JsonObject, lang: CodeLanguage): string => generateCode({ kind: 'find', db: 'd', collection: 'c', filter }, lang)

  test('Node.js wraps whole-number doubles, which would otherwise be stored as Int32', () => {
    const code = one(f('{ a: 3.0, b: -0.0, c: 2.5, d: 3 }'), 'node')
    assert.ok(code.includes('const filter = { a: new Double(3.0), b: new Double(-0.0), c: 2.5, d: 3 };'))
    assert.ok(code.startsWith("const { Double, MongoClient } = require('mongodb');"))
  })

  test('PHP: documents that look like lists are cast to objects, Int64 is built from a string', () => {
    const code = one(f("{ a: {}, b: { '0': 'x', '1': 'y' }, c: { '1': 'x' }, d: [], e: NumberLong('-9223372036854775808') }"), 'php')
    assert.ok(code.includes("'a' => (object) [],"))
    assert.ok(code.includes("'b' => (object) ['0' => 'x', '1' => 'y'],"))
    assert.ok(code.includes("'c' => ['1' => 'x'],"))
    assert.ok(code.includes("'d' => [],"))
    assert.ok(code.includes("'e' => new Int64('-9223372036854775808'),"))
  })

  test('PHP takes the timestamp increment first, so the arguments are named', () => {
    assert.ok(one(f('{ ts: Timestamp({ t: 5, i: 9 }) }'), 'php').includes("$filter = ['ts' => new Timestamp(increment: 9, timestamp: 5)];"))
  })

  test('Java: a lone null in a list, and timestamps past the int range', () => {
    const code = one({ a: [null], ts: { $timestamp: { t: 4294967295, i: 1 } } }, 'java')
    assert.ok(code.includes('.append("a", Arrays.asList((Object) null))'))
    assert.ok(code.includes('.append("ts", new BsonTimestamp(-4294967295L))'))
    assert.ok(code.includes('import java.util.Arrays;'))
  })

  test('C#: timestamps past the int range use the 64-bit value', () => {
    assert.ok(one({ ts: { $timestamp: { t: 4294967295, i: 1 } } }, 'csharp').includes('new BsonDocument("ts", new BsonTimestamp(-4294967295L))'))
  })

  test('dates outside years 1 to 9999 use milliseconds', () => {
    const filter = { d: { $date: { $numberLong: '253402300800000' } } }
    assert.ok(one(filter, 'node').includes('{ d: new Date(253402300800000) }'))
    assert.ok(one(filter, 'python').includes('{"d": DatetimeMS(253402300800000)}'))
    assert.ok(one(filter, 'python').includes('from bson.datetime_ms import DatetimeMS'))
    assert.ok(one(filter, 'java').includes('new Document("d", new Date(253402300800000L))'))
    assert.ok(one(filter, 'csharp').includes('new BsonDocument("d", new BsonDateTime(253402300800000))'))
    assert.ok(one(filter, 'php').includes("['d' => new UTCDateTime(253402300800000)]"))
    assert.ok(one(filter, 'ruby').includes("{ 'd' => Time.utc(10000, 1, 1, 0, 0, 0) }"))
  })

  test('binary subtypes without a name, and UUID subtype data that is not 16 bytes', () => {
    const filter = { a: { $binary: { base64: 'AAEC', subType: '85' } }, b: { $binary: { base64: 'AAEC', subType: '04' } } }
    assert.ok(one(filter, 'java').includes('new Binary((byte) 0x85, Base64.getDecoder().decode("AAEC"))'))
    assert.ok(one(filter, 'java').includes('new Binary(BsonBinarySubType.UUID_STANDARD, Base64.getDecoder().decode("AAEC"))'))
    assert.ok(one(filter, 'csharp').includes('(BsonBinarySubType)0x85'))
    assert.ok(one(filter, 'python').includes('"b": Binary(b64decode("AAEC"), 4)'))
    assert.ok(one(filter, 'ruby').includes("BSON::Binary.new('AAEC'.unpack1('m'), 0x85)"))
    assert.ok(one(filter, 'php').includes("new Binary(base64_decode('AAEC'), 133)"))
    assert.ok(one(filter, 'node').includes("b: Binary.createFromBase64('AAEC', 4)"))
  })

  test('decimal special values keep their text', () => {
    const filter = { a: { $numberDecimal: 'NaN' }, b: { $numberDecimal: '-0' }, c: { $numberDecimal: '1.50' } }
    assert.ok(one(filter, 'java').includes('Decimal128.parse("NaN")'))
    assert.ok(one(filter, 'java').includes('Decimal128.parse("-0")'))
    assert.ok(one(filter, 'csharp').includes('Decimal128.Parse("1.50")'))
    assert.ok(one(filter, 'python').includes('Decimal128("-0")'))
  })
})

describe('find options', () => {
  test('empty and zero options are left out', () => {
    const op: Operation = { kind: 'find', db: 'd', collection: 'c', filter: {}, projection: {}, sort: {}, collation: {}, skip: 0, limit: 0 }
    assert.ok(generateCode(op, 'node').includes('const cursor = collection.find(filter);'))
    assert.ok(generateCode(op, 'python').includes('query = {}\n\ncursor = collection.find(query)\n'))
    assert.ok(generateCode(op, 'java').includes('Document filter = new Document();\n            FindIterable<Document> results = collection.find(filter);'))
    assert.ok(generateCode(op, 'csharp').includes('var filter = new BsonDocument();\n\nvar results = collection.Find(filter);'))
    assert.ok(generateCode(op, 'php').includes('$filter = [];\n\n$cursor = $collection->find($filter);'))
    assert.ok(generateCode(op, 'ruby').includes('filter = {}\n\ncursor = collection.find(filter)'))
  })

  test('a full collation becomes typed builder calls in Java and C#', () => {
    const op: Operation = {
      kind: 'find',
      db: 'd',
      collection: 'c',
      filter: {},
      collation: f("{ locale: 'fr', caseLevel: true, caseFirst: 'upper', strength: 3, numericOrdering: true, alternate: 'shifted', maxVariable: 'punct', normalization: false, backwards: true }")
    }
    assert.ok(
      generateCode(op, 'java').includes(`                .collation(Collation.builder()
                    .locale("fr")
                    .caseLevel(true)
                    .collationCaseFirst(CollationCaseFirst.UPPER)
                    .collationStrength(CollationStrength.TERTIARY)
                    .numericOrdering(true)
                    .collationAlternate(CollationAlternate.SHIFTED)
                    .collationMaxVariable(CollationMaxVariable.PUNCT)
                    .normalization(false)
                    .backwards(true)
                    .build());`)
    )
    assert.ok(
      generateCode(op, 'csharp').includes(`var options = new FindOptions
{
    Collation = new Collation(
        "fr",
        caseLevel: true,
        caseFirst: CollationCaseFirst.Upper,
        strength: CollationStrength.Tertiary,
        numericOrdering: true,
        alternate: CollationAlternate.Shifted,
        maxVariable: CollationMaxVariable.Punctuation,
        normalization: false,
        backwards: true)
};
var results = collection.Find(filter, options);`)
    )
  })

  test('an unknown collation option is left out with a note', () => {
    const op: Operation = { kind: 'find', db: 'd', collection: 'c', filter: {}, collation: f("{ locale: 'en', strength: 9, bogus: 1 }") }
    const java = generateCode(op, 'java')
    assert.ok(java.includes('// Note: collation.bogus: this collation option is not supported here and was left out'))
    assert.ok(java.includes('// Note: collation.strength: the value 9 is not a known option and was left out'))
    assert.ok(generateCode(op, 'csharp').includes('Collation = new Collation("en")'))
  })

  test('an empty pipeline', () => {
    const op: Operation = { kind: 'aggregate', db: 'd', collection: 'c', pipeline: [] }
    assert.ok(generateCode(op, 'csharp').includes('var pipeline = Array.Empty<BsonDocument>();'))
    assert.ok(generateCode(op, 'java').includes('List<Document> pipeline = Arrays.asList();'))
    assert.ok(generateCode(op, 'python').includes('pipeline = []'))
  })
})
