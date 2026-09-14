import assert from 'node:assert/strict';
import test from 'node:test';

import { createHostPacer } from '../../providers/_host-pacer.mjs';

test('runs queued tasks in FIFO order with only one task in flight', async () => {
  const pacer = createHostPacer();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = pacer.pace(async () => {
    order.push('first started');
    await firstGate;
    order.push('first finished');
  });
  const second = pacer.pace(() => {
    order.push('second started');
  });

  await Promise.resolve();
  assert.deepEqual(order, ['first started']);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first started', 'first finished', 'second started']);
});

test('waits the remaining minimum interval from the prior task start', async () => {
  let clock = 0;
  const waits = [];
  const pacer = createHostPacer({ minimumIntervalMs: 1000, now: () => clock });
  const ctx = {
    sleep(ms) {
      waits.push(ms);
      clock += ms;
    },
  };

  await pacer.pace(() => {}, ctx);
  await pacer.pace(() => {}, ctx);

  assert.deepEqual(waits, [1000]);
});

test('continues with later tasks after a task rejects', async () => {
  const pacer = createHostPacer();
  const order = [];

  const failed = pacer.pace(() => {
    order.push('failed');
    throw new Error('expected failure');
  });
  const completed = pacer.pace(() => {
    order.push('completed');
    return 'ok';
  });

  await assert.rejects(failed, /expected failure/);
  assert.equal(await completed, 'ok');
  assert.deepEqual(order, ['failed', 'completed']);
});
