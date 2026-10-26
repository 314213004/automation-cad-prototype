import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { demoMachineConfig } from '../src/commission/machine-config.ts';
import { precheck } from '../src/plcgen/precheck.ts';
import { buildTags } from '../src/plcgen/tags.ts';
import { generateSt } from '../src/plcgen/st.ts';

function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test-machine',
    name: '测试机型',
    stations: ['上料'],
    actuators: [
      {
        id: 'cyl-1',
        name: '上料气缸',
        kind: 'cylinder',
        station: '上料',
        extendPoint: 'Y0',
        retractPoint: 'Y1',
        travelMm: 40,
        durationMs: 400
      }
    ],
    sensors: [
      { point: 'X0', station: '上料', part: 'cyl-1' },
      { point: 'X1', station: '上料', part: 'cyl-1' }
    ],
    safety: { emergencyStop: 'X8', safetyDoor: 'X9' },
    sequence: [],
    ...overrides
  };
}

function codes(result: { errors: Array<{ code: string }> }): string[] {
  return result.errors.map((error) => error.code);
}

function fileContent(result: ReturnType<typeof generateSt>, name: string): string {
  const file = result.files.find((candidate) => candidate.path.endsWith(name));
  assert.ok(file, `缺少文件 ${name}`);
  return file.content;
}

function digest(result: ReturnType<typeof generateSt>): string {
  return createHash('sha256')
    .update(result.files.map((file) => `${file.path}\n${file.content}`).join('\n'))
    .digest('hex');
}

test('预检：合法机型无错误无警告', () => {
  const result = precheck(makeConfig());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('预检：X0 与 I0.0 指向同一地址时报地址重复', () => {
  const config = makeConfig({
    sensors: [
      { point: 'X0', station: '上料', part: 'cyl-1' },
      { point: 'I0.0', station: '上料', part: 'cyl-1' }
    ]
  });
  assert.ok(codes(precheck(config)).includes('ADDRESS_DUPLICATE'));
});

test('预检：I32.0 超出 I 区 256 点上限', () => {
  const config = makeConfig({
    sensors: [
      { point: 'X0', station: '上料', part: 'cyl-1' },
      { point: 'I32.0', station: '上料', part: 'cyl-1' }
    ]
  });
  assert.ok(codes(precheck(config)).includes('ADDRESS_OUT_OF_RANGE'));
});

test('预检：传感器显式 address 重复或越界同样拦截', () => {
  const duplicate = makeConfig({
    sensors: [
      { point: 'X0', station: '上料', part: 'cyl-1', address: 'I0.0' },
      { point: 'X1', station: '上料', part: 'cyl-1', address: 'I0.0' }
    ]
  });
  assert.ok(codes(precheck(duplicate)).includes('ADDRESS_DUPLICATE'));
  const outOfRange = makeConfig({
    sensors: [
      { point: 'X0', station: '上料', part: 'cyl-1', address: 'I31.7' },
      { point: 'X1', station: '上料', part: 'cyl-1', address: 'I32.0' }
    ]
  });
  assert.ok(codes(precheck(outOfRange)).includes('ADDRESS_OUT_OF_RANGE'));
});

test('预检：步序可直接引用传感器的显式 address', () => {
  const config = makeConfig({
    sensors: [
      { point: 'X0', station: '上料', part: 'cyl-1', address: 'I0.1' },
      { point: 'X1', station: '上料', part: 'cyl-1' }
    ],
    sequence: [{ id: 's1', action: 'wait', point: 'I0.1' }]
  });
  assert.ok(!codes(precheck(config)).includes('SEQUENCE_POINT_NOT_FOUND'));
});

test('预检：同一点位被两个执行机构占用', () => {
  const config = makeConfig({
    actuators: [
      { id: 'a1', name: '气缸 A', kind: 'cylinder', station: '上料', extendPoint: 'Y0', retractPoint: 'Y1' },
      { id: 'a2', name: '气缸 B', kind: 'cylinder', station: '上料', extendPoint: 'Y0', retractPoint: 'Y2' }
    ],
    sensors: [
      { point: 'X0', station: '上料', part: 'a1' },
      { point: 'X1', station: '上料', part: 'a2' }
    ]
  });
  assert.ok(codes(precheck(config)).includes('POINT_MULTI_ACTUATOR'));
});

test('预检：执行机构没有绑定任何到位传感器', () => {
  const config = makeConfig({ sensors: [] });
  const result = precheck(config);
  assert.ok(codes(result).includes('ACTUATOR_SENSOR_MISSING'));
});

test('预检：传感器 part 不在执行机构表中', () => {
  const config = makeConfig({
    sensors: [
      { point: 'X0', station: '上料', part: 'cyl-1' },
      { point: 'X2', station: '上料', part: 'ghost' }
    ]
  });
  const result = precheck(config);
  assert.ok(codes(result).includes('SENSOR_UNBOUND'));
});

test('预检：未定义急停报错，安全门已定义仍保留', () => {
  const config = makeConfig({ safety: { safetyDoor: 'X9' } });
  const result = precheck(config);
  assert.ok(codes(result).includes('ESTOP_UNDEFINED'));
  assert.ok(!codes(result).includes('SAFETY_DOOR_UNDEFINED'));
});

test('预检：未定义安全门报错', () => {
  const config = makeConfig({ safety: { emergencyStop: 'X8' } });
  const result = precheck(config);
  assert.ok(codes(result).includes('SAFETY_DOOR_UNDEFINED'));
  assert.ok(!codes(result).includes('ESTOP_UNDEFINED'));
});

test('预检：步序引用不存在的点位', () => {
  const config = makeConfig({
    sequence: [
      { id: 's1', name: '前进', action: 'set', point: 'Y0' },
      { id: 's2', name: '等待', action: 'wait', point: 'X99' }
    ]
  });
  const result = precheck(config);
  assert.ok(codes(result).includes('SEQUENCE_POINT_NOT_FOUND'));
});

test('预检：同一输出点被两个步序赋值报双线圈', () => {
  const config = makeConfig({
    sequence: [
      { id: 's1', action: 'set', point: 'Y0' },
      { id: 's2', action: 'set', point: 'Y0' }
    ]
  });
  const result = precheck(config);
  assert.ok(codes(result).includes('DOUBLE_COIL'));
});

test('预检：步序 type/sets 别名也参与双线圈扫描', () => {
  const config = makeConfig({
    sequence: [
      { id: 's1', type: 'set', sets: ['Y0'] },
      { id: 's2', action: 'set', point: 'Y0' }
    ]
  });
  assert.ok(codes(precheck(config)).includes('DOUBLE_COIL'));
});

test('预检：BOM 输入点数不足', () => {
  const result = precheck(makeConfig(), {
    modules: [{ name: 'PLC IO 模块', model: 'M', quantity: 1, inputPoints: 2, outputPoints: 8 }]
  });
  assert.ok(codes(result).includes('BOM_PLC_INPUT_POINTS_INSUFFICIENT'));
  assert.ok(!codes(result).includes('BOM_PLC_OUTPUT_POINTS_INSUFFICIENT'));
});

test('预检：BOM 只有总点数时按总用量校验', () => {
  const result = precheck(makeConfig(), {
    modules: [{ name: 'PLC IO 模块', model: 'M', quantity: 1, points: 3 }]
  });
  assert.ok(codes(result).includes('BOM_PLC_POINTS_INSUFFICIENT'));
});

test('预检：BOM 文本 16DI/16DO 可解析且容量足够', () => {
  const result = precheck(makeConfig(), [
    { name: 'PLC IO 模块', model: '16DI/16DO', quantity: 1 }
  ]);
  assert.deepEqual(result.errors, []);
});

test('预检：BOM 文本多种点数写法都能解析（输入8 输出6 / 8 IN / 6 OUT / 8×DI 6×DO）', () => {
  for (const model of ['输入8 输出6', '8 IN / 6 OUT', '8入/6出', '8×DI 6×DO', 'DI:8 DO:6']) {
    const result = precheck(makeConfig(), [{ name: 'PLC IO 模块', model, quantity: 1 }]);
    assert.deepEqual(codes(result), [], `${model} 应解析出 8 入 / 6 出且容量够`);
  }
});

test('预检：BOM 文本 DI 16/DO 16 与点数别名可解析', () => {
  const textResult = precheck(makeConfig(), [
    { name: 'PLC IO 模块', model: 'DI 16/DO 16', quantity: 1 }
  ]);
  assert.deepEqual(textResult.errors, []);
  const aliasResult = precheck(makeConfig(), [
    { name: 'PLC IO 模块', model: 'M', quantity: 1, inputCount: 2, outputCount: 8 }
  ]);
  assert.ok(codes(aliasResult).includes('BOM_PLC_INPUT_POINTS_INSUFFICIENT'));
});

test('预检：一次返回全部规则错误，不遇错即停', () => {
  const config = makeConfig({
    actuators: [
      { id: 'a1', name: '气缸 A', kind: 'cylinder', station: '上料', extendPoint: 'Y0', retractPoint: 'Y1' },
      { id: 'a2', name: '气缸 B', kind: 'cylinder', station: '上料', extendPoint: 'Y0', retractPoint: 'Y2' },
      { id: 'a3', name: '气缸 C', kind: 'cylinder', station: '上料', extendPoint: 'Y3', retractPoint: 'Y4' }
    ],
    sensors: [
      { point: 'X0', station: '上料', part: 'a1' },
      { point: 'I0.0', station: '上料', part: 'a2' },
      { point: 'I32.0', station: '上料', part: 'a1' },
      { point: 'X3', station: '上料', part: 'ghost' }
    ],
    safety: undefined,
    sequence: [
      { id: 's1', action: 'set', point: 'Y0' },
      { id: 's2', action: 'set', point: 'Y0' },
      { id: 's3', action: 'wait', point: 'X99' }
    ]
  });
  const result = precheck(config, {
    modules: [{ name: 'PLC IO 模块', model: 'M', quantity: 1, inputPoints: 1, outputPoints: 1 }]
  });
  const found = new Set(codes(result));
  for (const required of [
    'ADDRESS_DUPLICATE',
    'ADDRESS_OUT_OF_RANGE',
    'POINT_MULTI_ACTUATOR',
    'ACTUATOR_SENSOR_MISSING',
    'SENSOR_UNBOUND',
    'ESTOP_UNDEFINED',
    'SAFETY_DOOR_UNDEFINED',
    'SEQUENCE_POINT_NOT_FOUND',
    'DOUBLE_COIL',
    'BOM_PLC_INPUT_POINTS_INSUFFICIENT',
    'BOM_PLC_OUTPUT_POINTS_INSUFFICIENT'
  ]) {
    assert.ok(found.has(required), `缺少错误 ${required}`);
  }
});

test('变量表：I/Q 分开顺序分配且按点位自然序稳定排序', () => {
  const config = makeConfig({
    actuators: [
      { id: 'cyl-1', name: '上料气缸', kind: 'cylinder', station: '上料', extendPoint: 'Y1', retractPoint: 'Y0' }
    ],
    sensors: [
      { point: 'X10', station: '上料', part: 'cyl-1' },
      { point: 'X2', station: '上料', part: 'cyl-1' }
    ]
  });
  const tags = buildTags(config);
  assert.deepEqual(tags.rows.map((row) => row.address), ['I0.0', 'I0.1', 'I0.2', 'I0.3', 'Q0.0', 'Q0.1']);
  assert.deepEqual(
    tags.rows.slice(0, 4).map((row) => /输入 ([^；]+)/.exec(row.comment)?.[1]),
    ['X2', 'X8', 'X9', 'X10']
  );
});

test('变量表：名称按 工位_机构_用途 生成，非法字符替换为下划线', () => {
  const config = makeConfig({
    actuators: [
      { id: 'cyl-1', name: '气缸 A', kind: 'cylinder', station: '上料', extendPoint: 'Y0', retractPoint: 'Y1' }
    ]
  });
  const tags = buildTags(config);
  assert.equal(tags.rows.find((row) => row.address === 'Q0.0')?.name, '上料_气缸_A_伸出');
  assert.ok(tags.rows.every((row) => row.name.length <= 32));
  assert.ok(tags.rows.every((row) => !/[^\p{L}\p{N}_]/u.test(row.name)));
});

test('变量表：超长名称截断到 32 字符且保持唯一', () => {
  const config = makeConfig({
    actuators: [
      {
        id: 'long',
        name: '超长气缸名称用于测试截断超长气缸名称用于测试截断',
        kind: 'cylinder',
        station: '超长工位名称',
        extendPoint: 'Y0',
        retractPoint: 'Y1'
      }
    ],
    sensors: [
      { point: 'X0', station: '超长工位名称', part: 'long' },
      { point: 'X1', station: '超长工位名称', part: 'long' }
    ]
  });
  const tags = buildTags(config);
  assert.ok(tags.rows.every((row) => Array.from(row.name).length <= 32));
  assert.equal(new Set(tags.rows.map((row) => row.name)).size, tags.rows.length);
});

test('变量表：跨来源重复点位只保留首次出现', () => {
  const config = makeConfig({
    actuators: [
      {
        id: 'cyl-1',
        name: '上料气缸',
        kind: 'cylinder',
        station: '上料',
        extendPoint: 'X0',
        retractPoint: 'Y1'
      }
    ]
  });
  const tags = buildTags(config);
  const x0 = tags.rows.filter((row) => row.comment.includes('X0'));
  assert.equal(x0.length, 1);
  assert.equal(x0[0]?.address, 'I0.0');
  assert.match(x0[0]?.comment ?? '', /输入 X0/);
});

test('变量表：Unicode 工位与 emoji 名称按白名单净化且保留中文', () => {
  const config = makeConfig({
    stations: ['上料🚀'],
    actuators: [
      {
        id: 'cyl-u',
        name: '气缸·A 🦾',
        kind: 'cylinder',
        station: '上料🚀',
        extendPoint: 'Y0',
        retractPoint: 'Y1'
      }
    ],
    sensors: [
      { point: 'X0', station: '上料🚀', part: 'cyl-u' },
      { point: 'X1', station: '上料🚀', part: 'cyl-u' }
    ],
    safety: undefined
  });
  const tags = buildTags(config);
  const extend = tags.rows.find((row) => row.address === 'Q0.0');
  assert.ok(extend, '缺少伸出点位');
  assert.match(extend.name, /^[\p{L}\p{N}_]+$/u);
  assert.ok(extend.name.includes('上料'));
  assert.ok(extend.name.includes('气缸'));
  assert.ok(extend.name.includes('伸出'));
  assert.ok(!extend.name.includes('🚀'));
  assert.ok(Array.from(extend.name).length <= 32);
});

test('变量表：完全空配置只输出 BOM 与表头', () => {
  const tags = buildTags({
    id: 'empty',
    name: '空机型',
    stations: [],
    actuators: [],
    sensors: []
  });
  assert.equal(tags.rows.length, 0);
  assert.equal(tags.csv, `\uFEFF${'地址,名称,数据类型,注释,工位'}`);
});

test('变量表 CSV：UTF-8 BOM、固定表头、逗号转义', () => {
  const config = makeConfig({ stations: ['上料,1'] });
  config.stations = ['上料,1'];
  const actuator = (config.actuators as Array<Record<string, unknown>>)[0];
  if (actuator) actuator.station = '上料,1';
  const sensorRows = config.sensors as Array<Record<string, unknown>>;
  for (const sensor of sensorRows) sensor.station = '上料,1';
  const tags = buildTags(config);
  assert.equal(tags.csv.charCodeAt(0), 0xFEFF);
  assert.equal(tags.csv.slice(1).split('\r\n')[0], '地址,名称,数据类型,注释,工位');
  assert.match(tags.csv, /"上料,1"/);
});

test('ST：生成 5 个文件且路径稳定', () => {
  const result = generateSt({ config: makeConfig() });
  assert.deepEqual(result.files.map((file) => file.path), [
    'src/FB_Cylinder.st',
    'src/FB_Gripper.st',
    'src/FB_RotaryAxis.st',
    'src/DB_IO.st',
    'src/OB1_Main.st'
  ]);
});

test('ST：气缸 FB 含上升沿、超时、到位与互锁语句', () => {
  const content = fileContent(generateSt({ config: makeConfig() }), 'FB_Cylinder.st');
  assert.match(content, /FUNCTION_BLOCK FB_Cylinder/);
  assert.match(content, /_Edge\(CLK := Execute\)/);
  assert.match(content, /TimeoutTime : TIME := T#3s/);
  assert.match(content, /ExtendOutput := _TargetExtend/);
  assert.match(content, /RetractOutput := NOT _TargetExtend/);
  assert.match(content, /Done := TRUE/);
  assert.match(content, /ELSIF _Timer\.Q THEN/);
  assert.match(content, /ErrorCode := ERR_TIMEOUT/);
});

test('ST：夹爪 FB 开合两路输出互锁', () => {
  const content = fileContent(generateSt({ config: makeConfig() }), 'FB_Gripper.st');
  assert.match(content, /FUNCTION_BLOCK FB_Gripper/);
  assert.match(content, /OpenCommand : BOOL/);
  assert.match(content, /CloseCommand : BOOL/);
  assert.match(content, /OpenOutput := TRUE;\s*\n\s*CloseOutput := FALSE/);
  assert.match(content, /OpenOutput := FALSE;\s*\n\s*CloseOutput := TRUE/);
  assert.match(content, /IF OpenOutput AND CloseOutput THEN/);
  assert.match(content, /开\/合两路互锁/);
});

test('ST：旋转轴 FB 使用容差判断角度到位', () => {
  const content = fileContent(generateSt({ config: makeConfig(), toleranceDeg: 0.2 }), 'FB_RotaryAxis.st');
  assert.match(content, /Tolerance : REAL := 0\.2/);
  assert.match(content, /InPosition := ABS\(ActualAngle - TargetAngle\) <= Tolerance/);
  assert.match(content, /Done := TRUE/);
});

test('ST：DB_IO 写入变量表地址与名称映射', () => {
  const result = generateSt({ config: makeConfig() });
  const content = fileContent(result, 'DB_IO.st');
  assert.match(content, /DATA_BLOCK DB_IO/);
  assert.match(content, /上料_上料气缸_伸出 AT %Q0\.0 : BOOL/);
  assert.match(content, /上料_上料气缸_缩回 AT %Q0\.1 : BOOL/);
  assert.match(content, /AT %I0\.0 : BOOL/);
});

test('ST：OB1 含手动、自动、报警占位调用', () => {
  const content = fileContent(generateSt({ config: makeConfig() }), 'OB1_Main.st');
  assert.match(content, /PROGRAM OB1_Main/);
  assert.match(content, /FC_Manual\(\)/);
  assert.match(content, /FC_AutoSequence\(\)/);
  assert.match(content, /FC_Alarms\(\)/);
  assert.match(content, /P8-2/);
});

test('ST：连续生成两次逐字节一致', () => {
  const input = { config: makeConfig() };
  const first = generateSt(input);
  const second = generateSt(input);
  assert.equal(digest(first), digest(second));
  assert.equal(first.stats.inputHash, second.stats.inputHash);
});

test('ST：每个文件头含机型、版本、输入哈希与生成器版本', () => {
  const input = { config: makeConfig({ version: 3 }) };
  const result = generateSt(input);
  const expectedHash = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 12);
  assert.equal(result.stats.inputHash, expectedHash);
  for (const file of result.files) {
    assert.match(file.content, /机型: 测试机型 \(test-machine\)  版本: 3/);
    assert.match(file.content, new RegExp(`输入哈希: ${expectedHash}`));
    assert.match(file.content, /AutomationCAD 生成器 v1\.0\.0/);
    assert.doesNotMatch(file.content, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  }
});

test('ST：空配置仍生成 5 个文件，安全点单独成表且完全空配置为 0 行', () => {
  const empty = {
    id: 'empty',
    name: '空机型',
    stations: [],
    actuators: [],
    sensors: [],
    safety: { emergencyStop: 'X0', safetyDoor: 'X1' }
  };
  const result = generateSt({ config: empty });
  assert.equal(result.files.length, 5);
  assert.equal(buildTags(empty).rows.length, 2);
  const completelyEmpty = {
    id: 'empty-2',
    name: '完全空',
    stations: [],
    actuators: [],
    sensors: []
  };
  const noIo = generateSt({ config: completelyEmpty });
  assert.equal(noIo.stats.tags, 0);
  assert.equal(noIo.files.length, 5);
});

test('ST：超时参数必须是正整数毫秒', () => {
  for (const timeoutTimeMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => generateSt({ config: makeConfig(), timeoutTimeMs }),
      /超时时间必须是大于 0 的整数毫秒/
    );
  }
  const result = generateSt({ config: makeConfig(), timeoutTimeMs: 2500 });
  assert.match(fileContent(result, 'FB_Cylinder.st'), /TimeoutTime : TIME := T#2500ms/);
});

test('ST：角度容差必须是非负有限数', () => {
  assert.throws(() => generateSt({ config: makeConfig(), toleranceDeg: -0.1 }), /角度容差/);
  assert.throws(() => generateSt({ config: makeConfig(), toleranceDeg: Number.NaN }), /角度容差/);
  assert.match(
    fileContent(generateSt({ config: makeConfig(), toleranceDeg: 0 }), 'FB_RotaryAxis.st'),
    /Tolerance : REAL := 0;/
  );
});

test('ST：可直接传 MachineConfig 且 stats 与实际变量数一致', () => {
  const result = generateSt(makeConfig());
  assert.equal(result.stats.files, 5);
  assert.equal(result.stats.tags, 6);
  assert.equal(result.stats.inputs, 4);
  assert.equal(result.stats.outputs, 2);
  assert.equal(result.stats.actuators, 1);
  assert.equal(result.stats.stations, 1);
  assert.ok(result.stats.lines > 50);
});

test('ST：demo 机型生成 5 文件 / 32 变量', () => {
  const result = generateSt({ config: demoMachineConfig() });
  assert.equal(result.stats.files, 5);
  assert.equal(result.stats.tags, 32);
});
