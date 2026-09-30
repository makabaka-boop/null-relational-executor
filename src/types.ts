export type DataType = "string" | "number" | "boolean";
export type ExpressionType = DataType | "null";
export type Scalar = string | number | boolean | null;
export type Trilean = boolean | null;

export interface ColumnSchema {
  name: string;
  type: DataType;
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
}

export interface SourceRow {
  id: string;
  values: Record<string, Scalar>;
}

export interface InputTable {
  schema: TableSchema;
  rows: SourceRow[];
}

export interface ColumnRef {
  name: string;
  table?: string;
}

export type Expr =
  | { kind: "literal"; value: Scalar }
  | { kind: "column"; column: ColumnRef }
  | { kind: "isNull"; value: Expr }
  | { kind: "not"; value: Expr }
  | { kind: "and"; values: Expr[] }
  | { kind: "or"; values: Expr[] }
  | { kind: "eq"; left: Expr; right: Expr };

export interface ResolvedColumn {
  table?: string;
  name: string;
  type: ExpressionType;
}

export interface ExecRow {
  values: Record<string, Scalar>;
  sourceRowIds: string[];
}

export interface ScanNode {
  kind: "scan";
  table: string;
  as?: string;
}

export interface FilterNode {
  kind: "filter";
  input: PlanNode;
  predicate: Expr;
}

export interface JoinNode {
  kind: "join";
  left: PlanNode;
  right: PlanNode;
  on: {
    left: ColumnRef;
    right: ColumnRef;
  };
}

export interface ProjectNode {
  kind: "project";
  input: PlanNode;
  columns: Array<{ expr: Expr; as: string }>;
}

export type AggregateFunction = "COUNT" | "SUM";

export interface GroupAggregateNode {
  kind: "groupAggregate";
  input: PlanNode;
  groupBy: Array<{ column: ColumnRef; as?: string }>;
  aggregates: Array<{
    fn: AggregateFunction;
    column?: ColumnRef | null;
    as: string;
  }>;
}

export type PlanNode =
  | ScanNode
  | FilterNode
  | JoinNode
  | ProjectNode
  | GroupAggregateNode;

export interface QueryRequest {
  tables: InputTable[];
  plan: PlanNode;
}

export interface ResultColumn {
  name: string;
  type: ExpressionType;
}

export interface ResultRow {
  values: Record<string, Scalar>;
  sourceRowIds: string[];
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: ResultRow[];
}
