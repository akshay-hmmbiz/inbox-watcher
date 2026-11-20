import './helpers/example-config.mjs';
// Read means handled. The owner opens an item in Gmail (from the alert's link or straight
// from the inbox) and expects the Watcher to stop raising it. If only a sent reply could
// close an email item, and Chat items never closed by themselves, then anything acted on
// elsewhere (an approval in another system, an access request granted in Drive, a Chat DM
// that was read) would stay "still open" in every digest for weeks.
//
// The rule: an open item closes once every Gmail thread it came from has been read: no
// message in any of them still carries Gmail's UNREAD label. Read state is collected by the
// scheduled agent into state/readState.json. Anything missing, unreadable or empty is treated
// as UNREAD: a wrong close is silence, the failure this system exists to prevent.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDetailed, runOnce, summarize } from '../src/run.mjs';
import { triage, triageFiles } from '../src/triage.mjs';
import { openItem, loadLedger, saveLedger, threadsOf } from '../src/ledger.mjs';

const MIN = 60_000;
const plusMinutes = (d, m) => new Date(d.getTime() + m * MIN);
// 02:00 UTC is 07:30 in Asia/Kolkata: before the digest hour.
const t0 = new Date('2026-10-30T02:00:00Z');

// Invented Gmail ids. A web link carries the thread as a decimal `thread-f:` number; the
// API's thread id is the same number in hex.
const LINK_THREAD_DEC = '7310829546615203841';
const LINK_THREAD_HEX = '657548bcfb6de801';
const dmLink = `https://mail.google.com/mail/?authuser=alex@northwind.example#all/thread-f:${LINK_THREAD_DEC}`;

const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-read-'));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const capture = () => {
  const texts = [];
  return { texts, postImpl: async (t) => { texts.push(t); return { ok: true, status: 200 }; } };
};
const noSites = async () => [];
const setLastRun = (dir, date) => writeFileSync(join(dir, 'lastRun'), date.toISOString());
const json = (dir, name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

function seed(dir, items) {
  let l = { items: {} };
  for (const it of items) l = openItem(l, { person: 'Nolan', summary: 'approval request', link: 'https://x.test/1', openedAt: plusMinutes(t0, -600), ...it });
  // Already alerted and nagged at both stages, so a run that keeps them open posts nothing.
  for (const k of Object.keys(l.items)) l.items[k].nagged = [2, 6];
  saveLedger(dir, l);
}

const read = (id = 'm') => ({ id, labelIds: ['INBOX', 'IMPORTANT'] });
const unread = (id = 'm') => ({ id, labelIds: ['INBOX', 'UNREAD'] });

const run = (dir, over = {}) => runDetailed({ inbox: [], sent: [], now: t0, stateDir: dir, checkSitesImpl: noSites, postImpl: capture().postImpl, ...over });

// --- which threads an item is tracked by -------------------------------------------

test('threadsOf: a thread: key, its stored threads, and the Gmail link all name threads', () => {
  assert.deepEqual(threadsOf({ key: 'thread:0f0f1234abcd5678' }), ['0f0f1234abcd5678']);
  assert.deepEqual(threadsOf({ key: 'dm:x@northwind.example', threads: ['aa', 'bb'] }), ['aa', 'bb']);
  // A Chat DM item with no stored threads: its link's decimal thread-f is the Gmail thread id in hex.
  assert.deepEqual(threadsOf({ key: 'dm:dana@northwind.example', link: dmLink }), [LINK_THREAD_HEX]);
  // A message-level link carries the thread first; only the thread is taken.
  assert.deepEqual(
    threadsOf({ key: 'thread:64ac8f891cb91bff', link: 'https://mail.google.com/mail/?authuser=a#all/thread-f:7254330918842211327|msg-f:7254330918842211999' }),
    ['64ac8f891cb91bff'],
  );
  // The fallback link the Watcher builds itself.
  assert.deepEqual(threadsOf({ key: 'space:Design', link: 'https://mail.google.com/mail/u/0/#all/1a2b3c' }), ['1a2b3c']);
  // Nothing recognisable: no threads, so it can never close by reading.
  assert.deepEqual(threadsOf({ key: 'space:Design', link: 'https://x.test/1' }), []);
});

// --- closing on read ------------------------------------------------------------------

test('an open email item closes once its thread has been read', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seed(dir, [{ key: 'thread:T1' }]);
  const r = await run(dir, { readState: { T1: [read('a'), read('b')] } });
  assert.equal(loadLedger(dir).items['thread:T1'], undefined);
  assert.equal(r.closedRead, 1);
  assert.match(summarize(r), /closed 1 item you had read/);
});

test('one unread message in the thread keeps the item open', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seed(dir, [{ key: 'thread:T1' }]);
  const r = await run(dir, { readState: { T1: [read('a'), unread('b')] } });
  assert.ok(loadLedger(dir).items['thread:T1']);
  assert.equal(r.closedRead, 0);
});

test('a thread missing from readState, an empty one, or a message with no labels keeps the item open', async () => {
  for (const readState of [{}, { T1: [] }, { T1: [{ id: 'a' }] }, { T1: 'read' }, { T1: [null] },
    // A list that is not plainly Gmail's own strings is not proof of reading.
    { T1: [{ id: 'a', labelIds: [] }] },
    { T1: [{ id: 'a', labelIds: ['unread'] }] },
    { T1: [{ id: 'a', labelIds: [{ id: 'UNREAD', name: 'UNREAD' }] }] },
    { T1: [{ id: 'a', labelIds: [null, 1] }] },
    { T1: [{ id: 'a', labelIds: ['INBOX', 7] }] }]) {
    const dir = tmp();
    setLastRun(dir, plusMinutes(t0, -30));
    seed(dir, [{ key: 'thread:T1' }]);
    await run(dir, { readState });
    assert.ok(loadLedger(dir).items['thread:T1'], `closed on ${JSON.stringify(readState)}`);
  }
});

test('a Chat DM item with only a link closes when that notification thread is read', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seed(dir, [{ key: 'dm:dana@northwind.example', link: dmLink }]);
  await run(dir, { readState: { [LINK_THREAD_HEX]: [read()] } });
  assert.equal(loadLedger(dir).items['dm:dana@northwind.example'], undefined);
});

test('an item tracked by several threads closes only when every one is read', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seed(dir, [{ key: 'dm:dana@northwind.example', threads: ['A', 'B'] }]);
  await run(dir, { readState: { A: [read()] } });
  assert.ok(loadLedger(dir).items['dm:dana@northwind.example'], 'B was never checked');
  await run(dir, { readState: { A: [read()], B: [unread()] } });
  assert.ok(loadLedger(dir).items['dm:dana@northwind.example'], 'B is unread');
  await run(dir, { readState: { A: [read()], B: [read()] } });
  assert.equal(loadLedger(dir).items['dm:dana@northwind.example'], undefined);
});

test('an item with no recognisable thread never closes by reading', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seed(dir, [{ key: 'space:Design', link: 'https://x.test/1' }]);
  await run(dir, { readState: { anything: [read()] } });
  assert.ok(loadLedger(dir).items['space:Design']);
});

test('readState.json is read from the state folder, and a bad one closes nothing and says so', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seed(dir, [{ key: 'thread:T1' }, { key: 'thread:T2' }]);
  writeFileSync(join(dir, 'readState.json'), JSON.stringify({ T1: [read()] }));
  await run(dir);
  assert.equal(loadLedger(dir).items['thread:T1'], undefined);
  assert.ok(loadLedger(dir).items['thread:T2']);

  const bad = tmp();
  setLastRun(bad, plusMinutes(t0, -30));
  seed(bad, [{ key: 'thread:T1' }]);
  writeFileSync(join(bad, 'readState.json'), '[1,2]');
  const warnings = [];
  await run(bad, { warn: (w) => warnings.push(w) });
  assert.ok(loadLedger(bad).items['thread:T1']);
  assert.ok(warnings.some((w) => /readState\.json/.test(w)));
});

// --- mail the owner has already read never raises an alert ----------------------------

const colleague = (labelIds) => ({
  id: 'm1', threadId: 'T1', from: 'Nolan <nolan@northwind.example>', to: ['alex@northwind.example'],
  subject: 'Timesheet', date: plusMinutes(t0, -10).toISOString(), snippet: 'Can you send the timesheet?',
  ...(labelIds ? { labelIds } : {}),
});

test('a Tier 1 email already read is not alerted; if it is marked unread again it is raised', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { texts, postImpl } = capture();
  const r = await runDetailed({ inbox: [colleague(['INBOX'])], sent: [], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(texts, []);
  assert.deepEqual(loadLedger(dir).items, {});
  assert.equal(r.alreadyRead, 1);
  assert.match(summarize(r), /1 message you had already read was not raised/);
  // Not marked seen: while it is still in the inbox window, a run that finds it unread raises it.
  await runDetailed({ inbox: [colleague(['INBOX', 'UNREAD'])], sent: [], now: plusMinutes(t0, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(texts.length, 1);
  assert.ok(loadLedger(dir).items['thread:T1']);
});

test('a Tier 1 email that is unread, or whose labels are unknown or odd, is alerted as before', async () => {
  for (const labelIds of [['INBOX', 'UNREAD'], undefined, 'UNREAD', [], ['unread'], [{ id: 'UNREAD' }]]) {
    const dir = tmp();
    setLastRun(dir, plusMinutes(t0, -30));
    const { texts, postImpl } = capture();
    await runOnce({ inbox: [colleague(labelIds)], sent: [], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
    assert.equal(texts.length, 1, `labels ${JSON.stringify(labelIds)}`);
    assert.ok(loadLedger(dir).items['thread:T1']);
  }
});

// --- new items remember their Gmail thread ---------------------------------------------

test('a new item stores its Gmail thread', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { postImpl } = capture();
  await runOnce({ inbox: [colleague(['INBOX', 'UNREAD'])], sent: [], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(loadLedger(dir).items['thread:T1'].threads, ['T1']);
});

const fixturesDir = new URL('../fixtures/', import.meta.url);
const dmFixture = JSON.parse(readFileSync(new URL('manifest.json', fixturesDir), 'utf8')).find((f) => f.name === 'dmFixture');
const dmMail = (threadId, labelIds) => ({
  id: `dm-${threadId}`, threadId, from: 'Google Chat <chat-noreply@google.com>', to: ['alex@northwind.example'],
  subject: dmFixture.subject,
  plaintextBody: readFileSync(new URL(dmFixture.file, fixturesDir), 'utf8'), date: plusMinutes(t0, -5).toISOString(),
  ...(labelIds ? { labelIds } : {}),
});

test('a second Chat notification in another Gmail thread joins the open item, so reading only the first does not close it', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { postImpl } = capture();
  await runOnce({ inbox: [dmMail('A', ['INBOX', 'UNREAD'])], sent: [], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  const [key] = Object.keys(loadLedger(dir).items);
  assert.match(key, /^dm:/);
  assert.deepEqual(loadLedger(dir).items[key].threads, ['A']);
  await runOnce({ inbox: [dmMail('B', ['INBOX', 'UNREAD'])], sent: [], now: plusMinutes(t0, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(loadLedger(dir).items[key].threads, ['A', 'B']);
  // Only the first notification was read: still open.
  await runOnce({ inbox: [], sent: [], readState: { A: [read('dm-A')] }, now: plusMinutes(t0, 60), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.ok(loadLedger(dir).items[key]);
  await runOnce({ inbox: [], sent: [], readState: { A: [read('dm-A')], B: [read('dm-B')] }, now: plusMinutes(t0, 90), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(loadLedger(dir).items[key], undefined);
});

test('triage passes labelIds through, and only a real array', () => {
  const { classified } = triage([
    { id: 'a', threadId: 'A', from: 'x@y.com', subject: 's', labelIds: ['INBOX', 'UNREAD'] },
    { id: 'b', threadId: 'B', from: 'x@y.com', subject: 's', labelIds: 'UNREAD' },
    { id: 'c', threadId: 'C', from: 'x@y.com', subject: 's' },
    // Objects in place of strings: dropping them would leave [] and fake "read". Kept out whole.
    { id: 'd', threadId: 'D', from: 'x@y.com', subject: 's', labelIds: [{ id: 'UNREAD' }] },
  ]);
  assert.deepEqual(classified[0].labelIds, ['INBOX', 'UNREAD']);
  assert.equal(classified[1].labelIds, undefined);
  assert.equal(classified[2].labelIds, undefined);
  assert.equal(classified[3].labelIds, undefined);
});

test('triage lists every open item\'s threads in openThreads.json and resets readState.json', () => {
  const dir = tmp();
  seed(dir, [
    { key: 'thread:0f0f1234abcd5678' },
    { key: 'dm:dana@northwind.example', link: dmLink },
    { key: 'space:Design', link: 'https://x.test/1' },
  ]);
  writeFileSync(join(dir, 'inbox.json'), '[]');
  writeFileSync(join(dir, 'readState.json'), JSON.stringify({ stale: [{ id: 'x', labelIds: [] }] }));
  const r = triageFiles(dir);
  assert.equal(r.openThreads, 2);
  assert.deepEqual(json(dir, 'openThreads.json').sort(), ['0f0f1234abcd5678', LINK_THREAD_HEX].sort());
  // Last run's answers must never close anything this run: the agent writes them afresh.
  assert.deepEqual(json(dir, 'readState.json'), {});
});

test('triage still runs on a corrupt ledger, listing no threads', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'ledger.json'), '{oops');
  writeFileSync(join(dir, 'inbox.json'), '[]');
  triageFiles(dir);
  assert.deepEqual(json(dir, 'openThreads.json'), []);
});

// --- every message must be accounted for ----------------------------------------------

test('an item remembers every message that joined it, and closes only when readState shows each one read', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { postImpl } = capture();
  const msg = (id, mins) => ({ ...colleague(['INBOX', 'UNREAD']), id, date: plusMinutes(t0, mins).toISOString() });
  await runOnce({ inbox: [msg('m1', -10)], sent: [], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  await runOnce({ inbox: [msg('m2', 20)], sent: [], now: plusMinutes(t0, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(loadLedger(dir).items['thread:T1'].messages, ['m1', 'm2']);
  // The agent listed only the first message of the thread: not enough.
  await runOnce({ inbox: [], sent: [], readState: { T1: [read('m1')] }, now: plusMinutes(t0, 60), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.ok(loadLedger(dir).items['thread:T1']);
  await runOnce({ inbox: [], sent: [], readState: { T1: [read('m1'), read('m2')] }, now: plusMinutes(t0, 90), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.equal(loadLedger(dir).items['thread:T1'], undefined);
});

test('a message in this run’s inbox still marked UNREAD vetoes closing its thread', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  seed(dir, [{ key: 'thread:T1' }]);
  const inbox = [{ ...colleague(['INBOX', 'UNREAD']), id: 'm9' }];
  const r = await run(dir, { inbox, readState: { T1: [read('m1')] } });
  assert.ok(loadLedger(dir).items['thread:T1']);
  assert.equal(r.closedRead, 0);
});

test('a merge keeps the thread an old item only had in its link', async () => {
  const dir = tmp();
  setLastRun(dir, plusMinutes(t0, -30));
  const { postImpl } = capture();
  await runOnce({ inbox: [dmMail('A', ['INBOX', 'UNREAD'])], sent: [], now: t0, stateDir: dir, postImpl, checkSitesImpl: noSites });
  // Make it look like an item opened before threads were stored: link only.
  const l = loadLedger(dir);
  const [key] = Object.keys(l.items);
  delete l.items[key].threads;
  delete l.items[key].messages;
  l.items[key].link = dmLink;
  saveLedger(dir, l);
  await runOnce({ inbox: [dmMail('B', ['INBOX', 'UNREAD'])], sent: [], now: plusMinutes(t0, 30), stateDir: dir, postImpl, checkSitesImpl: noSites });
  assert.deepEqual(loadLedger(dir).items[key].threads.sort(), [LINK_THREAD_HEX, 'B'].sort());
});

// --- the ledger refuses what it would never write ---------------------------------------

test('openItem stores threads and messages only as cleaned, non-empty string lists; loadLedger rejects anything else', () => {
  const at = plusMinutes(t0, -10);
  let l = openItem({ items: {} }, { key: 'a', person: 'P', summary: 's', link: 'l', openedAt: at, threads: [' T1 ', 'T1', '', 7], messages: ['m1', 'm1'] });
  assert.deepEqual(l.items.a.threads, ['T1']);
  assert.deepEqual(l.items.a.messages, ['m1']);
  l = openItem(l, { key: 'b', person: 'P', summary: 's', link: 'l', openedAt: at, threads: [], messages: 'm1' });
  assert.equal('threads' in l.items.b, false);
  assert.equal('messages' in l.items.b, false);
  for (const field of ['threads', 'messages']) {
    for (const bad of ['T1', [1], [null], {}]) {
      const dir = tmp();
      writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ items: { k: { key: 'k', nagged: [], [field]: bad } } }));
      assert.throws(() => loadLedger(dir), new RegExp(`"${field}"`), `${field}: ${JSON.stringify(bad)}`);
    }
  }
});
