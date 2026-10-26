/**
 * 软件模块管线 → 电气出图：机型方案的 BOM 草稿/功率估算必须一路传到电气图。
 *
 * 断点回归：apply_machine_design 落盘的是完整方案，但渲染桥 applyMachineConfig 以前只收 config，
 * 电气图于是把每个旋转轴按 0.4 kW 缺省伺服、通用型号出图。这里用 fake bridge 截下真实载荷，
 * 喂给渲染层同一个 ElecSourceTracker（extension.ts 里用的那个），断言图上的功率/型号来自 BOM。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createAgentCommandBus, RendererBridge } from '../../src/agent/commands.ts';
import { readActiveMachineDesign } from '../../src/machine/store.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { renderElecDrawing } from '../../src/elec/drawing.ts';
import { drawingNoFor } from '../../src/elec/adapters.ts';
import { ElecSourceTracker, MACHINE_CONFIG_ONLY_NOTE, pickMachineElecPayload } from '../../src/elec/source.ts';

const CASE = JSON.parse(readFileSync(new URL('../../../docs/desktop/eval/machine-case.json', import.meta.url), 'utf8'));
const DEFAULT_NOTE = /功率无数据，按 0\.4 kW 出图/;
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup(handler = () => undefined) {
  const root = mkdtempSync(join(tmpdir(), 'cad-elec-source-'));
  roots.push(root);
  const calls = [];
  const bridge = {
    async call(method, args) {
      calls.push({ method, args });
      const custom = handler(method, args);
      if (custom !== undefined) return custom;
      if (method === 'applyMachineConfig') return { ok: true };
      if (method === 'appendMachineBomRows') return { ok: true, added: args?.rows?.length ?? 0 };
      if (method === 'removeMachineBomRows') return { ok: true, removed: 1 };
      return { ok: false, message: `unexpected ${method}` };
    }
  };
  const bus = createAgentCommandBus({ listParts: () => [] }, bridge, {
    userDataRoot: root,
    exportsRoot: join(root, 'exports'),
    now: () => new Date('2026-10-25T13:00:00Z')
  });
  return { root, calls, bus };
}

const refreshes = (calls) => calls.filter((call) => call.method === 'applyMachineConfig');
const tracker = () => new ElecSourceTracker(renderElecDrawing, () => '2026-10-25');

function caseDesign() {
  return structuredClone(CASE.design);
}

function bomServo(design, name) {
  return design.bomDraft.items.find((item) => item.name === name && item.model && !item.pendingSelection);
}

test('apply_machine_design：渲染桥载荷带归一化后的 bomDraft 与 power', async () => {
  const { calls, bus } = setup();
  const result = await bus.execute('apply_machine_design', { design: caseDesign(), withGeometry: false });
  assert.equal(result.ok, true);
  const [refresh] = refreshes(calls);
  assert.ok(refresh, '应调用 applyMachineConfig');
  assert.equal(refresh.args.config.id, 'design-screw-6st');
  assert.equal(refresh.args.machineId, 'design-screw-6st');
  assert.ok(Array.isArray(refresh.args.design?.bomDraft?.items), '载荷缺 design.bomDraft');
  assert.ok(Array.isArray(refresh.args.design?.power?.byGroup), '载荷缺 design.power');
  // 与落盘方案一致（同一份归一化结果）
  const stored = JSON.parse(readFileSync(result.data.designPath, 'utf8'));
  assert.deepEqual(refresh.args.design.bomDraft, stored.bomDraft);
  assert.deepEqual(refresh.args.design.power, stored.power);
  // 走 JSON 序列化（RendererBridge 用 executeJavaScript 传参）后形状仍被渲染层接受
  const roundTrip = pickMachineElecPayload(JSON.parse(JSON.stringify(refresh.args.design)));
  assert.ok(roundTrip.bomDraft && roundTrip.power);
});

test('六工位锁螺丝：电气图主回路电机功率/型号来自方案 BOM，不再按 0.4 kW 缺省出图', async () => {
  const { calls, bus } = setup();
  await bus.execute('apply_machine_design', { design: caseDesign(), withGeometry: false });
  const payload = JSON.parse(JSON.stringify(refreshes(calls)[0].args));
  const sources = tracker();
  sources.useMachine(payload.config, payload.design);
  const drawing = sources.drawing();
  assert.ok(drawing);
  const motorRow = bomServo(CASE.design, '伺服电机');
  const driveRow = bomServo(CASE.design, '伺服驱动器');
  assert.ok(motorRow && driveRow);
  const { design } = drawing.build;
  assert.equal(design.motors.length, 6);
  for (const motor of design.motors) {
    assert.equal(motor.starter, 'servo');
    assert.equal(motor.powerKw, motorRow.ratedW / 1000, `${motor.purpose} 功率应取 BOM ${motorRow.ratedW} W`);
    assert.equal(motor.motorModel, motorRow.model);
    assert.equal(motor.driveModel, driveRow.model);
  }
  assert.ok(!design.notes.some((note) => DEFAULT_NOTE.test(note)), design.notes.join('\n'));
  assert.ok(!design.notes.includes(MACHINE_CONFIG_ONLY_NOTE));
  const power = drawing.pages.find((page) => page.kind === 'power');
  assert.ok(power, '应有主回路页');
  assert.ok(power.svg.includes(motorRow.model.split(' ')[0]), '主回路页应写出 BOM 伺服电机型号');
  // 负载（电气校验面板/Agent 同源数据）按 BOM 功率统计
  const loads = drawing.document.loads ?? [];
  assert.ok(loads.length >= 6);
  assert.equal(drawing.project, CASE.design.config.name);
  assert.equal(drawing.drawingNo, drawingNoFor('screw', 'design-screw-6st'));
});

test('对照：只有 config 的旧载荷仍能出图，但图纸说明明确标注未携带 BOM/功率', () => {
  const sources = tracker();
  sources.useMachine(CASE.design.config, undefined);
  const drawing = sources.drawing();
  assert.ok(drawing.build.design.notes[0] === MACHINE_CONFIG_ONLY_NOTE);
  assert.ok(drawing.build.design.notes.some((note) => DEFAULT_NOTE.test(note)));
  // 形状不对的 design 字段被丢弃，同样按“只有 config”处理
  sources.useMachine(CASE.design.config, { bomDraft: { items: 'x' }, power: 3 });
  assert.equal(sources.current().configOnly, true);
});

test('幂等重复应用：仍把完整方案送到渲染层', async () => {
  const { calls, bus } = setup();
  await bus.execute('apply_machine_design', { design: caseDesign(), withGeometry: false });
  const again = await bus.execute('apply_machine_design', { design: caseDesign(), withGeometry: false });
  assert.equal(again.ok, true);
  assert.equal(again.data.idempotent, true);
  const list = refreshes(calls);
  assert.equal(list.length, 2);
  assert.deepEqual(list[1].args.design, list[0].args.design);
});

test('覆盖 + 撤销：渲染层回到上一版的完整方案；首次应用撤销则退回工程/清空', async () => {
  const { calls, bus } = setup();
  const brief = (stations) => synthMachine(parseMachineBrief(`设计一台${stations}工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服`), {
    id: 'line-x',
    name: `线体 ${stations} 工位`
  });
  await bus.execute('apply_machine_design', { design: brief('三'), withGeometry: false });
  const first = refreshes(calls).at(-1).args;
  await bus.execute('apply_machine_design', { design: brief('五'), withGeometry: false, overwrite: true });
  const second = refreshes(calls).at(-1).args;
  assert.notDeepEqual(second.design.power, first.design.power);

  const sources = tracker();
  sources.useMachine(second.config, second.design);
  const undone = await bus.undoLast();
  assert.equal(undone.ok, true);
  const restored = refreshes(calls).at(-1).args;
  assert.equal(restored.config.name, '线体 三 工位');
  assert.equal(restored.machineId, 'line-x');
  assert.deepEqual(restored.design, first.design, '撤销应送回上一版 bomDraft/power');
  sources.useMachine(restored.config, restored.design);
  assert.equal(sources.drawing().project, '线体 三 工位');
  assert.equal(sources.current().configOnly, false);

  // 再撤销到“没有方案”：载荷 config=null、不带 design；渲染层退回最近打开的工程，没有就清空
  await bus.undoLast();
  const empty = refreshes(calls).at(-1).args;
  assert.equal(empty.config, null);
  assert.equal(empty.design, undefined);
  const project = { id: 'proj-ab12', name: '输送线 2000×400', process: 'conveyor', parts: 28, massKg: 50, params: { lengthMm: 2000 } };
  sources.clearMachine(project);
  assert.equal(sources.current().kind, 'project');
  assert.equal(sources.drawing().project, '输送线 2000×400');
  const bare = tracker();
  bare.useMachine(restored.config, restored.design);
  bare.clearMachine(null);
  assert.equal(bare.current(), null);
  assert.equal(bare.drawing(), null);
});

test('启动恢复：machine:active 读到的落盘方案带 BOM/功率，恢复后电气图与应用时一致', async () => {
  const { root, calls, bus } = setup();
  await bus.execute('apply_machine_design', { design: caseDesign(), withGeometry: false });
  const applied = tracker();
  const payload = refreshes(calls)[0].args;
  applied.useMachine(payload.config, payload.design);

  // electron/ipc.ts machine:active 返回 readActiveMachineDesign 的结果；extension 把整份 design 交给 restoreMachine
  const stored = JSON.parse(JSON.stringify(readActiveMachineDesign(root)));
  const boot = tracker();
  assert.equal(boot.restoreMachine(stored.config, stored), true);
  assert.equal(boot.current().configOnly, false);
  const a = applied.drawing();
  const b = boot.drawing();
  assert.deepEqual(b.build.design.motors, a.build.design.motors);
  assert.ok(!b.build.design.notes.some((note) => DEFAULT_NOTE.test(note)));

  // 启动期间用户已打开工程：恢复不盖掉它
  const busy = tracker();
  busy.useProject({ id: 'proj-1', name: '已打开工程', parts: 1, massKg: null });
  assert.equal(busy.restoreMachine(stored.config, stored), false);
  assert.equal(busy.current().kind, 'project');
});

test('谁新用谁：工程/方案交替打开，图号与工程名跟随当前数据源；同源不重复出图', () => {
  const sources = tracker();
  assert.equal(sources.drawing(), null);
  const project = { id: 'proj-ab12', name: '输送线 2000×400', process: 'conveyor', parts: 28, massKg: 50, params: { lengthMm: 2000 } };
  sources.useProject(project);
  const p1 = sources.drawing();
  assert.equal(p1.project, project.name);
  assert.equal(p1.drawingNo, drawingNoFor('conveyor', 'proj-ab12'));
  assert.equal(sources.drawing(), p1, '同源同日应复用缓存图（画布/校验面板/Agent 同一份）');

  sources.useMachine(CASE.design.config, CASE.design);
  const m1 = sources.drawing();
  assert.equal(m1.project, CASE.design.config.name);
  assert.equal(m1.drawingNo, drawingNoFor('screw', 'design-screw-6st'));
  assert.deepEqual(sources.label(), { kind: 'machine', id: 'design-screw-6st', name: CASE.design.config.name });

  sources.useProject(project);
  const p2 = sources.drawing();
  assert.notEqual(p2, p1, '换源必须重建');
  assert.equal(p2.drawingNo, p1.drawingNo);
  // 方案被撤销时只影响机型源：当前是工程就保持工程
  sources.clearMachine(null);
  assert.equal(sources.current().kind, 'project');
});

test('图纸日期跨天会重建，不沿用旧标题栏日期', () => {
  let day = '2026-10-25';
  const sources = new ElecSourceTracker(renderElecDrawing, () => day);
  sources.useMachine(CASE.design.config, CASE.design);
  const first = sources.drawing();
  day = '2026-10-26';
  const next = sources.drawing();
  assert.notEqual(next, first);
  assert.equal(next.build.design.date, '2026-10-26');
});

test('run_electrical_check 不传数据：校验当前电气图纸（getElecDocument 同源）', async () => {
  const sources = tracker();
  sources.useMachine(CASE.design.config, CASE.design);
  const drawing = sources.drawing();
  const { calls, bus } = setup((method) => method === 'getElecDocument'
    ? JSON.parse(JSON.stringify({ ok: true, document: drawing.document, source: { kind: 'machine', drawingNo: drawing.drawingNo } }))
    : undefined);
  const result = await bus.execute('run_electrical_check', {});
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(calls.some((call) => call.method === 'getElecDocument'));
  assert.equal(result.data.source.drawingNo, drawing.drawingNo);
  const expectedKw = drawing.document.loads.reduce((sum, load) => sum + load.powerKw * (load.qty ?? 1), 0);
  assert.ok(Math.abs(result.data.summary.totalKw - expectedKw) < 1e-6, `${result.data.summary.totalKw} vs ${expectedKw}`);

  // 渲染层没有数据源：仍按原样拒绝空文档
  const empty = setup((method) => method === 'getElecDocument' ? { ok: false, message: '尚无电气数据源' } : undefined);
  const rejected = await empty.bus.execute('run_electrical_check', {});
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'INVALID_ARGUMENT');
  assert.match(rejected.error.message, /至少一条 wires \/ loads \/ circuits/);

  // 显式传了数据就不碰渲染桥
  const explicit = setup();
  const own = await explicit.bus.execute('run_electrical_check', { loads: [{ tag: 'M1', powerKw: 1.5 }] });
  assert.equal(own.ok, true);
  assert.equal(explicit.calls.length, 0);
});

test('RendererBridge 白名单包含命令层实际调用的 buildMachineModel / markPlcGenerated / getElecDocument', async () => {
  const scripts = [];
  const bridge = new RendererBridge(() => ({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (code) => {
        scripts.push(code);
        return { ok: true };
      }
    }
  }));
  for (const method of ['buildMachineModel', 'markPlcGenerated', 'getElecDocument', 'applyMachineConfig']) {
    const result = await bridge.call(method, method === 'applyMachineConfig' ? { config: null } : undefined);
    assert.equal(result.ok, true, method);
  }
  assert.ok(scripts.some((code) => code.includes('bridge.buildMachineModel(')));
  // 命令层源码里每个 bridge.call('x') 都必须在白名单里（防止再漏）
  const commands = readFileSync(new URL('../../src/agent/commands.ts', import.meta.url), 'utf8');
  const called = new Set([...commands.matchAll(/bridge\.call(?:<[^(]*>)?\(\s*'([A-Za-z]+)'/g)].map((match) => match[1]));
  assert.ok(called.size >= 15, `只找到 ${called.size} 个桥调用`);
  for (const method of called) {
    await assert.doesNotReject(() => bridge.call(method), `${method} 不在 BRIDGE_METHODS 白名单`);
  }
});

test('extension：电气图数据源接线（完整方案、启动恢复、所有电气域入口、校验同源）', () => {
  const source = readFileSync(new URL('../../src/extension.ts', import.meta.url), 'utf8');
  assert.match(source, /elecSources\.useMachine\(config, source\.design\)/, 'applyMachineConfig 要把完整方案交给电气数据源');
  assert.match(source, /elecSources\.clearMachine\(lastOpenedProject\)/, '撤销到无方案时退回最近工程');
  assert.match(source, /elecSources\.restoreMachine\(commission\.getMachineConfig\(\), result\.design\)/, '启动恢复 active 方案');
  assert.match(source, /attributeFilter: \['data-domain'\]/, '顶栏/快捷键/菜单进电气域都要刷新');
  assert.match(source, /setCurrentProject\(projectMenuRecordOf\(savedProject\.record/, 'build_machine_model 生成的整机成为当前数据源');
  assert.match(source, /getElecDocument: \(\) =>/, 'Agent 校验当前图的桥方法');
  assert.ok(!/elecDesignFromMachine\(\{ config/.test(source), '不得再只用 config 出图');
});
