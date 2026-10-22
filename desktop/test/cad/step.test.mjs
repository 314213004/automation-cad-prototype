import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseOcctBuffer } from '../../src/cad/step.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, '../fixtures/cube.stp');

function bounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i + axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max, size: max.map((value, axis) => value - min[axis]) };
}

test('cube.stp 解析为 300×300×300 mm 与 12 个三角面', async () => {
  const data = readFileSync(fixture);
  const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const result = await parseOcctBuffer(arrayBuffer, 'cube.stp');

  assert.equal(result.stats.meshCount, 1);
  assert.equal(result.stats.triangleCount, 12);
  assert.equal(result.meshes[0].indices.length, 36);
  const box = bounds(result.meshes[0].positions);
  for (const size of box.size) {
    assert.equal(size.toFixed(3), '300.000');
  }
  assert.match(result.meshes[0].name, /cube/i);
});
