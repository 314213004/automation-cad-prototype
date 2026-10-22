# 模块：智慧工厂接入（src/factory/）

职责：把产线点位（PLC / MQTT）接进设计软件，让「装配体 ↔ 机台状态」对应起来。设计侧不因工厂断线而卡死。

## 适配器架构

```
FactoryManager（src/factory/manager.ts）
 ├─ DemoAdapter   ：内置仿真产线，2 工位 8 点位，1s 变化
 ├─ OpcuaAdapter  ：node-opcua，SecurityPolicy=None（本期）
 └─ MqttAdapter   ：mqtt.js，topic → tag 映射
```

```ts
interface FactoryAdapter {
  readonly kind: 'demo' | 'opcua' | 'mqtt';
  connect(cfg: FactoryConfig): Promise<void>;
  disconnect(): Promise<void>;
  browse(nodeId?: string): Promise<TagNode[]>;
  readTags(ids: string[]): Promise<Record<string, TagValue>>;
  writeTag(id: string, value: unknown): Promise<void>;
  subscribe(ids: string[], cb: (v: TagValue) => void): () => void;
  status(): FactoryStatus;   // disconnected | connecting | connected | error
}
```

## 数据结构

```ts
interface FactoryConfig {
  kind; label?;
  endpointUrl?;               // opc.tcp://host:4840
  brokerUrl?;                 // mqtt://host:1883
  topicMap?: Record<string, string>;  // topic → tagId
  securityPolicy?: 'None' | 'Basic256Sha256';
  username?; password?;
}
interface TagNode { id; name; kind?: 'station'|'folder'|'tag'; dataType?; unit?; writable?; station?; children? }
interface TagValue { id; value: unknown; quality: 'good'|'bad'|'uncertain'; timestamp; dataType?; unit? }
interface FactoryStatusInfo { kind; status; config? (password 只回 hasPassword); connectedAt?; error? }
```

demo 点位命名：`<station>.<tag>`，例如 `press.run`、`press.cycle`、`press.good`、`press.alarm`；两个工位 `press-station`（压装）/ `screw-station`（锁付）。

## 持久化与超时

- 配置：`%APPDATA%/AutomationCAD/factory.json`
- 所有网络调用统一 `withTimeout(op, 10_000)`，超时抛中文错误（如「工厂连接超时（10s）」）
- 切换适配器时先断旧连接，再连新的；失败保持 `error` 状态并回传原因
- 写入必须由 UI `confirm()` 二次确认后才下发

## 坑点

1. **不要把异常抛到主进程未捕获**：`manager` 内全部转成 `{ok:false,message}`，否则一次断线会崩窗。
2. **`status()` 必须是同步纯函数**：UI 每秒轮询，异步化会导致状态抖动。
3. **密码字段绝不回传渲染层**：`toPublicConfig()` 剥掉 `password`，只给 `hasPassword`。
4. **OPC UA 首次连接会生成证书目录**，SecurityPolicy=None 也要确认 `userData/pki` 可写；企业环境常被组策略拦。
5. **MQTT topic 映射为空要直接拒绝**，否则订阅了却拿不到任何点位，表现为「连上了但没数据」。
6. **仿真数据要能被测试确定性断言**：demo 用固定工位/固定点位集合，数值变化但 id 稳定。

## 进度

- ✅ demo 适配器（2 工位 8 点位），实测 connect + browse
- ✅ OPC UA（connect/browse/read/write/subscribe，懒加载 SDK，仅 None 策略）
- ✅ MQTT（connect/subscribe/publish，topicMap 校验）
- ✅ 配置持久化、10s 超时、状态广播、面板（连接/断开/实时值/写入确认）
- ⏳ 真实 PLC 联调（无设备）
- ⏳ 点位 ↔ 装配体绑定（把 `press.cycle` 绑到气缸组并在 3D 上显示状态）

## 待办

1. Basic256Sha256 + 证书信任管理（见 Issue #3）。
2. 断线自动重连（指数退避）并保留订阅。
3. 点位绑定表 `userData/bindings.json`，3D 视口叠加实时状态。
4. 历史曲线（节拍/良品率）与报警置顶。
