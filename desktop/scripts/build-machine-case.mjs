// 生成六工位锁螺丝机案例：解析 → 合成 → 真实型号 BOM → PLC IO。
// 全部结果写入 docs/desktop/eval/machine-case.json，文档中的数字以此为准。
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMachineBrief } from '../src/machine/spec.ts';
import { synthMachine } from '../src/machine/synth.ts';
import { mapMachineBom } from '../src/machine/bom-map.ts';
import { buildMachineIoMap } from '../src/machine/io-map.ts';
import { estimatePower } from '../src/machine/power.ts';
import { estimateCost, DEFAULT_MACHINE_PRICING } from '../src/machine/cost-model.ts';
import { validatePricebook } from '../src/cost/pricebook.ts';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..');
const builtinDir = join(repoRoot, 'packs', 'builtin');
const outFile = join(repoRoot, 'docs', 'desktop', 'eval', 'machine-case.json');
const screenshotFile = join(repoRoot, 'docs', 'desktop', 'eval', 'machine-screenshots.json');

const BRIEF = '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅';
const pricebookFile = join(builtinDir, 'pricebook-cn', 'pricebook.json');

function loadBuiltinParts() {
  const parts = [];
  for (const entry of readdirSync(builtinDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const partsFile = join(builtinDir, entry.name, 'parts.json');
    if (!existsSync(partsFile)) continue;
    const manifestFile = join(builtinDir, entry.name, 'manifest.json');
    const manifest = existsSync(manifestFile)
      ? JSON.parse(readFileSync(manifestFile, 'utf8'))
      : { id: entry.name, name: entry.name };
    const raw = JSON.parse(readFileSync(partsFile, 'utf8'));
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw.parts) ? raw.parts : [];
    for (const row of rows) {
      parts.push({
        id: String(row.id),
        model: String(row.model),
        category: String(row.category),
        specs: row.specs && typeof row.specs === 'object' ? row.specs : {},
        ...(typeof row.price === 'number' ? { price: row.price } : {}),
        packId: entry.name,
        packName: String(manifest.name ?? entry.name)
      });
    }
  }
  return parts;
}

function stationTable(design) {
  return design.config.stations.map((station) => {
    const actuators = design.config.actuators
      .filter((actuator) => actuator.station === station)
      .map((actuator) => ({
        id: actuator.id,
        kind: actuator.kind,
        name: actuator.name,
        points: [actuator.extendPoint, actuator.retractPoint, actuator.gripPoint, actuator.point].filter(Boolean)
      }));
    const sensors = design.config.sensors
      .filter((sensor) => sensor.station === station)
      .map((sensor) => ({ point: sensor.point, part: sensor.part }));
    return { station, actuators, sensors };
  });
}

const parts = loadBuiltinParts();
const pricebook = existsSync(pricebookFile)
  ? validatePricebook(JSON.parse(readFileSync(pricebookFile, 'utf8')))
  : undefined;
const pricingAssumptions = ['machine-case.json 未读取 userData/machine-pricing.json，使用工程默认系数与工时单价。'];
const pricedPricing = DEFAULT_MACHINE_PRICING;
const brief = parseMachineBrief(BRIEF);
const design = synthMachine(brief, {
  parts,
  pricing: pricedPricing,
  pricingAssumptions,
  ...(pricebook ? { builtinPricebook: pricebook } : {})
});
const mapping = mapMachineBom(design, parts);
design.bomDraft = { items: mapping.items };
design.warnings.push(...mapping.pending.map((entry) => `${entry.name}：${entry.reason}`));
design.warnings.push(...mapping.notices);
const mainBreaker = mapping.items.find((item) => item.name === '总进线断路器');
const mainBreakerPart = mainBreaker?.partId
  ? parts.find((part) => part.id === mainBreaker.partId && part.packId === mainBreaker.packId)
  : undefined;
const selectedBreakerA = (() => {
  const raw = mainBreakerPart?.specs?.['额定电流'];
  if (typeof raw === 'number') return raw;
  const match = typeof raw === 'string' ? raw.match(/(\d+(?:\.\d+)?)\s*A/i) : null;
  return match?.[1] ? Number(match[1]) : undefined;
})();
design.power = estimatePower(design, {
  parts,
  voltage: design.power.voltage,
  simultaneity: pricedPricing.power.simultaneity,
  loadFactor: pricedPricing.power.loadFactor,
  efficiency: pricedPricing.power.efficiency,
  cosPhi: pricedPricing.power.cosPhi,
  ...(selectedBreakerA !== undefined ? { selectedBreakerA } : {}),
  assumptions: pricingAssumptions
});
design.cost = estimateCost(design, {
  parts,
  pricing: pricedPricing,
  pricingAssumptions,
  ...(pricebook ? { builtinPricebook: pricebook } : {})
});
const ioMap = buildMachineIoMap(design.config);

const caseData = {
  schemaVersion: 1,
  kind: 'machine-case',
  brief: BRIEF,
  parsed: brief,
  design: {
    config: design.config,
    points: design.points,
    cycle: design.cycle,
    power: design.power,
    cost: design.cost,
    form: design.form,
    warnings: design.warnings,
    assumptions: design.assumptions,
    bomDraft: design.bomDraft
  },
  cycleAnalysis: {
    mode: design.cycle.mode,
    targetPerMin: design.cycle.perMin,
    targetSecondsPerPiece: design.cycle.secondsPerPiece,
    stationSeconds: design.cycle.stationSeconds,
    throughputPerMin: design.cycle.throughputPerMin,
    estimatedSecondsPerPiece: design.cycle.estimatedSecondsPerPiece,
    baseSeconds: design.cycle.baseSeconds,
    slowestStation: design.cycle.slowestStation,
    slowestActionSeconds: design.cycle.slowestActionSeconds,
    meetsTarget: design.cycle.meetsTarget,
    requiredParallelStations: design.cycle.requiredParallelStations,
    requiredTotalStations: design.cycle.requiredTotalStations,
    verdict: design.cycle.meetsTarget
      ? design.cycle.mode === 'parallel'
        ? `当前方案按同工序并行满足目标节拍：单工位 ${design.cycle.stationSeconds} 秒/件 × ${brief.stations} 工位 ≈ ${design.cycle.throughputPerMin} 件/分钟`
        : `当前 ${design.cycle.mode} 布局满足目标节拍：最慢工位 ${design.cycle.stationSeconds} 秒/件 → ${design.cycle.throughputPerMin} 件/分钟`
      : design.cycle.mode === 'parallel'
        ? `当前并行方案未满足目标节拍，按现估算总工位至少 ${design.cycle.requiredTotalStations} 个`
        : `当前 ${design.cycle.mode} 布局未满足目标节拍，按现估算需每道工序 ${design.cycle.requiredParallelStations} 个并行工位，总工位至少 ${design.cycle.requiredTotalStations} 个`,
    bottleneck: design.cycle.bottleneck
  },
  stations: stationTable(design),
  bom: {
    items: mapping.items,
    pending: mapping.pending,
    notices: mapping.notices,
    sourcePacks: mapping.sourcePacks,
    realPartCount: mapping.items.filter((item) => item.partId).length,
    pendingCount: mapping.items.filter((item) => item.pendingSelection).length
  },
  electrical: mapping.electrical,
  cost: design.cost,
  ioMap: {
    rowCount: ioMap.rows.length,
    rows: ioMap.rows,
    csv: ioMap.csv
  },
  screenshotValidation: existsSync(screenshotFile)
    ? JSON.parse(readFileSync(screenshotFile, 'utf8'))
    : null
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(caseData, null, 2)}\n`, 'utf8');
console.log(`MACHINE_CASE_OK ${outFile}`);
console.log(`stations=${design.config.stations.length} actuators=${design.config.actuators.length} sensors=${design.config.sensors.length} points=${ioMap.rows.length}`);
console.log(`form=${design.form.id} range=${design.form.stationRange.join('-')} default=${design.form.defaultStations}`);
console.log(`cycle mode=${design.cycle.mode} station=${design.cycle.stationSeconds}s throughput=${design.cycle.throughputPerMin}/min meetsTarget=${design.cycle.meetsTarget} requiredStations=${design.cycle.requiredTotalStations}`);
console.log(`bomRows=${mapping.items.length} realParts=${caseData.bom.realPartCount} pending=${caseData.bom.pendingCount}`);
console.log(`power kw=${design.power.totalKw} a=${design.power.currentA} breaker=${design.power.breakerSuggestion.rating} dc24=${design.power.dc24?.marginPct ?? 'n/a'}`);
console.log(`cost total=${design.cost.total} material=${design.cost.material} electrical=${design.cost.electrical} labor=${design.cost.labor} missing=${design.cost.missingCount}`);
