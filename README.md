# Structured Query Service

A small TypeScript/Node service that executes a typed relational query plan. It deliberately does **not** parse SQL text. Plans are JSON-compatible objects built from:

- table scans
- three-valued `WHERE` filters
- one inner equi-join
- projection
- grouping and aggregate calculation

The engine preserves SQL bag semantics: duplicate input rows and duplicate join matches are retained.

## Requirements

- Node.js 20+
- npm 10+

## Install, test, and run

```bash
npm install
npm test
npm start
```

The HTTP server defaults to port `3000`; override it with `PORT`.

```bash
PORT=8080 npm start
```

## HTTP API

### `POST /query`

Send a `QueryRequest` as JSON. Validation is completed before any execution node runs, so malformed requests return `400 { "error": "..." }` without partial results.

```bash
curl -s http://localhost:3000/query \
  -H 'content-type: application/json' \
  -d '{
    "tables": [
      {
        "schema": {
          "name": "orders",
          "columns": [
            { "name": "id", "type": "string" },
            { "name": "customer_id", "type": "string" },
            { "name": "amount", "type": "number" }
          ]
        },
        "rows": [
          { "id": "o1", "values": { "id": "o1", "customer_id": "c1", "amount": 10 } },
          { "id": "o2", "values": { "id": "o2", "customer_id": "c1", "amount": 15 } },
          { "id": "o3", "values": { "id": "o3", "customer_id": null, "amount": 20 } }
        ]
      }
    ],
    "plan": {
      "kind": "groupAggregate",
      "input": { "kind": "scan", "table": "orders" },
      "groupBy": [{ "column": { "name": "customer_id" } }],
      "aggregates": [
        { "fn": "COUNT", "column": null, "as": "order_count" },
        { "fn": "SUM", "column": { "name": "amount" }, "as": "total_amount" }
      ]
    }
  }'
```

## Library usage

```ts
import { executeQuery } from "./src/index.js";

const result = executeQuery({
  tables: [
    // up to two tables, at most 300 rows each
  ],
  plan: {
    // typed plan nodes
  },
});
```

## Request shape

### Types

Column types are `"string"`, `"number"`, or `"boolean"`. Cell values are JSON values matching that type, or `null`. Number literals must be finite; `NaN` and `Infinity` are rejected.

### Source rows

Every source row has:

```json
{
  "id": "globally-unique-string-id",
  "values": { "columnName": "typed value or null" }
}
```

Source row IDs must be globally unique across both request tables.

Each result row contains a `sourceRowIds` array:

- scan/filter/project rows contain the source row IDs that produced that row
- a join result contains the left and right IDs for that matched pair
- an aggregate group contains all IDs in that group

If a source row joins multiple times, its ID appears once for each participating join pair. Thus source evidence itself follows bag semantics and preserves multiplicity.

## Plan nodes

### Scan

```json
{ "kind": "scan", "table": "orders" }
```

A self-join scans one physical table twice. Both scans require distinct aliases:

```json
{ "kind": "scan", "table": "people", "as": "manager" }
```

### Filter

Filter predicates use Kleene three-valued logic. Only `true` passes; `false` and `null` are removed.

```json
{
  "kind": "filter",
  "input": { "kind": "scan", "table": "orders" },
  "predicate": {
    "kind": "and",
    "values": [
      { "kind": "eq", "left": { "kind": "column", "column": { "name": "status" } }, "right": { "kind": "literal", "value": "paid" } },
      { "kind": "not", "value": { "kind": "isNull", "value": { "kind": "column", "column": { "name": "amount" } } } }
    ]
  }
}
```

Equality is strict and type checked. Equality involving `null` evaluates to unknown, including `NULL = NULL`; therefore null keys never join.

Supported boolean/expression forms are:

- `{ "kind": "literal", "value": ... }`
- `{ "kind": "column", "column": { "name": "x", "table": "optional" } }`
- `{ "kind": "eq", "left": ..., "right": ... }`
- `{ "kind": "isNull", "value": ... }`
- `{ "kind": "not", "value": ... }`
- `{ "kind": "and", "values": [...] }`
- `{ "kind": "or", "values": [...] }`

### Equi-join

The join is an explicit nested-loop inner equi-join. For each left row in left order, it visits each right row in right order. That order determines output row order.

```json
{
  "kind": "join",
  "left": { "kind": "scan", "table": "customers" },
  "right": { "kind": "scan", "table": "orders" },
  "on": {
    "left": { "name": "id", "table": "customers" },
    "right": { "name": "customer_id", "table": "orders" }
  }
}
```

When unqualified names are ambiguous after a join, column references must include `table` (or a scan alias). A final projection is required to rename duplicated join output columns to distinct result names.

### Projection

```json
{
  "kind": "project",
  "input": { "kind": "scan", "table": "orders" },
  "columns": [
    { "expr": { "kind": "column", "column": { "name": "amount" } }, "as": "amount" }
  ]
}
```

### Grouping and aggregation

All `null` values in a `GROUP BY` column form one group. Groups are ordered by first appearance in the input row order.

```json
{
  "kind": "groupAggregate",
  "input": { "kind": "scan", "table": "orders" },
  "groupBy": [{ "column": { "name": "customer_id" }, "as": "customer_id" }],
  "aggregates": [
    { "fn": "COUNT", "column": null, "as": "row_count" },
    { "fn": "COUNT", "column": { "name": "amount" }, "as": "non_null_amounts" },
    { "fn": "SUM", "column": { "name": "amount" }, "as": "total_amount" }
  ]
}
```

Rules:

- `COUNT(*)` is represented by `COUNT` with `column: null` and counts every row.
- `COUNT(column)` counts rows where that column is not `null`.
- `SUM(column)` ignores `null`.
- `SUM` over an empty aggregate or an all-NULL group returns `null`.
- An aggregate without `groupBy` returns exactly one row, even for an empty input.

## Validation guarantees

Before execution, the service checks:

- request and node structure, rejecting unknown fields
- table and column names
- column types and every source row value
- source row ID uniqueness
- at most two tables, 300 rows per table, two scans, one join, and one aggregate node
- references to existing, unambiguous columns
- predicate and equality types
- join key type compatibility
- numeric `SUM` arguments
- distinct result column names

No query execution begins until all these checks have passed.

## Ordering guarantees

- scans preserve source row order
- filters preserve their input order
- joins use left-row then right-row nested-loop order
- projections preserve their input order
- grouped rows are ordered by each key's first input appearance
