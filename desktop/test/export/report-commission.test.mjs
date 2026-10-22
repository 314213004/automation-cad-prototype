import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderReportHtml } from '../../src/export/report.ts';

test('PDF 报告渲染 commission 章节与失败明细', () => {
  const html = renderReportHtml({
    project: { name: '联调样机', code: 'P2-B' },
    bom: [],
    interference: [],
    stress: [],
    commission: {
      plcKind: 'sim',
      plcStatus: 'connected',
      startedAt: '2026-10-22T00:00:00.000Z',
      completedAt: '2026-10-22T00:01:00.000Z',
      powerUp: {
        pass: false,
        results: [{
          stepId: 'power.main',
          name: '1. 主回路',
          pass: false,
          expected: 'Y0 = true',
          actual: 'Y0 = false',
          durationMs: 12,
          message: '主回路接触器未吸合'
        }]
      },
      cases: [{
        id: 'jog',
        name: '点动',
        pass: true,
        at: '2026-10-22T00:01:00.000Z',
        durationMs: 120,
        results: [{
          stepId: 'jog.on',
          name: '点动前进',
          pass: true,
          expected: 'Y6 = true',
          actual: 'Y6 = true',
          durationMs: 100
        }]
      }],
      points: [{ id: 'Y0', name: '主回路', value: false }]
    }
  });
  assert.match(html, /通电联调/);
  assert.match(html, /上电顺序检查/);
  assert.match(html, /联调用例明细/);
  assert.match(html, /Y0 = false/);
  assert.match(html, /点动/);
});
