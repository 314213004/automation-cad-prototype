import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  DEFAULT_LLM_CONFIG,
  maskApiKey,
  mergeLlmConfig,
  publicLlmConfig,
  readLlmConfig,
  saveLlmConfig,
  writeLlmConfig
} from '../../src/agent/llm-config.ts';

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-llm-config-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test('模型配置缺失时返回约定的默认值', () => {
  assert.deepEqual(readLlmConfig(sandbox), {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    maxIterations: 6
  });
  assert.deepEqual(readLlmConfig(sandbox), DEFAULT_LLM_CONFIG);
});

test('公开配置只返回掩码 apiKey，不泄露明文', () => {
  assert.equal(maskApiKey('sk-1234567890abcd'), 'sk-****abcd');
  assert.equal(maskApiKey('abc'), '****');
  const visible = publicLlmConfig({
    baseUrl: 'https://llm.example.com/v1',
    apiKey: 'sk-secret-value-abcd',
    model: 'gpt-test',
    maxIterations: 4
  });
  assert.equal(visible.apiKey, 'sk-****abcd');
  assert.equal(visible.hasApiKey, true);
  assert.equal(JSON.stringify(visible).includes('secret-value'), false);
});

test('agent-llm.json 写入权限为 600 且只保存四个配置字段', { skip: process.platform === 'win32' }, () => {
  const config = {
    baseUrl: 'http://127.0.0.1:9999/v1/',
    apiKey: 'local-key-1234',
    model: 'local-model',
    maxIterations: 3
  };
  writeLlmConfig(sandbox, config);
  assert.deepEqual(readLlmConfig(sandbox), {
    ...config,
    baseUrl: 'http://127.0.0.1:9999/v1'
  });
  const file = join(sandbox, 'agent-llm.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['apiKey', 'baseUrl', 'maxIterations', 'model']);
});

test('空或掩码 apiKey 保存时保留原密钥，新密钥才覆盖', () => {
  const existing = {
    baseUrl: 'https://llm.example.com/v1',
    apiKey: 'old-secret',
    model: 'gpt-test',
    maxIterations: 6
  };
  assert.equal(mergeLlmConfig(existing, { apiKey: '' }).apiKey, 'old-secret');
  assert.equal(mergeLlmConfig(existing, { apiKey: 'sk-****cret' }).apiKey, 'old-secret');
  assert.equal(mergeLlmConfig(existing, { apiKey: 'new-secret' }).apiKey, 'new-secret');

  writeLlmConfig(sandbox, existing);
  const saved = saveLlmConfig(sandbox, {
    baseUrl: existing.baseUrl,
    apiKey: publicLlmConfig(existing).apiKey,
    model: existing.model,
    maxIterations: 8
  });
  assert.equal(saved.apiKey, 'old-secret');
  assert.equal(saved.maxIterations, 8);
});
