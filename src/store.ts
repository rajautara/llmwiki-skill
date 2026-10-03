import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const version = (text: string) => createHash('sha256').update(text).digest('hex');
export class WikiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function fail(code: string, message: string): never { throw new WikiError(code, message); }
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const textSchema = z.string().refine(s => Buffer.byteLength(s) <= MAX_FILE_BYTES && !s.includes('\0'), 'UTF-8 text must be <= 1 MiB and contain no NUL');
export const changeSchema = z.object({
  path: z.string().max(240), content: textSchema,
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
export const sourceSchema = z.object({ path: z.string().max(240), content: textSchema });
const journalSchema = z.object({
  format: z.literal(1), changes: z.array(changeSchema).min(1).max(52),
});
type Change = z.infer<typeof changeSchema>;

// Reject Windows aliases as well as traversal, even when hosted on another OS.
function checkRelative(relative: string) {
  if (!relative || relative.length > 240 || relative.includes('\\')) fail('INVALID_PATH', 'Use a relative forward-slash path.');
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)) {
      fail('INVALID_PATH', `Unsafe path: ${relative}`);
    }
  }
}
function checkDocument(relative: string) {
  checkRelative(relative);
  if (relative === '.github/copilot-instructions.md') return;
  if (!/^(raw|wiki)\/.+\.(md|txt)$/i.test(relative) || !/^(raw|wiki)\//.test(relative)) fail('INVALID_PATH', 'Only raw/ and wiki/ Markdown or text files are accessible.');
}
function checkWikiWrite(relative: string) {
  checkDocument(relative);
  if (relative === 'wiki/index.md') return;
  if (!/^wiki\/(sources|entities|concepts)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(relative)) {
    fail('INVALID_PATH', 'Write wiki/index.md or lowercase-hyphen .md pages in wiki/sources, entities or concepts. The log is server-managed.');
  }
}

export class WikiStore {
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private closed = false;
  private lockHandle?: fs.FileHandle;
  private constructor(public readonly root: string) {}

  static async open(root: string) {
    if (!path.isAbsolute(root)) fail('CONFIG', 'WIKI_ROOT must be an absolute path.');
    await fs.mkdir(root, { recursive: true });
    const store = new WikiStore(await fs.realpath(root));
    await store.directory('.llmwiki');
    const lock = await store.safe('.llmwiki/server.lock');
    try {
      store.lockHandle = await fs.open(lock, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(await fs.readFile(lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) fail('LOCKED', 'Invalid server.lock; verify no server is running before removing it.');
      try { process.kill(pid, 0); fail('LOCKED', 'Another server already owns this wiki.'); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; }
      await fs.unlink(lock);
      store.lockHandle = await fs.open(lock, 'wx');
    }
    try {
      await store.lockHandle.writeFile(String(process.pid));
      await store.lockHandle.sync();
      await store.recover();
      return store;
    } catch (e) { await store.close(); throw e; }
  }

  async close() {
    this.closed = true;
    await this.queue.catch(() => {});
    if (this.lockHandle) {
      await this.lockHandle.close();
      this.lockHandle = undefined;
      await fs.unlink(await this.safe('.llmwiki/server.lock'));
    }
  }

  // Reads share the write queue so clients never observe half of a batch.
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new WikiError('CLOSED', 'Server is shutting down.'));
    const task = this.queue.then(() => {
      if (this.poisoned) fail('RECOVERY_REQUIRED', 'A write was interrupted. Restart the server to recover before further operations.');
      return fn();
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async safe(relative: string): Promise<string> {
    checkRelative(relative);
    let current = this.root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) fail('UNSAFE_PATH', `Symlinks and junctions are not allowed: ${relative}`);
        if (stat.isFile() && stat.nlink > 1) fail('UNSAFE_PATH', `Hard-linked files are not allowed: ${relative}`);
      } catch (e) { if (!missing(e)) throw e; }
    }
    return current;
  }

  private async directory(relative: string) {
    const target = await this.safe(relative);
    await fs.mkdir(target, { recursive: true });
    if (!(await fs.stat(target)).isDirectory()) fail('PATH_CONFLICT', `${relative} must be a directory.`);
  }

  async content(relative: string): Promise<string | null> {
    const target = await this.safe(relative);
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile()) fail('NOT_FILE', `${relative} is not a regular file.`);
      if (stat.size > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', `${relative} exceeds the 1 MiB text limit; it has not been read.`);
      const bytes = await fs.readFile(target);
      if (bytes.length > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', `${relative} exceeds the 1 MiB text limit.`);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { return fail('INVALID_TEXT', `${relative} is not valid UTF-8.`); }
      if (text.includes('\0')) fail('INVALID_TEXT', `${relative} contains binary content.`);
      return text;
    } catch (e) { if (missing(e)) return null; throw e; }
  }

  private async atomicWrite(relative: string, content: string) {
    const target = await this.safe(relative);
    const temporary = await this.safe(`.llmwiki/stage-${randomUUID()}`);
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.rename(temporary, target); }
    finally { await fs.unlink(temporary).catch(e => { if (!missing(e)) throw e; }); }
  }

  private validateJournal(changes: Change[]) {
    const seen = new Set<string>();
    for (const change of changes) {
      checkDocument(change.path);
      if (seen.has(change.path.toLowerCase())) fail('DUPLICATE_PATH', `Duplicate path: ${change.path}`);
      seen.add(change.path.toLowerCase());
      if (change.path.startsWith('raw/') || change.path === '.github/copilot-instructions.md') {
        if (change.expectedVersion !== null) fail('IMMUTABLE_SOURCE', 'Sources and local instructions cannot be overwritten.');
      } else if (change.path !== 'wiki/log.md') checkWikiWrite(change.path);
    }
  }

  private async recover() {
    const location = await this.safe('.llmwiki/transaction.json');
    let text: string;
    try {
      if ((await fs.stat(location)).size > 56 * MAX_FILE_BYTES) fail('RECOVERY_REQUIRED', 'Transaction journal exceeds its size limit.');
      text = await fs.readFile(location, 'utf8');
    } catch (e) { if (missing(e)) return; throw e; }
    const journal = journalSchema.parse(JSON.parse(text));
    this.validateJournal(journal.changes);
    // Validate the whole recovery before writing anything. Never overwrite outside edits.
    for (const change of journal.changes) {
      const current = await this.content(change.path);
      if (current !== change.content && (current === null ? null : version(current)) !== change.expectedVersion) {
        fail('RECOVERY_CONFLICT', `Recovery conflicts with ${change.path}; preserve the journal and resolve the outside edit before restarting.`);
      }
    }
    for (const change of journal.changes) {
      if (await this.content(change.path) === change.content) continue;
      await this.directory(path.posix.dirname(change.path));
      await this.atomicWrite(change.path, change.content);
    }
    await fs.unlink(location);
  }

  private async commit(changes: Change[]) {
    journalSchema.parse({ format: 1, changes });
    this.validateJournal(changes);
    for (const change of changes) {
      const current = await this.content(change.path);
      if ((current === null ? null : version(current)) !== change.expectedVersion) fail('VERSION_CONFLICT', `${change.path} changed or already exists. Read it again and retry the complete batch.`);
      await this.safe(path.posix.dirname(change.path));
    }
    try {
      await this.atomicWrite('.llmwiki/transaction.json', JSON.stringify({ format: 1, changes }));
      await this.recover();
    } catch (e) { this.poisoned = true; throw e; }
    return { changed: changes.map(c => ({ path: c.path, version: version(c.content) })) };
  }

  async initialize(instructions: string) {
    const directories = ['raw', 'wiki', 'wiki/sources', 'wiki/entities', 'wiki/concepts', '.github'];
    for (const dir of directories) {
      const target = await this.safe(dir);
      try { if (!(await fs.stat(target)).isDirectory()) fail('PATH_CONFLICT', `${dir} is occupied by a file.`); }
      catch (e) { if (!missing(e)) throw e; }
    }
    for (const dir of directories) await this.directory(dir);
    const seeds: Record<string, string> = {
      'wiki/index.md': '# Knowledge Base Index\n\n## Sources\n\n[Sources](sources/)\n\n## Entities\n\n[Entities](entities/)\n\n## Concepts\n\n[Concepts](concepts/)\n\n[Activity log](log.md)\n',
      'wiki/log.md': `# Knowledge Base Activity Log\n\n- ${new Date().toISOString()}: Initialized wiki.\n`,
      '.github/copilot-instructions.md': instructions,
    };
    const changes: Change[] = [];
    const preserved: string[] = [];
    for (const [relative, content] of Object.entries(seeds)) {
      if (await this.content(relative) === null) changes.push({ path: relative, content, expectedVersion: null });
      else preserved.push(relative);
    }
    const result = changes.length ? await this.commit(changes) : { changed: [] };
    return { ...result, preserved, directories, guidance: 'Existing instructions are preserved. Use wiki_get_guidance before wiki work.' };
  }

  async inventory(scope: 'raw' | 'wiki' | 'all') {
    const files: string[] = [];
    const skipped: string[] = [];
    let count = 0;
    const walk = async (dir: string, depth: number) => {
      if (depth > 32) fail('INVENTORY_LIMIT', 'Directory nesting exceeds 32 levels.');
      let entries;
      try { entries = await fs.readdir(await this.safe(dir), { withFileTypes: true }); }
      catch (e) { if (missing(e)) return; throw e; }
      for (const entry of entries) {
        if (++count > 10000) fail('INVENTORY_LIMIT', 'Wiki exceeds the v1 limit of 10,000 directory entries.');
        const relative = `${dir}/${entry.name}`;
        if (entry.isSymbolicLink()) { skipped.push(relative); continue; }
        try { await this.safe(relative); } catch { skipped.push(relative); continue; }
        if (entry.isDirectory()) await walk(relative, depth + 1);
        else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) files.push(relative);
        else skipped.push(relative);
      }
    };
    for (const dir of scope === 'all' ? ['raw', 'wiki'] : [scope]) await walk(dir, 0);
    return { files: files.sort(), skipped };
  }

  async list(scope: 'raw' | 'wiki' | 'all', offset: number, limit: number) {
    const { files, skipped } = await this.inventory(scope);
    return { files: files.slice(offset, offset + limit), total: files.length, nextOffset: offset + limit < files.length ? offset + limit : null, skippedCount: skipped.length, skipped: skipped.slice(0, 20) };
  }

  async read(relative: string, startLine: number, lineCount: number) {
    checkDocument(relative);
    const text = await this.content(relative);
    if (text === null) fail('NOT_FOUND', `${relative} does not exist.`);
    const lines = text.split('\n');
    if (startLine > lines.length) fail('INVALID_RANGE', `startLine exceeds ${lines.length} lines.`);
    const selected: string[] = [];
    let bytes = 0;
    for (const line of lines.slice(startLine - 1, startLine - 1 + lineCount)) {
      const size = Buffer.byteLength(line) + 1;
      if (bytes + size > MAX_RESPONSE_BYTES) {
        if (!selected.length) fail('LINE_TOO_LARGE', 'This line exceeds 64 KiB and cannot be returned by v1. Source has not been fully read.');
        break;
      }
      selected.push(line); bytes += size;
    }
    const endLine = startLine + selected.length - 1;
    return { path: relative, version: version(text), content: selected.join('\n'), startLine, endLine, totalLines: lines.length, complete: startLine === 1 && endLine === lines.length, nextLine: endLine < lines.length ? endLine + 1 : null };
  }

  async search(query: string, scope: 'raw' | 'wiki' | 'all', offset: number, limit: number) {
    const { files, skipped } = await this.inventory(scope);
    const results: { path: string; line: number; excerpt: string }[] = [];
    const unread: string[] = [];
    let matches = 0;
    // Scan a bounded number of files, with a file cursor rather than silently stopping.
    const batch = files.slice(offset, offset + 200);
    for (const relative of batch) {
      try {
        const content = await this.content(relative);
        if (content === null) { unread.push(relative); continue; }
        content.split('\n').forEach((line, i) => {
          const position = line.toLowerCase().indexOf(query.toLowerCase());
          if (position < 0) return;
          matches++;
          if (results.length < limit) results.push({ path: relative, line: i + 1, excerpt: line.slice(Math.max(0, position - 80), position + 240) });
        });
      } catch { unread.push(relative); }
    }
    return { results, matchingLines: matches, resultsTruncated: matches > results.length, filesScanned: batch.length, nextOffset: offset + batch.length < files.length ? offset + batch.length : null, unread, skippedCount: skipped.length, skipped: skipped.slice(0, 20), note: 'offset is a file cursor. If resultsTruncated, narrow the query or use wiki_read on matching files.' };
  }

  private async logChange(summary: string, files: string[]): Promise<Change> {
    const old = await this.content('wiki/log.md');
    if (old === null || await this.content('wiki/index.md') === null) fail('NOT_INITIALIZED', 'Call wiki_initialize first.');
    const clean = summary.replace(/[\r\n\x00-\x1f]/g, ' ');
    const content = `${old}${old.endsWith('\n') ? '' : '\n'}\n- ${new Date().toISOString()}: ${clean} (${files.join(', ')})\n`;
    textSchema.parse(content);
    return { path: 'wiki/log.md', content, expectedVersion: version(old) };
  }

  async addSource(input: z.infer<typeof sourceSchema>) {
    const { path: relative, content } = sourceSchema.parse(input);
    checkDocument(relative);
    if (!/^raw\/[a-z0-9]+(?:-[a-z0-9]+)*\.(md|txt)$/.test(relative)) fail('INVALID_PATH', 'New sources use raw/lowercase-hyphen.md or .txt.');
    return this.commit([{ path: relative, content, expectedVersion: null }, await this.logChange('Added source', [relative])]);
  }

  async apply(changes: Change[], summary: string) {
    z.array(changeSchema).min(1).max(50).parse(changes);
    z.string().min(1).max(500).parse(summary);
    for (const change of changes) checkWikiWrite(change.path);
    return this.commit([...changes, await this.logChange(summary, changes.map(c => c.path))]);
  }
}
