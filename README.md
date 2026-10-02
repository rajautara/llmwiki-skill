# LLM Wiki Skill

LLM Wiki Skill provides GitHub Copilot instructions and skills for creating
and maintaining a personal, Markdown-based knowledge base. The wiki organizes
original material, source summaries, entity pages, and concepts synthesized
across sources.

## Repository contents

- `copilot/copilot-instructions.md` — shared guidance for working with the wiki.
- `copilot/skills/init-wiki/SKILL.md` — initializes the wiki structure and
  creates missing navigation and instruction files.
- `copilot/skills/ingest/SKILL.md` — summarizes a source in the wiki and
  integrates relevant information into existing pages.
- `copilot/skills/lint/SKILL.md` — checks wiki links, citations, navigation,
  consistency, and other health issues.

## Set up a workspace

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
