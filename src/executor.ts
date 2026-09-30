import { QueryPlanError } from "./errors.js";
import type { Field } from "./fields.js";
import { qualifiedKey } from "./fields.js";
import type {
  Expr,
  ExecRow,
  InputTable,
  PlanNode,
  QueryResult,
  Scalar,
  Trilean,
} from "./types.js";
import type { ValidatedQueryRequest } from "./validate.js";
import { inferFields } from "./validate.js";

function getScalar(row: ExecRow, key: string): Scalar {
  const value = row.values[key];
  return value === undefined ? null : value;
}

interface AggregateGroup {
  output: Record<string, Scalar>;
  sourceRowIds: string[];
  counts: number[];
  sums: Array<number | null>;
}

function scanFields(table: InputTable, alias = table.schema.name): Field[] {
  return table.schema.columns.map((column) => ({
    key: qualifiedKey(alias, column.name),
    name: column.name,
    table: alias,
    type: column.type,
  }));
}

function joinFields(left: readonly Field[], right: readonly Field[]): Field[] {
  return [...left, ...right];
}

function resolveField(
  fields: readonly Field[],
  reference: { name: string; table?: string },
): Field {
  const matches =
    reference.table === undefined
      ? fields.filter((field) => field.name === reference.name)
      : fields.filter(
          (field) => field.table === reference.table && field.name === reference.name,
        );

  if (matches.length !== 1) {
    throw new QueryPlanError(
      `Validated query contains invalid column "${reference.name}"`,
    );
  }
  return matches[0]!;
}

function evalExpression(expression: Expr, row: ExecRow, fields: readonly Field[]): Scalar {
  switch (expression.kind) {
    case "literal":
      return expression.value;

    case "column": {
      const field = resolveField(fields, expression.column);
      return row.values[field.key] ?? null;
    }

    case "isNull":
      return evalExpression(expression.value, row, fields) === null;

    case "not":
      return kleeneNot(truthValue(evalExpression(expression.value, row, fields)));

    case "and":
      return kleeneAnd(
        expression.values.map((operand) =>
          truthValue(evalExpression(operand, row, fields)),
        ),
      );

    case "or":
      return kleeneOr(
        expression.values.map((operand) =>
          truthValue(evalExpression(operand, row, fields)),
        ),
      );

    case "eq":
      return strictEquality(
        evalExpression(expression.left, row, fields),
        evalExpression(expression.right, row, fields),
      );
  }
}

function truthValue(value: Scalar): Trilean {
  if (value === null) return null;
  return value === true;
}

function strictEquality(left: Scalar, right: Scalar): Trilean {
  if (left === null || right === null) return null;
  if (typeof left !== typeof right) return null;
  return left === right;
}

function kleeneNot(value: Trilean): Trilean {
  if (value === null) return null;
  return !value;
}

function kleeneAnd(values: readonly Trilean[]): Trilean {
  let hasUnknown = false;
  for (const value of values) {
    if (value === false) return false;
    if (value === null) hasUnknown = true;
  }
  return hasUnknown ? null : true;
}

function kleeneOr(values: readonly Trilean[]): Trilean {
  let hasUnknown = false;
  for (const value of values) {
    if (value === true) return true;
    if (value === null) hasUnknown = true;
  }
  return hasUnknown ? null : false;
}

interface ExecutedNode {
  rows: ExecRow[];
  fields: Field[];
}

function executeNode(
  node: PlanNode,
  tables: ReadonlyMap<string, InputTable>,
): ExecutedNode {
  switch (node.kind) {
    case "scan": {
      const table = tables.get(node.table);
      if (!table) throw new QueryPlanError(`Unknown table "${node.table}"`);
      const fields = scanFields(table, node.as ?? node.table);
      const rows: ExecRow[] = table.rows.map((sourceRow) => {
        const values: Record<string, Scalar> = {};
        for (const field of fields) {
          values[field.key] = sourceRow.values[field.name] ?? null;
        }
        return { values, sourceRowIds: [sourceRow.id] };
      });
      return { rows, fields };
    }

    case "filter": {
      const input = executeNode(node.input, tables);
      const rows = input.rows.filter(
        (row) => truthValue(evalExpression(node.predicate, row, input.fields)) === true,
      );
      return { rows, fields: input.fields };
    }

    case "join": {
      const left = executeNode(node.left, tables);
      const right = executeNode(node.right, tables);
      const leftKeyField = resolveField(left.fields, node.on.left);
      const rightKeyField = resolveField(right.fields, node.on.right);
      const fields = joinFields(left.fields, right.fields);
      const rows: ExecRow[] = [];

      // Explicit nested-loop order: input row order is stable and observable.
      for (const leftRow of left.rows) {
        const leftValue = getScalar(leftRow, leftKeyField.key);
        for (const rightRow of right.rows) {
          const rightValue = getScalar(rightRow, rightKeyField.key);
          if (strictEquality(leftValue, rightValue) !== true) continue;

          rows.push({
            values: { ...leftRow.values, ...rightRow.values },
            sourceRowIds: [...leftRow.sourceRowIds, ...rightRow.sourceRowIds],
          });
        }
      }

      return { rows, fields };
    }

    case "project": {
      const input = executeNode(node.input, tables);
      const fields = inferFields(node, tables);
      const rows = input.rows.map((row) => {
        const values: Record<string, Scalar> = {};
        for (const column of node.columns) {
          values[column.as] = evalExpression(column.expr, row, input.fields);
        }
        return { values, sourceRowIds: [...row.sourceRowIds] };
      });
      return { rows, fields };
    }

    case "groupAggregate":
      return executeGroupAggregate(node, tables);
  }
}

function groupKeyValue(value: Scalar): string {
  if (value === null) return JSON.stringify({ type: "null" });
  return JSON.stringify({ type: typeof value, value });
}

function executeGroupAggregate(
  node: Extract<PlanNode, { kind: "groupAggregate" }>,
  tables: ReadonlyMap<string, InputTable>,
): ExecutedNode {
  const input = executeNode(node.input, tables);

  const groupFields = node.groupBy.map((group) => {
    const source = resolveField(input.fields, group.column);
    const alias = group.as ?? source.name;
    return { source, alias };
  });
  const aggregateFields = node.aggregates.map((aggregate, index) => {
    const field =
      aggregate.column === null || aggregate.column === undefined
        ? undefined
        : resolveField(input.fields, aggregate.column);
    return {
      index,
      fn: aggregate.fn,
      field,
      alias: aggregate.as,
      countsAll: aggregate.fn === "COUNT" && field === undefined,
    };
  });

  const groups = new Map<string, AggregateGroup>();
  const orderedGroups: AggregateGroup[] = [];

  for (const row of input.rows) {
    const keyValues = groupFields.map((group) => row.values[group.source.key] ?? null);
    const groupKey = JSON.stringify(keyValues.map(groupKeyValue));
    let group = groups.get(groupKey);

    if (!group) {
      const output: Record<string, Scalar> = {};
      groupFields.forEach((field, index) => {
        const value = keyValues[index];
        if (value !== undefined) output[field.alias] = value;
      });
      group = {
        output,
        sourceRowIds: [],
        counts: aggregateFields.map(() => 0),
        sums: aggregateFields.map((aggregate) =>
          aggregate.fn === "SUM" ? null : 0,
        ),
      };
      groups.set(groupKey, group);
      orderedGroups.push(group);
    }

    aggregateFields.forEach((aggregate, index) => {
      if (aggregate.fn === "COUNT") {
        if (aggregate.countsAll) {
          group!.counts[index]! += 1;
        } else if (aggregate.field) {
          const value = row.values[aggregate.field.key];
          if (value !== null) group!.counts[index]! += 1;
        }
      } else if (aggregate.field) {
        const value = row.values[aggregate.field.key];
        if (value !== null) {
          const current = group!.sums[index];
          group!.sums[index] = (current ?? 0) + (value as number);
        }
      }
    });
    group.sourceRowIds.push(...row.sourceRowIds);
  }

  // An aggregate without GROUP BY returns exactly one row for an empty input.
  if (groupFields.length === 0 && orderedGroups.length === 0) {
    orderedGroups.push({
      output: {},
      sourceRowIds: [],
      counts: aggregateFields.map(() => 0),
      sums: aggregateFields.map((aggregate) => (aggregate.fn === "SUM" ? null : 0)),
    });
  }

  const fields: Field[] = [
    ...groupFields.map((group) => ({
      key: group.alias,
      name: group.alias,
      type: group.source.type,
    })),
    ...aggregateFields.map((aggregate) => ({
      key: aggregate.alias,
      name: aggregate.alias,
      type: "number" as const,
    })),
  ];

  const rows = orderedGroups.map((group) => {
    const values = { ...group.output };
    aggregateFields.forEach((aggregate, index) => {
      if (aggregate.fn === "COUNT") {
        values[aggregate.alias] = group.counts[index] ?? 0;
      } else {
        values[aggregate.alias] = group.sums[index] ?? null;
      }
    });
    return { values, sourceRowIds: group.sourceRowIds };
  });

  return { rows, fields };
}

/**
 * Executes a request that has already passed complete plan validation.
 * Normal callers should use executeQuery rather than this function.
 */
export function executeValidatedQuery(request: ValidatedQueryRequest): QueryResult {
  const result = executeNode(request.plan, request.tables);
  return {
    columns: result.fields.map((field) => ({ name: field.name, type: field.type })),
    rows: result.rows.map((row) => {
      const values: Record<string, Scalar> = {};
      for (const field of result.fields) {
        values[field.name] = row.values[field.key] ?? null;
      }
      return { values, sourceRowIds: [...row.sourceRowIds] };
    }),
  };
}
