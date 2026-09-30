import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { QueryPlanError } from "./errors.js";
import { executeValidatedQuery } from "./executor.js";
import { validateQueryRequest } from "./validate.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");

    request.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        reject(new QueryPlanError("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body) as unknown);
      } catch {
        reject(new QueryPlanError("Request body must be valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

export const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/query") {
    sendJson(response, 404, { error: "POST /query is the only supported endpoint" });
    return;
  }

  try {
    const requestBody = await readJson(request);
    const validated = validateQueryRequest(requestBody);
    const result = executeValidatedQuery(validated);
    sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof QueryPlanError) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    sendJson(response, 500, { error: "Internal query execution error" });
  }
});

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  server.listen(port, () => {
    console.log(`Structured query service listening on port ${port}`);
  });
}
