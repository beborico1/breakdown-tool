// Persistent queue of single-card Anki adds that failed because AnkiConnect
// was unreachable. Drained opportunistically when the user comes back online.

const QUEUE_KEY = 'ankiPendingQueue';
const QUEUE_CAP = 200;

async function readQueue() {
  try {
    const obj = await chrome.storage.local.get(QUEUE_KEY);
    const q = obj?.[QUEUE_KEY];
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

async function writeQueue(q) {
  try {
    await chrome.storage.local.set({ [QUEUE_KEY]: q.slice(-QUEUE_CAP) });
  } catch {}
}

export async function enqueueAnkiAdd(card) {
  const q = await readQueue();
  q.push({ ...card, addedAt: Date.now() });
  await writeQueue(q);
}

export async function getQueueSize() {
  return (await readQueue()).length;
}

// flushFn(card) -> Promise<{ ok: boolean, retriable: boolean }>
// retriable=false means a non-transient error (e.g. duplicate) — drop the card
// but keep flushing the rest. retriable=true means stop and try again later.
export async function flushAnkiQueue(flushFn) {
  const q = await readQueue();
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

  await writeQueue(remaining);
  return { flushed, remaining: remaining.length };
}
