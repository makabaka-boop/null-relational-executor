import type { ExpressionType } from "./types.js";

export interface Field {
  /** Key used to store the value in an ExecRow. */
  key: string;
  /** Unqualified output/field name. */
  name: string;
  /** Source table name, when the field is still table-qualified. */
  table?: string;
  type: ExpressionType;
}

export function qualifiedKey(table: string, column: string): string {
  return `${table}.${column}`;
}
