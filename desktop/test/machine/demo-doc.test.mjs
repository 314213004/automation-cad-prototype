import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const caseFile = join(repoRoot, 'docs', 'desktop', 'eval', 'machine-case.json');
const docFile = join(repoRoot, 'docs', 'desktop', 'MACHINE-DESIGN-DEMO.md');
const HINT = '先重跑 build:machine-case 再更新文档';

function section(doc, heading) {
  const start = doc.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `文档缺少「${heading}」章节（${HINT}）`);
  const rest = doc.slice(start + heading.length + 3);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

function money(value) {
  return value.toLocaleString('en-US');
}

function assertPowerCostDocConsistent(caseData, doc) {
  const power = caseData.design.power;
  const cost = caseData.design.cost;
  const powerSection = section(doc, '功率与成本估算');
  const costSection = section(doc, '方案阶段成本粗估');

  assert.ok(powerSection.includes(power.totalKw.toFixed(2)), `文档功率 ${power.totalKw.toFixed(2)} kW 与 json 不一致（${HINT}）`);
  assert.ok(powerSection.includes(power.totalVa.toFixed(2)), `文档视在功率 ${power.totalVa.toFixed(2)} VA 与 json 不一致（${HINT}）`);
  assert.ok(powerSection.includes(power.currentA.toFixed(2)), `文档计算电流 ${power.currentA.toFixed(2)} A 与 json 不一致（${HINT}）`);
  assert.ok(
    powerSection.includes(`${power.breakerSuggestion.rating} A / ${power.breakerSuggestion.poles}P`),
    `文档断路器 ${power.breakerSuggestion.rating} A / ${power.breakerSuggestion.poles}P 与 json 不一致（${HINT}）`
  );
  assert.ok(
    powerSection.includes(`${power.dc24.marginPct.toFixed(1)}%`),
    `文档 24V 余量 ${power.dc24.marginPct.toFixed(1)}% 与 json 不一致（${HINT}）`
  );

  for (const key of ['material', 'electrical', 'labor', 'total']) {
    assert.ok(costSection.includes(money(cost[key])), `文档成本 ${key}=${money(cost[key])} 与 json 不一致（${HINT}）`);
  }
  assert.ok(
    costSection.includes(`缺价 ${cost.missingCount} 行`) || costSection.includes(`缺价 ${cost.missingCount} 项`),
    `文档缺价数 ${cost.missingCount} 与 json 不一致（${HINT}）`
  );
  assert.ok(
    costSection.includes(String(cost.laborDetail.hours)),
    `文档人工工时 ${cost.laborDetail.hours} h 与 json 不一致（${HINT}）`
  );
}

function assertCaseDocConsistent(caseData, doc) {
  const form = caseData.design.form;
  const cycle = caseData.design.cycle;
  assert.ok(doc.includes(form.name), `文档未出现形态名 ${form.name}（${HINT}）`);
  assert.ok(doc.includes(form.id), `文档未出现形态 id ${form.id}（${HINT}）`);

  const throughput = cycle.throughputPerMin.toFixed(2);
  const selection = section(doc, '整机形态选型');
  const timing = section(doc, '节拍计算');
  const selectedText = `${selection}\n${timing}`;
  assert.ok(selectedText.includes(throughput), `文档产能 ${throughput} 与 json 不一致（${HINT}）`);
  assert.ok(selectedText.includes(`throughputPerMin=${throughput}`), `文档缺少 throughputPerMin=${throughput}（${HINT}）`);
  for (const match of selectedText.matchAll(/(\d+\.\d{2})\s*件\/分钟/g)) {
    assert.equal(match[1], throughput, `文档出现产能 ${match[1]} 件/分钟，与 json ${throughput} 不一致（${HINT}）`);
  }

  const meets = cycle.meetsTarget === true ? 'true' : 'false';
  assert.ok(selectedText.includes(`meetsTarget=${meets}`), `文档 meetsTarget 与 json=${meets} 不一致（${HINT}）`);
  if (cycle.meetsTarget === true) {
    assert.match(selectedText, /(达标|满足)/, `json 已达标，文档未写达标结论（${HINT}）`);
  } else {
    assert.match(selectedText, /未达标/, `json 未达标，文档未写缺口（${HINT}）`);
  }

  const bomSection = section(doc, 'BOM（真实型号）');
  const rows = [...bomSection.matchAll(/^\|\s*\d+\s*\|/gm)].length;
  assert.equal(rows, caseData.bom.items.length, `文档 BOM 行数 ${rows} 与 json ${caseData.bom.items.length} 不一致（${HINT}）`);
  assert.ok(bomSection.includes(`共 \`${caseData.bom.items.length}\` 行`), `文档 BOM 行数说明与 json 不一致（${HINT}）`);
  assertPowerCostDocConsistent(caseData, doc);
}

test('案例文档的形态、产能、达标结论、BOM 行数、功率与成本均来自 machine-case.json', () => {
  const caseData = JSON.parse(readFileSync(caseFile, 'utf8'));
  const doc = readFileSync(docFile, 'utf8');
  assertCaseDocConsistent(caseData, doc);
  assert.doesNotMatch(doc, /113\.21|15\.87|4628/);
});

test('人为改错文档产能时一致性断言失败，并提示先重跑案例', () => {
  const caseData = JSON.parse(readFileSync(caseFile, 'utf8'));
  const doc = readFileSync(docFile, 'utf8');
  const wrong = doc.replaceAll(caseData.design.cycle.throughputPerMin.toFixed(2), '99.99');
  assert.throws(() => assertCaseDocConsistent(caseData, wrong), new RegExp(HINT));
});

test('人为删掉 BOM 行时一致性断言失败', () => {
  const caseData = JSON.parse(readFileSync(caseFile, 'utf8'));
  const doc = readFileSync(docFile, 'utf8');
  const wrong = doc.replace(/\n\|\s*12\s*\|[^\n]*/, '');
  assert.throws(() => assertCaseDocConsistent(caseData, wrong), new RegExp(HINT));
});

test('人为改错文档功率或成本时一致性断言失败', () => {
  const caseData = JSON.parse(readFileSync(caseFile, 'utf8'));
  const doc = readFileSync(docFile, 'utf8');
  const wrongPower = doc.replaceAll(`${caseData.design.power.totalKw.toFixed(2)} kW`, '9.99 kW');
  assert.throws(() => assertCaseDocConsistent(caseData, wrongPower), new RegExp(HINT));
  const wrongCost = doc.replaceAll(`¥${money(caseData.design.cost.total)}`, '¥1');
  assert.throws(() => assertCaseDocConsistent(caseData, wrongCost), new RegExp(HINT));
});
