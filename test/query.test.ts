import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeQuery } from "../src/index.js";
import type {
  AggregateFunction,
  ColumnRef,
  Expr,
  InputTable,
  PlanNode,
  QueryRequest,
} from "../src/index.js";

function table(
  name: string,
  columns: Array<[string, "string" | "number" | "boolean"]>,
  rows: Array<[string, Record<string, unknown>]>,
): InputTable {
  return {
    schema: {
      name,
      columns: columns.map(([column, type]) => ({ name: column, type })),
    },
    rows: rows.map(([id, values]) => ({ id, values: values as never })),
  };
}

function scan(name: string, as?: string): PlanNode {
  return as === undefined ? { kind: "scan", table: name } : { kind: "scan", table: name, as };
}

function filter(input: PlanNode, predicate: Expr): PlanNode {
  return { kind: "filter", input, predicate };
}

function join(left: PlanNode, right: PlanNode, l: ColumnRef, r: ColumnRef): PlanNode {
  return { kind: "join", left, right, on: { left: l, right: r } };
}

function project(
  input: PlanNode,
  columns: Array<[Expr, string]>,
): PlanNode {
  return {
    kind: "project",
    input,
    columns: columns.map(([expr, as]) => ({ expr, as })),
  };
}

function aggregate(
  input: PlanNode,
  aggregates: Array<[AggregateFunction, ColumnRef | null | undefined, string]>,
  groupBy: Array<[ColumnRef, string?]> = [],
): PlanNode {
  return {
    kind: "groupAggregate",
    input,
    groupBy: groupBy.map(([column, as]) =>
      as === undefined ? { column } : { column, as },
    ),
    aggregates: aggregates.map(([fn, column, as]) =>
      column === undefined ? { fn, as } : { fn, column, as },
    ),
  };
}

const col = (name: string, tableName?: string): Expr => ({
  kind: "column",
  column: tableName === undefined ? { name } : { name, table: tableName },
});
const eq = (left: Expr, right: Expr): Expr => ({ kind: "eq", left, right });
const and = (...values: Expr[]): Expr => ({ kind: "and", values });
const or = (...values: Expr[]): Expr => ({ kind: "or", values });
const not = (value: Expr): Expr => ({ kind: "not", value });
const isNull = (value: Expr): Expr => ({ kind: "isNull", value });
const literal = (value: string | number | boolean | null): Expr => ({
  kind: "literal",
  value,
});

describe("three-valued logic", () => {
  it("checks every Kleene AND/OR/NOT truth-table combination", () => {
    const values: Array<boolean | null> = [true, false, null];
    const andExpected: Array<Array<boolean | null>> = [
      [true, false, null],
      [false, false, false],
      [null, false, null],
    ];
    const orExpected: Array<Array<boolean | null>> = [
      [true, true, true],
      [true, false, null],
      [true, null, null],
    ];

    for (let i = 0; i < values.length; i += 1) {
      for (let j = 0; j < values.length; j += 1) {
        const rows = [
          table(
            "flags",
            [
              ["id", "string"],
              ["a", "boolean"],
              ["b", "boolean"],
            ],
            [[`r${i}-${j}`, { id: `r${i}-${j}`, a: values[i], b: values[j] }]],
          ),
        ];
        const andResult = executeQuery({
          tables: rows,
          plan: project(filter(scan("flags"), and(col("a"), col("b"))), [
            [col("id"), "id"],
          ]),
        });
        assert.equal(andResult.rows.length, andExpected[i]![j] === true ? 1 : 0);

        const orResult = executeQuery({
          tables: rows,
          plan: project(filter(scan("flags"), or(col("a"), col("b"))), [
            [col("id"), "id"],
          ]),
        });
        assert.equal(orResult.rows.length, orExpected[i]![j] === true ? 1 : 0);

        const notResult = executeQuery({
          tables: rows,
          plan: project(filter(scan("flags"), not(col("a"))), [
            [col("id"), "id"],
          ]),
        });
        const notExpected: Array<boolean | null> = [false, true, null];
        assert.equal(notResult.rows.length, notExpected[i] === true ? 1 : 0);
      }
    }
  });

  it("treats equality involving NULL as unknown, including NULL = NULL", () => {
    const values: Scalar[] = [1, null];
    for (const left of values) {
      for (const right of values) {
        const t = table(
          "nums",
          [
            ["id", "string"],
            ["a", "number"],
            ["b", "number"],
          ],
          [["r1", { id: "r1", a: left, b: right }]],
        );
        const result = executeQuery({
          tables: [t],
          plan: project(filter(scan("nums"), eq(col("a"), col("b"))), [
            [col("id"), "id"],
          ]),
        });
        assert.deepEqual(result.rows.map((row) => row.values.id), left === 1 && right === 1 ? ["r1"] : []);
      }
    }
  });
});

type Scalar = string | number | boolean | null;

describe("nested-loop equi-join and bag semantics", () => {
  it("emits one output row for every pair found by the nested-loop order", () => {
    const departments = table(
      "dept",
      [
        ["dept_id", "string"],
        ["name", "string"],
      ],
      [
        ["d1", { dept_id: "A", name: "Alpha" }],
        ["d2", { dept_id: "A", name: "Alpha duplicate" }],
        ["d3", { dept_id: "B", name: "Beta" }],
        ["d4", { dept_id: null, name: "No dept" }],
      ],
    );
    const employees = table(
      "emp",
      [
        ["emp_id", "string"],
        ["dept_id", "string"],
      ],
      [
        ["e1", { emp_id: "one", dept_id: "A" }],
        ["e2", { emp_id: "two", dept_id: "A" }],
        ["e3", { emp_id: "three", dept_id: "B" }],
        ["e4", { emp_id: "four", dept_id: null }],
      ],
    );

    const result = executeQuery({
      tables: [departments, employees],
      plan: project(
        join(
          scan("dept"),
          scan("emp"),
          { name: "dept_id", table: "dept" },
          { name: "dept_id", table: "emp" },
        ),
        [
          [col("emp_id", "emp"), "emp_id"],
          [col("name", "dept"), "dept_name"],
        ],
      ),
    });

    assert.deepEqual(
      result.rows.map((row) => [row.values.emp_id, row.values.dept_name]),
      [
        ["one", "Alpha"],
        ["two", "Alpha"],
        ["one", "Alpha duplicate"],
        ["two", "Alpha duplicate"],
        ["three", "Beta"],
      ],
    );
    assert.deepEqual(
      result.rows.map((row) => row.sourceRowIds),
      [
        ["d1", "e1"],
        ["d1", "e2"],
        ["d2", "e1"],
        ["d2", "e2"],
        ["d3", "e3"],
      ],
    );
  });

  it("retains duplicates through filters and projections", () => {
    const t = table(
      "vals",
      [
        ["id", "string"],
        ["v", "number"],
      ],
      [
        ["a", { id: "a", v: 1 }],
        ["b", { id: "b", v: 1 }],
        ["c", { id: "c", v: 2 }],
      ],
    );
    const result = executeQuery({
      tables: [t],
      plan: project(filter(scan("vals"), eq(col("v"), literal(1))), [
        [col("v"), "v"],
      ]),
    });
    assert.deepEqual(result.rows.map((row) => row.values.v), [1, 1]);
    assert.deepEqual(result.rows.map((row) => row.sourceRowIds), [["a"], ["b"]]);
  });
});

describe("grouping and aggregates", () => {
  it("groups all NULL values together and ignores NULL arguments", () => {
    const t = table(
      "events",
      [
        ["id", "string"],
        ["group_name", "string"],
        ["score", "number"],
      ],
      [
        ["e1", { id: "e1", group_name: "x", score: 10 }],
        ["e2", { id: "e2", group_name: "x", score: null }],
        ["e3", { id: "e3", group_name: "y", score: 5 }],
        ["e4", { id: "e4", group_name: null, score: 7 }],
        ["e5", { id: "e5", group_name: null, score: 8 }],
        ["e6", { id: "e6", group_name: null, score: null }],
      ],
    );

    const result = executeQuery({
      tables: [t],
      plan: aggregate(
        scan("events"),
        [
          ["COUNT", null, "row_count"],
          ["COUNT", { name: "score" }, "score_count"],
          ["SUM", { name: "score" }, "score_sum"],
        ],
        [[{ name: "group_name" }, "group_name"]],
      ),
    });

    assert.deepEqual(result.rows.map((row) => row.values), [
      { group_name: "x", row_count: 2, score_count: 1, score_sum: 10 },
      { group_name: "y", row_count: 1, score_count: 1, score_sum: 5 },
      { group_name: null, row_count: 3, score_count: 2, score_sum: 15 },
    ]);
    assert.deepEqual(result.rows.map((row) => row.sourceRowIds), [
      ["e1", "e2"],
      ["e3"],
      ["e4", "e5", "e6"],
    ]);
  });

  it("returns one row for an empty aggregate with COUNT(*) 0 and SUM NULL", () => {
    const t = table("nums", [["id", "string"], ["n", "number"]], []);
    const result = executeQuery({
      tables: [t],
      plan: aggregate(filter(scan("nums"), eq(col("n"), literal(1))), [
        ["COUNT", null, "cnt"],
        ["SUM", { name: "n" }, "total"],
      ]),
    });
    assert.deepEqual(result.rows, [
      {
        values: { cnt: 0, total: null },
        sourceRowIds: [],
      },
    ]);
  });

  it("keeps joined pair evidence for duplicate matching and aggregate groups", () => {
    const left = table(
      "l",
      [
        ["id", "string"],
        ["key", "string"],
        ["amount", "number"],
      ],
      [
        ["l1", { id: "l1", key: "k", amount: 2 }],
        ["l2", { id: "l2", key: "k", amount: 3 }],
      ],
    );
    const right = table(
      "r",
      [
        ["id", "string"],
        ["key", "string"],
      ],
      [
        ["r1", { id: "r1", key: "k" }],
        ["r2", { id: "r2", key: "k" }],
      ],
    );
    const result = executeQuery({
      tables: [left, right],
      plan: aggregate(
        join(
          scan("l"),
          scan("r"),
          { name: "key", table: "l" },
          { name: "key", table: "r" },
        ),
        [
          ["COUNT", null, "cnt"],
          ["SUM", { name: "amount", table: "l" }, "total"],
        ],
      ),
    });
    assert.deepEqual(result.rows, [
      {
        values: { cnt: 4, total: 10 },
        sourceRowIds: ["l1", "r1", "l1", "r2", "l2", "r1", "l2", "r2"],
      },
    ]);
  });
});

describe("validation before execution", () => {
  it("rejects type mismatches and missing columns", () => {
    const valid = table("t", [["id", "string"], ["n", "number"]], [
      ["x", { id: "x", n: 1 }],
    ]);

    const badType: QueryRequest = {
      tables: [table("t", [["id", "string"], ["n", "number"]], [
        ["x", { id: "x", n: "not-a-number" }],
      ])],
      plan: project(scan("t"), [[col("n"), "n"]]),
    };
    assert.throws(() => executeQuery(badType), /must be a number or null/);

    const missingColumn: QueryRequest = {
      tables: [valid],
      plan: filter(scan("t"), eq(col("missing"), literal(1))),
    };
    assert.throws(() => executeQuery(missingColumn), /unknown column/);

    const mismatchedComparison: QueryRequest = {
      tables: [valid],
      plan: filter(scan("t"), eq(col("n"), literal("x"))),
    };
    assert.throws(() => executeQuery(mismatchedComparison), /matching types/);
  });

  it("rejects more than 300 rows in a table and duplicate source IDs", () => {
    const rows = Array.from({ length: 301 }, (_unused, index) => [
      `r${index}`,
      { id: `r${index}`, n: index },
    ]) as Array<[string, Record<string, unknown>]>;
    assert.throws(
      () =>
        executeQuery({
          tables: [table("t", [["id", "string"], ["n", "number"]], rows)],
          plan: project(scan("t"), [[col("id"), "id"]]),
        }),
      /at most 300 rows/,
    );

    assert.throws(
      () =>
        executeQuery({
          tables: [
            table("a", [["id", "string"]], [["same", { id: "same" }]]),
            table("b", [["id", "string"]], [["same", { id: "same" }]]),
          ],
          plan: join(scan("a"), scan("b"), { name: "id", table: "a" }, { name: "id", table: "b" }),
        }),
      /Duplicate source row id/,
    );
  });

  it("requires NULL checks rather than joining NULL keys", () => {
    const t = table("t", [["id", "string"]], [["x", { id: null }]]);
    const joined = executeQuery({
      tables: [t],
      plan: project(
        join(
          scan("t", "left_t"),
          scan("t", "right_t"),
          { name: "id", table: "left_t" },
          { name: "id", table: "right_t" },
        ),
        [
          [col("id", "left_t"), "left_id"],
          [col("id", "right_t"), "right_id"],
        ],
      ),
    });
    assert.equal(joined.rows.length, 0);

    const nulls = executeQuery({
      tables: [t],
      plan: filter(scan("t"), isNull(col("id"))),
    });
    assert.deepEqual(nulls.rows.map((row) => row.sourceRowIds), [["x"]]);
  });
});
