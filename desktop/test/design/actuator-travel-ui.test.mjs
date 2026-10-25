import assert from 'node:assert/strict';
import test from 'node:test';
import { actuatorRotationRangeInputError, actuatorRotationRangeSourceLabel, actuatorTravelInputError, actuatorTravelSourceLabel, guardMotionInputs, renderActuatorTravelCell } from '../../src/design/actuator-travel-ui.ts';
import { resetActuatorTravelOnKindChange } from '../../src/design/wizard-state.ts';

test('行程输入控件明确显示 mm、范围与方案估算/工程师待复核来源', () => {
  const estimated = renderActuatorTravelCell({ id: 'cyl-1', name: '推料气缸', kind: 'cylinder', station: '上料', travelMm: 40 }, 0);
  assert.match(estimated, /type="number" min="0\.1" max="2000" step="0\.1"/);
  assert.match(estimated, /aria-label="推料气缸行程（毫米）"/);
  assert.match(estimated, /value="40"/);
  assert.match(estimated, /<span>mm<\/span>/);
  assert.match(estimated, /方案\/系统估算·待核验/);

  const edited = { id: 'grip-1', name: '夹爪', kind: 'gripper', station: '取料', travelMm: 35, travelSource: 'engineer-input' };
  const html = renderActuatorTravelCell(edited, 1);
  assert.match(html, /data-key="travelMm"/);
  assert.match(html, /工程师输入·待复核/);
  assert.equal(actuatorTravelSourceLabel(edited), '工程师输入·待复核');
});

test('旋转轴分度角可编辑，默认 90° 标为估算；拒绝非有限、低于下限与超上限值', () => {
  const rotary = renderActuatorTravelCell({ id: 'rot-1', name: '转盘', kind: 'rotary', station: '装配' }, 0);
  assert.match(rotary, /type="number" min="0\.1" max="360" step="0\.1"/);
  assert.match(rotary, /data-key="rotationRangeDeg"/);
  assert.match(rotary, /aria-label="转盘旋转分度角（度）"/);
  assert.match(rotary, /value="90"/);
  assert.match(rotary, /<span>°<\/span>/);
  assert.match(rotary, /方案\/系统估算·待核验/);
  assert.equal(actuatorRotationRangeSourceLabel({}), '方案/系统估算·待核验');
  assert.equal(actuatorRotationRangeSourceLabel({ rotationRangeSource: 'engineer-input' }), '工程师输入·待复核');
  assert.equal(actuatorRotationRangeInputError(Number.NaN), '旋转分度角必须是 0.1–360° 的有限数');
  assert.equal(actuatorRotationRangeInputError(0), '旋转分度角必须是 0.1–360° 的有限数');
  assert.equal(actuatorRotationRangeInputError(360.1), '旋转分度角必须是 0.1–360° 的有限数');
  assert.equal(actuatorRotationRangeInputError(180), null);
  assert.equal(actuatorTravelInputError(Number.NaN), '行程必须是 0.1–2000 mm 的有限数');
  assert.equal(actuatorTravelInputError(0), '行程必须是 0.1–2000 mm 的有限数');
  assert.equal(actuatorTravelInputError(2000.1), '行程必须是 0.1–2000 mm 的有限数');
  assert.equal(actuatorTravelInputError(40), null);
});

test('advance 守卫分别阻断无效直线行程和旋转角，并把错误呈现到对应字段', () => {
  const cases = [
    { key: 'travelMm', valueAsNumber: 0, label: '推料气缸行程（毫米）', expected: '行程必须是 0.1–2000 mm 的有限数' },
    { key: 'rotationRangeDeg', valueAsNumber: 361, label: '分度台旋转分度角（度）', expected: '旋转分度角必须是 0.1–360° 的有限数' }
  ];

  for (const [index, item] of cases.entries()) {
    const input = {
      dataset: { key: item.key, actuator: String(index) },
      valueAsNumber: item.valueAsNumber,
      customValidity: '',
      attributes: {},
      getAttribute(name) { return name === 'aria-label' ? item.label : null; },
      setCustomValidity(value) { this.customValidity = value; },
      setAttribute(name, value) { this.attributes[name] = value; }
    };
    const errorNode = { textContent: '' };
    const statusNode = { textContent: '方案/系统估算·待核验' };
    const root = {
      querySelectorAll(selector) {
        assert.equal(selector, '[data-key="travelMm"], [data-key="rotationRangeDeg"]');
        return [input];
      },
      querySelector(selector) {
        if (selector === `[data-motion-error="${index}"]`) return errorNode;
        if (selector === `[data-motion-status="${index}"]`) return statusNode;
        return null;
      }
    };
    const notifications = [];

    const mayAdvance = guardMotionInputs(root, (message) => notifications.push(message));

    assert.equal(mayAdvance, false, `${item.key} 无效时不能继续`);
    assert.equal(input.customValidity, item.expected);
    assert.equal(input.attributes['aria-invalid'], 'true');
    assert.equal(errorNode.textContent, item.expected);
    assert.equal(statusNode.textContent, '输入无效，尚未应用');
    assert.equal(notifications.length, 1);
    assert.ok(notifications[0].includes(item.label));
  }
});

test('UI 类型切换清除另一运动类型的值和来源，旋转轴回到 90° 估算', () => {
  for (const [from, to, oldTravel, oldRotation] of [
    ['cylinder', 'gripper', 125, undefined],
    ['gripper', 'cylinder', 35, undefined],
    ['rotary', 'cylinder', undefined, 135],
    ['cylinder', 'rotary', 125, undefined]
  ]) {
    const actuator = {
      id: `switch-${from}`,
      name: '切换测试执行机构',
      kind: from,
      station: '工位1',
      travelMm: oldTravel,
      travelSource: oldTravel === undefined ? undefined : 'engineer-input',
      rotationRangeDeg: oldRotation,
      rotationRangeSource: oldRotation === undefined ? undefined : 'engineer-input'
    };
    actuator.kind = to;
    resetActuatorTravelOnKindChange(actuator);

    assert.equal(actuator.travelMm, undefined);
    assert.equal(actuator.travelSource, undefined);
    assert.equal(actuator.rotationRangeSource, undefined);
    assert.equal(actuatorTravelSourceLabel(actuator), '方案/系统估算·待核验');
    const html = renderActuatorTravelCell(actuator, 0);
    assert.match(html, /方案\/系统估算·待核验/);
    if (to === 'rotary') {
      assert.equal(actuator.rotationRangeDeg, 90);
      assert.match(html, /data-key="rotationRangeDeg"/);
      assert.match(html, /value="90"/);
    } else {
      assert.equal(actuator.rotationRangeDeg, undefined);
      assert.match(html, /value="40"/);
      if (oldTravel !== undefined) assert.doesNotMatch(html, new RegExp(`value="${oldTravel}"`));
    }
  }
});
