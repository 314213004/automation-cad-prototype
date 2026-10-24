import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ORBIT_STORE_KEY,
  loadOrbit,
  parseStoredOrbit,
  persistableOverrides,
  saveOrbit,
  serializeOrbit
} from '../../src/orbit/persist.ts';
import { assemblyViolation, buildAssembly } from '../../src/orbit/model.ts';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); }
  };
}

test('只持久化内置零件、参数表内、范围内的覆盖；插入件与坏值丢弃', () => {
  const { overrides, dropped } = persistableOverrides({
    base: { thickness: 12, bogus: 3 },
    carriage: { x: 120 },
    ins1: { w: 40 },
    rail: { height: 1 },
    sensor: { z: Number.NaN }
  });
  assert.deepEqual(overrides, { base: { thickness: 12 }, carriage: { x: 120 } });
  assert.deepEqual(dropped.sort(), ['base.bogus', 'ins1', 'rail.height', 'sensor.z']);
});

test('保存 → 读回往返一致（模拟重启：新的读取方只拿到存储）', () => {
  const storage = memoryStorage();
  assert.ok(saveOrbit(storage, { base: { thickness: 12 }, carriage: { x: 120 }, ins2: { h: 9 } }, new Date('2026-10-24T02:00:00Z')));
  const raw = JSON.parse(storage.getItem(ORBIT_STORE_KEY));
  assert.equal(raw.version, 1);
  assert.equal(raw.savedAt, '2026-10-24T02:00:00.000Z');
  const loaded = loadOrbit(storage);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.overrides, { base: { thickness: 12 }, carriage: { x: 120 } });
  const asm = buildAssembly({ bore: 32, stroke: 50, inserted: [], overrides: loaded.overrides });
  assert.equal(asm.parts.find((p) => p.id === 'rail').bbox.min[2], 12);
  assert.equal(asm.sectionX, 120);
});

test('全部恢复默认后删除存储键；没有存储时安全返回', () => {
  const storage = memoryStorage({ [ORBIT_STORE_KEY]: serializeOrbit({ base: { thickness: 12 } }) });
  assert.ok(saveOrbit(storage, {}));
  assert.equal(storage.getItem(ORBIT_STORE_KEY), null);
  assert.equal(saveOrbit(null, {}), false);
  assert.deepEqual(loadOrbit(null), { ok: true, overrides: {}, dropped: [] });
  assert.deepEqual(loadOrbit(storage), { ok: true, overrides: {}, dropped: [] });
});

test('坏数据整体拒绝：非 JSON、版本不符、缺字段、装配不合理（滑台脱轨）', () => {
  assert.equal(parseStoredOrbit('{oops').ok, false);
  assert.equal(parseStoredOrbit(JSON.stringify({ version: 2, overrides: {} })).ok, false);
  assert.equal(parseStoredOrbit(JSON.stringify({ version: 1 })).ok, false);
  const derailed = parseStoredOrbit(JSON.stringify({ version: 1, overrides: { carriage: { x: 500 } } }));
  assert.equal(derailed.ok, false);
  assert.match(derailed.reason, /脱出导轨/);
  assert.deepEqual(derailed.overrides, {});
});

test('存储读写抛异常时不影响编辑', () => {
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
  assert.equal(loadOrbit(broken).ok, false);
  assert.equal(saveOrbit(broken, { base: { thickness: 12 } }), false);
});

test('assemblyViolation：编辑校验与存储恢复共用同一套装配规则', () => {
  assert.equal(assemblyViolation({ inserted: [], overrides: {} }), null);
  assert.match(assemblyViolation({ inserted: [], overrides: { rail: { length: 300 } } }), /导轨长度/);
  assert.match(assemblyViolation({ inserted: [], overrides: { rail: { width: 80 } } }), /导轨宽度/);
  assert.match(assemblyViolation({ inserted: [], overrides: { carriage: { length: 200 } } }), /滑台长度/);
});
