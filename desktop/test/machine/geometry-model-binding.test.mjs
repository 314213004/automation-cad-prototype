import assert from 'node:assert/strict';
import test from 'node:test';
import { demoMachineConfig } from '../../src/commission/machine-config.ts';
import { generateMachineGeometry } from '../../src/machine/geometry.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { withGeometryAssessment } from '../../src/design/footprint.ts';

function withUnknownBoundModel(config) {
  const actuators = config.actuators.map((item, index) => index === 0
    ? { ...item, model: 'MODEL-NOT-IN-CATALOG', partId: 'unknown-part', packId: 'custom-pack' }
    : { ...item });
  return { ...config, actuators, sensors: config.sensors.map((item) => ({ ...item })) };
}

test('型号绑定不会冒充真实模型：占位体保持估算标记并显式警告未联动', () => {
  const config = demoMachineConfig();
  const base = generateMachineGeometry(config, { layout: 'linear', bypassCache: true });
  const selected = generateMachineGeometry(withUnknownBoundModel(config), { layout: 'linear', bypassCache: true });

  assert.equal(selected.geometryFidelity, 'conceptual-estimate');
  assert.ok(selected.parts.length > 0);
  assert.ok(selected.parts.every((part) => part.estimated === true));
  assert.deepEqual(selected.envelope, base.envelope, '未知型号不得静默改变典型尺寸包络');
  assert.deepEqual(selected.parts, base.parts, '没有安装基准/模型资源时不得猜造选型几何');
  assert.ok(selected.assumptions.some((line) => /dims.*w×h×d（mm）.*安装基准/.test(line)));
  assert.ok(selected.warnings.some((line) => /型号绑定未联动到 CAD 几何.*MODEL-NOT-IN-CATALOG.*通用典型占位尺寸/.test(line)));
  assert.ok(selected.warnings.some((line) => /估算占位几何.*安装空间.*制造尺寸/.test(line)));
});

test('型号与几何脱节警告进入设计假设/警告且重复刷新不叠加', () => {
  const design = synthMachine(parseMachineBrief('四工位装配机，2 个气缸'));
  const selectedDesign = {
    ...design,
    config: withUnknownBoundModel(design.config)
  };
  const assessed = withGeometryAssessment(selectedDesign);
  const refreshed = withGeometryAssessment(assessed);

  assert.ok(assessed.assumptions.some((line) => /CAD 几何精度：概念估算占位体（conceptual-estimate）/.test(line)));
  assert.ok(assessed.assumptions.some((line) => /CAD 几何假设：.*estimated.*型号级 STEP/.test(line)));
  assert.ok(assessed.warnings.some((line) => /CAD 几何警告：型号绑定未联动到 CAD 几何.*MODEL-NOT-IN-CATALOG/.test(line)));
  assert.equal(refreshed.assumptions.filter((line) => line.startsWith('CAD 几何精度：')).length, 1);
  assert.equal(refreshed.warnings.filter((line) => line.startsWith('CAD 几何警告：')).length, assessed.warnings.filter((line) => line.startsWith('CAD 几何警告：')).length);
});
