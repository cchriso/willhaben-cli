#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "./server.js";

// Existing API DEBUG logging uses stdout and could leak data or corrupt stdio.
delete process.env.DEBUG;
const allowWrites = process.env.WILLHABEN_MCP_ALLOW_WRITES === "true";
const transport = process.env.WILLHABEN_MCP_TRANSPORT || "http";
if (transport === "stdio") {
  await createServer({ allowWrites }).connect(new StdioServerTransport());
} else if (transport === "http") {
  const token = process.env.WILLHABEN_MCP_TOKEN;
  if (!token || token.length < 32) throw new Error("Set WILLHABEN_MCP_TOKEN to a random secret of at least 32 characters.");
  const host = process.env.WILLHABEN_MCP_HOST || "127.0.0.1";
  const port = Number(process.env.WILLHABEN_MCP_PORT || 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MCP port");
  const allowedHosts = (process.env.WILLHABEN_MCP_ALLOWED_HOSTS || "localhost,127.0.0.1").split(",").map(v => v.trim().toLowerCase());
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (!allowedHosts.includes(req.hostname.toLowerCase()) || req.headers.origin) {
      res.status(403).json({ error: "Host or Origin not allowed (server-to-server only)" }); return;
    }
    const provided = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({ error: "Unauthorized" }); return;
    }
    next();
  });
  app.use(express.json({ limit: "12mb" }));
  app.post("/mcp", async (req, res) => {
    // Stateless transport: no sticky sessions required. Each request gets its own SDK instance.
    const server = createServer({ allowWrites });
    const http = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void http.close(); void server.close(); });
    try {
      await server.connect(http);
      await http.handleRequest(req, res, req.body);
    } catch {
      console.error("MCP request failed");
      if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
    }
  });
  app.all("/mcp", (_req, res) => { res.setHeader("Allow", "POST"); res.status(405).end(); });
  const listener = app.listen(port, host, () => console.error(`Willhaben MCP: http://${host}:${port}/mcp (writes: ${allowWrites})`));
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => listener.close(() => process.exit(0)));
} else {
  throw new Error("WILLHABEN_MCP_TRANSPORT must be http or stdio");
}
