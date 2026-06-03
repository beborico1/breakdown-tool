// Persistent queues of single-card Anki ops that failed because AnkiConnect
// was unreachable. Drained opportunistically when the user comes back online.
// Two queues: pending adds and pending removals.

const QUEUE_KEY = 'ankiPendingQueue';
const REMOVE_KEY = 'ankiPendingRemovals';
const QUEUE_CAP = 200;

async function readQueue(key) {
  try {
    const obj = await chrome.storage.local.get(key);
    const q = obj?.[key];
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

async function writeQueue(key, q) {
  try {
    await chrome.storage.local.set({ [key]: q.slice(-QUEUE_CAP) });
  } catch {}
}

export async function enqueueAnkiAdd(card) {
  const q = await readQueue(QUEUE_KEY);
  q.push({ ...card, addedAt: Date.now() });
  await writeQueue(QUEUE_KEY, q);
}

export async function enqueueAnkiRemove(card) {
  const q = await readQueue(REMOVE_KEY);
  q.push({ ...card, addedAt: Date.now() });
  await writeQueue(REMOVE_KEY, q);
}

export async function getQueueSize() {
  return (await readQueue(QUEUE_KEY)).length;
}

// Drop any queued add(s) for a word that was only queued (Anki offline) and
// never actually written, so "Remove from Anki" can cancel a pending add.
export async function dequeueAnkiAdd(word) {
  if (!word) return 0;
  const q = await readQueue(QUEUE_KEY);
  const remaining = q.filter((card) => card?.word !== word);
  const removed = q.length - remaining.length;
  if (removed > 0) await writeQueue(QUEUE_KEY, remaining);
  return removed;
}

// flushFn(card) -> Promise<{ ok: boolean, retriable: boolean }>
// retriable=false means a non-transient error (e.g. duplicate) — drop the card
// but keep flushing the rest. retriable=true means stop and try again later.
async function flushQueue(key, flushFn) {
  const q = await readQueue(key);
  if (!q.length) return { flushed: 0, remaining: 0 };

  let flushed = 0;
  const remaining = [];
  let stopped = false;

  for (let i = 0; i < q.length; i++) {
    const card = q[i];
    if (stopped) {
      remaining.push(card);
      continue;
    }
    try {
      const res = await flushFn(card);
      if (res?.ok) {
        flushed += 1;
      } else if (res?.retriable) {
        remaining.push(card);
        stopped = true;
      }
      // non-retriable failure → drop card (don't push)
    } catch {
      remaining.push(card);
      stopped = true;
    }
  }

  await writeQueue(key, remaining);
  return { flushed, remaining: remaining.length };
}

export function flushAnkiQueue(flushFn) {
  return flushQueue(QUEUE_KEY, flushFn);
}

export function flushAnkiRemoveQueue(flushFn) {
  return flushQueue(REMOVE_KEY, flushFn);
}
