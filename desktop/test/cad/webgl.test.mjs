import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeWebGL } from '../../src/cad/webgl.ts';

test('probeWebGL: webgl2 可用时返回成功', () => {
  const calls = [];
  const result = probeWebGL(() => ({
    getContext(id) {
      calls.push(id);
      return id === 'webgl2' ? { version: 2 } : null;
    }
  }));
  assert.equal(result.ok, true);
  assert.equal(result.contextId, 'webgl2');
  assert.deepEqual(calls, ['webgl2']);
});

test('probeWebGL: 所有上下文均为空时返回可读失败原因', () => {
  const result = probeWebGL(() => ({
    getContext() {
      return null;
    }
  }));
  assert.equal(result.ok, false);
  assert.equal(result.contextId, undefined);
  assert.match(result.reason, /未提供 WebGL 上下文/);
  assert.match(result.reason, /webgl2/);
  assert.match(result.reason, /experimental-webgl/);
});

test('probeWebGL: 创建画布抛异常时不向上抛', () => {
  const result = probeWebGL(() => {
    throw new Error('canvas 不可用');
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /创建探测画布失败：canvas 不可用/);
});
