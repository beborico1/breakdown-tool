/**
 * Concurrency-limited async queue.
 *
 * The offscreen kuromoji tokenizer is single-threaded, so capping the number of
 * in-flight analyze calls prevents flooding the message channel on heavy pages;
 * excess jobs wait for a slot. Each job is a thunk returning a promise.
 *
 * @param {{concurrency?: number}} [opts]
 */
export function createAnalyzeQueue({ concurrency = 3 } = {}) {
  let active = 0;
  const q = [];

  function pump() {
    while (active < concurrency && q.length > 0) {
      const job = q.shift();
      active++;
      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => { active--; pump(); });
    }
  }

  return {
    /**
     * @param {() => Promise<any>} run - thunk to execute when a slot is free
     * @returns {Promise<any>}
     */
    enqueue(run) {
      return new Promise((resolve, reject) => {
        q.push({ run, resolve, reject });
        pump();
      });
    },
    get pending() { return q.length; },
    get active() { return active; },
  };
}
