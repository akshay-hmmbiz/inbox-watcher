// Inbox Watcher. Created by Akshay Bhimani, Senior SEO Strategist (https://github.com/akshay-hmmbiz).
// Copyright (c) 2026 Akshay Bhimani. MIT licence: keep this notice in every copy.
// Original source: https://github.com/akshay-hmmbiz/inbox-watcher
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const LEDGER_FILE = 'ledger.json';
const HOUR_MS = 60 * 60 * 1000;
const NAG_STAGES = [2, 6]; // hours after an item opens, ascending
const RENAME_BACKOFF_MS = [50, 150]; // delays before the 2nd and 3rd attempts

const empty = () => ({ items: {} });
const copy = (ledger) => structuredClone(ledger);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One conversation, one item. A key that is already open leaves the ledger
// unchanged: the original openedAt is what the nag schedule runs from, and the
// original waitingFor is kept with it. waitingFor is optional, and is stored only
// when it is a non-empty string, so an item opened without one has the same shape as before.
// threads and messages are optional too: the Gmail thread ids and message ids the item came
// from, kept so it can close once the owner has read them all. Each is stored only when it
// holds at least one non-empty string.
export function openItem(ledger, { key, person, summary, link, openedAt, waitingFor, importance, threads, messages }) {
  const next = copy(ledger);
  if (next.items[key]) return next;
  next.items[key] = {
    key,
    person,
    summary,
    link,
    openedAt: new Date(openedAt).toISOString(),
    nagged: [],
  };
  // The writer must never produce what loadLedger rejects, so only a non-empty string is kept.
  if (typeof waitingFor === 'string' && waitingFor.trim() !== '') next.items[key].waitingFor = waitingFor;
  // Optional too, and only one of the four known words is ever stored.
  if (['top', 'high', 'medium', 'low'].includes(importance)) next.items[key].importance = importance;
  // The Gmail threads the item came from, so it can close once the owner has read them all.
  const own = cleanIds(threads);
  if (own.length) next.items[key].threads = own;
  // And the Gmail message ids behind it: each must be seen read before reading closes it.
  const ids = cleanIds(messages);
  if (ids.length) next.items[key].messages = ids;
  return next;
}

const cleanIds = (list) => (Array.isArray(list)
  ? [...new Set(list.filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()))]
  : []);

// Every Gmail thread an open item is tracked by, deduplicated: the threads stored on it, the
// thread in a `thread:` key, and the thread in its Gmail link. An item opened before threads
// were stored has only the link. Gmail's web links carry the thread as a decimal `thread-f:`
// number, which is the API's hex thread id; the Watcher's own fallback link carries the hex id
// directly. An item with none of these has no threads and can never close by reading.
export function threadsOf(item) {
  const out = cleanIds(item?.threads);
  const key = String(item?.key ?? '');
  if (key.startsWith('thread:') && key.length > 'thread:'.length) out.push(key.slice('thread:'.length));
  const link = String(item?.link ?? '');
  const f = /[#/]all\/thread-f:(\d{1,20})/.exec(link);
  if (f) out.push(BigInt(f[1]).toString(16));
  else {
    const hex = /\/mail\/u\/\d+\/#all\/([0-9a-f]{6,32})$/i.exec(link);
    if (hex) out.push(hex[1].toLowerCase());
  }
  return [...new Set(out)];
}

export function closeItem(ledger, key) {
  const next = copy(ledger);
  delete next.items[key];
  return next;
}

// Returns each open item whose highest crossed nag stage has not been sent,
// with that stage attached. A single nag per item per check: if the 6h stage
// is due, the 2h stage is not sent on its own.
export function dueForNag(ledger, now) {
  const due = [];
  for (const item of Object.values(ledger.items)) {
    const ageHours = (now.getTime() - new Date(item.openedAt).getTime()) / HOUR_MS;
    const crossed = NAG_STAGES.filter((h) => ageHours >= h);
    if (crossed.length === 0) continue;
    const stage = crossed[crossed.length - 1];
    if (item.nagged.includes(stage)) continue;
    due.push({ ...item, nagged: [...item.nagged], stage });
  }
  return due;
}

// Sending a stage also marks every earlier stage as sent, so a skipped
// stage can never fire late (a 2h nag after the 6h one).
export function markNagged(ledger, key, stage) {
  const next = copy(ledger);
  const item = next.items[key];
  if (item) {
    for (const s of NAG_STAGES) {
      if (s <= stage && !item.nagged.includes(s)) item.nagged.push(s);
    }
  }
  return next;
}

// Rejects valid JSON that is not a ledger, so a bad file fails here with a
// named error instead of as a TypeError deep inside dueForNag or openItem.
function checkLedgerShape(value, file) {
  const fail = (why) => {
    throw new Error(`${file} is not a valid ledger: ${why}`);
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('must be an object');
  const { items } = value;
  if (items === null || typeof items !== 'object' || Array.isArray(items)) fail('"items" must be an object');
  for (const [key, item] of Object.entries(items)) {
    if (item === null || typeof item !== 'object') fail(`item "${key}" must be an object`);
    if (typeof item.key !== 'string') fail(`item "${key}" has no string "key"`);
    if (!Array.isArray(item.nagged)) fail(`item "${key}" has no "nagged" array`);
    if (item.waitingFor !== undefined && typeof item.waitingFor !== 'string') {
      fail(`item "${key}" has a "waitingFor" that is not a string`);
    }
    for (const field of ['threads', 'messages']) {
      const v = item[field];
      if (v !== undefined && (!Array.isArray(v) || v.some((t) => typeof t !== 'string'))) {
        fail(`item "${key}" has a "${field}" that is not a list of strings`);
      }
    }
  }
  return value;
}

export function loadLedger(stateDir) {
  const file = join(stateDir, LEDGER_FILE);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return empty();
    throw err;
  }
  return checkLedgerShape(JSON.parse(text), file);
}

// Write to a temp file in the same directory, then rename over the target.
// The rename is atomic, so an interrupted run leaves either the old ledger
// or the new one, never a half-written file. A rename can fail transiently
// on Windows when a scanner holds the target, so it is retried; the injected
// rename and sleep exist so tests can drive that path.
export function saveLedger(stateDir, ledger, { rename = renameSync, sleep = sleepSync } = {}) {
  mkdirSync(stateDir, { recursive: true });
  const target = join(stateDir, LEDGER_FILE);
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    for (let attempt = 0; ; attempt += 1) {
      try {
        rename(tmp, target);
        return;
      } catch (err) {
        if (attempt >= RENAME_BACKOFF_MS.length) throw err;
        sleep(RENAME_BACKOFF_MS[attempt]);
      }
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* temp file may not exist */ }
    throw err;
  }
}
