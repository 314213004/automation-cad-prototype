import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { mapMachineBom } from '../../src/machine/bom-map.ts';
import { buildMachineIoMap } from '../../src/machine/io-map.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const builtinDir = join(repoRoot, 'packs', 'builtin');
const caseFile = join(repoRoot, 'docs', 'desktop', 'eval', 'machine-case.json');
const BRIEF = '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅';

function loadBuiltinParts() {
  const parts = [];
  for (const entry of readdirSync(builtinDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const partsFile = join(builtinDir, entry.name, 'parts.json');
    if (!existsSync(partsFile)) continue;
    const manifestFile = join(builtinDir, entry.name, 'manifest.json');
    const manifest = existsSync(manifestFile)
      ? JSON.parse(readFileSync(manifestFile, 'utf8'))
      : { name: entry.name };
    const raw = JSON.parse(readFileSync(partsFile, 'utf8'));
    const rows = Array.isArray(raw) ? raw : raw.parts;
    for (const row of rows) {
      parts.push({
        id: row.id,
        model: row.model,
        category: row.category,
        specs: row.specs ?? {},
        packId: entry.name,
        packName: manifest.name ?? entry.name
      });
    }
  }
  return parts;
}

const parts = loadBuiltinParts();

function caseDesign() {
  return synthMachine(parseMachineBrief(BRIEF));
}

test('六工位 brief：解析出 6 工位、6 伺服轴、6 气爪、6 到位检测、1 安全光栅', () => {
  const brief = parseMachineBrief(BRIEF);
  assert.equal(brief.process, 'screw');
  assert.equal(brief.stations, 6);
  assert.equal(brief.cyclePerMin, 20);
  assert.deepEqual(brief.actuators, [
    { kind: 'gripper', count: 6 },
    { kind: 'rotary', count: 6 }
  ]);
  assert.deepEqual(brief.sensors, [
    { kind: 'proximity', count: 6 },
    { kind: 'safety', count: 1 }
  ]);
});

test('方案合成：6 工位、12 执行机构、7 传感器，点位 19 个且唯一', () => {
  const design = caseDesign();
  assert.equal(design.config.stations.length, 6);
  assert.equal(design.config.actuators.length, 12);
  assert.equal(design.config.sensors.length, 7);
  assert.equal(design.points.length, 19);
  assert.equal(new Set(design.points).size, 19);
  assert.equal(design.power.va, 4628);
});

test('节拍如实记录：目标 3.00 秒/件，估算 3.18 秒/件，需 12 个总工位', () => {
  const design = caseDesign();
  assert.equal(design.cycle.perMin, 20);
  assert.equal(design.cycle.secondsPerPiece, 3);
  assert.equal(design.cycle.estimatedSecondsPerPiece, 3.18);
  assert.equal(design.cycle.meetsTarget, false);
  assert.equal(design.cycle.requiredParallelStations, 2);
  assert.equal(design.cycle.requiredTotalStations, 12);
  assert.match(design.cycle.bottleneck, /3\.18/);
  assert.ok(design.warnings.some((warning) => /超过目标 3\.00 秒\/件/.test(warning)));
  assert.ok(design.warnings.some((warning) => /总工位建议 ≥ 12/.test(warning)));
});

test('BOM 型号存在性：每个 partId 都在声明的 builtin 包中，型号完全匹配', () => {
  const mapping = mapMachineBom(caseDesign(), parts);
  for (const item of mapping.items) {
    if (item.pendingSelection) {
      assert.equal(item.model, '待选型');
      assert.equal(item.partId, undefined);
      continue;
    }
    assert.ok(item.partId, `${item.name} 缺少 partId`);
    assert.ok(item.packId, `${item.name} 缺少 packId`);
    const source = parts.find((part) => part.id === item.partId && part.packId === item.packId);
    assert.ok(source, `${item.name}: ${item.packId}/${item.partId} 不存在`);
    assert.equal(item.model, source.model);
  }
});

test('BOM 明确包含 SV660P / MHZ2-20D / D-M9B / SY5120-5LZD，安全光栅待选型', () => {
  const mapping = mapMachineBom(caseDesign(), parts);
  const byModel = new Map(mapping.items.map((item) => [item.model, item]));
  assert.equal(byModel.get('SV660P 750 W')?.qty, 6);
  assert.equal(byModel.get('MHZ2-20D')?.qty, 6);
  assert.equal(byModel.get('D-M9B')?.qty, 6);
  assert.equal(byModel.get('D-M9B')?.packId, 'smc-cn');
  assert.equal(byModel.get('SY5120-5LZD')?.qty, 6);
  assert.equal(byModel.get('待选型')?.pendingSelection, true);
  assert.match(byModel.get('待选型')?.note ?? '', /库里无安全光栅型号，需补录/);
  assert.deepEqual(mapping.pending, [{ name: '安全光栅', reason: '库里无安全光栅型号，需补录' }]);
});

test('电气选型：总进线/伺服支路/电源进线/24V 输出余量均 ≥1.25 倍', () => {
  const mapping = mapMachineBom(caseDesign(), parts);
  for (const calculation of mapping.electrical.calculations) {
    assert.ok(calculation.margin !== undefined, calculation.name);
    assert.ok(calculation.margin >= 1.25, `${calculation.name} 余量 ${calculation.margin}`);
    assert.ok(calculation.ratedA !== undefined && calculation.requiredA !== undefined, calculation.name);
    assert.ok(calculation.ratedA >= calculation.requiredA, calculation.name);
  }
  assert.equal(mapping.electrical.totalServoW, 4500);
  assert.equal(mapping.electrical.totalAuxW, 150);
  assert.equal(mapping.electrical.totalDesignW, 4650);
});

test('IO 映射：19 行，覆盖 12 个执行机构点位与 7 个传感器点位', () => {
  const design = caseDesign();
  const ioMap = buildMachineIoMap(design.config);
  assert.equal(ioMap.rows.length, 19);
  assert.equal(ioMap.rows.length, design.points.length);
  assert.equal(new Set(ioMap.rows.map((row) => row.address)).size, 19);
  for (const point of ['ST1-GRIP-A1', 'ST1-ROT-A2', 'ST1-PRX-S1', 'ST1-SAFE-S2', 'ST6-ROT-A2']) {
    assert.ok(ioMap.rows.some((row) => row.point === point), point);
  }
  assert.equal(ioMap.rows.filter((row) => row.direction === '输入').length, 7);
  assert.equal(ioMap.rows.filter((row) => row.direction === '输出').length, 12);
  assert.match(ioMap.csv, /ST1-ROT-A2/);
});

test('machine-case.json 与实时计算结果一致，且截图校验齐全', () => {
  const stored = JSON.parse(readFileSync(caseFile, 'utf8'));
  const design = caseDesign();
  assert.equal(stored.brief, BRIEF);
  assert.equal(stored.design.config.stations.length, design.config.stations.length);
  assert.equal(stored.design.config.actuators.length, design.config.actuators.length);
  assert.equal(stored.design.config.sensors.length, design.config.sensors.length);
  assert.equal(stored.cycleAnalysis.estimatedSecondsPerPiece, design.cycle.estimatedSecondsPerPiece);
  assert.equal(stored.cycleAnalysis.requiredTotalStations, design.cycle.requiredTotalStations);
  assert.equal(stored.ioMap.rowCount, 19);
  assert.equal(stored.bom.items.length, 12);
  assert.equal(stored.screenshotValidation.shots.length, 4);
  for (const shot of stored.screenshotValidation.shots) {
    assert.deepEqual(shot.width, 1600);
    assert.deepEqual(shot.height, 1000);
    assert.ok(shot.bytes > 20 * 1024, shot.name);
    assert.ok(shot.uniqueColors > 500, shot.name);
    assert.ok(existsSync(join(repoRoot, 'docs', 'desktop', 'screenshots', shot.name)), shot.name);
  }
});

test('缺失真实型号时映射失败，不悄悄编造型号', () => {
  const design = caseDesign();
  const withoutServo = parts.filter((part) => part.id !== 'SV660PS5R5I');
  assert.throws(() => mapMachineBom(design, withoutServo), /iec-cn.*SV660PS5R5I/);
});
