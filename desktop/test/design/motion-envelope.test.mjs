import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeConceptMotionEnvelopes, renderMotionEnvelopePanel } from '../../src/design/motion-envelope.ts';
import { projectMachineGeometryTopView, renderGeometryTopViewSvg } from '../../src/design/geometry-plan-view.ts';
import { demoMachineConfig } from '../../src/commission/machine-config.ts';
import { generateMachineGeometry, partBounds } from '../../src/machine/geometry.ts';
import { applyStationGeometryLayout } from '../../src/machine/station-layout.ts';

function realGeometry() {
  return generateMachineGeometry(demoMachineConfig(), { layout: 'linear', bypassCache: true });
}

function axisResult(analysis, actuatorId) {
  const result = analysis.axes.find((item) => item.actuatorId === actuatorId);
  assert.ok(result, `缺少轴 ${actuatorId}`);
  return result;
}

function contains(bounds, candidate, label) {
  const epsilon = 1e-7;
  assert.ok(candidate.min[0] >= bounds.minX - epsilon, `${label}: minX ${candidate.min[0]} < ${bounds.minX}`);
  assert.ok(candidate.max[0] <= bounds.maxX + epsilon, `${label}: maxX ${candidate.max[0]} > ${bounds.maxX}`);
  assert.ok(candidate.min[1] >= bounds.minY - epsilon, `${label}: minY ${candidate.min[1]} < ${bounds.minY}`);
  assert.ok(candidate.max[1] <= bounds.maxY + epsilon, `${label}: maxY ${candidate.max[1]} > ${bounds.maxY}`);
}

function close(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${label}: ${actual} != ${expected}`);
}

function rotatePointAroundPivot(point, pivot, angleDeg) {
  const angle = angleDeg * Math.PI / 180;
  const dx = point[0] - pivot[0];
  const dy = point[1] - pivot[1];
  return [pivot[0] + dx * Math.cos(angle) - dy * Math.sin(angle), pivot[1] + dx * Math.sin(angle) + dy * Math.cos(angle), point[2]];
}

test('真实几何：linear 与 gripper 全行程边界精确，采样位置全部包含；双指按 ±sign 各走半行程', () => {
  const geometry = realGeometry();
  const reviewedGeometry = { pass: false, errors: ['existing geometry review finding'], state: 'concept' };
  const analysisInput = { ...geometry, reviewedGeometry };
  const beforeAnalysis = JSON.stringify(analysisInput);
  const analysis = analyzeConceptMotionEnvelopes(analysisInput);
  assert.equal(analysis.status, 'computed');
  assert.equal(JSON.stringify(analysisInput), beforeAnalysis);
  assert.deepEqual(analysisInput.reviewedGeometry, reviewedGeometry);
  assert.equal('pass' in analysis, false);
  assert.match(renderMotionEnvelopePanel(analysis), /双指总行程 40 mm（每指 ±20 mm）/);
  const linear = geometry.moving.find((axis) => axis.kind === 'linear');
  const gripper = geometry.moving.find((axis) => axis.kind === 'gripper');
  assert.ok(linear, '真实 demo 几何应包含直线轴');
  assert.ok(gripper, '真实 demo 几何应包含夹爪轴');
  for (const sourceAxis of [linear, gripper]) {
    const computed = axisResult(analysis, sourceAxis.actuatorId);
    assert.equal(computed.coverage, 'covered', computed.reason);
    for (const partId of sourceAxis.partIds) {
      const part = geometry.parts.find((item) => item.id === partId);
      const envelope = computed.parts.find((item) => item.partId === partId);
      assert.ok(part && envelope, `${sourceAxis.actuatorId}/${partId}`);
      const base = partBounds(part);
      let expectedMinX = base.min[0];
      let expectedMaxX = base.max[0];
      let expectedMinY = base.min[1];
      let expectedMaxY = base.max[1];
      const jaw = sourceAxis.kind === 'gripper' ? sourceAxis.jaws.find((item) => item.partId === partId) : undefined;
      const factor = sourceAxis.kind === 'gripper' ? sourceAxis.strokeMm / 2 * jaw.sign : sourceAxis.strokeMm;
      const dx = sourceAxis.axis[0] * factor;
      const dy = sourceAxis.axis[1] * factor;
      expectedMinX = Math.min(expectedMinX, base.min[0] + dx);
      expectedMaxX = Math.max(expectedMaxX, base.max[0] + dx);
      expectedMinY = Math.min(expectedMinY, base.min[1] + dy);
      expectedMaxY = Math.max(expectedMaxY, base.max[1] + dy);
      close(envelope.bounds.minX, expectedMinX, `${sourceAxis.kind}/${partId} minX boundary`);
      close(envelope.bounds.maxX, expectedMaxX, `${sourceAxis.kind}/${partId} maxX boundary`);
      close(envelope.bounds.minY, expectedMinY, `${sourceAxis.kind}/${partId} minY boundary`);
      close(envelope.bounds.maxY, expectedMaxY, `${sourceAxis.kind}/${partId} maxY boundary`);
      for (let sample = 0; sample <= 20; sample += 1) {
        const ratio = sample / 20;
        const distance = factor * ratio;
        const moved = { ...part, center: [part.center[0] + sourceAxis.axis[0] * distance, part.center[1] + sourceAxis.axis[1] * distance, part.center[2] + sourceAxis.axis[2] * distance] };
        contains(envelope.bounds, partBounds(moved), `${sourceAxis.kind}/${partId} sample ${sample}`);
      }
      if (jaw) {
        const projection = sourceAxis.axis.reduce((sum, component, index) => sum + component * ((part.center[index] + component * factor) - part.center[index]), 0);
        close(projection, jaw.sign * sourceAxis.strokeMm / 2, `${partId} jaw direction/half-stroke`);
      }
    }
    close(computed.bounds.minX, Math.min(...computed.parts.map((part) => part.bounds.minX)), `${sourceAxis.kind} union minX`);
    close(computed.bounds.maxX, Math.max(...computed.parts.map((part) => part.bounds.maxX)), `${sourceAxis.kind} union maxX`);
  }
  const signs = gripper.jaws.map((jaw) => jaw.sign).sort();
  assert.deepEqual(signs, [-1, 1]);
});

test('真实几何：rotary 偏心随动件的采样姿态均落在保守 Z 轴 swept XY AABB 内', () => {
  const geometry = realGeometry();
  const analysis = analyzeConceptMotionEnvelopes(geometry);
  const rotary = geometry.moving.find((axis) => axis.kind === 'rotary');
  assert.ok(rotary, '真实 demo 几何应包含旋转轴');
  const computed = axisResult(analysis, rotary.actuatorId);
  assert.equal(computed.coverage, 'covered', computed.reason);
  assert.ok(rotary.rangeDeg > 0);
  for (const partId of rotary.partIds) {
    const part = geometry.parts.find((item) => item.id === partId);
    const envelope = computed.parts.find((item) => item.partId === partId);
    assert.ok(part && envelope);
    for (let sample = 0; sample <= 120; sample += 1) {
      const angle = rotary.axis[2] * rotary.rangeDeg * sample / 120;
      const center = rotatePointAroundPivot(part.center, rotary.pivot, angle);
      const moved = { ...part, center, rotationZDeg: part.rotationZDeg + angle };
      contains(envelope.bounds, partBounds(moved), `${partId} rotary sample ${sample}`);
    }
  }
  const fullTurn = analyzeConceptMotionEnvelopes({ ...geometry, moving: geometry.moving.map((axis) => axis.actuatorId === rotary.actuatorId ? { ...axis, rangeDeg: 360 } : axis) });
  const fullTurnAxis = axisResult(fullTurn, rotary.actuatorId);
  assert.equal(fullTurnAxis.coverage, 'covered');
  for (const item of fullTurnAxis.parts) {
    const part = geometry.parts.find((candidate) => candidate.id === item.partId);
    const base = partBounds(part);
    const radius = Math.max(...[
      [base.min[0], base.min[1]], [base.min[0], base.max[1]], [base.max[0], base.min[1]], [base.max[0], base.max[1]]
    ].map(([x, y]) => Math.hypot(x - rotary.pivot[0], y - rotary.pivot[1])));
    close(item.bounds.minX, rotary.pivot[0] - radius, `${item.partId} full-turn minX`);
    close(item.bounds.maxY, rotary.pivot[1] + radius, `${item.partId} full-turn maxY`);
  }
});

test('平移工位后：该工位真实零件扫掠包络同量平移，其他工位不动', () => {
  const geometry = realGeometry();
  const station = geometry.stations.find((item) => item.actuatorIds.length > 0 && item.id === 'st2') ?? geometry.stations.find((item) => item.actuatorIds.length > 0);
  assert.ok(station);
  const dx = 321.25;
  const dy = -456.75;
  const identities = geometry.stations.map((_item, index) => `station:motion-${index + 1}`);
  const moved = applyStationGeometryLayout(geometry, {
    schemaVersion: 2,
    offsets: [{ stationIdentity: identities[station.index], stationName: station.name, xMm: dx, yMm: dy }]
  }, identities);
  const before = analyzeConceptMotionEnvelopes(geometry);
  const after = analyzeConceptMotionEnvelopes(moved);
  assert.equal(after.status, 'computed');
  for (const axis of geometry.moving) {
    const first = axisResult(before, axis.actuatorId);
    const second = axisResult(after, axis.actuatorId);
    assert.equal(second.coverage, first.coverage, axis.actuatorId);
    if (axis.stationId !== station.id || first.coverage !== 'covered') {
      assert.deepEqual(second.bounds, first.bounds, `${axis.actuatorId} must remain unchanged`);
      continue;
    }
    close(second.bounds.minX, first.bounds.minX + dx, `${axis.actuatorId} translated minX`);
    close(second.bounds.maxX, first.bounds.maxX + dx, `${axis.actuatorId} translated maxX`);
    close(second.bounds.minY, first.bounds.minY + dy, `${axis.actuatorId} translated minY`);
    close(second.bounds.maxY, first.bounds.maxY + dy, `${axis.actuatorId} translated maxY`);
  }
});

test('未知或错误轴关联、无效行程/轴/枢轴及不支持 rotary 方向均阻断对应轴，不假报包络', () => {
  const geometry = realGeometry();
  const axis = geometry.moving.find((item) => item.kind === 'linear');
  const rotary = geometry.moving.find((item) => item.kind === 'rotary');
  assert.ok(axis && rotary);
  const mutations = [
    ['missing-part', (item) => ({ ...item, partIds: ['not-a-real-part'] }), /ID\/工位\/执行机构|随动零件/],
    ['negative-stroke', (item) => ({ ...item, strokeMm: -1 }), /行程/],
    ['infinite-stroke', (item) => ({ ...item, strokeMm: Infinity }), /行程/],
    ['non-unit-axis', (item) => ({ ...item, axis: [2, 0, 0] }), /归一化/],
    ['invalid-pivot', (item) => ({ ...item, pivot: [0, Number.NaN, 0] }), /枢轴/],
    ['wrong-actuator-part', (item) => ({ ...item, partIds: [geometry.parts.find((part) => part.actuatorId !== item.actuatorId && part.moving)?.id ?? 'missing'] }), /ID\/工位\/执行机构|随动零件/]
  ];
  for (const [label, mutate, expected] of mutations) {
    const result = analyzeConceptMotionEnvelopes({ ...geometry, moving: geometry.moving.map((item) => item.actuatorId === axis.actuatorId ? mutate(item) : item) });
    const computed = axisResult(result, axis.actuatorId);
    assert.equal(computed.coverage, 'uncovered', label);
    assert.match(computed.reason, expected, label);
    assert.equal(computed.parts.length, 0, `${label}: invalid axis must not render an envelope`);
  }
  const unsupportedRotary = analyzeConceptMotionEnvelopes({ ...geometry, moving: geometry.moving.map((item) => item.actuatorId === rotary.actuatorId ? { ...item, axis: [1, 0, 0] } : item) });
  const unsupported = axisResult(unsupportedRotary, rotary.actuatorId);
  assert.equal(unsupported.coverage, 'uncovered');
  assert.match(unsupported.reason, /世界 Z 轴旋转/);
  assert.equal(unsupported.parts.length, 0);
  const badRange = analyzeConceptMotionEnvelopes({ ...geometry, moving: geometry.moving.map((item) => item.actuatorId === rotary.actuatorId ? { ...item, rangeDeg: Number.NaN } : item) });
  assert.equal(axisResult(badRange, rotary.actuatorId).coverage, 'uncovered');
  const unsupportedPartTransform = analyzeConceptMotionEnvelopes({ ...geometry, parts: geometry.parts.map((part, index) => index === 0 ? { ...part, rotationXDeg: 5 } : part) });
  assert.equal(unsupportedPartTransform.status, 'blocked');
  assert.match(unsupportedPartTransform.reason, /未支持的坐标变换/);
  const missingMapping = analyzeConceptMotionEnvelopes({ ...geometry, moving: geometry.moving.slice(1) });
  assert.ok(missingMapping.uncoveredParts.some((part) => part.partId === axis.partIds[0]));
});

test('3D AABB 相交只生成“需人工复核”提示；没有 AABB 重叠也不构成校核通过', () => {
  const geometry = realGeometry();
  const axis = geometry.moving.find((item) => item.kind === 'linear');
  assert.ok(axis);
  const initial = analyzeConceptMotionEnvelopes(geometry);
  const envelope = axisResult(initial, axis.actuatorId).parts[0];
  assert.ok(envelope);
  const staticPart = geometry.parts.find((part) => part.moving !== true && !axis.partIds.includes(part.id));
  assert.ok(staticPart);
  const overlapped = analyzeConceptMotionEnvelopes({
    ...geometry,
    parts: geometry.parts.map((part) => part.id === staticPart.id
      ? { ...part, shape: { type: 'box', size: [4, 4, 4] }, center: [(envelope.bounds.minX + envelope.bounds.maxX) / 2, (envelope.bounds.minY + envelope.bounds.maxY) / 2, (envelope.minZ + envelope.maxZ) / 2] }
      : part)
  });
  assert.ok(overlapped.alerts.some((item) => item.other.partId === staticPart.id && item.other.kind === 'static'));
  const alertPanel = renderMotionEnvelopePanel(overlapped);
  assert.match(alertPanel, /需人工复核/);
  assert.match(alertPanel, new RegExp(staticPart.id));
  assert.match(alertPanel, /可能误报/);
  assert.match(alertPanel, /未建模线缆/);
  assert.match(alertPanel, /不表示无干涉/);
  assert.doesNotMatch(alertPanel, /安全校核通过/);

  const station = geometry.stations.find((item) => item.id === axis.stationId);
  const movingPart = geometry.parts.find((part) => part.id === axis.partIds[0]);
  assert.ok(station && movingPart);
  const isolatedAxis = { ...axis, kind: 'linear', axis: [1, 0, 0], pivot: [0, 0, 0], strokeMm: 10, rangeDeg: 0, home: 'retracted', jaws: undefined, partIds: [movingPart.id] };
  const isolatedMoving = { ...movingPart, shape: { type: 'box', size: [2, 2, 2] }, center: [0, 0, 0], rotationZDeg: 0, moving: true, stationId: station.id, actuatorId: axis.actuatorId };
  const farStatic = { ...staticPart, id: 'far-static-test', name: '远处静止件', shape: { type: 'box', size: [2, 2, 2] }, center: [1000, 1000, 0], rotationZDeg: 0, moving: false, stationId: station.id, actuatorId: undefined };
  const isolated = { ...geometry, stations: [station], parts: [isolatedMoving, farStatic], moving: [isolatedAxis] };
  const clearOfOverlap = analyzeConceptMotionEnvelopes(isolated);
  assert.equal(clearOfOverlap.status, 'computed');
  assert.equal(clearOfOverlap.alerts.length, 0);
  const noOverlapPanel = renderMotionEnvelopePanel(clearOfOverlap);
  assert.match(noOverlapPanel, /本次未发现 3D AABB 重叠/);
  assert.match(noOverlapPanel, /不表示无干涉/);
  assert.match(noOverlapPanel, /即使没有 AABB 重叠，也不表示无干涉或校核通过/);
});

test('SVG 将已覆盖扫掠框作为独立颜色层叠加，失败轴不绘制', () => {
  const geometry = realGeometry();
  const analysis = analyzeConceptMotionEnvelopes(geometry);
  const projection = projectMachineGeometryTopView(geometry);
  assert.equal(projection.status, 'ready');
  const svg = renderGeometryTopViewSvg(projection, { motionAnalysis: analysis });
  assert.match(svg, /class="geometry-plan-motion-envelope"/);
  assert.match(svg, /data-geometry-motion-envelope="true"/);
  const gripper = geometry.moving.find((axis) => axis.kind === 'gripper');
  assert.ok(gripper);
  const extended = analyzeConceptMotionEnvelopes({ ...geometry, moving: geometry.moving.map((axis) => axis.actuatorId === gripper.actuatorId ? { ...axis, strokeMm: 10000 } : axis) });
  const extendedSvg = renderGeometryTopViewSvg(projection, { motionAnalysis: extended });
  const viewBox = extendedSvg.match(/viewBox="([^"]+)"/)?.[1]?.split(/\s+/).map(Number);
  assert.ok(viewBox && viewBox.length === 4);
  const overlayRects = [...extendedSvg.matchAll(/<rect class="geometry-plan-motion-envelope"[^>]*>/g)].map(([tag]) => {
    const attribute = (name) => Number(tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1]);
    return { x: attribute('x'), y: attribute('y'), width: attribute('width'), height: attribute('height') };
  });
  assert.ok(overlayRects.length > 0);
  const [viewMinX, viewMinY, viewWidth, viewHeight] = viewBox;
  for (const rect of overlayRects) {
    assert.ok(rect.x >= viewMinX && rect.x + rect.width <= viewMinX + viewWidth, 'swept X bounds must remain in the SVG viewBox');
    assert.ok(rect.y >= viewMinY && rect.y + rect.height <= viewMinY + viewHeight, 'swept Y bounds must remain in the SVG viewBox');
  }
  const brokenAxis = geometry.moving[0];
  const blockedAxis = analyzeConceptMotionEnvelopes({ ...geometry, moving: geometry.moving.map((axis) => axis.actuatorId === brokenAxis.actuatorId ? { ...axis, partIds: ['missing'] } : axis) });
  const blockedSvg = renderGeometryTopViewSvg(projection, { motionAnalysis: blockedAxis });
  assert.doesNotMatch(blockedSvg, new RegExp(`data-motion-axis-id="${brokenAxis.actuatorId}"`));
});
