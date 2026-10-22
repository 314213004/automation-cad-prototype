import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SimPlcAdapter } from '../../src/plc/sim.ts';
import { runSequence } from '../../src/commission/sequence.ts';
import {
  COMMISSION_CASES,
  COMMISSION_POINTS,
  POWER_UP_STEPS,
  createSimulatorConfig
} from '../../src/commission/standard.ts';

test('内置 IO 规划共 28 点位且 ID 唯一', () => {
  assert.equal(COMMISSION_POINTS.length, 28);
  assert.equal(new Set(COMMISSION_POINTS.map((point) => point.id)).size, 28);
  assert.ok(COMMISSION_POINTS.some((point) => point.id === 'X8' && point.name.includes('安全门')));
  assert.ok(COMMISSION_POINTS.some((point) => point.id === 'AO0' && point.writable === true));
});

test('仿真器跑通 6 步上电 + 3 条用例', async () => {
  const sim = new SimPlcAdapter();
  await sim.connect(createSimulatorConfig());
  const io = {
    read: (id) => sim.read(id),
    write: (id, value) => sim.write(id, value),
    readAll: () => sim.readAll(),
    pollMs: 20
  };
  try {
    assert.equal(POWER_UP_STEPS.length, 6);
    const power = await runSequence(POWER_UP_STEPS, io);
    assert.equal(power.pass, true, power.failure?.message);
    assert.equal(power.results.length, 6);
    assert.equal(COMMISSION_CASES.length, 3);
    for (const testCase of COMMISSION_CASES) {
      const result = await runSequence(testCase.steps, io);
      assert.equal(result.pass, true, `${testCase.name}: ${result.failure?.message}`);
    }
    const values = await sim.readAll();
    assert.equal(values.Y0, true);
    assert.equal(values.Y5, true);
  } finally {
    await sim.disconnect();
  }
});
