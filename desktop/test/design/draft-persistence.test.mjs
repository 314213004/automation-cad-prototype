import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftPersistence } from '../../src/design/draft-persistence.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const clone = (value) => structuredClone(value);

test('保存串行执行且会在进行中编辑后继续写入最新快照', async () => {
  const gate = deferred();
  const writes = [];
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const persistence = new DraftPersistence(async (snapshot) => {
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    writes.push(snapshot);
    if (writes.length === 1) await gate.promise;
    activeWrites -= 1;
  }, clone);
  const first = { value: 1 };

  persistence.markDirty(first);
  first.value = 99;
  const initialFlush = persistence.flush();
  await Promise.resolve();
  persistence.markDirty({ value: 2 });
  const secondFlush = persistence.flush();
  gate.resolve();
  await Promise.all([initialFlush, secondFlush]);

  assert.deepEqual(writes, [{ value: 1 }, { value: 2 }]);
  assert.equal(maxActiveWrites, 1);
  assert.equal(persistence.state.status, 'saved');
  assert.equal(persistence.hasPendingChanges, false);
});

test('保存失败时保留未保存状态，重试成功后明确标记已保存', async () => {
  const states = [];
  let attempts = 0;
  const persistence = new DraftPersistence(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('磁盘满');
  }, clone, (state) => states.push(state));

  persistence.markDirty({ value: '最新编辑' });
  await assert.rejects(persistence.flush(), /磁盘满/);
  assert.equal(persistence.state.status, 'error');
  assert.deepEqual(persistence.state, { status: 'error', error: '磁盘满' });
  assert.equal(persistence.hasPendingChanges, true);

  await persistence.flush();
  assert.equal(attempts, 2);
  assert.equal(persistence.state.status, 'saved');
  assert.equal(persistence.hasPendingChanges, false);
  assert.ok(states.some((state) => state.status === 'saving'));
  assert.ok(states.some((state) => state.status === 'error'));
});

test('旧快照失败但期间已有新编辑时自动保存最新版本', async () => {
  const firstWrite = deferred();
  const writes = [];
  const persistence = new DraftPersistence(async (snapshot) => {
    writes.push(snapshot);
    if (writes.length === 1) await firstWrite.promise;
  }, clone);

  persistence.markDirty({ value: 1 });
  const flush = persistence.flush();
  await Promise.resolve();
  persistence.markDirty({ value: 2 });
  firstWrite.reject(new Error('旧快照失败'));

  await flush;
  assert.deepEqual(writes, [{ value: 1 }, { value: 2 }]);
  assert.equal(persistence.state.status, 'saved');
  assert.equal(persistence.hasPendingChanges, false);
});
