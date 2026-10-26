import test from 'node:test';
import assert from 'node:assert/strict';
import { completeDesign } from '../../src/design/synthesis.ts';
import { syncDesignBom } from '../../src/design/bom-sync.ts';

const baseDesign = completeDesign({
  process: 'screw',
  stations: 2,
  cyclePerMin: 10,
  layout: 'auto',
  processes: ['锁螺丝'],
  actuators: [],
  sensors: [],
  brand: null,
  voltage: '380VAC',
  notes: []
}, []);

test('BOM 设备行按当前工位配置重建，旧数量不再沿用', () => {
  const design = {
    ...baseDesign,
    config: {
      ...baseDesign.config,
      stations: ['上料'],
      actuators: [
        { id: 'cyl-1', name: '推料气缸', kind: 'cylinder', station: '上料' },
        { id: 'grip-1', name: '夹持气爪', kind: 'gripper', station: '上料', model: 'MHZ2-20D', partId: 'MHZ2-20D', packId: 'smc-cn' }
      ],
      sensors: [
        { point: 'ST1-PRX-S1', station: '上料', part: 'cyl-1' },
        { point: 'ST1-SAFE-S1', station: '上料', part: '上料' }
      ]
    }
  };
  const electricalBefore = baseDesign.bomDraft.items.filter((item) => item.kind === 'electrical');
  const synced = syncDesignBom(design);
  const items = synced.bomDraft.items;

  assert.equal(items.find((item) => item.role === 'cylinder')?.qty, 1);
  assert.equal(items.find((item) => item.role === 'gripper')?.qty, 1);
  assert.equal(items.find((item) => item.role === 'gripper')?.model, 'MHZ2-20D');
  assert.equal(items.find((item) => item.role === 'gripper')?.partId, 'MHZ2-20D');
  assert.equal(items.find((item) => item.role === 'sensor' && /接近/.test(item.name))?.qty, 1);
  assert.equal(items.find((item) => item.role === 'safety')?.qty, 1);
  assert.deepEqual(items.filter((item) => item.kind === 'electrical'), electricalBefore);
  assert.ok(items.find((item) => item.role === 'cylinder')?.pendingSelection);
});

test('没有当前旋转轴时不保留旧伺服行；有夹爪而无阀选型时显式待选型', () => {
  const stale = {
    ...baseDesign,
    config: {
      ...baseDesign.config,
      stations: ['工位 1'],
      actuators: [{ id: 'grip-1', name: '气爪', kind: 'gripper', station: '工位 1' }],
      sensors: []
    },
    bomDraft: {
      items: [
        ...baseDesign.bomDraft.items,
        { kind: 'actuator', name: '伺服电机', qty: 2, role: 'servo', model: '旧型号' }
      ]
    }
  };
  const items = syncDesignBom(stale).bomDraft.items;

  assert.ok(!items.some((item) => item.role === 'servo'));
  const valve = items.find((item) => item.role === 'valve');
  assert.equal(valve?.qty, 1);
  assert.equal(valve?.pendingSelection, true);
});

test('保留伺服选型时按当前旋转轴数更新数量，未选型仍明确待选', () => {
  const design = {
    ...baseDesign,
    config: {
      ...baseDesign.config,
      stations: ['工位 1'],
      actuators: [{ id: 'rotary-1', name: '转台', kind: 'rotary', station: '工位 1' }],
      sensors: []
    },
    bomDraft: {
      items: [
        { kind: 'actuator', name: '伺服电机', qty: 2, role: 'servo', model: 'MS1H1-75B30CB' },
        { kind: 'actuator', name: '伺服驱动器', qty: 2, role: 'servo', model: 'SV660PS5R5I' }
      ]
    }
  };
  const items = syncDesignBom(design).bomDraft.items;

  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.qty === 1));
  assert.ok(items.every((item) => item.pendingSelection !== true));
});

test('设备类别或绑定型号变化时不继承旧行的型号与额定功率', () => {
  const design = {
    ...baseDesign,
    config: {
      ...baseDesign.config,
      stations: ['工位 1'],
      actuators: [{ id: 'grip-1', name: '夹爪', kind: 'gripper', station: '工位 1', model: 'NEW-MODEL', partId: 'new-id', packId: 'new-pack' }],
      sensors: []
    },
    bomDraft: {
      items: [{ kind: 'actuator', name: '气缸', qty: 1, role: 'cylinder', model: 'OLD-MODEL', partId: 'old-id', packId: 'old-pack', ratedW: 900 }]
    }
  };
  const gripper = syncDesignBom(design).bomDraft.items.find((item) => item.role === 'gripper');

  assert.equal(gripper?.name, '气爪');
  assert.equal(gripper?.model, 'NEW-MODEL');
  assert.equal(gripper?.partId, 'new-id');
  assert.equal(gripper?.packId, 'new-pack');
  assert.equal(gripper?.ratedW, undefined);
});
