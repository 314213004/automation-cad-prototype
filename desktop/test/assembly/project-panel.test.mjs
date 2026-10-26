import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  __testRenderPart,
  __testRenderSummary,
  toPanelInfo
} from '../../src/assembly/project-panel.ts';

const record = {
  name: '光伏缓存堆叠单元',
  parts: 140,
  envelope: [1500, 1400, 1800],
  massKg: 803.9,
  hasStep: true,
  hasStl: true,
  createdAt: '2026-10-26T12:40:00.000Z',
  material: ['铝型材 6063-T5', 'Q235 钢板']
};
const info = toPanelInfo(record);

test('toPanelInfo：工程记录转面板信息，缺材料给空数组', () => {
  assert.equal(info.name, '光伏缓存堆叠单元');
  assert.equal(info.parts, 140);
  assert.deepEqual(info.envelopeMm, [1500, 1400, 1800]);
  assert.equal(info.massKg, 803.9);
  assert.deepEqual(info.materials, ['铝型材 6063-T5', 'Q235 钢板']);
  assert.deepEqual(toPanelInfo({ ...record, material: undefined }).materials, []);
});

test('summaryHtml：显示件数/包络/合计质量/导出物，且写明不显示演示件', () => {
  const html = __testRenderSummary(info);
  assert.match(html, /140 件/);
  assert.match(html, /1500 × 1400 × 1800 mm/);
  assert.match(html, /803\.9 kg/);
  assert.match(html, /STEP \/ STL/);
  assert.match(html, /演示气缸的属性只在未打开工程时出现/);
});

test('partHtml：选中零件显示真实包围盒与工程归属，不编质量', () => {
  const html = __testRenderPart('链轨-近侧-外', [0, 0, 0, 1200, 8, 1640], info);
  assert.match(html, /链轨-近侧-外/);
  assert.match(html, /1200 × 8 × 1640 mm/, '包围盒由 max-min 算出');
  assert.match(html, /0~1200/, '给出 XYZ 范围');
  assert.match(html, /所属工程：光伏缓存堆叠单元/);
  assert.match(html, /未称重（工程合计 803\.9 kg）/, '单件质量不估算，只给工程合计');
});

test('partHtml：没有包围盒时显示占位，不抛错', () => {
  const html = __testRenderPart('未知件', null, info);
  assert.match(html, /包围盒<\/span><b>—/);
});

test('partHtml：名称做 HTML 转义（零件名可能带 < >）', () => {
  const html = __testRenderPart('托条<3mm>', null, info);
  assert.equal(html.includes('<3mm>'), false);
  assert.match(html, /托条&lt;3mm&gt;/);
});

import { groupOfPartName } from '../../src/assembly/project-panel.ts';

test('groupOfPartName：按第一个连字符前缀分组，与结构树分组规则一致', () => {
  assert.equal(groupOfPartName('托条-L17-2'), '托条');
  assert.equal(groupOfPartName('链轨-近侧-外'), '链轨');
  assert.equal(groupOfPartName('立柱-左前'), '立柱');
  assert.equal(groupOfPartName('驱动座'), '其他', '没有分隔符的件归「其他」');
  assert.equal(groupOfPartName(''), '其他');
});
