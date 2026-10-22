import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../..');
const DEFAULT_BUILTIN_DIR = resolve(REPO_ROOT, 'packs', 'builtin');
const DEFAULT_OUT_FILE = resolve(REPO_ROOT, 'docs', 'reference', 'electrical-components.md');

const CATEGORY_ORDER = [
  '断路器',
  '接触器',
  '热继电器',
  '中间继电器',
  '按钮',
  '指示灯',
  '端子',
  '开关电源',
  'PLC',
  '传感器',
  '变频器',
  '伺服驱动器'
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function cell(value) {
  if (value === undefined || value === null || value === '') return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ').trim() || '—';
}

export function loadReferencePacks(builtinDir = DEFAULT_BUILTIN_DIR) {
  if (!existsSync(builtinDir)) return { packs: [], parts: [] };
  const packs = [];
  const entries = readdirSync(builtinDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const dir = join(builtinDir, entry.name);
    if (!statSync(dir).isDirectory()) continue;
    const partsFile = join(dir, 'parts.json');
    if (!existsSync(partsFile)) continue;
    let manifest = {};
    const manifestFile = join(dir, 'manifest.json');
    if (existsSync(manifestFile)) manifest = readJson(manifestFile);
    const parts = readJson(partsFile);
    if (!Array.isArray(parts)) throw new Error(`${entry.name}/parts.json 必须是数组`);
    packs.push({
      id: typeof manifest.id === 'string' ? manifest.id : entry.name,
      name: typeof manifest.name === 'string' ? manifest.name : entry.name,
      parts
    });
  }
  return { packs, parts: packs.flatMap((pack) => pack.parts) };
}

export function buildReferenceMarkdown(options = {}) {
  const builtinDir = options.builtinDir ?? DEFAULT_BUILTIN_DIR;
  const { packs, parts } = loadReferencePacks(builtinDir);
  const grouped = new Map();
  for (const part of parts) {
    const category = typeof part.category === 'string' && part.category.trim() ? part.category.trim() : '未分类';
    if (!grouped.has(category)) grouped.set(category, { parts: [], keys: [] });
    const group = grouped.get(category);
    group.parts.push(part);
    for (const key of Object.keys(part.specs ?? {})) {
      if (!group.keys.includes(key)) group.keys.push(key);
    }
  }

  const categories = [
    ...CATEGORY_ORDER.filter((category) => grouped.has(category)),
    ...Array.from(grouped.keys()).filter((category) => !CATEGORY_ORDER.includes(category))
  ];

  const lines = [
    '# 常用电气元器件参数表',
    '',
    '> 本文件由 `desktop/scripts/gen-reference.mjs` 读取 `packs/builtin/*/parts.json` 自动生成，请勿手工修改。',
    '> 参数取自厂商公开样本的常用值，用于选型与原理图设计参考；定型前请以官方最新样本与铭牌为准。',
    '',
    `数据包：${packs.map((pack) => `\`${pack.id}\``).join('、') || '无'}。`,
    ''
  ];

  for (const category of categories) {
    const group = grouped.get(category);
    lines.push(`## ${category}`, '');
    lines.push(`| 型号 | 厂商 |${group.keys.map((key) => ` ${cell(key)} |`).join('')}`);
    lines.push(`|---|---|${group.keys.map(() => '---|').join('')}`);
    for (const part of group.parts) {
      const specs = part.specs ?? {};
      const values = group.keys.map((key) => cell(specs[key]));
      lines.push(`| ${cell(part.model ?? part.id)} | ${cell(part.vendor)} |${values.map((value) => ` ${value} |`).join('')}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function generateReference(options = {}) {
  const builtinDir = options.builtinDir ?? DEFAULT_BUILTIN_DIR;
  const outFile = options.outFile ?? DEFAULT_OUT_FILE;
  const markdown = buildReferenceMarkdown({ builtinDir });
  writeFileSync(outFile, markdown, 'utf8');
  const { packs, parts } = loadReferencePacks(builtinDir);
  return { outFile, packCount: packs.length, partCount: parts.length, markdown };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = generateReference();
    console.log(`已写入 ${result.packCount} 个数据包、${result.partCount} 个条目 → ${result.outFile}`);
  } catch (error) {
    console.error(`生成参考资料失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
