// Serializes requests that share a host without letting a failed request block
// the requests queued behind it.

import { sleep } from './_http.mjs';

export function createHostPacer({ minimumIntervalMs = 0, now = () => performance.now() } = {}) {
  let tail = Promise.resolve();
  let lastStartedAt = null;

  function pace(task, ctx) {
    const run = async () => {
      if (lastStartedAt !== null) {
        const waitMs = Math.max(0, minimumIntervalMs - (now() - lastStartedAt));
        if (waitMs > 0) await sleep(waitMs, ctx);
      }
      lastStartedAt = now();
      return await task();
    };

    const result = tail.then(run);
    tail = result.catch(() => {});
    return result;
  }

  return { pace };
}
