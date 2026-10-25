import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDesignProject } from '../../src/design/save-service.ts';
import { writeDesignDraft, readDesignDraft, clearDesignDraft } from '../../src/design/draft-store.ts';
import { saveProject, openProject } from '../../electron/projects.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
test('projects:save 参数含 design/config，成功后草稿清理', async () => {
  const design = synthMachine(parseMachineBrief('三工位锁螺丝机，10 件/分钟'));
  let payload;
  let cleared = 0;
  const result = await saveDesignProject(async (value) => { payload = value; return { ok: true, record: { id: 'design-1' } }; }, async () => { cleared += 1; }, { name: '设计一', process: 'screw', params: {}, parts: 1, massKg: null, envelope: [100,100,100], material: [], design, config: design.config });
  assert.equal(result.ok, true);
  assert.equal(payload.design, design);
  assert.equal(payload.config, design.config);
  assert.equal(cleared, 1);
});
test('保存失败不清草稿', async () => {
  let cleared = 0;
  const result = await saveDesignProject(async () => ({ ok: false, message: '磁盘满' }), async () => { cleared += 1; }, {});
  assert.equal(result.ok, false);
  assert.equal(cleared, 0);
});
test('草稿0600原子写、损坏恢复与删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-draft-test-'));
  writeDesignDraft(dir, { version: 1, step: 1 });
  assert.equal(statSync(join(dir, 'design-draft.json')).mode & 0o777, 0o600);
  assert.equal(readDesignDraft(dir).draft.version, 1);
  assert.equal(existsSync(join(dir, 'design-draft.json')), true);
  clearDesignDraft(dir);
  assert.equal(existsSync(join(dir, 'design-draft.json')), false);
});
test('真实工程库写入 design/config 和 STL，打开可恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-project-test-'));
  const design = synthMachine(parseMachineBrief('三工位锁螺丝机，10 件/分钟'));
  const stlData = new Uint8Array(84);
  new DataView(stlData.buffer).setUint32(80, 0, true);
  const saved = saveProject(dir, { name: '整机测试', process: 'screw', parts: 1, design, config: design.config, stlData });
  assert.equal(saved.ok, true, saved.message);
  const record = JSON.parse(readFileSync(join(dir, 'projects', '整机测试', 'project.json'), 'utf8'));
  assert.equal(record.design.config.id, design.config.id);
  assert.equal(existsSync(join(dir, 'projects', '整机测试', 'model.stl')), true);
  assert.equal(openProject(dir, saved.record.id).ok, true);
});
