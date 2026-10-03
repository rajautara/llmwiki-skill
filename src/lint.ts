import * as fs from 'node:fs/promises';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import GithubSlugger from 'github-slugger';
import { WikiStore } from './store.js';

const markdown = new MarkdownIt();
type Finding = { severity: 'medium' | 'low'; code: string; path: string; line?: number; message: string };

function parse(text: string) {
  const tokens = markdown.parse(text, {});
  const headings = new Set<string>();
  const links: { href: string; line: number }[] = [];
  const slugger = new GithubSlugger();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'heading_open') {
      const inline = tokens[i + 1];
      const title = (inline?.children ?? []).filter(t => ['text', 'code_inline', 'image'].includes(t.type)).map(t => t.content).join('');
      headings.add(slugger.slug(title));
    }
    for (const child of token.children ?? []) {
      const href = child.type === 'link_open' ? child.attrGet('href') : child.type === 'image' ? child.attrGet('src') : null;
      if (href !== null) links.push({ href: String(href), line: (token.map?.[0] ?? 0) + 1 });
    }
  }
  return { headings, links };
}

export async function lint(store: WikiStore) {
  const inventory = await store.inventory('wiki');
  const findings: Finding[] = [];
  const unread: { path: string; reason: string }[] = [];
  const parsed = new Map<string, ReturnType<typeof parse>>();
  const selected = inventory.files.slice(0, 200);
  const report = (finding: Finding) => findings.push(finding);
  for (const required of ['raw', 'wiki', 'wiki/sources', 'wiki/entities', 'wiki/concepts', 'wiki/index.md', 'wiki/log.md']) {
    try {
      const stat = await fs.stat(await store.safe(required));
      if (required.endsWith('.md') ? !stat.isFile() : !stat.isDirectory()) throw new Error('Incorrect file/directory type');
    } catch {
      report({ severity: 'medium', code: 'MISSING_STRUCTURE', path: required, message: 'Required wiki path is missing, unsafe, or has the wrong type.' });
    }
  }
  for (const relative of selected) {
    try {
      const content = await store.content(relative);
      if (content === null) throw new Error('File disappeared during the scan');
      parsed.set(relative, parse(content));
    } catch (e) { unread.push({ path: relative, reason: (e as Error).message }); }
  }
  const incoming = new Set<string>();
  const edges = new Map<string, Set<string>>();
  const external = { count: 0 };
  for (const [relative, document] of parsed) {
    const targets = new Set<string>();
    edges.set(relative, targets);
    for (const link of document.links) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link.href)) { external.count++; continue; }
      let file: string, anchor: string;
      try {
        const hash = link.href.indexOf('#');
        file = decodeURIComponent((hash < 0 ? link.href : link.href.slice(0, hash)).split('?')[0]);
        anchor = hash < 0 ? '' : decodeURIComponent(link.href.slice(hash + 1));
      } catch {
        report({ severity: 'medium', code: 'INVALID_LINK', path: relative, line: link.line, message: `Invalid link encoding: ${link.href}` }); continue;
      }
      const target = file ? path.posix.normalize(path.posix.join(path.posix.dirname(relative), file)).replace(/\/$/, '') : relative;
      try {
        if (file.startsWith('/') || !/^(raw|wiki)(\/|$)/.test(target)) throw new Error('Link leaves the wiki data directories');
        const stat = await fs.stat(await store.safe(target));
        if (stat.isFile()) {
          targets.add(target);
          if (relative !== target) incoming.add(target);
          if (anchor) {
            let targetDoc = parsed.get(target);
            if (!targetDoc && /\.(md|txt)$/i.test(target)) {
              const text = await store.content(target);
              if (text !== null) targetDoc = parse(text);
            }
            if (targetDoc && !targetDoc.headings.has(anchor)) report({ severity: 'medium', code: 'MISSING_HEADING', path: relative, line: link.line, message: `Heading not found: ${link.href} (GitHub-style heading IDs checked; custom HTML IDs are not checked).` });
          }
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        report({ severity: 'medium', code: code === 'ENOENT' ? 'BROKEN_LINK' : 'UNVERIFIED_LINK', path: relative, line: link.line, message: `Cannot resolve ${link.href}: ${(e as Error).message}` });
      }
    }
  }
  const complete = inventory.files.length <= 200 && unread.length === 0 && inventory.skipped.length === 0;
  if (complete) {
    const reachable = new Set<string>();
    const visit = (relative: string) => {
      if (reachable.has(relative)) return;
      reachable.add(relative);
      for (const target of edges.get(relative) ?? []) visit(target);
    };
    visit('wiki/index.md');
    for (const relative of selected.filter(p => !['wiki/index.md', 'wiki/log.md'].includes(p))) {
      if (!incoming.has(relative)) report({ severity: 'low', code: 'ORPHAN_PAGE', path: relative, message: 'No incoming links from other wiki pages.' });
      if (!reachable.has(relative)) report({ severity: 'medium', code: 'MISSING_NAVIGATION', path: relative, message: 'Not reachable through page links from wiki/index.md. Directory links do not enumerate pages.' });
    }
  }
  return {
    scope: { totalWikiFiles: inventory.files.length, checkedFiles: selected.length, completeStructuralScan: complete },
    findings: findings.slice(0, 100), totalFindings: findings.length, findingsTruncated: findings.length > 100,
    unread: unread.slice(0, 100), unreadCount: unread.length, skipped: inventory.skipped.slice(0, 20), skippedCount: inventory.skipped.length,
    limitations: [
      'Read-only structural audit; no factual support, missing citations, contradictions, duplicate meaning, or currency checks were performed. Use wiki_get_guidance(lint) and read sources for AI review.',
      `External URL availability was not checked (${external.count} external links).`,
      'At most 200 wiki files are audited. Orphan/navigation checks run only for a complete scan. HTML links, custom heading IDs, and [[wiki links]] are not resolved.',
    ],
  };
}
