import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const html = readFileSync(resolve(REPO_ROOT, 'index.html'), 'utf8');
const ctxbar = html.slice(html.indexOf('<div class="ctxbar"'), html.indexOf('<main class="main"'));

const toolButtons = [...ctxbar.matchAll(/<button class="tool([^"]*)"([^>]*)>/g)].map((m) => ({
  classNames: m[1],
  attrs: m[2]
}));

test('上下文工具条：未接线的按钮必须禁用并标注「尚未实现」', () => {
  // 每个分组第一个按钮带 is-active，是当前模式的指示位，保留可点（不影响任何状态）。
  const placeholders = toolButtons.filter((b) => !b.attrs.includes('data-act') && !b.classNames.includes('is-active'));
  assert.ok(placeholders.length > 0, '应存在占位按钮');
  for (const button of placeholders) {
    assert.match(button.attrs, /\bdisabled\b/, `占位按钮应禁用：${button.attrs}`);
    assert.match(button.attrs, /title="尚未实现"/, `占位按钮应标注尚未实现：${button.attrs}`);
  }
});

test('上下文工具条：已实现的按钮（data-act）保持可用', () => {
  const implemented = toolButtons.filter((b) => b.attrs.includes('data-act'));
  assert.ok(implemented.length > 0, '应存在已实现按钮');
  for (const button of implemented) {
    assert.doesNotMatch(button.attrs, /\bdisabled\b/, `已实现按钮不应禁用：${button.attrs}`);
  }
});

test('上下文工具条：每个分组保留一个激活态按钮作为当前模式指示', () => {
  const groups = ctxbar.split('<div class="ctx"').slice(1);
  for (const group of groups) {
    assert.match(group, /class="tool is-active"/, '每个上下文分组应有一个 is-active 按钮');
  }
});

test('上下文工具条：开关类占位（吸附/剖切 等）必须禁用', () => {
  const checkboxes = [...ctxbar.matchAll(/<input type="checkbox"([^>]*)>/g)].map((m) => m[1]);
  assert.ok(checkboxes.length > 0, '应存在开关');
  for (const attrs of checkboxes) {
    assert.match(attrs, /\bdisabled\b/, `占位开关应禁用：${attrs}`);
  }
});
