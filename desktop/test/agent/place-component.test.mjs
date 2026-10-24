import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { AgentSession } from '../../src/agent/session.ts';
import { planTool, routeIntent, WRITE_TOOLS } from '../../src/agent/router.ts';
import {
  extractPlacementSpec,
  isPlacementInstruction,
  resolvePartReference
} from '../../src/agent/placement.ts';
import {
  placementWarnings,
  railSnapPlacement,
  rotateSize
} from '../../src/enclosure/layout.ts';

const PARTS = [
  {
    id: 'iC65N-C16-1P',
    model: 'iC65N 1P C16',
    category: '断路器',
    vendor: '施耐德',
    specs: {},
    dims: { w: 18, h: 85, d: 78.5 },
    railMount: true
  },
  {
    id: 'iC65N-C16-2P',
    model: 'iC65N 2P C16',
    category: '断路器',
    vendor: '施耐德',
    specs: {},
    dims: { w: 36, h: 85, d: 78.5 },
    railMount: true
  },
  {
    id: 'LC1D18M7C',
    model: 'LC1D18M7C',
    category: '接触器',
    vendor: '施耐德',
    specs: {},
    dims: { w: 45, h: 77, d: 86 },
    railMount: true
  },
  {
    id: 'CDM3-100S-3300',
    model: 'CDM3-100S/3300 100A',
    category: '断路器',
    vendor: '德力西',
    specs: {}
  },
  {
    id: 'SENSOR-M8',
    model: 'SENSOR-M8',
    category: '传感器',
    vendor: 'SICK',
    specs: {},
    dims: { w: 20, h: 30, d: 12 }
  }
];

const PLATE = {
  width: 600,
  height: 800,
  rails: [
    { id: 'rail-1', y: 160, height: 35, label: '导轨 1' },
    { id: 'rail-2', y: 500, height: 35, label: '导轨 2' }
  ]
};

let sandbox;
let registry;
let bridge;
let tools;
let sequence = 0;

function part(id, x, y, w, h) {
  return { id, partId: id, model: `MODEL-${id}`, x, y, w, h };
}

function placementPart(partId) {
  return PARTS.find((item) => item.id === partId);
}

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-place-component-test-'));
  const builtin = join(sandbox, 'builtin', 'iec-cn');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(join(builtin, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'iec-cn',
    name: 'IEC',
    vendor: 'IEC',
    version: '1.0.0',
    categories: ['气缸', '气爪', '断路器', '传感器'],
    partsCount: 1
  }));
  writeFileSync(join(builtin, 'parts.json'), JSON.stringify(PARTS));
  registry = new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
  bridge = {
    calls: [],
    placed: [],
    async call(method, args) {
      this.calls.push({ method, args });
      if (method === 'placeEnclosurePart') {
        const request = Array.isArray(args) ? args[0] : args;
        const part = placementPart(request.partId);
        const dims = part?.dims ?? { w: 10, h: 10 };
        const size = request.rotate === true ? rotateSize(dims.w, dims.h) : { w: dims.w, h: dims.h };
        const placement = {
          id: `enc-test-${++sequence}`,
          partId: request.partId,
          model: part?.model ?? request.partId,
          x: request.x,
          y: request.y,
          w: size.w,
          h: size.h
        };
        this.placed.push(placement);
        return {
          ok: true,
          placement,
          warnings: request.x > PLATE.width || request.y > PLATE.height
            ? [{ code: 'OUT_OF_BOUNDS', message: '超出底板' }]
            : []
        };
      }
      if (method === 'removeEnclosurePart') {
        const id = Array.isArray(args) ? args[0] : args;
        this.placed = this.placed.filter((item) => item.id !== id);
        return { ok: true };
      }
      return { ok: false, message: `unexpected ${method}` };
    }
  };
  tools = new AgentTools(registry, createAgentCommandBus(registry, bridge));
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

test('路由：放/摆/加 + 坐标映射到 place_component，插入仍走 insert_component', () => {
  const plan = planTool('把 iC65N-C16-1P 放到 12, 40 位置');
  assert.equal(plan?.tool, 'place_component');
  assert.equal(plan?.readOnly, false);
  assert.equal(plan?.args.partId, 'iC65N-C16-1P');
  assert.equal(plan?.args.x, 12);
  assert.equal(plan?.args.y, 40);
  assert.equal(plan?.args.rotate, false);
  assert.equal(plan?.args.railSnap, true);
  assert.equal(routeIntent('摆一个 LC1D18M7C 在 120, 180').intent, 'modify');
  assert.equal(planTool('插入物料号 LC1D09 的接触器')?.tool, 'insert_component');
  assert.notEqual(planTool('底板上有哪些元件')?.tool, 'place_component');
});

test('路由：缺型号或缺坐标时点名缺参，不猜写操作', () => {
  const noRef = planTool('在底板上加一个到 120, 180');
  assert.equal(noRef?.tool, 'place_component');
  assert.deepEqual(noRef?.missing, ['partId']);

  const noPos = planTool('在底板上放一个 iC65N 1P C16');
  assert.equal(noPos?.tool, 'place_component');
  assert.deepEqual(noPos?.missing, ['x', 'y']);
  assert.equal(planTool('插入一个气缸')?.tool, 'insert_component');
});

test('坐标抽取：支持 x=/y=、逗号、旋转与关闭吸附', () => {
  const spec = extractPlacementSpec('把 LC1D18M7C 旋转后放在 x=12 y=40，不吸附');
  assert.equal(spec.x, 12);
  assert.equal(spec.y, 40);
  assert.equal(spec.rotate, true);
  assert.equal(spec.railSnap, false);
  assert.equal(spec.partRef, 'LC1D18M7C');
  assert.equal(isPlacementInstruction('把 LC1D18M7C 放在底板'), true);
  assert.equal(extractPlacementSpec('在底板上放一个 iC65N 1P C16').partRef, 'iC65N 1P C16');
});

test('型号解析：唯一命中自动填 partId', () => {
  const resolved = resolvePartReference(PARTS, 'iC65N 1P C16');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.part.id, 'iC65N-C16-1P');
});

test('型号解析：多个命中返回 AMBIGUOUS 与候选列表', () => {
  const resolved = resolvePartReference(PARTS, 'iC65N');
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, 'AMBIGUOUS');
  assert.equal(resolved.candidates.length, 2);
  assert.match(resolved.message, /请指定 partId/);
});

test('place_component 参数校验：partId 与坐标必填', async () => {
  const noPart = await tools.call('place_component', { x: 12, y: 40 });
  assert.equal(noPart.ok, false);
  assert.equal(noPart.code, 'INVALID_ARGUMENT');

  const noPos = await tools.call('place_component', { partId: 'iC65N-C16-1P', x: 12 });
  assert.equal(noPos.ok, false);
  assert.equal(noPos.code, 'INVALID_ARGUMENT');
  assert.match(noPos.message, /x\/y/);
});

test('place_component 对未知型号返回 PART_NOT_FOUND', async () => {
  const result = await tools.call('place_component', { partId: 'NOT-EXIST-1P', x: 12, y: 40 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PART_NOT_FOUND');
});

test('place_component 对无 dims 的元件返回 NO_DIMENSIONS 中文提示', async () => {
  const result = await tools.call('place_component', { partId: 'CDM3-100S-3300', x: 12, y: 40 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_DIMENSIONS');
  assert.match(result.message, /缺少外形尺寸/);
  assert.equal(bridge.calls.some((call) => call.method === 'placeEnclosurePart'), false);
});

test('place_component 模糊型号唯一命中后按真实 id 下发命令', async () => {
  const result = await tools.call('place_component', {
    partId: 'iC65N 1P C16',
    x: 12,
    y: 40,
    rotate: true,
    railSnap: false
  });
  assert.equal(result.ok, true);
  assert.equal(result.partId, 'iC65N-C16-1P');
  assert.equal(result.placementId.startsWith('enc-test-'), true);
  const call = bridge.calls.at(-1);
  assert.equal(call.method, 'placeEnclosurePart');
  assert.deepEqual(call.args, {
    partId: 'iC65N-C16-1P',
    x: 12,
    y: 40,
    rotate: true,
    railSnap: false
  });
  assert.equal(result.placement.w, 85);
  assert.equal(result.placement.h, 18);
});

test('place_component 多义型号返回 AMBIGUOUS 且不放置', async () => {
  const before = bridge.placed.length;
  const result = await tools.call('place_component', { partId: 'iC65N', x: 12, y: 40 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AMBIGUOUS');
  assert.equal(result.candidates.length, 2);
  assert.equal(bridge.placed.length, before);
});

test('place_component 成功返回 warnings，越界只告警不拒绝', async () => {
  const result = await tools.call('place_component', { partId: 'LC1D18M7C', x: 700, y: 900 });
  assert.equal(result.ok, true);
  assert.equal(result.warnings[0].code, 'OUT_OF_BOUNDS');
});

test('放置命令写入撤销栈，undo_last 返回 removed=placementId', async () => {
  const bus = createAgentCommandBus(registry, bridge);
  const placed = await bus.execute('place_component', {
    partId: 'LC1D18M7C',
    x: 12,
    y: 40
  });
  assert.equal(placed.ok, true);
  const placementId = placed.data.placementId;
  assert.equal(typeof placementId, 'string');

  const undone = await bus.undoLast();
  assert.equal(undone.ok, true);
  assert.equal(undone.data.command, 'place_component');
  assert.equal(undone.data.removed, placementId);
  assert.deepEqual(bridge.calls.at(-1), { method: 'removeEnclosurePart', args: [placementId] });
});

test('放置命令对无 dims 元件直接拒绝', async () => {
  const bus = createAgentCommandBus(registry, bridge);
  const result = await bus.execute('place_component', { partId: 'CDM3-100S-3300', x: 12, y: 40 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NO_DIMENSIONS');
});

test('放置命令对非数值坐标返回 INVALID_ARGUMENT', async () => {
  const bus = createAgentCommandBus(registry, bridge);
  const result = await bus.execute('place_component', { partId: 'LC1D18M7C', x: '12', y: 40 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
});

test('几何告警：重叠返回 OVERLAP', () => {
  const existing = [part('a', 100, 100, 50, 50)];
  const candidate = part('b', 120, 120, 50, 50);
  const warnings = placementWarnings(existing, candidate, PLATE);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'OVERLAP');
  assert.match(warnings[0].message, /重叠/);
});

test('几何告警：越界返回 OUT_OF_BOUNDS 且提示贴边', () => {
  const candidate = part('b', 590, 760, 50, 60);
  const warnings = placementWarnings([], candidate, PLATE);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'OUT_OF_BOUNDS');
  assert.match(warnings[0].message, /已贴边放置/);
});

test('旋转后宽高交换', () => {
  assert.deepEqual(rotateSize(18, 85), { w: 85, h: 18 });
});

test('railSnap 吸附到最近导轨底边，旋转后按新高度重算', () => {
  assert.deepEqual(railSnapPlacement(PLATE, { y: 180, h: 85 }), { y: 110, railId: 'rail-1' });
  assert.deepEqual(railSnapPlacement(PLATE, { y: 180, h: 18 }), { y: 177, railId: 'rail-1' });
});

test('place_component 在写工具集合中，离线预览不会执行', () => {
  assert.equal(WRITE_TOOLS.has('place_component'), true);
  assert.equal(planTool('把 LC1D18M7C 放在底板 12, 40')?.readOnly, false);
});

function toolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

test('确认拒绝路径：place_component 返回 USER_DENIED 且不执行命令', async () => {
  const responses = [
    { content: '', toolCalls: [toolCall('p1', 'place_component', { partId: 'LC1D18M7C', x: 12, y: 40 })] },
    { content: '已取消放置。', toolCalls: [] }
  ];
  let index = 0;
  const calls = [];
  const audit = [];
  const session = new AgentSession({
    llm: { async chat() { return responses[Math.min(index++, responses.length - 1)]; } },
    bus: {
      async execute(name, args) {
        calls.push({ name, args });
        return { ok: true, data: {} };
      },
      async undoLast() {
        calls.push({ name: 'undo_last', args: {} });
        return { ok: true, data: {} };
      }
    },
    confirmWrite: async () => false,
    audit: (record) => audit.push(record)
  });
  const reply = await session.run('把 LC1D18M7C 放在底板 12, 40');
  assert.equal(reply, '已取消放置。');
  assert.equal(calls.length, 0);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].code, 'USER_DENIED');
});

test('确认允许路径：place_component 只执行一次', async () => {
  const responses = [
    { content: '', toolCalls: [toolCall('p2', 'place_component', { partId: 'LC1D18M7C', x: 12, y: 40 })] },
    { content: '已放置。', toolCalls: [] }
  ];
  let index = 0;
  const calls = [];
  const prompts = [];
  const session = new AgentSession({
    llm: { async chat() { return responses[Math.min(index++, responses.length - 1)]; } },
    bus: {
      async execute(name, args) {
        calls.push({ name, args });
        return { ok: true, data: { placementId: 'enc-1' } };
      },
      async undoLast() {
        return { ok: true, data: {} };
      }
    },
    confirmWrite: async (name) => {
      prompts.push(name);
      return true;
    }
  });
  const reply = await session.run('把 LC1D18M7C 放在底板 12, 40');
  assert.equal(reply, '已放置。');
  assert.deepEqual(prompts, ['place_component']);
  assert.deepEqual(calls, [{
    name: 'place_component',
    args: { partId: 'LC1D18M7C', x: 12, y: 40 }
  }]);
});
