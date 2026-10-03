import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WikiStore, version, MAX_FILE_BYTES } from '../src/store.js';
import { lint } from '../src/lint.js';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llmwiki-test-'));
  const store = await WikiStore.open(root);
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store };
}
const errorCode = (code: string) => (e: unknown) => (e as { code: string }).code === code;

test('initialization preserves pages, instructions and log on repeated calls', async t => {
  const { root, store } = await fixture(t);
  await fs.mkdir(path.join(root, '.github'));
  await fs.writeFile(path.join(root, '.github/copilot-instructions.md'), 'Existing custom guidance');
  const first = await store.run(() => store.initialize('New guidance'));
  const log = await store.content('wiki/log.md');
  const second = await store.run(() => store.initialize('Replacement'));
  assert.equal(first.changed.length, 2);
  assert.equal(second.changed.length, 0);
  assert.equal(await store.content('.github/copilot-instructions.md'), 'Existing custom guidance');
  assert.equal(await store.content('wiki/log.md'), log);
  assert.equal((await lint(store)).totalFindings, 0);
});

test('initializer reports an occupied directory without overwriting it', async t => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'wiki'), 'keep');
  await assert.rejects(store.run(() => store.initialize('')), errorCode('PATH_CONFLICT'));
  assert.equal(await fs.readFile(path.join(root, 'wiki'), 'utf8'), 'keep');
});

test('sources are immutable, original bytes remain intact, and log is server-managed', async t => {
  const { store } = await fixture(t);
  await store.run(() => store.initialize(''));
  await store.run(() => store.addSource({ path: 'raw/article.md', content: '\ufeffOriginal\r\nFact.' }));
  await assert.rejects(store.run(() => store.addSource({ path: 'raw/article.md', content: 'replace' })), errorCode('VERSION_CONFLICT'));
  await assert.rejects(store.run(() => store.apply([{ path: 'raw/article.md', content: 'replace', expectedVersion: version('\ufeffOriginal\r\nFact.') }], 'bad')), errorCode('INVALID_PATH'));
  await assert.rejects(store.run(() => store.apply([{ path: 'wiki/log.md', content: 'replace', expectedVersion: null }], 'bad')), errorCode('INVALID_PATH'));
  assert.equal(await store.content('raw/article.md'), '\ufeffOriginal\r\nFact.');
});

test('queued competing writers reject stale versions before modifying any file', async t => {
  const { store } = await fixture(t);
  await store.run(() => store.initialize(''));
  const before = await store.read('wiki/index.md', 1, 500);
  const change = { path: 'wiki/index.md', content: '# Updated index\n', expectedVersion: before.version };
  const outcomes = await Promise.allSettled([
    store.run(() => store.apply([change], 'First writer')),
    store.run(() => store.apply([{ path: 'wiki/concepts/extra.md', content: 'Must not be written', expectedVersion: null }, { ...change, content: 'Stale writer' }], 'Second writer')),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(await store.content('wiki/concepts/extra.md'), null);
  assert.equal(await store.content('wiki/index.md'), change.content);
  assert.doesNotMatch((await store.content('wiki/log.md'))!, /Second writer/);
});

test('an interrupted batch blocks reads, rolls forward on restart, and logs once', async t => {
  const { store, root } = await fixture(t);
  await store.run(() => store.initialize(''));
  const original = Reflect.get(store, 'atomicWrite').bind(store);
  Reflect.set(store, 'atomicWrite', async (relative: string, content: string) => {
    if (relative === 'wiki/concepts/second.md') throw new Error('Simulated disk failure');
    return original(relative, content);
  });
  await assert.rejects(store.run(() => store.apply([
    { path: 'wiki/concepts/first.md', content: 'First page', expectedVersion: null },
    { path: 'wiki/concepts/second.md', content: 'Second page', expectedVersion: null },
  ], 'Recovered batch')), /Simulated disk failure/);
  await assert.rejects(store.run(() => store.read('wiki/index.md', 1, 5)), errorCode('RECOVERY_REQUIRED'));
  await store.close();
  const reopened = await WikiStore.open(root);
  try {
    assert.equal(await reopened.content('wiki/concepts/first.md'), 'First page');
    assert.equal(await reopened.content('wiki/concepts/second.md'), 'Second page');
    assert.equal((await reopened.content('wiki/log.md'))!.match(/Recovered batch/g)?.length, 1);
    await assert.rejects(fs.stat(path.join(root, '.llmwiki/transaction.json')), errorCode('ENOENT'));
  } finally { await reopened.close(); }
});

test('recovery refuses to overwrite an external edit', async t => {
  const { root, store } = await fixture(t);
  await store.run(() => store.initialize(''));
  await store.close();
  await fs.writeFile(path.join(root, '.llmwiki/transaction.json'), JSON.stringify({ format: 1, changes: [
    { path: 'wiki/concepts/conflict.md', content: 'Pending', expectedVersion: null },
  ] }));
  await fs.writeFile(path.join(root, 'wiki/concepts/conflict.md'), 'External edit');
  await assert.rejects(WikiStore.open(root), errorCode('RECOVERY_CONFLICT'));
  assert.equal(await fs.readFile(path.join(root, 'wiki/concepts/conflict.md'), 'utf8'), 'External edit');
  assert.ok(await fs.stat(path.join(root, '.llmwiki/transaction.json')));
});

test('only one process/store owns a data directory', async t => {
  const { root } = await fixture(t);
  await assert.rejects(WikiStore.open(root), errorCode('LOCKED'));
});

test('paths cannot escape through traversal, Windows aliases, or junctions', async t => {
  const { root, store } = await fixture(t);
  await store.run(() => store.initialize(''));
  for (const relative of ['../secret.md', 'raw/../../secret.md', 'C:/secret.md', 'raw\\secret.md', 'raw/con.md', 'raw/file.md:secret', 'raw/file.md.']) {
    await assert.rejects(store.read(relative, 1, 20), errorCode('INVALID_PATH'));
  }
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'llmwiki-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'secret.md'), 'Never expose this');
  await fs.symlink(outside, path.join(root, 'raw/escape'), 'junction');
  await assert.rejects(store.read('raw/escape/secret.md', 1, 20), errorCode('UNSAFE_PATH'));
  const listing = await store.list('raw', 0, 100);
  assert.equal(listing.files.length, 0);
  assert.deepEqual(listing.skipped, ['raw/escape']);
});

test('line reads preserve versions, state partial coverage, and enforce byte limits', async t => {
  const { root, store } = await fixture(t);
  await store.run(() => store.initialize(''));
  await store.run(() => store.addSource({ path: 'raw/lines.md', content: 'one\ntwo\nthree' }));
  const first = await store.read('raw/lines.md', 1, 2);
  const last = await store.read('raw/lines.md', first.nextLine!, 2);
  assert.equal(first.complete, false);
  assert.equal(first.nextLine, 3);
  assert.equal(last.nextLine, null);
  assert.equal(first.version, last.version);
  assert.equal(last.content, 'three');
  await fs.writeFile(path.join(root, 'raw/huge.md'), 'x'.repeat(MAX_FILE_BYTES + 1));
  await assert.rejects(store.read('raw/huge.md', 1, 1), errorCode('FILE_TOO_LARGE'));
  await assert.rejects(store.run(() => store.addSource({ path: 'raw/oversize.md', content: '界'.repeat(MAX_FILE_BYTES / 2) })));
  await fs.writeFile(path.join(root, 'raw/long.md'), 'x'.repeat(70000));
  await assert.rejects(store.read('raw/long.md', 1, 1), errorCode('LINE_TOO_LARGE'));
  await fs.writeFile(path.join(root, 'raw/binary.md'), Buffer.from([0xff, 0x00]));
  await assert.rejects(store.read('raw/binary.md', 1, 1), errorCode('INVALID_TEXT'));
});

test('list and search provide bounded cursors and disclose unread sources', async t => {
  const { root, store } = await fixture(t);
  await store.run(() => store.initialize(''));
  for (const name of ['alpha', 'beta']) await store.run(() => store.addSource({ path: `raw/${name}.md`, content: '# Evidence\nA useful Fact\nAnother fact' }));
  await fs.writeFile(path.join(root, 'raw/big.md'), 'x'.repeat(MAX_FILE_BYTES + 1));
  const first = await store.list('raw', 0, 1);
  assert.deepEqual(first.files, ['raw/alpha.md']);
  assert.equal(first.nextOffset, 1);
  const results = await store.search('FACT', 'raw', 0, 1);
  assert.equal(results.matchingLines, 4);
  assert.equal(results.results[0].line, 2);
  assert.equal(results.resultsTruncated, true);
  assert.deepEqual(results.unread, ['raw/big.md']);
});

test('lint resolves relative/reference/heading links, reports orphans and never writes', async t => {
  const { root, store } = await fixture(t);
  await store.run(() => store.initialize(''));
  const index = await store.read('wiki/index.md', 1, 500);
  await store.run(() => store.apply([
    { path: 'wiki/index.md', content: '# Index\n[Topic](concepts/topic.md#valid-heading)\n', expectedVersion: index.version },
    { path: 'wiki/concepts/topic.md', content: '# Valid Heading\n[broken][ref]\n\n[ref]: missing.md\n\n[wrong](#absent)\n\n```md\n[ignore](ignored.md)\n```\n', expectedVersion: null },
    { path: 'wiki/concepts/orphan.md', content: '# Orphan\n', expectedVersion: null },
  ], 'Lint fixtures'));
  const before = await fs.readFile(path.join(root, 'wiki/log.md'), 'utf8');
  const result = await store.run(() => lint(store));
  assert.ok(result.findings.some(f => f.code === 'BROKEN_LINK' && f.message.includes('missing.md')));
  assert.ok(result.findings.some(f => f.code === 'MISSING_HEADING'));
  assert.ok(result.findings.some(f => f.code === 'ORPHAN_PAGE' && f.path.endsWith('/orphan.md')));
  assert.ok(result.findings.some(f => f.code === 'MISSING_NAVIGATION' && f.path.endsWith('/orphan.md')));
  assert.ok(!result.findings.some(f => f.message.includes('ignored.md')));
  assert.equal(await fs.readFile(path.join(root, 'wiki/log.md'), 'utf8'), before);
});
