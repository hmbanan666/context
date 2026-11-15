import http from "node:http";
import { Readable } from "node:stream";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const url = process.env.MCP_URL;
const host = process.env.MCP_HOST;
const token = process.env.MCP_TOKEN;
const scope = process.env.MCP_SCOPE;
if (!url || !host || !token || !scope) {
  process.stderr.write("MCP smoke is missing URL, host, token, or scope\n");
  process.exit(1);
}

function fetchWithHost(input, init = {}) {
  const target = new URL(typeof input === "string" ? input : input.href);
  const headers = new Headers(init.headers);
  const outgoing = {};
  headers.forEach((value, key) => {
    if (key !== "host") outgoing[key] = value;
  });
  outgoing.host = host;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET",
        headers: outgoing,
        signal: init.signal,
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item);
          } else if (value !== undefined) responseHeaders.set(key, value);
        }
        resolve(
          new Response(Readable.toWeb(res), {
            status: res.statusCode ?? 500,
            statusText: res.statusMessage,
            headers: responseHeaders,
          }),
        );
      },
    );
    req.on("error", reject);
    if (typeof init.body === "string") req.end(init.body);
    else if (init.body instanceof Uint8Array) req.end(init.body);
    else req.end();
  });
}

const client = new Client({ name: "context-image-smoke", version: "0" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: fetchWithHost,
    }),
  );
  const listed = await client.listTools();
  const search = await client.callTool({
    name: "search",
    arguments: { scope, query: "synthetic" },
  });
  process.stdout.write(
    `${JSON.stringify({
      tools: listed.tools.map((tool) => tool.name).sort(),
      searchOk: search.isError !== true,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "MCP smoke failed"}\n`,
  );
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
