import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampToPlate,
  collision,
  findCollisions,
  railSnapY,
  snapMm,
  utilization
} from '../../src/enclosure/layout.ts';

const plate = {
  width: 600,
  height: 800,
  rails: [
    { id: 'rail-1', y: 160, height: 35, label: '导轨 1' },
    { id: 'rail-2', y: 500, height: 35, label: '导轨 2' }
  ]
};

function part(id, x, y, w, h) {
  return { id, partId: id, model: `MODEL-${id}`, x, y, w, h };
}

test('snapMm 默认按 1mm 四舍五入并消除负零', () => {
  assert.equal(snapMm(10.4), 10);
  assert.equal(snapMm(10.5), 11);
  assert.equal(snapMm(-0.4), 0);
  assert.equal(snapMm(-2.6), -3);
});

test('snapMm 支持自定义网格', () => {
  assert.equal(snapMm(7.4, 5), 5);
  assert.equal(snapMm(7.5, 5), 10);
  assert.equal(snapMm(18, 18), 18);
});

test('snapMm 对非法输入返回 0', () => {
  assert.equal(snapMm(Number.NaN), 0);
  assert.equal(snapMm(Number.POSITIVE_INFINITY), 0);
  assert.equal(snapMm(12, 0), 0);
});

test('collision 对真实相交返回 true', () => {
  assert.equal(collision(part('a', 0, 0, 50, 40), part('b', 40, 30, 50, 40)), true);
});

test('collision 水平相切不算碰撞', () => {
  assert.equal(collision(part('a', 0, 0, 50, 40), part('b', 50, 0, 50, 40)), false);
});

test('collision 垂直相切不算碰撞', () => {
  assert.equal(collision(part('a', 0, 0, 50, 40), part('b', 0, 40, 50, 40)), false);
});

test('findCollisions 返回多件之间的全部冲突对', () => {
  const pairs = findCollisions([
    part('a', 0, 0, 20, 20),
    part('b', 10, 10, 20, 20),
    part('c', 25, 25, 20, 20)
  ]);
  assert.deepEqual(pairs, [['a', 'b'], ['b', 'c']]);
});

test('findCollisions 在互不接触时为空', () => {
  assert.deepEqual(findCollisions([
    part('a', 0, 0, 20, 20),
    part('b', 20, 0, 20, 20),
    part('c', 0, 20, 20, 20)
  ]), []);
});

test('utilization 计算单件面积与底板占比', () => {
  const result = utilization([part('a', 20, 20, 100, 100)], plate);
  assert.equal(result.usedMm2, 10_000);
  assert.ok(Math.abs(result.ratio - 10_000 / 480_000) < 1e-12);
});

test('utilization 重叠区域只计一次', () => {
  const result = utilization([
    part('a', 0, 0, 50, 50),
    part('b', 25, 25, 50, 50)
  ], plate);
  assert.equal(result.usedMm2, 4375);
});

test('utilization 只统计底板范围内的面积', () => {
  const result = utilization([part('a', 550, 750, 100, 100)], plate);
  assert.equal(result.usedMm2, 2500);
});

test('utilization 空画布为 0', () => {
  assert.deepEqual(utilization([], plate), { usedMm2: 0, ratio: 0 });
});

test('clampToPlate 钳制负值与越界右下角', () => {
  assert.deepEqual(clampToPlate(part('a', -15, -30, 50, 40), plate), part('a', 0, 0, 50, 40));
  assert.deepEqual(clampToPlate(part('b', 590, 790, 50, 40), plate), part('b', 550, 760, 50, 40));
});

test('clampToPlate 对大于底板的元件贴左上角', () => {
  assert.deepEqual(clampToPlate(part('a', 30, 50, 700, 900), plate), part('a', 0, 0, 700, 900));
});

test('railSnapY 让元件底部贴住导轨底边', () => {
  assert.equal(railSnapY(plate.rails[0], 85), 110);
  assert.equal(railSnapY({ id: 'r', y: 12, height: 35, label: 'r' }, 80), -33);
});

test('旋转 90° 交换宽高后产生新的碰撞', () => {
  const flat = part('a', 0, 0, 100, 10);
  const neighbor = part('b', 5, 20, 10, 10);
  assert.equal(collision(flat, neighbor), false);
  const rotated = { ...flat, w: flat.h, h: flat.w };
  assert.equal(collision(rotated, neighbor), true);
  assert.deepEqual(clampToPlate(rotated, plate), rotated);
});
