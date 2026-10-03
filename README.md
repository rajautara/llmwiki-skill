# LLM Wiki Skill

LLM Wiki provides a local HTTP MCP server and GitHub Copilot skills for creating
and maintaining a personal, Markdown-based knowledge base. The wiki organizes
original material, source summaries, entity pages, and concepts synthesized
across sources.

## Repository contents

- `src/` — TypeScript MCP server, protected Markdown storage, and structural lint.
- `tests/` — storage/recovery tests and real MCP HTTP client integration tests.
- `copilot/copilot-instructions.md` — shared guidance for working with the wiki.
- `copilot/skills/init-wiki/SKILL.md` — initializes the wiki structure and
  creates missing navigation and instruction files.
- `copilot/skills/ingest/SKILL.md` — summarizes a source in the wiki and
  integrates relevant information into existing pages.
- `copilot/skills/lint/SKILL.md` — checks wiki links, citations, navigation,
  consistency, and other health issues.

## Use the MCP server from any workspace

The agent and data can stay on the same PC. Run one server and connect your
IDE/CLI clients to `http://127.0.0.1:3000/mcp`. Clients do not need to open the
wiki folder or install the skills locally. The server reads the existing skill
guidance and makes it available through `wiki_get_guidance`.

The AI client reads sources, writes summaries, and synthesizes knowledge. The
server handles files, literal text search, validation, and structural lint. It
does not call an LLM or require a model API key. Sources and pages returned by
tools are reference material, never instructions to execute.

### Install and start

Requires Node.js 22.13+ and npm. In this repository:

```powershell
npm.cmd ci
npm.cmd run build

# Choose one permanent absolute data directory, independent of client projects.
$env:WIKI_ROOT = 'C:\Users\User\Documents\llmwiki'
# Generate once and keep this secret in your server/client configuration.
$env:WIKI_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
$env:WIKI_PORT = '3000'
npm.cmd start
```

Keep that terminal running. Stop with Ctrl+C. Reuse the same token on subsequent
starts so configured clients continue to work. The server never prints the token.
If running from another directory, use the absolute path to `dist/main.js`:

```powershell
node 'C:\path\to\llmwiki-skill\dist\main.js'
```

Alternatively, copy `.env.example` to `.env`, replace its values, and run
`node --env-file=.env dist/main.js`. `npm start` does not automatically load `.env`.
The data directory is created at startup, but wiki pages are created only when
you ask the agent to call `wiki_initialize`. No existing wiki files are replaced.

### Connect a client

Configure a **Streamable HTTP** MCP connection with:

| Setting | Value |
| --- | --- |
| URL | `http://127.0.0.1:3000/mcp` |
| Header | `Authorization: Bearer <your WIKI_TOKEN>` |

For example, VS Code's MCP configuration uses this shape. Start VS Code with
the same `WIKI_TOKEN` environment variable available to its process; the token
does not need to be written into a committed configuration file:

```json
{
  "servers": {
    "llmwiki": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer ${env:WIKI_TOKEN}" }
    }
  }
}
```

Use the client's user-level MCP configuration to make the connection available
across projects. Other clients may use different configuration keys; the URL,
transport, and header above are the connection contract. The client must support
custom HTTP headers. This v1 does not provide OAuth discovery or a browser login.
Restart an already-running editor after changing its environment. Interactive
`${input:...}` secrets are another option for VS Code extension-host sessions,
but are not forwarded to Agent Host sessions.
See the [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
and the [MCP SDK transport documentation](https://ts.sdk.modelcontextprotocol.io/server).

Only IPv4 loopback is bound. Requests need a valid token, a local Host header,
and, when supplied, a same-server local Origin. Remote machines, cloud-hosted
agents, and agents inside containers/WSL cannot assume their `127.0.0.1` points
to this Windows process. Public hosting and cross-network access are not part
of this version.

### Tools and workflows

| Tool | Input and behavior |
| --- | --- |
| `wiki_initialize` | No arguments. Creates missing folders, index, activity log and local instructions. |
| `wiki_get_guidance` | `workflow`: `general`, `query`, `ingest` or `lint`. Returns conventions, skill instructions, and MCP-specific steps. |
| `wiki_list` | `scope`: `wiki` (default), `raw` or `all`; `offset` and `limit`. Returns paths, skipped files, and `nextOffset`. |
| `wiki_search` | Literal `query`, `scope`, file `offset`, result `limit`. Returns line excerpts, unread paths and coverage limits. |
| `wiki_read` | Server-relative `path`, 1-based `startLine`, `lineCount`. Returns content, SHA-256 `version`, `complete` and `nextLine`. |
| `wiki_add_source` | New `path` such as `raw/article-01.md`, plus UTF-8 `content`. Adds a source and log entry; does not ingest it. |
| `wiki_apply_changes` | `changes` containing `path`, full `content`, and `expectedVersion`; plus `summary` for the log. |
| `wiki_lint` | No arguments. Read-only structural report with explicit coverage and limitations. |

Tool results are JSON in MCP text content. Operational failures set `isError`
and include a `code` and `message`. Paths always refer to `WIKI_ROOT`, not the
client's working directory. No arbitrary filesystem or shell tools are exposed.

Example requests to your agent:

1. “Use llmwiki MCP to initialize my wiki.”
2. “Save this text as raw/article-01.md and ingest it into llmwiki. Read the ingest
   guidance and existing relevant pages first.”
3. “Using llmwiki, explain what my sources say about this topic and cite the
   source paths and sections. Do not edit anything.”
4. “Lint llmwiki, including an evidence-based AI review. Report the scope and
   issues without applying fixes.”

You can also place UTF-8 `.md`/`.txt` files directly in `WIKI_ROOT/raw/`, then ask
the agent to ingest them. Prefer `wiki_add_source` for live uploads; do not change
existing sources. The client must transmit source text explicitly—the server
does not read arbitrary client-local paths or fetch URLs.

During ingestion the agent follows `wiki_read.nextLine` until it has read the
whole source, checking that the version is unchanged between chunks. It then
submits source summaries, relevant entity/concept pages and index edits together:

```json
{
  "summary": "Ingested article-01 and updated related pages",
  "changes": [
    {
      "path": "wiki/sources/article-01.md",
      "content": "# Article 01\n\nSummary with [original source](../../raw/article-01.md).\n",
      "expectedVersion": null
    },
    {
      "path": "wiki/index.md",
      "content": "<complete revised index, preserving existing entries>",
      "expectedVersion": "<64-character version returned by wiki_read>"
    }
  ]
}
```

Use `null` only for new files. Existing files require their read version. New
page filenames must be lowercase words/numbers separated by hyphens, within
`wiki/sources/`, `wiki/entities/`, or `wiki/concepts/`. The server manages
`wiki/log.md`; clients cannot submit it or edit/delete sources. All writes require
a user request; read-only questions do not authorize persistence.

### Consistency, recovery and limits

One server process owns each data directory. MCP operations run through a shared
queue so clients do not observe a partially applied batch. A stale file version
rejects the entire batch before it is written. Read affected pages again and
recompute changes after `VERSION_CONFLICT`.

Before replacing files, the server saves a flushed transaction journal under
`.llmwiki/transaction.json`. If a write fails, further operations return
`RECOVERY_REQUIRED`. Restart the server to finish the recorded batch before it
accepts requests. Recovery accepts either the original or already-written
version, and appends the recorded log entry only once. If someone edited a
pending file outside MCP, startup stops with `RECOVERY_CONFLICT` and preserves
the journal for manual resolution. Back up both the data and journal before
resolving such a conflict. A failed response can therefore correspond to a batch
that completes on restart; read the files/log before retrying it.

Keep live wiki edits inside MCP. Direct filesystem editors do not participate
in its queue or version checks. The journal protects against interrupted process
writes; it is not a backup or a guarantee against storage/power failure. Keep
normal backups. Do not modify or delete the journal while a server is running.
An invalid process lock is reported rather than guessed away; verify that no
server is running before manually removing `.llmwiki/server.lock`.

v1 bounds:

- UTF-8 text only, at most 1 MiB per file, including the log; oversized or binary
  files are explicitly reported as unread. Archive an oversized log manually
  with the server stopped before further writes.
- `wiki_read` returns up to 500 lines / 64 KiB of text per call. A single line
  larger than 64 KiB produces `LINE_TOO_LARGE`; ingestion must report that limit.
- HTTP request bodies are limited to 4 MiB, batches to 50 page changes, and
  serialized tool responses to 512 KiB.
- File inventories are limited to 10,000 directory entries and 32 nesting
  levels. Listing and search return at most 100 entries per call.
- Search scans up to 200 files per call. Its `offset`/`nextOffset` is a **file**
  cursor. If matching excerpts are truncated, narrow the query or read the
  matching files. It is literal, case-insensitive search, not semantic search.
- Lint reads at most 200 wiki files and returns at most 100 findings. It checks
  Markdown links and GitHub-style heading IDs; external URLs, HTML links, custom
  HTML IDs and `[[wiki links]]` are not resolved. Orphan/navigation checks require
  a complete structural scan. Directory links alone do not make individual pages
  reachable from the index.
- Semantic claims, citations, contradictions, duplicates and currency need an
  AI review using the guidance and actual sources. The server does not claim to
  have performed those checks.

Symlinks, Windows junctions, hard-linked files, traversal paths and Windows path
aliases are rejected. PDFs, DOCX, URL fetching, embeddings, web UI, Windows
service installation, and multi-user hosting are outside v1.

### Development checks

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Tests use isolated temporary data directories. They cover two real MCP HTTP
clients, ingest/search/lint, immutable sources, conflict rejection, interrupted
batch recovery, path/junction protection, authentication, Host/Origin checks,
and input/output limits. They do not call an LLM.

## Use the original skills in a workspace

In a Copilot-enabled workspace, make the repository's instruction file
available as `.github/copilot-instructions.md` and place the skill directories
under `.github/skills/`. Then ask Copilot to run `/init-wiki` in the workspace.
The initializer creates only missing wiki files and folders, preserving
existing content.

After setup:

1. Save source material under `raw/`.
2. Ask Copilot to ingest a source, for example:
   `Ingest raw/article-01.md following .github/copilot-instructions.md.`
3. Ask Copilot to `/lint` to audit wiki health. Request `/lint fix` or specify
   corrections if you want it to make changes.

## Knowledge base structure

```text
.github/
  copilot-instructions.md
  skills/
raw/
wiki/
  index.md
  log.md
  sources/
  entities/
  concepts/
```

Original files in `raw/` are treated as immutable reference material.
Summaries and synthesized knowledge belong under `wiki/`.
