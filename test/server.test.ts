import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { server } from "../src/server.js";

const baseUrl = await new Promise<string>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }
    resolve(`http://127.0.0.1:${address.port}`);
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("HTTP service", () => {
  it("executes a valid structured plan", async () => {
    const response = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tables: [
          {
            schema: {
              name: "t",
              columns: [
                { name: "id", "type": "string" },
                { name: "n", "type": "number" },
              ],
            },
            rows: [
              { id: "a", values: { id: "a", n: 1 } },
              { id: "b", values: { id: "b", n: 2 } },
            ],
          },
        ],
        plan: {
          kind: "groupAggregate",
          input: { kind: "scan", table: "t" },
          groupBy: [],
          aggregates: [
            { fn: "COUNT", column: null, as: "cnt" },
            { fn: "SUM", column: { name: "n" }, as: "total" },
          ],
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      rows: Array<{ values: Record<string, unknown>; sourceRowIds: string[] }>;
    };
    assert.deepEqual(body.rows, [
      { values: { cnt: 2, total: 3 }, sourceRowIds: ["a", "b"] },
    ]);
  });

  it("returns 400 without a partial-result envelope for invalid JSON", async () => {
    const response = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{invalid",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Request body must be valid JSON" });
  });
});
