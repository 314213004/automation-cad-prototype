#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PARTS_FILE = resolve(REPO_ROOT, 'packs', 'builtin', 'iec-cn', 'parts.json');

const CJX2_SOURCE = '正泰 CJX2 系列交流接触器样本 2020 官方';
const NP2_SOURCE = '正泰 NP2 系列按钮外形安装尺寸图 官方';
const ND16_SOURCE = '正泰 ND16 系列信号灯外形安装尺寸图 官方';
const E5CC_SOURCE = '欧姆龙 E5CC-800 系列样本 官方（48×48，进深 60 mm）';

const FILL = {
  'CJX2-0910': { dims: { w: 80, h: 74, d: 45, source: CJX2_SOURCE }, railMount: true },
  'CJX2-1210': { dims: { w: 80, h: 74, d: 45, source: CJX2_SOURCE }, railMount: true },
  'CJX2-1810': { dims: { w: 85, h: 74, d: 45, source: CJX2_SOURCE }, railMount: true },
  'CJX2-2510': { dims: { w: 93, h: 84, d: 56, source: CJX2_SOURCE }, railMount: true },
  'CJX2-3210': { dims: { w: 98, h: 84, d: 56, source: CJX2_SOURCE }, railMount: true },
  'CJX2-6511': { dims: { w: 114, h: 127, d: 75, source: CJX2_SOURCE }, railMount: true },

  'CDB6i-C16-1P': {
    dims: { w: 17.7, h: 80, d: 73, source: '德力西 CDB6i 小型断路器样本 官方' },
    railMount: true
  },
  'CDB6i-C32-3P': {
    dims: { w: 53.1, h: 80, d: 73, source: '德力西 CDB6i 小型断路器样本 官方' },
    railMount: true
  },
  'NXBLE-32-C16-1P+N': {
    dims: { w: 45, h: 76.8, d: 94.5, source: '正泰 NXBLE-32 剩余电流动作断路器样本 2026 官方' },
    railMount: true,
    moduleWidth: 45
  },
  'NXBLE-32-C20-2P': {
    dims: { w: 63, h: 77.8, d: 94.5, source: '正泰 NXBLE-32 剩余电流动作断路器样本 2026 官方' },
    railMount: true,
    moduleWidth: 63
  },

  'NR2-25Z': { dims: { w: 45, h: 94, d: 66, source: '正泰 NR2 系列热继电器样本 2026 官方' } },

  RXM4AB2BD: {
    dims: { w: 26.9, h: 79, d: 78.45, source: '同系列推定：RXM2AB2BD', estimated: true },
    railMount: true
  },
  RXM4AB2P7: {
    dims: { w: 26.9, h: 79, d: 78.45, source: '同系列推定：RXM2AB2BD', estimated: true },
    railMount: true
  },

  'NP2-BA31': { dims: { w: 31, h: 41, d: 55, source: NP2_SOURCE } },
  'NP2-BA21': { dims: { w: 31, h: 41, d: 55, source: NP2_SOURCE } },
  'NP2-BA42': { dims: { w: 31, h: 41, d: 55, source: NP2_SOURCE } },
  'NP2-BS542': { dims: { w: 41, h: 41, d: 75, source: NP2_SOURCE } },
  'NP2-BD21': { dims: { w: 31, h: 41, d: 70, source: NP2_SOURCE } },
  'NP2-BD25': { dims: { w: 31, h: 41, d: 70, source: NP2_SOURCE } },
  'NP2-BD33': { dims: { w: 31, h: 41, d: 70, source: NP2_SOURCE } },

  'XB2-BVM4LC': { dims: { w: 30, h: 30, d: 52.5, source: '同系列推定：XB2-BVM3LC', estimated: true } },
  'XB2-BVM5LC': { dims: { w: 30, h: 30, d: 52.5, source: '同系列推定：XB2-BVM3LC', estimated: true } },
  'XB2-BVB3LC': { dims: { w: 30, h: 30, d: 52.5, source: '同系列推定：XB2-BVM3LC', estimated: true } },
  'XB2-BVB4LC': { dims: { w: 30, h: 30, d: 52.5, source: '同系列推定：XB2-BVM3LC', estimated: true } },
  'XB2-BA35': { dims: { w: 40, h: 30, d: 54.5, source: '同系列推定：XB2-BA31', estimated: true } },
  'XB2-BD21': { dims: { w: 40, h: 30, d: 70, source: '同系列推定：XB2-BD25', estimated: true } },
  'XB2-BG21': { dims: { w: 40, h: 30, d: 70, source: '同系列推定：XB2-BD25', estimated: true } },
  'ND16-22DS-4': { dims: { w: 30, h: 30, d: 51.2, source: ND16_SOURCE } },
  'ND16-22DS-2': { dims: { w: 30, h: 30, d: 51.2, source: ND16_SOURCE } },
  'ND16-22DS-4-RD': { dims: { w: 30, h: 30, d: 51.2, source: ND16_SOURCE } },
  'ND16-22FS': { dims: { w: 30, h: 30, d: 54.6, source: ND16_SOURCE } },

  'WDU-2.5': {
    dims: { w: 5.1, h: 60, d: 46.5, source: '同系列推定：WPE-2.5', estimated: true },
    railMount: true
  },

  'NES-350-24': { dims: { w: 215, h: 115, d: 50, source: '明纬 NES-350 系列数据手册 官方' } },
  'NES-35-12': { dims: { w: 99, h: 97, d: 36, source: '明纬 NES-35 系列数据手册 官方' } },
  'NKY2-120-24': {
    dims: { w: 41, h: 133, d: 123, source: '正泰 NKY2/NKY2G 系列开关电源样本 2026 官方' },
    railMount: true
  },
  'NKY2-240-24': {
    dims: { w: 64, h: 133, d: 123, source: '正泰 NKY2/NKY2G 系列开关电源样本 2026 官方' },
    railMount: true
  },
  'NKY2G-75-24': {
    dims: { w: 33, h: 133, d: 112, source: '同系列推定：NKY2-75', estimated: true },
    railMount: true
  },

  'E3Z-LS61': {
    dims: { w: 10.8, h: 31, d: 20, source: '同系列推定：E3Z-D61', estimated: true }
  },
  'IME18-08NPSZC0S': {
    dims: { w: 18, h: 69, d: 18, source: '同系列推定：IME18-05BPSZC0S', estimated: true }
  },

  'CP1W-AD041': {
    dims: { w: 86, h: 90, d: 50, source: '同系列推定：CP1W-20EDR1', estimated: true },
    railMount: true
  },

  XPSAC5121: {
    dims: { w: 22.5, h: 99, d: 114, source: '施耐德 XPSAC5121 产品数据表 官方' },
    railMount: true
  },

  'RT18-32X-1P': {
    dims: { w: 18, h: 63, d: 80, source: '人民电器 RT18 系列熔断器样本 官方' },
    railMount: true,
    moduleWidth: 18
  },
  'RT18-32X-3P': {
    dims: { w: 54, h: 63, d: 80, source: '人民电器 RT18 系列熔断器样本 官方' },
    railMount: true,
    moduleWidth: 54
  },

  'E6CP-AG5C-256': {
    dims: { w: 50, h: 50, d: 38, source: '同系列推定：E6C3-AG5C-360', estimated: true }
  },
  'H7EC-NV': { dims: { w: 48, h: 24, d: 48.5, source: '同系列推定：H7EC-N', estimated: true } },

  DM556: { dims: { w: 118, h: 90, d: 21, source: '雷赛 DM556 V3.0 使用说明书 官方' } },

  IT7100E: { dims: { w: 271, h: 213, d: 36, source: '汇川 IT7100E 用户手册 官方' } },
  'MD500T2.2GB': { dims: { w: 130, h: 200, d: 162, source: '汇川 MD500 系列变频器样本 V4.0 官方' } },
  'MD500T5.5GB': { dims: { w: 140, h: 250, d: 170, source: '汇川 MD500 系列变频器样本 V4.0 官方' } },

  'E5CC-RX2ASM-800': { dims: { w: 48, h: 48, d: 60, source: E5CC_SOURCE } },
  'E5CC-QX2ASM-800': { dims: { w: 48, h: 48, d: 60, source: E5CC_SOURCE } },
  'E5CC-CX2ASM-800': { dims: { w: 48, h: 48, d: 60, source: E5CC_SOURCE } },
  'E5CC-RX2DSM-800': { dims: { w: 48, h: 48, d: 60, source: E5CC_SOURCE } }
};

// 第二批（2026-10-24，feat/lib-safety-dims）：只收厂商官网/官方数据表上逐型号写明的外形尺寸，
// 不做同系列推定。圆柱传感器按既有口径记 w=d=螺纹直径、h=壳体长度；导轨件 w 为沿导轨宽度。
const FILL_BATCH2 = {
  'NBB2-12GM50-E2': {
    dims: { w: 12, h: 53, d: 12, source: '倍加福 NBB2-12GM50-E2 产品页 官方（Length 53 / Diameter 12）：https://www.pepperl-fuchs.com/en/products-gp25581/98931' }
  },
  'NBB5-18GM50-E2': {
    dims: { w: 18, h: 56, d: 18, source: '倍加福 NBB5-18GM50-E2 产品页 官方（Length 56 / Diameter 18）：https://www.pepperl-fuchs.com/en/products-gp25581/99190' }
  },
  'NBB5-18GM50-E0': {
    dims: { w: 18, h: 56, d: 18, source: '倍加福 NBB5-18GM50-E0 产品页 官方（Length 56 / Diameter 18）：https://www.pepperl-fuchs.com/en/products-gp25581/99191' }
  },
  'NBB10-30GM50-E2': {
    dims: { w: 30, h: 60, d: 30, source: '倍加福 NBB10-30GM50-E2 产品页 官方（Length 60 / Diameter 30）：https://www.pepperl-fuchs.com/en/products-gp25581/99278' }
  },
  'UB500-18GM75-E5-V15': {
    dims: { w: 18, h: 85, d: 18, source: '倍加福 UB500-18GM75-E5-V15 数据表 133053 官方（Length 85 / Diameter 18）：https://files.pepperl-fuchs.com/webcat/navi/productInfo/pds/133053_eng.pdf' }
  },
  'IME30-10BPSZC0S': {
    dims: { w: 30, h: 71, d: 30, source: '西克 IME30-10BPSZC0S 数据表 官方（Ø30，Housing length 71）：https://www.sick.com/media/pdf/5/15/615/dataSheet_IME30-10BPSZC0S_1040998_en.pdf' }
  },
  'BI10-M30-AP6X': {
    dims: { w: 30, h: 64, d: 30, source: '图尔克 BI10-M30-AP6X 数据表 ID 46170 官方（M30×1.5，Dimensions 64 mm）：https://www.turck.us/datasheet/_us/edb_46170_eng_us.pdf' }
  },
  '3LD2003-0TK51': {
    dims: { w: 67, h: 84, d: 92.5, source: '西门子 3LD2003-0TK51 数据表 官方（width 67 / height 84 / depth 92.5）：https://support.industry.siemens.com/teddatasheet/?caller=SIOS&format=pdf&language=en&mlfbs=3LD2003-0TK51' }
  },
  '6SL3210-5FB10-4UF1': {
    dims: { w: 55, h: 170, d: 170, source: '西门子 SINAMICS V90 6SL3210-5FB10-4UF1 数据表 官方（FSB，W55×H170×D170）：https://mall.industry.siemens.com/spice/docuservice/rest/document.spring?articleNumber=6SL32105FB104UF1&language=en&region=ww&documentGroup=TED&documentId=DCS_DATASHEET_PMD_CLEANED' }
  },
  DRP048V480W1BA: {
    dims: { w: 144, h: 121, d: 118.6, source: '台达 DRP048V480W1BA 数据表 官方（H121×W144×D118.6）：https://psu.deltaww.com/en/products/download/Datasheet/DRP048V480W1BA' },
    railMount: true
  },
  'UK-6N': {
    dims: { w: 8.2, h: 42.5, d: 47, source: '菲尼克斯 UK 6 N（3004524）产品数据 官方（Width 8.2 / Height 42.5 / Depth on NS 35/7,5 47）：https://www.phoenixcontact.com/en-us/products/feed-through-terminal-block-uk-6-n-3004524' },
    railMount: true
  }
};

const BATCH2_IDS = new Set(Object.keys(FILL_BATCH2));
for (const [id, fill] of Object.entries(FILL_BATCH2)) {
  if (FILL[id]) throw new Error(`第二批与第一批重复：${id}`);
  FILL[id] = fill;
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function findObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error('JSON 对象未闭合');
}

function insertionFor(id, fill) {
  const fields = { dims: fill.dims };
  if (fill.railMount !== undefined) fields.railMount = fill.railMount;
  if (fill.moduleWidth !== undefined) fields.moduleWidth = fill.moduleWidth;
  return JSON.stringify(fields, null, 2)
    .split('\n')
    .slice(1, -1)
    .map((line) => `    ${line.replace(/^  /, '')}`)
    .join('\n');
}

function applyFills(parts, text) {
  const byId = new Map(parts.map((part) => [part.id, part]));
  const insertions = [];
  const skipped = [];
  for (const [id, fill] of Object.entries(FILL)) {
    const part = byId.get(id);
    if (!part) throw new Error(`FILL 中的 id 不存在：${id}`);
    if (part.dims) {
      skipped.push(id);
      continue;
    }
    const anchor = text.indexOf(`"id": ${JSON.stringify(id)}`);
    if (anchor < 0) throw new Error(`无法在原始 JSON 中定位：${id}`);
    const start = text.lastIndexOf('{', anchor);
    insertions.push({ id, start, end: findObjectEnd(text, start) });
  }

  let output = text;
  for (const insertion of insertions.sort((left, right) => right.start - left.start)) {
    const before = output.slice(0, insertion.end).trimEnd();
    const after = output.slice(insertion.end);
    output = `${before},\n${insertionFor(insertion.id, FILL[insertion.id])}\n  ${after}`;
  }
  return { output, inserted: insertions.length, skipped };
}

function collectStats(parts) {
  const byCategory = new Map();
  for (const part of parts) {
    const row = byCategory.get(part.category) ?? {
      category: part.category,
      total: 0,
      have: 0,
      missing: 0,
      sourced: 0,
      official: 0,
      estimated: 0,
      batch: 0,
      batchOfficial: 0,
      batchEstimated: 0,
      batch2: 0
    };
    row.total += 1;
    if (part.dims) {
      row.have += 1;
      if (part.dims.source) {
        row.sourced += 1;
        if (part.dims.estimated === true) row.estimated += 1;
        else row.official += 1;
      }
    } else {
      row.missing += 1;
    }
    const fill = FILL[part.id];
    if (fill && BATCH2_IDS.has(part.id)) {
      row.batch2 += 1;
    } else if (fill) {
      row.batch += 1;
      if (fill.dims.estimated === true) row.batchEstimated += 1;
      else row.batchOfficial += 1;
    }
    byCategory.set(part.category, row);
  }
  const rows = [...byCategory.values()].sort((left, right) => right.missing - left.missing || right.total - left.total);
  const summary = rows.reduce(
    (acc, row) => ({
      total: acc.total + row.total,
      have: acc.have + row.have,
      missing: acc.missing + row.missing,
      sourced: acc.sourced + row.sourced,
      official: acc.official + row.official,
      estimated: acc.estimated + row.estimated,
      batch: acc.batch + row.batch,
      batchOfficial: acc.batchOfficial + row.batchOfficial,
      batchEstimated: acc.batchEstimated + row.batchEstimated,
      batch2: acc.batch2 + row.batch2
    }),
    { total: 0, have: 0, missing: 0, sourced: 0, official: 0, estimated: 0, batch: 0, batchOfficial: 0, batchEstimated: 0, batch2: 0 }
  );
  return { rows, summary };
}

function validate(parts) {
  const errors = [];
  const warnings = [];
  const ids = new Set();
  const legacyModuleWidths = [];

  for (const [index, part] of parts.entries()) {
    const where = `parts[${index}] ${part.id ?? '<无 id>'}`;
    if (typeof part.id !== 'string' || part.id.trim() === '') errors.push(`${where}: id 为空`);
    if (ids.has(part.id)) errors.push(`${where}: id 重复`);
    ids.add(part.id);
    if (!FILL[part.id] && !part.dims) continue;

    if (part.dims) {
      for (const key of ['w', 'h', 'd']) {
        if (!positiveNumber(part.dims[key])) errors.push(`${where}: dims.${key} 必须是有限正数`);
      }
      if (part.dims.source !== undefined && (typeof part.dims.source !== 'string' || part.dims.source.trim() === '')) {
        errors.push(`${where}: dims.source 必须是非空字符串`);
      }
      if (part.dims.estimated !== undefined && part.dims.estimated !== true) {
        errors.push(`${where}: dims.estimated 只能是 true`);
      }
      if (part.dims.estimated === true && !part.dims.source?.startsWith('同系列推定：')) {
        errors.push(`${where}: 推定条目的 dims.source 必须以「同系列推定：」开头`);
      }
      if (part.dims.source?.startsWith('同系列推定：') && part.dims.estimated !== true) {
        errors.push(`${where}: 同系列推定来源必须同时设置 dims.estimated=true`);
      }
    }

    if (part.railMount !== undefined && typeof part.railMount !== 'boolean') {
      errors.push(`${where}: railMount 必须是布尔值`);
    }
    if (part.moduleWidth !== undefined) {
      if (!positiveNumber(part.moduleWidth)) {
        errors.push(`${where}: moduleWidth 必须是有限正数`);
      } else if (part.moduleWidth % 9 !== 0) {
        if (FILL[part.id]) errors.push(`${where}: 新增 moduleWidth=${part.moduleWidth} 不是 9 mm 的整数倍`);
        else legacyModuleWidths.push(`${part.id}=${part.moduleWidth}`);
      }
    }
  }

  for (const id of Object.keys(FILL)) {
    if (!ids.has(id)) errors.push(`FILL 中的 id 不存在：${id}`);
  }
  if (legacyModuleWidths.length > 0) {
    warnings.push(`已有条目的非 9 mm 模数宽保留不改：${legacyModuleWidths.join(', ')}`);
  }
  return { errors, warnings };
}

function printMarkdown(rows) {
  console.log('| 分类 | 总数 | 有尺寸 | 首批官方 | 首批推定 | 二批官方 | 剩余缺口 |');
  console.log('|------|-----:|-------:|---------:|---------:|---------:|---------:|');
  for (const row of rows) {
    console.log(`| ${row.category} | ${row.total} | ${row.have} | ${row.batchOfficial} | ${row.batchEstimated} | ${row.batch2} | ${row.missing} |`);
  }
}

const flags = new Set(process.argv.slice(2));
const allowedFlags = new Set(['--apply', '--check', '--json', '--markdown']);
for (const flag of flags) {
  if (!allowedFlags.has(flag)) {
    console.error(`未知参数：${flag}`);
    process.exit(2);
  }
}

let text = readFileSync(PARTS_FILE, 'utf8');
let parts = JSON.parse(text);
let inserted = 0;
let skipped = [];

if (flags.has('--apply')) {
  const result = applyFills(parts, text);
  text = result.output;
  parts = JSON.parse(text);
  inserted = result.inserted;
  skipped = result.skipped;
  if (inserted > 0) writeFileSync(PARTS_FILE, text, 'utf8');
}

const validationErrors = [];
const validationWarnings = [];
for (const [id, fill] of Object.entries(FILL)) {
  const category = parts.find((part) => part.id === id)?.category ?? '未知';
  for (const key of ['w', 'h', 'd']) {
    if (!positiveNumber(fill.dims[key])) validationErrors.push(`FILL ${id} (${category}): dims.${key} 必须是有限正数`);
  }
  if (fill.moduleWidth !== undefined && (!positiveNumber(fill.moduleWidth) || fill.moduleWidth % 9 !== 0)) {
    validationErrors.push(`FILL ${id} (${category}): moduleWidth 必须是 9 mm 的整数倍`);
  }
}
const validated = validate(parts);
validationErrors.push(...validated.errors);
validationWarnings.push(...validated.warnings);

const { rows, summary } = collectStats(parts);
if (flags.has('--json')) {
  console.log(JSON.stringify({ inserted, skipped, summary, rows, errors: validationErrors, warnings: validationWarnings }, null, 2));
} else {
  if (flags.has('--markdown')) printMarkdown(rows);
  else console.log(`backfill-dims: ${summary.total} 个型号，${summary.have} 个有尺寸，${summary.missing} 个缺失`);
  console.log(`补录表：首批 ${summary.batch} 条（官方 ${summary.batchOfficial} / 推定 ${summary.batchEstimated}），二批 ${summary.batch2} 条（全部官方）；本次写入 ${inserted} 条，已有尺寸跳过 ${skipped.length} 条`);
  console.log(`来源标记：官方 ${summary.official} / 推定 ${summary.estimated}；覆盖 ${summary.have}/${summary.total}（${(summary.have / summary.total * 100).toFixed(1)}%）`);
  if (validationWarnings.length > 0) console.log(`警告 ${validationWarnings.length} 条：${validationWarnings.join('；')}`);
  if (validationErrors.length > 0) {
    console.error(`校验失败 ${validationErrors.length} 条：\n- ${validationErrors.join('\n- ')}`);
    process.exit(1);
  }
  console.log('校验通过：id 唯一、w/h/d 为正数、来源/推定标记一致、新增模数宽合理。');
}
