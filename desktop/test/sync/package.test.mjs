import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { buildDesignPackage, PACKAGE_ENTRIES, sha256Hex } from '../../src/sync/package.ts';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const bom = [
  { no: 1, name: '底板', spec: 'BASE-01', qty: 1, mat: 'AL6061', remark: '阳极氧化' },
  { no: 2, name: '气缸', spec: 'MXQ20-50', qty: 2, mat: '铝合金' }
];

function sources(overrides = {}) {
  return {
    projectId: 'asm-slide-cyl',
    projectName: '滑台气缸装配体',
    appVersion: '0.1.0',
    createdAt: '2026-10-22T14:00:00.000Z',
    bom,
    bomCsv: '序号,名称\r\n1,底板\r\n',
    pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
    dxf: '0\nSECTION\n0\nENDSEC\n',
    ...overrides
  };
}

test('manifest 生成固定路径、大小与 SHA-256', () => {
  const built = buildDesignPackage(sources());
  assert.deepEqual(built.skipped, []);
  assert.equal(built.manifest.schemaVersion, 1);
  assert.equal(built.manifest.projectId, 'asm-slide-cyl');
  assert.equal(built.manifest.projectName, '滑台气缸装配体');
  assert.equal(built.manifest.appVersion, '0.1.0');
  assert.equal(built.manifest.createdAt, '2026-10-22T14:00:00.000Z');
  assert.deepEqual(built.manifest.files.map((file) => [file.path, file.kind]), [
    ['bom.csv', 'BOM'],
    ['report.pdf', 'PDF'],
    ['model.glb', 'GLTF'],
    ['drawing.dxf', 'DXF']
  ]);
  assert.equal(built.manifest.files[0].sha256, sha256Hex('序号,名称\r\n1,底板\r\n'));
  assert.equal(built.manifest.files[1].size, 4);
  assert.equal(built.manifest.bomSha256, built.manifest.files[0].sha256);
  assert.equal(built.manifest.bom[1].spec, 'MXQ20-50');
  assert.equal(built.manifest.bom[0].remark, '阳极氧化');
  assert.equal(built.zipSha256, createHash('sha256').update(built.zip).digest('hex'));
});

test('zip 只包含四个固定产物与 manifest.json', () => {
  const built = buildDesignPackage(sources());
  const zip = new AdmZip(Buffer.from(built.zip));
  const names = zip.getEntries().map((entry) => entry.entryName).sort();
  assert.deepEqual(names, [
    PACKAGE_ENTRIES.bom,
    PACKAGE_ENTRIES.dxf,
    PACKAGE_ENTRIES.glb,
    PACKAGE_ENTRIES.manifest,
    PACKAGE_ENTRIES.pdf
  ].sort());
  const manifestEntry = zip.getEntry(PACKAGE_ENTRIES.manifest);
  const written = JSON.parse(manifestEntry.getData().toString('utf8'));
  assert.deepEqual(written, built.manifest);
  assert.deepEqual(zip.getEntry(PACKAGE_ENTRIES.pdf).getData(), Buffer.from([0x25, 0x50, 0x44, 0x46]));
});

test('缺失或空文件被跳过并记录，仍生成有效 manifest', () => {
  const built = buildDesignPackage(sources({ glb: undefined, dxf: '' }));
  assert.deepEqual(built.skipped, ['model.glb', 'drawing.dxf']);
  assert.deepEqual(built.manifest.files.map((file) => file.path), ['bom.csv', 'report.pdf']);
  const zip = new AdmZip(Buffer.from(built.zip));
  assert.equal(zip.getEntry('model.glb'), null);
  assert.equal(zip.getEntry('drawing.dxf'), null);
});

test('全部文件缺失时拒绝打包', () => {
  assert.throws(
    () => buildDesignPackage(sources({ bomCsv: undefined, pdf: undefined, glb: undefined, dxf: undefined })),
    /没有可打包的导出文件/
  );
  assert.throws(() => buildDesignPackage(sources({ projectId: '  ' })), /projectId不能为空/);
});
