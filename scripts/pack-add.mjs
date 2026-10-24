#!/usr/bin/env node
// 生成新数据包骨架：manifest + 空 parts + README。默认写入给定目录。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readme({ id, name }) {
  return `# ${name}\n\n数据包 id：\`${id}\`\n\n## 填写步骤\n\n1. 修改 \`manifest.json\` 的 \`name\`、\`vendor\`、\`license\`、\`description\`、\`categories\`。\n2. 把元器件写入 \`parts.json\` 的 \`parts\` 数组；每条至少包含 \`id\`、\`model\`、\`category\`、\`specs\`。\n3. 同步 \`manifest.partsCount\` 与 \`manifest.categories\`。\n4. 重算 \`manifest.partsSha256\`（对 \`parts.json\` 原始字节做 SHA-256）。\n5. 在 \`desktop\` 目录运行：\n\n\`\`\`bash\nnpm run packs:validate\nnpm run packs:stats\nTZ=Asia/Shanghai npm test\n\`\`\`\n\n参数与尺寸必须有可核实来源；查不到就留空，不要编造。\n`;
}

export function createPackSkeleton(dir, options = {}) {
  const absolute = resolve(dir);
  const id = (options.id ?? basename(absolute)).trim();
  if (!PACK_ID_PATTERN.test(id)) throw new Error(`包 id 不合法：${id}`);
  if (existsSync(resolve(absolute, 'manifest.json')) && options.force !== true) {
    throw new Error(`目录已存在 manifest.json：${absolute}（如需覆盖请加 --force）`);
  }
  mkdirSync(absolute, { recursive: true });

  const name = (options.name ?? id).trim() || id;
  const vendor = (options.vendor ?? '待填写').trim() || '待填写';
  const categories = options.categories?.length ? [...new Set(options.categories.map((item) => String(item).trim()).filter(Boolean))] : ['未分类'];
  if (categories.length === 0) throw new Error('categories 不能为空');

  const partsContent = `${JSON.stringify({ schemaVersion: 2, parts: [] }, null, 2)}\n`;
  const partsSha256 = sha256(partsContent);
  const manifest = {
    schemaVersion: 2,
    id,
    name,
    vendor,
    version: '1.0.0',
    license: '待填写：写明数据来源与使用限制',
    description: '待填写：数据包覆盖范围',
    categories,
    partsCount: 0,
    keywords: [],
    partsSha256
  };

  writeFileSync(resolve(absolute, 'parts.json'), partsContent, 'utf8');
  writeFileSync(resolve(absolute, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(absolute, 'README.md'), readme({ id, name }), 'utf8');
  return { dir: absolute, id, partsSha256, manifest };
}

function parseArgs(argv) {
  const options = { force: false, categories: [] };
  let dir = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') options.force = true;
    else if (arg === '--name') options.name = argv[++index];
    else if (arg === '--vendor') options.vendor = argv[++index];
    else if (arg === '--categories') options.categories = String(argv[++index] ?? '').split(/[,，]/);
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
    else if (!dir) dir = arg;
    else throw new Error(`多余参数：${arg}`);
  }
  return { dir, options };
}

function main() {
  try {
    const { dir, options } = parseArgs(process.argv.slice(2));
    if (!dir) {
      console.error('用法：npm run packs:add -- <dir> [--name 名称] [--vendor 厂商] [--categories 分类1,分类2] [--force]');
      process.exit(1);
    }
    const result = createPackSkeleton(dir, options);
    console.log(`PACK_ADD_OK dir=${result.dir} id=${result.id} partsSha256=${result.partsSha256}`);
  } catch (error) {
    console.error(`PACK_ADD_FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
