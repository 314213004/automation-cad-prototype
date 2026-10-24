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
  assert.equal(brief.layout, 'parallel');
  assert.deepEqual(brief.processes, ['锁螺丝']);
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
  assert.ok(design.power.totalKw > 2);
  assert.ok(design.power.currentA > 0);
  assert.ok(design.power.breakerSuggestion.rating >= 6);
  assert.ok(design.cost.total > 0);
});

test('节拍按 dual-lane：单轨 3.18 秒/件 + 0.6 秒转移，2 轨并行 → 31.75 件/分钟', () => {
  const design = caseDesign();
  assert.equal(design.form.id, 'dual-lane');
  assert.equal(design.cycle.mode, 'cell');
  assert.equal(design.cycle.perMin, 20);
  assert.equal(design.cycle.secondsPerPiece, 3);
  assert.equal(design.cycle.stationSeconds, 3.18);
  assert.equal(design.cycle.throughputPerMin, 31.75);
  assert.equal(design.cycle.estimatedSecondsPerPiece, 3.18);
  assert.equal(design.cycle.meetsTarget, true);
  assert.equal(design.cycle.requiredParallelStations, 1);
  assert.equal(design.cycle.requiredTotalStations, 6);
  assert.match(design.cycle.bottleneck, /3\.18/);
  assert.match(design.cycle.bottleneck, /2 轨并行/);
  assert.match(design.cycle.bottleneck, /31\.75 件\/分钟/);
  assert.ok(design.assumptions.some((line) => /布局按单元式/.test(line)));
  assert.equal(design.warnings.some((warning) => /节拍瓶颈/.test(warning)), false);
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

test('BOM 明确包含 SV660P / MHZ2-20D / D-M9B / SY5120-5LZD，安全光栅选到 F3SG-4SRA0640-14', () => {
  const mapping = mapMachineBom(caseDesign(), parts);
  const byModel = new Map(mapping.items.map((item) => [item.model, item]));
  assert.equal(byModel.get('SV660P 750 W')?.qty, 6);
  assert.equal(byModel.get('MHZ2-20D')?.qty, 6);
  assert.equal(byModel.get('D-M9B')?.qty, 6);
  assert.equal(byModel.get('D-M9B')?.packId, 'smc-cn');
  assert.equal(byModel.get('SY5120-5LZD')?.qty, 6);
  const curtain = byModel.get('F3SG-4SRA0640-14');
  assert.ok(curtain, '安全光栅应映射到真实型号');
  assert.equal(curtain.name, '安全光栅');
  assert.equal(curtain.kind, 'sensor');
  assert.equal(curtain.qty, 1);
  assert.equal(curtain.packId, 'iec-cn');
  assert.equal(curtain.partId, 'F3SG-4SRA0640-14');
  assert.equal(curtain.pendingSelection, undefined);
  assert.match(curtain.note, /14 mm \/ 640 mm \/ Type 4 \/ PL e/);
  assert.equal(byModel.has('待选型'), false);
  assert.equal(mapping.items.filter((item) => item.pendingSelection).length, 0);
  assert.deepEqual(mapping.pending, []);
  assert.equal(mapping.notices.length, 1);
  assert.match(mapping.notices[0], /F3SG-4SRA0640-14.*ISO 13855/);
  assert.match(byModel.get('PNOZ s3 750103')?.note ?? '', /F3SG-4SRA0640-14 的 OSSD/);
});

test('六工位所选安全光栅规格：14 mm 手指保护、Type 4/PL e、OSSD、24 V DC，带官方来源与尺寸', () => {
  const raw = JSON.parse(readFileSync(join(builtinDir, 'iec-cn', 'parts.json'), 'utf8'));
  const curtain = raw.find((part) => part.id === 'F3SG-4SRA0640-14');
  assert.ok(curtain);
  assert.equal(curtain.category, '安全件');
  assert.match(curtain.specs['分辨率'], /^14 mm/);
  assert.equal(curtain.specs['保护高度'], '640 mm');
  assert.match(curtain.specs['安全等级'], /Type 4 \/ PL e/);
  assert.match(curtain.specs['输出'], /OSSD/);
  assert.match(curtain.specs['电源'], /24 V DC/);
  assert.match(curtain.specs['数据来源'], /^https:\/\/assets\.omron\.eu\//);
  assert.deepEqual([curtain.dims.w, curtain.dims.h, curtain.dims.d], [32, 640, 38]);
  assert.equal(curtain.price, undefined, '无官方价，不应填价格');
});

test('元件包缺少安全光栅型号时退回「待选型」并写明原因，不编造型号', () => {
  const withoutCurtain = parts.filter((part) => part.id !== 'F3SG-4SRA0640-14');
  const mapping = mapMachineBom(caseDesign(), withoutCurtain);
  const pendingItems = mapping.items.filter((item) => item.pendingSelection);
  assert.equal(pendingItems.length, 1);
  assert.equal(pendingItems[0].name, '安全光栅');
  assert.equal(pendingItems[0].model, '待选型');
  assert.equal(pendingItems[0].partId, undefined);
  assert.deepEqual(mapping.pending, [{
    name: '安全光栅',
    reason: '元件包 iec-cn 中未找到安全光栅 F3SG-4SRA0640-14，需补录或手工选型'
  }]);
  assert.deepEqual(mapping.notices, []);
  assert.match(mapping.electrical.assumptions.at(-1), /未选到型号/);
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
  assert.equal(stored.design.form.id, 'dual-lane');
  assert.deepEqual(stored.design.form.stationRange, [4, 6]);
  assert.equal(stored.cycleAnalysis.mode, 'cell');
  assert.equal(stored.cycleAnalysis.stationSeconds, 3.18);
  assert.equal(stored.cycleAnalysis.throughputPerMin, 31.75);
  assert.equal(stored.cycleAnalysis.meetsTarget, true);
  assert.equal(stored.ioMap.rowCount, 19);
  assert.equal(stored.bom.items.length, 12);
  assert.equal(stored.bom.pendingCount, 0);
  assert.equal(stored.bom.realPartCount, 12);
  assert.ok(stored.design.power.totalKw > 0);
  assert.ok(stored.design.power.currentA > 0);
  assert.ok(stored.design.power.breakerSuggestion.rating >= 6);
  assert.ok(stored.design.cost.total > 0);
  assert.ok(stored.design.cost.assumptions.some((line) => /方案阶段粗估|人工\/调试/.test(line)));
  assert.ok(stored.bom.items.some((item) => item.partId === 'F3SG-4SRA0640-14' && item.packId === 'iec-cn'));
  assert.ok(stored.design.warnings.some((warning) => /F3SG-4SRA0640-14.*ISO 13855/.test(warning)));
  assert.equal(stored.screenshotValidation.shots.length, 4);
  for (const shot of stored.screenshotValidation.shots) {
    assert.deepEqual(shot.width, 1600);
    assert.deepEqual(shot.height, 1000);
    assert.ok(shot.bytes > 20 * 1024, shot.name);
    assert.ok(shot.uniqueColors > 500, shot.name);
    assert.ok(existsSync(join(repoRoot, 'docs', 'desktop', 'screenshots', shot.name)), shot.name);
  }
});

test('machine-case.json 的 form 非 null，且工位范围覆盖 6', () => {
  const stored = JSON.parse(readFileSync(caseFile, 'utf8'));
  assert.ok(stored.design.form);
  assert.equal(stored.design.form.id, 'dual-lane');
  assert.deepEqual(stored.design.form.stationRange, [4, 6]);
  assert.ok(stored.design.form.stationRange[0] <= 6);
  assert.ok(stored.design.form.stationRange[1] >= 6);
});

test('缺失真实型号时映射失败，不悄悄编造型号', () => {
  const design = caseDesign();
  const withoutServo = parts.filter((part) => part.id !== 'SV660PS5R5I');
  assert.throws(() => mapMachineBom(design, withoutServo), /iec-cn.*SV660PS5R5I/);
});
