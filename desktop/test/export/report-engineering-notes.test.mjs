import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReportHtml } from '../../src/export/report.ts';
import { demoMachineConfig } from '../../src/commission/machine-config.ts';
import { generateMachineGeometry } from '../../src/machine/geometry.ts';

test('PDF HTML reports expose CAD estimate boundaries, model warnings, and escape user/library text', () => {
  const html = renderReportHtml({
    project: { name: '几何口径测试' },
    bom: [],
    interference: [],
    stress: [],
    engineeringNotes: {
      assumptions: ['CAD 几何精度：概念估算占位体；未加载 dims/asset。'],
      warnings: ['型号绑定未联动：<MODEL-X> & 未按型号建模。']
    }
  });

  assert.match(html, /CAD 几何假设与工程警告/);
  assert.match(html, /概念估算占位体/);
  assert.match(html, /CAD 几何精度：概念估算占位体；未加载 dims\/asset/);
  assert.match(html, /型号绑定未联动：&lt;MODEL-X&gt; &amp; 未按型号建模/);
  assert.doesNotMatch(html, /型号绑定未联动：<MODEL-X>/);
});

test('PDF HTML reports distinguish default estimated strokes from engineer-entered pending-review strokes', () => {
  const base = demoMachineConfig();
  const firstCylinder = base.actuators.find((item) => item.kind === 'cylinder');
  assert.ok(firstCylinder);
  const config = {
    ...base,
    actuators: base.actuators.map((item) => item.id === firstCylinder.id
      ? { ...item, travelMm: 88, travelSource: 'engineer-input' }
      : item)
  };
  const geometry = generateMachineGeometry(config, { bypassCache: true });
  const html = renderReportHtml({
    project: { name: '行程来源报告' },
    bom: [],
    interference: [],
    stress: [],
    engineeringNotes: { assumptions: geometry.assumptions, warnings: geometry.warnings }
  });

  assert.match(html, /直线行程（方案\/系统估算）/);
  assert.match(html, /直线行程（工程师输入·待复核）/);
  assert.match(html, /工程师输入的直线行程尚待复核/);
  assert.match(html, /概念估算占位体/);
  assert.match(html, /概念占位体仍非型号级制造模型/);
});

test('PDF HTML reports distinguish estimated and engineer-entered rotary ranges without claiming model or manufacturing data', () => {
  const base = demoMachineConfig();
  const rotary = base.actuators.find((item) => item.kind === 'rotary');
  assert.ok(rotary);
  const config = {
    ...base,
    actuators: base.actuators.map((item) => item.id === rotary.id
      ? { ...item, rotationRangeDeg: 123.5, rotationRangeSource: 'engineer-input' }
      : item)
  };
  const geometry = generateMachineGeometry(config, { bypassCache: true });
  const html = renderReportHtml({
    project: { name: '旋转分度角来源报告' },
    bom: [],
    interference: [],
    stress: [],
    engineeringNotes: { assumptions: geometry.assumptions, warnings: geometry.warnings }
  });

  assert.match(html, /旋转轴分度角（方案\/系统估算）.*90°/);
  assert.match(html, /旋转轴分度角（工程师输入·待复核）.*123\.5°/);
  assert.match(html, /工程师输入的旋转轴分度角尚待复核/);
  assert.match(html, /不代表具体旋转台型号、安装或制造数据/);
  assert.match(html, /概念估算占位体/);
});
