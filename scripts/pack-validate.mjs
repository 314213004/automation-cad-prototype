#!/usr/bin/env node
// 校验全部内置数据包；输出人读摘要或 JSON。

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackCatalog } from '../desktop/src/packs/validate.ts';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));

function parseArgs(argv) {
  const options = { json: false, packsDir: resolve(SCRIPT_DIR, '..', 'packs', 'builtin') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--packs') options.packsDir = resolve(String(argv[++index] ?? ''));
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
    else options.packsDir = resolve(arg);
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = validatePackCatalog({ packsDir: options.packsDir });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const pack of result.packs) {
        const status = pack.ok ? 'OK' : 'FAIL';
        const warnings = pack.warnings.length > 0 ? ` warnings=${pack.warnings.length}` : '';
        console.log(`${status} ${pack.stats.id}@${pack.stats.version} parts=${pack.stats.partsCount} categories=${pack.stats.categoryCount}${warnings}`);
        for (const error of pack.errors) console.log(`  ERROR ${error.code} ${error.message}`);
        for (const warning of pack.warnings) console.log(`  WARN  ${warning.code} ${warning.message}`);
      }
      console.log(`PACKS_VALIDATE_${result.ok ? 'OK' : 'FAIL'} packs=${result.stats.packs} errors=${result.stats.errors} warnings=${result.stats.warnings} parts=${result.stats.parts} models=${result.stats.uniqueModels}`);
    }
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(`PACKS_VALIDATE_FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
