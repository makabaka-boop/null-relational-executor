import { executeValidatedQuery } from "./executor.js";
import type { QueryRequest, QueryResult } from "./types.js";
import { validateQueryRequest } from "./validate.js";

/**
 * Validates the complete request before executing any node. Because validation
 * happens first, a malformed request cannot produce a partial query result.
 */
export function executeQuery(request: QueryRequest | unknown): QueryResult {
  const validated = validateQueryRequest(request);
  return executeValidatedQuery(validated);
}

export { QueryPlanError } from "./errors.js";
export * from "./types.js";
