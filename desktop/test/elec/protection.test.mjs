import assert from 'node:assert/strict';
import { test } from 'node:test';
import { protectionRows, selectMotorProtection } from '../../src/elec/protection.ts';

test('0.37 kW 三相：I≈0.7 A，落 C1 档', () => {
  const sel = selectMotorProtection(0.37);
  assert.equal(sel.currentA, 0.7);
  assert.equal(sel.breaker, 'iC65N 3P C1');
  assert.equal(sel.contactor, 'LC1D09');
  assert.match(sel.thermal, /LRD05/);
});

test('2.2 kW：I≈4.2 A，断路器 C6、接触器 LC1D09、热继 LRD10', () => {
  const sel = selectMotorProtection(2.2);
  assert.equal(sel.currentA, 4.2);
  assert.equal(sel.breaker, 'iC65N 3P C6');
  assert.equal(sel.contactor, 'LC1D09');
  assert.match(sel.thermal, /4–6A/);
});

test('电流随功率单调上升，档位不会跳档', () => {
  let last = 0;
  for (const kw of [0.04, 0.37, 0.75, 1.5, 2.2, 4, 7.5]) {
    const sel = selectMotorProtection(kw);
    assert.ok(sel.currentA > last, `${kw} kW 电流没有上升`);
    last = sel.currentA;
    assert.ok(sel.breaker.length > 0 && sel.thermal.length > 0);
  }
});

test('非法功率回退 0.37 kW，不产出 NaN 型号', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const sel = selectMotorProtection(bad);
    assert.ok(Number.isFinite(sel.currentA) && sel.currentA > 0);
    assert.match(sel.breaker, /iC65N/);
  }
});

test('元件表行：位号唯一、含光电数量、按数量合并', () => {
  const rows = protectionRows(selectMotorProtection(0.37), { sensors: 2 });
  const tags = rows.map((row) => row[0]);
  assert.equal(new Set(tags).size, tags.length);
  assert.ok(tags.includes('-SB1') && tags.includes('-SB3') && tags.includes('-HL1') && tags.includes('-FU1'));
  const sensorRow = rows.find((row) => row[0].startsWith('-PE1'));
  assert.equal(sensorRow?.[2], '2');
});

test('没有光电时不生成光电行', () => {
  const rows = protectionRows(selectMotorProtection(0.37), { sensors: 0 });
  assert.ok(!rows.some((row) => row[0].startsWith('-PE')));
});

test('热继整定值必须落在所选档范围内（0.04 kW 不能再选 0.63–1 A 档）', () => {
  const tiny = selectMotorProtection(0.04);
  const range = tiny.thermal.match(/([\d.]+)–([\d.]+)A/);
  assert.ok(range, `档位缺少范围：${tiny.thermal}`);
  const low = Number(range[1]);
  const high = Number(range[2]);
  assert.ok(tiny.thermalSetA >= low && tiny.thermalSetA <= high, `整定 ${tiny.thermalSetA} 超出 ${low}–${high}`);
});

test('元件表已取消 -KA1（自锁用 KM1 辅助触点），并保留 -FU1', () => {
  const tags = protectionRows(selectMotorProtection(0.37), { sensors: 2 }).map((row) => row[0]);
  assert.ok(!tags.includes('-KA1'));
  assert.ok(tags.includes('-FU1'));
  assert.ok(tags.includes('-SB2') && tags.includes('-SB3'));
});
