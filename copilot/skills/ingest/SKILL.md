---
name: ingest
description: Ingest source files from raw/ into this workspace's Markdown knowledge base.
argument-hint: "<source file path>"
---

# Ingest a Source

Follow [the knowledge base instructions](../../copilot-instructions.md).

Use the source file specified in the user's message.
If no file is specified or attached, ask which file to ingest.

- Keep the original source unchanged.
- Read the wiki index and relevant existing pages.
- Read the source and create or update its source summary.
- Integrate relevant information into existing entity and concept
  pages; create new pages only when needed.
- Preserve source references and record contradictions.
- Update the index and append an entry to the activity log.
- Report changed files and any unresolved issues.

If the file cannot be read completely, explain the limitation.
Do not claim successful ingestion of unread content.
