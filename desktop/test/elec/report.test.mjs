import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runElectricalCheck } from '../../src/elec/check.ts';
import { renderElecCheckHtml, SEVERITY_LABELS } from '../../src/elec/report.ts';

function sampleResult() {
  return runElectricalCheck({
    wires: [
      { no: '101', net: 'n1', potential: 'L1', from: 'QF1:2', to: 'KM1:1' },
      { no: '101', net: 'n2', potential: 'L1', from: 'KM1:2', to: 'M1:U' },
      { no: '', net: 'n3', potential: 'L2', from: 'QF2:2', to: 'KM1:3' }
    ],
    loads: [
      { tag: 'M1', powerKw: 2.2, phase: '3P' },
      { tag: 'YV1', powerKw: 0.02, phase: 'DC24' }
    ],
    circuits: [{ wireNo: '101', currentA: 30, sectionMm2: 2.5, breakerA: 32 }],
    options: { psuRatedA: 2 }
  });
}

test('报告包含项目信息、级别中文名与问题清单', () => {
  const result = sampleResult();
  const html = renderElecCheckHtml({ name: '包装机', code: 'ELEC-001', author: '老王' }, result);

  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /包装机 · 电气校验报告/);
  assert.match(html, /ELEC-001/);
  assert.match(html, /老王/);
  for (const label of Object.values(SEVERITY_LABELS)) {
    assert.ok(html.includes(label), `缺少级别中文名：${label}`);
  }
  assert.ok(html.includes('WIRE_NO_CROSS_NET'), '缺少跨网络重号规则');
  assert.ok(html.includes('截面 2.5mm² 载流量'), '缺少截面不足描述');
  assert.ok(html.includes('位置：'), '缺少问题位置标签');
  assert.ok(html.includes('KM1:2→M1:U'), '缺少问题位置内容');
});

test('报告统计与主断路器、24V 余量来自同一份结果', () => {
  const result = sampleResult();
  const html = renderElecCheckHtml({ name: '包装机' }, result);
  const breaker = result.summary.breakerSuggestion;

  assert.ok(breaker);
  assert.ok(html.includes(`${breaker.ratedA} A`), '缺少主断路器额定电流');
  assert.ok(html.includes(`≥${breaker.cableMm2} mm²`), '缺少主进线截面建议');
  assert.ok(html.includes(`${result.summary.totalKw.toFixed(2)} kW`));
  assert.ok(html.includes(`${result.summary.maxPhaseCurrentA.toFixed(1)} A`));
  assert.ok(html.includes(`${(result.summary.unbalanceRatio * 100).toFixed(1)} %`));
});

test('报告对问题文本做 HTML 转义，不注入标签', () => {
  const result = sampleResult();
  result.findings.push({
    code: 'XSS',
    severity: 'warning',
    message: '<script>alert(1)</script>',
    location: '<b>x</b>',
    suggestion: '"引号" & 与'
  });
  const html = renderElecCheckHtml({ name: '<项目>' }, result);

  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(html.includes('&quot;引号&quot; &amp; 与'));
  assert.ok(html.includes('&lt;项目&gt;'));
});

test('只有提示级问题时给出通过结论', () => {
  const info = runElectricalCheck({
    wires: [{ no: '101', net: 'n1', potential: 'L1', from: 'A', to: 'B' }]
  });
  const html = renderElecCheckHtml({ name: '空机台' }, info);

  assert.equal(info.counts.error, 0);
  assert.equal(info.counts.warning, 0);
  assert.ok(info.counts.info > 0, '未登记负载应给出提示');
  assert.ok(html.includes('通过：未发现严重问题'));
  assert.ok(!html.includes('class="verdict bad"'));
  assert.ok(html.includes('未登记负载'));
});

test('无问题时问题表渲染空状态行', () => {
  const base = runElectricalCheck({ wires: [] });
  const html = renderElecCheckHtml({ name: '空机台' }, { ...base, findings: [] });

  assert.ok(html.includes('未发现问题，线号、功率与导线截面校验全部通过'));
  assert.ok(html.includes('未登记负载') === false);
});

test('有严重问题时结论标记为不通过并高亮', () => {
  const result = sampleResult();
  assert.ok(result.counts.error > 0);
  const html = renderElecCheckHtml({ name: '包装机' }, result);

  assert.ok(html.includes('class="verdict bad"'));
  assert.ok(html.includes(`不通过：${result.counts.error} 项严重问题必须处理`));
});
