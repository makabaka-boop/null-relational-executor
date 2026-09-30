export class QueryPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryPlanError";
  }
}
