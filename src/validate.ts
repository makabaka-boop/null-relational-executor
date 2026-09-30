import { QueryPlanError } from "./errors.js";
import type {
  DataType,
  Expr,
  ExpressionType,
  InputTable,
  PlanNode,
  Scalar,
} from "./types.js";

import type { Field } from "./fields.js";
import { qualifiedKey } from "./fields.js";

interface AnalysisState {
  tables: ReadonlyMap<string, InputTable>;
  scannedTables: Map<string, number>;
  totalScans: number;
  joinCount: number;
  aggregateCount: number;
}

interface AnalysisResult {
  fields: Field[];
  hasAggregate: boolean;
}

const DATA_TYPES: readonly DataType[] = ["boolean", "number", "string"];
const PLAN_KINDS = new Set(["scan", "filter", "join", "project", "groupAggregate"]);
const EXPRESSION_KINDS = new Set([
  "literal",
  "column",
  "isNull",
  "not",
  "and",
  "or",
  "eq",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKnownKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string") {
    throw new QueryPlanError(`${description} must be a string`);
  }
  return value;
}

function requireNonEmptyName(value: unknown, description: string): string {
  const name = requireString(value, description);
  if (name.length === 0) {
    throw new QueryPlanError(`${description} must not be empty`);
  }
  if (name.includes(".")) {
    throw new QueryPlanError(`${description} must not contain "."`);
  }
  return name;
}

function checkScalar(value: unknown, type: DataType, context: string): Scalar {
  if (value === null) return null;
  if (type === "string" && typeof value === "string") return value;
  if (type === "boolean" && typeof value === "boolean") return value;
  if (
    type === "number" &&
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return value;
  }
  throw new QueryPlanError(`${context} must be a ${type} or null`);
}

function validateTable(input: unknown): InputTable {
  if (!isRecord(input)) {
    throw new QueryPlanError("Each table must be an object");
  }
  if (!isRecord(input.schema)) {
    throw new QueryPlanError("Each table must have a schema object");
  }
  if (!hasOnlyKnownKeys(input, ["schema", "rows"])) {
    throw new QueryPlanError("Table may only contain schema and rows");
  }
  if (!hasOnlyKnownKeys(input.schema, ["name", "columns"])) {
    throw new QueryPlanError("Table schema may only contain name and columns");
  }

  const tableName = requireNonEmptyName(input.schema.name, "Table name");
  const rawColumns = input.schema.columns;
  if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
    throw new QueryPlanError(`Table "${tableName}" must declare columns`);
  }

  const columnNames = new Set<string>();
  const columns = rawColumns.map((rawColumn, index) => {
    if (!isRecord(rawColumn) || !hasOnlyKnownKeys(rawColumn, ["name", "type"])) {
      throw new QueryPlanError(
        `Column ${index} in table "${tableName}" must contain only name and type`,
      );
    }
    const name = requireNonEmptyName(
      rawColumn.name,
      `Column ${index} name in table "${tableName}"`,
    );
    if (columnNames.has(name)) {
      throw new QueryPlanError(`Duplicate column "${name}" in table "${tableName}"`);
    }
    columnNames.add(name);

    const type = requireString(rawColumn.type, `Column "${tableName}.${name}" type`);
    if (!DATA_TYPES.includes(type as DataType)) {
      throw new QueryPlanError(
        `Column "${tableName}.${name}" has unsupported type "${type}"`,
      );
    }
    return { name, type: type as DataType };
  });

  if (!Array.isArray(input.rows)) {
    throw new QueryPlanError(`Table "${tableName}" rows must be an array`);
  }
  if (input.rows.length > 300) {
    throw new QueryPlanError(`Table "${tableName}" may contain at most 300 rows`);
  }

  const rows = input.rows.map((rawRow, rowIndex) => {
    if (!isRecord(rawRow) || !hasOnlyKnownKeys(rawRow, ["id", "values"])) {
      throw new QueryPlanError(
        `Row ${rowIndex} in table "${tableName}" must contain only id and values`,
      );
    }
    const id = requireString(rawRow.id, `Row ${rowIndex} id in table "${tableName}"`);
    if (id.length === 0) {
      throw new QueryPlanError(
        `Row ${rowIndex} id in table "${tableName}" must not be empty`,
      );
    }
    const valuesRecord = rawRow.values;
    if (!isRecord(valuesRecord)) {
      throw new QueryPlanError(`Row "${id}" in table "${tableName}" must have a values object`);
    }

    const valueKeys = new Set(Object.keys(valuesRecord));
    for (const column of columns) {
      if (!valueKeys.has(column.name)) {
        throw new QueryPlanError(
          `Row "${id}" in table "${tableName}" is missing column "${column.name}"`,
        );
      }
    }
    for (const key of valueKeys) {
      if (!columnNames.has(key)) {
        throw new QueryPlanError(
          `Row "${id}" in table "${tableName}" has unknown column "${key}"`,
        );
      }
    }

    const values: Record<string, Scalar> = {};
    for (const column of columns) {
      values[column.name] = checkScalar(
        valuesRecord[column.name],
        column.type,
        `Row "${id}" column "${tableName}.${column.name}"`,
      );
    }
    return { id, values };
  });

  return { schema: { name: tableName, columns }, rows };
}

function requireNode(value: unknown, context: string): PlanNode {
  if (!isRecord(value) || typeof value.kind !== "string" || !PLAN_KINDS.has(value.kind)) {
    throw new QueryPlanError(`${context} must be a supported plan node`);
  }
  return value as unknown as PlanNode;
}

function requireExpr(value: unknown, context: string): Expr {
  if (!isRecord(value) || typeof value.kind !== "string" || !EXPRESSION_KINDS.has(value.kind)) {
    throw new QueryPlanError(`${context} must be a supported expression`);
  }
  return value as Expr;
}

function resolveColumn(
  reference: unknown,
  fields: readonly Field[],
  context: string,
): import("./fields.js").Field {
  if (!isRecord(reference) || !hasOnlyKnownKeys(reference, ["name", "table"])) {
    throw new QueryPlanError(`${context} column reference must contain only name and optional table`);
  }
  const name = requireNonEmptyName(reference.name, `${context} column name`);
  const table =
    reference.table === undefined
      ? undefined
      : requireNonEmptyName(reference.table, `${context} table name`);

  const matches =
    table === undefined
      ? fields.filter((field) => field.name === name)
      : fields.filter((field) => field.table === table && field.name === name);

  if (matches.length === 0) {
    const qualifier = table === undefined ? "" : `${table}.`;
    throw new QueryPlanError(`${context} references unknown column ${qualifier}${name}`);
  }
  if (matches.length > 1) {
    throw new QueryPlanError(
      `${context} column "${name}" is ambiguous; qualify it with a table name`,
    );
  }
  return matches[0]!;
}

function literalType(value: Scalar): ExpressionType {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function isBooleanType(type: ExpressionType): boolean {
  return type === "boolean" || type === "null";
}

function inferExpression(
  rawExpression: unknown,
  fields: readonly Field[],
  context: string,
): ExpressionType {
  const expression = requireExpr(rawExpression, context);

  switch (expression.kind) {
    case "literal": {
      const value = (expression as { value?: unknown }).value;
      if (
        value !== null &&
        (typeof value === "object" ||
          typeof value === "function" ||
          typeof value === "symbol" ||
          typeof value === "bigint" ||
          typeof value === "undefined" ||
          (typeof value === "number" && !Number.isFinite(value)))
      ) {
        throw new QueryPlanError(
          `${context} literal must be string, finite number, boolean, or null`,
        );
      }
      return literalType(value as Scalar);
    }

    case "column":
      return resolveColumn((expression as { column?: unknown }).column, fields, context).type;

    case "isNull":
      inferExpression((expression as { value?: unknown }).value, fields, context);
      return "boolean";

    case "not": {
      const type = inferExpression((expression as { value?: unknown }).value, fields, context);
      if (!isBooleanType(type)) {
        throw new QueryPlanError(`${context} NOT requires a boolean expression`);
      }
      return "boolean";
    }

    case "and":
    case "or": {
      const operands = (expression as { values?: unknown }).values;
      if (!Array.isArray(operands) || operands.length === 0) {
        throw new QueryPlanError(`${context} ${expression.kind} requires operands`);
      }
      operands.forEach((operand, index) => {
        const type = inferExpression(operand, fields, `${context} ${expression.kind} operand ${index}`);
        if (!isBooleanType(type)) {
          throw new QueryPlanError(`${context} ${expression.kind} requires boolean operands`);
        }
      });
      return "boolean";
    }

    case "eq": {
      const left = inferExpression(
        (expression as { left?: unknown }).left,
        fields,
        `${context} equality left side`,
      );
      const right = inferExpression(
        (expression as { right?: unknown }).right,
        fields,
        `${context} equality right side`,
      );
      if (left !== "null" && right !== "null" && left !== right) {
        throw new QueryPlanError(
          `Equality comparison requires matching types; got ${left} and ${right}`,
        );
      }
      return "boolean";
    }
  }
}

function analyze(
  rawNode: unknown,
  state: AnalysisState,
  seen: WeakSet<object>,
): AnalysisResult {
  const node = requireNode(rawNode, "Plan node");
  if (seen.has(node)) {
    throw new QueryPlanError("Query plan must be a tree and must not contain cycles");
  }
  seen.add(node);

  switch (node.kind) {
    case "scan": {
      if (!isRecord(node) || !hasOnlyKnownKeys(node, ["kind", "table", "as"])) {
        throw new QueryPlanError("Scan node may only contain kind, table, and optional as");
      }
      const tableName = requireNonEmptyName(node.table, "Scan table name");
      const table = state.tables.get(tableName);
      if (!table) throw new QueryPlanError(`Scan references unknown table "${tableName}"`);
      const scanAlias =
        node.as === undefined
          ? tableName
          : requireNonEmptyName(node.as, "Scan alias");
      if (state.tables.has(scanAlias) && scanAlias !== tableName) {
        throw new QueryPlanError(`Scan alias "${scanAlias}" shadows a table name`);
      }

      state.totalScans += 1;
      if (state.totalScans > 2) {
        throw new QueryPlanError("A query plan may contain at most two table scans");
      }
      const scanCount = (state.scannedTables.get(tableName) ?? 0) + 1;
      if (scanCount > 2) {
        throw new QueryPlanError("A query plan may contain at most two table scans");
      }
      if (scanCount === 2 && node.as === undefined) {
        throw new QueryPlanError(
          `Self-join scan of table "${tableName}" must declare a distinct as alias`,
        );
      }
      state.scannedTables.set(tableName, scanCount);
      return { fields: scanFields(table, scanAlias), hasAggregate: false };
    }

    case "filter": {
      if (!hasOnlyKnownKeys(node, ["kind", "input", "predicate"])) {
        throw new QueryPlanError("Filter node may only contain kind, input, and predicate");
      }
      const input = analyze(node.input, state, seen);
      if (input.hasAggregate) {
        throw new QueryPlanError("Filter may not appear after an aggregate");
      }
      const predicateType = inferExpression(node.predicate, input.fields, "Filter predicate");
      if (!isBooleanType(predicateType)) {
        throw new QueryPlanError("Filter predicate must be boolean or null");
      }
      return { fields: input.fields, hasAggregate: false };
    }

    case "join": {
      if (!hasOnlyKnownKeys(node, ["kind", "left", "right", "on"])) {
        throw new QueryPlanError("Join node may only contain kind, left, right, and on");
      }
      state.joinCount += 1;
      if (state.joinCount > 1) {
        throw new QueryPlanError("A query plan may contain at most one equi-join");
      }
      if (!isRecord(node.on) || !hasOnlyKnownKeys(node.on, ["left", "right"])) {
        throw new QueryPlanError("Join on condition must contain only left and right references");
      }

      const left = analyze(node.left, state, seen);
      const right = analyze(node.right, state, seen);
      if (left.hasAggregate || right.hasAggregate) {
        throw new QueryPlanError("Equi-join inputs must not contain aggregates");
      }

      const leftKey = resolveColumn(node.on.left, left.fields, "Left join key");
      const rightKey = resolveColumn(node.on.right, right.fields, "Right join key");
      if (leftKey.type !== rightKey.type) {
        throw new QueryPlanError(
          `Join keys must have matching types; got ${leftKey.type} and ${rightKey.type}`,
        );
      }

      const fields: Field[] = [];
      const keys = new Set<string>();
      for (const field of [...left.fields, ...right.fields]) {
        if (keys.has(field.key)) {
          throw new QueryPlanError(`Duplicate join output key "${field.key}"`);
        }
        keys.add(field.key);
        fields.push(field);
      }
      return { fields, hasAggregate: false };
    }

    case "project": {
      if (!hasOnlyKnownKeys(node, ["kind", "input", "columns"])) {
        throw new QueryPlanError("Projection node may only contain kind, input, and columns");
      }
      if (!Array.isArray(node.columns) || node.columns.length === 0) {
        throw new QueryPlanError("Projection requires at least one column");
      }

      const input = analyze(node.input, state, seen);
      const aliases = new Set<string>();
      const fields = node.columns.map((rawColumn, index) => {
        if (!isRecord(rawColumn) || !hasOnlyKnownKeys(rawColumn, ["expr", "as"])) {
          throw new QueryPlanError(`Projection column ${index} must contain only expr and as`);
        }
        const alias = requireNonEmptyName(rawColumn.as, `Projection column ${index} alias`);
        if (aliases.has(alias)) {
          throw new QueryPlanError(`Duplicate projection alias "${alias}"`);
        }
        aliases.add(alias);
        const type = inferExpression(rawColumn.expr, input.fields, `Projection "${alias}"`);
        return { key: alias, name: alias, type };
      });
      return { fields, hasAggregate: input.hasAggregate };
    }

    case "groupAggregate": {
      if (!hasOnlyKnownKeys(node, ["kind", "input", "groupBy", "aggregates"])) {
        throw new QueryPlanError(
          "Aggregate node may only contain kind, input, groupBy, and aggregates",
        );
      }
      state.aggregateCount += 1;
      if (state.aggregateCount > 1) {
        throw new QueryPlanError("A query plan may contain at most one aggregate node");
      }
      if (!Array.isArray(node.groupBy)) {
        throw new QueryPlanError("Aggregate groupBy must be an array");
      }
      if (!Array.isArray(node.aggregates)) {
        throw new QueryPlanError("Aggregate aggregates must be an array");
      }

      const input = analyze(node.input, state, seen);
      if (input.hasAggregate) {
        throw new QueryPlanError("Aggregate inputs must not contain another aggregate");
      }

      const outputNames = new Set<string>();
      const fields: Field[] = [];

      node.groupBy.forEach((rawGroup, index) => {
        if (!isRecord(rawGroup) || !hasOnlyKnownKeys(rawGroup, ["column", "as"])) {
          throw new QueryPlanError(`Group key ${index} must contain only column and optional as`);
        }
        const source = resolveColumn(rawGroup.column, input.fields, `Group key ${index}`);
        const alias =
          rawGroup.as === undefined
            ? source.name
            : requireNonEmptyName(rawGroup.as, `Group key ${index} alias`);
        if (outputNames.has(alias)) {
          throw new QueryPlanError(`Duplicate aggregate output column "${alias}"`);
        }
        outputNames.add(alias);
        fields.push({ key: alias, name: alias, type: source.type });
      });

      node.aggregates.forEach((rawAggregate, index) => {
        if (!isRecord(rawAggregate) || !hasOnlyKnownKeys(rawAggregate, ["fn", "column", "as"])) {
          throw new QueryPlanError(
            `Aggregate ${index} must contain only fn, optional column, and as`,
          );
        }
        const fn = requireString(rawAggregate.fn, `Aggregate ${index} function`);
        if (fn !== "COUNT" && fn !== "SUM") {
          throw new QueryPlanError(`Unsupported aggregate function "${fn}"`);
        }
        const alias = requireNonEmptyName(rawAggregate.as, `Aggregate ${index} alias`);
        if (outputNames.has(alias)) {
          throw new QueryPlanError(`Duplicate aggregate output column "${alias}"`);
        }
        outputNames.add(alias);

        if (fn === "COUNT") {
          if (rawAggregate.column !== null && rawAggregate.column !== undefined) {
            resolveColumn(rawAggregate.column, input.fields, `COUNT argument ${index}`);
          }
        } else if (rawAggregate.column === null || rawAggregate.column === undefined) {
          throw new QueryPlanError("SUM requires a column argument");
        } else {
          const argument = resolveColumn(rawAggregate.column, input.fields, `SUM argument ${index}`);
          if (argument.type !== "number") {
            throw new QueryPlanError("SUM requires a numeric column");
          }
        }
        fields.push({ key: alias, name: alias, type: "number" });
      });

      if (fields.length === 0) {
        throw new QueryPlanError("Aggregate must output at least one group key or aggregate");
      }
      return { fields, hasAggregate: true };
    }
  }
}

function scanFields(table: InputTable, alias = table.schema.name): Field[] {
  return table.schema.columns.map((column) => ({
    key: qualifiedKey(alias, column.name),
    name: column.name,
    table: alias,
    type: column.type,
  }));
}

export interface ValidatedQueryRequest {
  tables: ReadonlyMap<string, InputTable>;
  plan: PlanNode;
}

export function validateQueryRequest(request: unknown): ValidatedQueryRequest {
  if (!isRecord(request) || !hasOnlyKnownKeys(request, ["tables", "plan"])) {
    throw new QueryPlanError("Query request must contain only tables and plan");
  }
  if (!Array.isArray(request.tables) || request.tables.length === 0) {
    throw new QueryPlanError("Query request requires at least one table");
  }
  if (request.tables.length > 2) {
    throw new QueryPlanError("Query request may contain at most two tables");
  }

  const tables = new Map<string, InputTable>();
  const allIds = new Set<string>();
  for (const rawTable of request.tables) {
    const table = validateTable(rawTable);
    if (tables.has(table.schema.name)) {
      throw new QueryPlanError(`Duplicate table name "${table.schema.name}"`);
    }
    for (const row of table.rows) {
      if (allIds.has(row.id)) {
        throw new QueryPlanError(`Duplicate source row id "${row.id}"`);
      }
      allIds.add(row.id);
    }
    tables.set(table.schema.name, table);
  }

  const plan = requireNode(request.plan, "Query plan");
  const state: AnalysisState = {
    tables,
    scannedTables: new Map<string, number>(),
    totalScans: 0,
    joinCount: 0,
    aggregateCount: 0,
  };
  const root = analyze(plan, state, new WeakSet<object>());
  const rootNames = new Set<string>();
  for (const field of root.fields) {
    if (rootNames.has(field.name)) {
      throw new QueryPlanError(
        `Result column "${field.name}" is ambiguous; add a final projection with distinct aliases`,
      );
    }
    rootNames.add(field.name);
  }

  for (const tableName of tables.keys()) {
    if (!state.scannedTables.has(tableName)) {
      throw new QueryPlanError(`Table "${tableName}" is not used by the query plan`);
    }
  }

  return { tables, plan };
}

export function inferFields(
  plan: PlanNode,
  tables: ReadonlyMap<string, InputTable>,
): Field[] {
  switch (plan.kind) {
    case "scan": {
      const table = tables.get(plan.table);
      if (!table) throw new QueryPlanError(`Unknown table "${plan.table}"`);
      return scanFields(table, plan.as ?? plan.table);
    }

    case "filter":
      return inferFields(plan.input, tables);

    case "join": {
      const left = inferFields(plan.left, tables);
      const right = inferFields(plan.right, tables);
      const keys = new Set<string>();
      for (const field of [...left, ...right]) {
        if (keys.has(field.key)) {
          throw new QueryPlanError(`Duplicate join output key "${field.key}"`);
        }
        keys.add(field.key);
      }
      return [...left, ...right];
    }

    case "project":
      return plan.columns.map((column) => ({
        key: column.as,
        name: column.as,
        type: inferExpression(column.expr, inferFields(plan.input, tables), `Projection "${column.as}"`),
      }));

    case "groupAggregate": {
      const input = inferFields(plan.input, tables);
      const result: Field[] = [];
      plan.groupBy.forEach((group) => {
        const source = resolveColumn(group.column, input, "Group key");
        result.push({
          key: group.as ?? source.name,
          name: group.as ?? source.name,
          type: source.type,
        });
      });
      plan.aggregates.forEach((aggregate) => {
        result.push({ key: aggregate.as, name: aggregate.as, type: "number" });
      });
      return result;
    }
  }
}
