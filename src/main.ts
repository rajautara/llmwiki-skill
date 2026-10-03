import { startServer } from './server.js';

async function main() {
  const root = process.env.WIKI_ROOT;
  const token = process.env.WIKI_TOKEN;
  if (!root || !token) throw new Error('Set WIKI_ROOT (absolute data directory) and WIKI_TOKEN (random token >=32 characters). See README.md.');
  const port = Number(process.env.WIKI_PORT ?? 3000);
  if (port === 0) throw new Error('WIKI_PORT must be between 1 and 65535.');
  const server = await startServer({ root, token, port });
  console.log(`llmwiki MCP listening at ${server.url}`);
  console.log(`Wiki root: ${server.store.root}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.close().catch(error => { console.error(error); process.exitCode = 1; });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
