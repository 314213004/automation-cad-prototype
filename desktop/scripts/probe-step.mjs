// 用 occt-import-js（App 内同一个 STEP 解析器）统计样本：网格数、三角面、层级根名
// 用法：node probe-step.mjs <file...>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const occtimportjs = require('occt-import-js');

const wasmPath = require.resolve('occt-import-js/dist/occt-import-js.wasm');
const occt = await occtimportjs({ locateFile: (p) => (p.endsWith('.wasm') ? wasmPath : p) });

for (const file of process.argv.slice(2)) {
  const started = Date.now();
  const bytes = new Uint8Array(readFileSync(file));
  let result;
  try {
    result = occt.ReadStepFile(bytes, {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.001,
      angularDeflection: 0.5
    });
  } catch (e) {
    console.log(`${file}\tFAIL\t${e.message}`);
    continue;
  }
  if (!result.success) { console.log(`${file}\tFAIL\tparse`); continue; }
  let tris = 0;
  for (const m of result.meshes) {
    tris += m.index.array.length ? m.index.array.length / 3 : m.attributes.position.array.length / 9;
  }
  // 层级：根节点名 + 直接子节点数
  const root = result.root;
  const childNames = (root?.children ?? []).map((c) => c.name || '(无名)');
  const named = result.meshes.filter((m) => m.name && !/^(COMPOUND|SOLID|SHELL|PART|BODY)$/i.test(m.name.trim())).length;
  const sample = result.meshes.slice(0, 5).map((m) => m.name || '(无名)');
  console.log(JSON.stringify({
    file: file.split('/').pop(),
    sizeMB: +(bytes.length / 1048576).toFixed(2),
    ms: Date.now() - started,
    meshes: result.meshes.length,
    triangles: tris,
    namedMeshes: named,
    rootName: root?.name ?? null,
    rootChildren: childNames.slice(0, 8),
    childCount: childNames.length,
    sampleNames: sample
  }));
}
