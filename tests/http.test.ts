import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server.js';

const token = '0123456789abcdef'.repeat(4);
const decode = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((result.content as { text: string }[])[0].text);

test('real HTTP clients discover tools and ingest a source outside their working directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llmwiki-http-'));
  const server = await startServer({ root, token, port: 0 });
  t.after(async () => { await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  assert.notEqual(root, process.cwd());
  const clients = [new Client({ name: 'agent-one', version: '1' }), new Client({ name: 'agent-two', version: '1' })];
  for (const client of clients) {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    t.after(() => client.close());
  }
  const [client, second] = clients;
  assert.equal((await client.listTools()).tools.length, 8);
  const guide = decode(await client.callTool({ name: 'wiki_get_guidance', arguments: { workflow: 'ingest' } }));
  assert.match(guide.workflowInstructions, /Ingest a Source/);
  assert.equal((await client.callTool({ name: 'wiki_initialize', arguments: {} })).isError, undefined);
  await client.callTool({ name: 'wiki_add_source', arguments: { path: 'raw/sample.md', content: '# Sample\nAcme makes widgets.' } });
  const raw = decode(await client.callTool({ name: 'wiki_read', arguments: { path: 'raw/sample.md' } }));
  assert.equal(raw.complete, true);
  const index = decode(await client.callTool({ name: 'wiki_read', arguments: { path: 'wiki/index.md' } }));
  const result = await client.callTool({ name: 'wiki_apply_changes', arguments: {
    summary: 'Ingested sample source', changes: [
      { path: 'wiki/sources/sample.md', content: '# Sample\nAcme makes widgets. [Original](../../raw/sample.md)\n', expectedVersion: null },
      { path: 'wiki/entities/acme.md', content: '# Acme\nMakes widgets. [Source](../sources/sample.md)\n', expectedVersion: null },
      { path: 'wiki/concepts/widgets.md', content: '# Widgets\nAcme makes widgets. [Source](../sources/sample.md)\n', expectedVersion: null },
      { path: 'wiki/index.md', content: index.content + '\n[Sample](sources/sample.md)\n[Acme](entities/acme.md)\n[Widgets](concepts/widgets.md)\n', expectedVersion: index.version },
    ],
  } });
  assert.equal(result.isError, undefined);
  assert.equal(decode(result).changed.length, 5);
  const stale = await second.callTool({ name: 'wiki_apply_changes', arguments: { summary: 'Stale', changes: [{ path: 'wiki/index.md', content: 'stale', expectedVersion: index.version }] } });
  assert.equal(stale.isError, true);
  assert.equal(decode(stale).code, 'VERSION_CONFLICT');
  const found = decode(await second.callTool({ name: 'wiki_search', arguments: { query: 'widgets' } }));
  assert.ok(found.results.some((r: { path: string }) => r.path === 'wiki/entities/acme.md'));
  assert.equal(decode(await client.callTool({ name: 'wiki_lint', arguments: {} })).totalFindings, 0);
  assert.equal((await fs.readFile(path.join(root, 'raw/sample.md'), 'utf8')), raw.content);
  assert.match(await fs.readFile(path.join(root, 'wiki/log.md'), 'utf8'), /Ingested sample source/);
});

test('HTTP rejects unauthorized access, invalid Host/Origin, malformed and oversized bodies', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llmwiki-auth-'));
  const server = await startServer({ root, token, port: 0 });
  t.after(async () => { await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal((await fetch(server.url)).status, 401);
  assert.equal((await fetch(server.url, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  // Fetch normalizes Host in some Node releases; exercise the actual wire header.
  const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(server.url, { headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(server.url, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(server.url, { headers })).status, 405);
  assert.equal((await fetch(server.url, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(4 * 1024 * 1024) }) })).status, 413);
});
