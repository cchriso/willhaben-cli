import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const client = new Client({ name: "test", version: "1" });
beforeAll(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
});
afterAll(async () => { await client.close(); await server.close(); });

test("discovers all tools, workflows and guide", async () => {
  const { tools } = await client.listTools();
  expect(tools).toHaveLength(20);
  expect(tools.find(t => t.name === "willhaben_create_listing")?.annotations?.readOnlyHint).toBe(false);
  expect(tools.find(t => t.name === "willhaben_list_listings")?.annotations?.readOnlyHint).toBe(true);
  expect((await client.listPrompts()).prompts).toHaveLength(2);
  expect((await client.readResource({ uri: "willhaben://guide" })).contents[0]).toHaveProperty("text");
  const result = await client.callTool({ name: "willhaben_capabilities", arguments: {} });
  expect(result.structuredContent).toHaveProperty("allowWrites", false);
});

test("writes denied without network access", async () => {
  const result = await client.callTool({ name: "willhaben_delete", arguments: { id: "123", confirm: true } });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toHaveProperty("error.code", "READ_ONLY");
});

test("confirmation, IDs and update inputs validated before execution", async () => {
  for (const args of [{ id: "123" }, { id: "../secret", confirm: true }, { id: "123", confirm: false }]) {
    const result = await client.callTool({ name: "willhaben_delete", arguments: args });
    expect(result.isError).toBe(true);
  }
  const result = await client.callTool({ name: "willhaben_update_listing", arguments: { id: "123", updates: {}, confirm: true } });
  expect(result.isError).toBe(true);
});

test("enabled writes still validate image bytes without contacting Willhaben", async () => {
  const writable = createServer({ allowWrites: true });
  const c = new Client({ name: "write-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await writable.connect(a); await c.connect(b);
  try {
    const result = await c.callTool({ name: "willhaben_upload_image", arguments: { id: "123", confirm: true, format: "png", base64: "!!!!" } });
    expect(result.structuredContent).toHaveProperty("error.code", "INVALID_IMAGE");
  } finally { await c.close(); await writable.close(); }
});

test("stdio transport: real SDK client can discover tools and call capabilities", async () => {
  const local = new Client({ name: "stdio-test", version: "1" });
  await local.connect(new StdioClientTransport({
    command: process.execPath, args: ["run", "src/mcp/index.ts"],
    env: { ...process.env, WILLHABEN_MCP_TRANSPORT: "stdio", WILLHABEN_MCP_ALLOW_WRITES: "false", DEBUG: "1" },
    stderr: "pipe",
  }));
  try {
    expect((await local.listTools()).tools).toHaveLength(20);
    expect((await local.callTool({ name: "willhaben_capabilities", arguments: {} })).structuredContent).toHaveProperty("allowWrites", false);
  } finally { await local.close(); }
});

test("HTTP transport: auth, host/origin protection, method handling, real SDK discovery", async () => {
  // Reserve a random port briefly to reduce collisions.
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!; await probe.stop(true);
  const token = "test-secret-".repeat(4);
  const child = Bun.spawn([process.execPath, "run", "src/mcp/index.ts"], {
    env: { ...process.env, WILLHABEN_MCP_TRANSPORT: "http", WILLHABEN_MCP_PORT: String(port), WILLHABEN_MCP_TOKEN: token },
    stdout: "ignore", stderr: "ignore",
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url)).status === 401) { ready = true; break; } } catch {}
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const headers = { Authorization: `Bearer ${token}` };
    expect((await fetch(url, { headers })).status).toBe(405);
    expect((await fetch(url, { headers: { ...headers, Origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(url, { headers: { ...headers, Host: "evil.example" } })).status).toBe(403);
    const remote = new Client({ name: "http-test", version: "1" });
    await remote.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    try {
      expect((await remote.listTools()).tools.length).toBe(20);
      const result = await remote.callTool({ name: "willhaben_capabilities", arguments: {} });
      expect(result.structuredContent).toHaveProperty("allowWrites", false);
    } finally { await remote.close(); }
  } finally { child.kill(); await child.exited; }
}, 15000);
