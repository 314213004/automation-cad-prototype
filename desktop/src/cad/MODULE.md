# 模块：CAD 轻量化查看（src/cad/）

职责：把 CAD 文件解析成三角网格，在 three.js 里渲染、拾取、测量、降级。**只做查看与包围盒测量，不做 B-rep 建模。**

## 文件分工

| 文件 | 作用 |
|------|------|
| `step.ts` | 调 `occt-import-js` 解析 STEP / IGES / BREP，输出 `CadImportResult` |
| `importer.worker.ts` | 解析跑在 Worker，避免阻塞 UI；用 transferable 回传 TypedArray |
| `loaders.ts` | STL / OBJ / GLTF / GLB 走 three 自带 loader（异步，不占 Worker） |
| `viewer.ts` | three 场景、OrbitControls、fit、线框、拾取、包围盒尺寸、零件列表 |
| `webgl.ts` | `probeWebGL(canvasFactory)` 纯函数，判定能否创建 WebGL 上下文 |
| `kinematics.ts` | 运动学标注层：动件 → 轴/行程/方向/点位绑定，校验 + 姿态解算 + 机型配置交叉核对 |
| `cad.css` | 覆盖层样式（复用原型 token，不新增 UI 主色） |

## 数据结构

```ts
// shared/types.ts
interface CadMeshData {
  name: string;
  positions: Float32Array;   // xyz 交错
  normals: Float32Array | null;
  indices: Uint32Array | null;
  color?: [number, number, number];  // 来自 STEP 的 RGB
}
interface CadImportResult {
  meshes: CadMeshData[];
  stats: { meshCount: number; triangleCount: number; elapsedMs: number; format: string };
}
```

Worker 协议（`importer.worker.ts`）：

```
Request:  { id: number; kind: 'occt'; name: string; buffer: ArrayBuffer; wasmUrl?: string }
Response: { id, ok: true, result: CadImportResult } | { id, ok: false, error: string }
```
回传时 `positions/normals/indices` 的 buffer 走 transfer 列表，主线程零拷贝接收。

## 渲染约定

- 背景 `#2A2D31`，网格 `GridHelper`，`HemisphereLight + DirectionalLight`
- 单位按 STEP 源文件 mm 解释，**不做隐式缩放**；状态栏明示「300.000 × 300.000 × 300.000 mm」
- 选中/悬停走材质高亮，不重建 Mesh
- 自动 fit 用包围球 + 视角 FOV 计算相机距离

## 运动学标注（kinematics.ts）

STEP/IGES 只给几何与装配名，不含轴、行程、方向、点位。本模块是**人工标注层**，不自动识别机构：
把零件名绑到一个运动轴，再绑 PLC 点位，最后由 `axisPose()` 按点位状态算出姿态。

```ts
interface KinematicsAxis {
  part: string;                 // STEP 网格名（动件）
  kind: 'linear' | 'rotary';
  axis: 'x' | 'y' | 'z';        // 直线：运动方向；旋转：绕哪个轴
  travelMm?: number;            // 直线行程，linear 必填
  retractedMm?: number;         // 缩回位置（默认 0，必须 < travelMm）
  rangeDeg?: number;            // 旋转角度量程，rotary 必填
  direction?: 1 | -1;           // 伸出方向，默认 +1
  bindings: { role: 'extend' | 'retract' | 'rotate'; point: string }[];
}
```

- `checkKinematics(doc, { partNames, knownPoints })` **不抛异常**：返回 `issues/errors/warnings`，错误中文可操作
  （动件不在 STEP、行程非正、缩回 ≥ 行程、直线轴填角度、点位不在 IO 表、同点位被两个动件占用等）；
  `assertKinematics()` 是严格包装，供命令行/智能体用。
- 校验通过后 `doc` 已归一化：动件名对齐 STEP 原名、点位统一大写、默认值补齐。
- `axisPose(axis, values)` 解算当前位移/角度；伸展与缩回信号同时为真时 `conflict=true`（传感器/接线冲突）。
- `crossCheckMachineConfig(doc, config)` 与机型配置比对：行程不一致、气缸/夹爪 vs 旋转轴类型冲突、
  执行机构点位未绑定动件，全部给 warning，不阻塞。
- `serializeKinematics()` / `parseKinematicsJson()` 负责保存与读回；`upsertAxis`、`setBinding`、
  `removeBinding`、`removeAxis` 都是不可变编辑，供下一轮标注面板复用。
- 数据来源诚实性：`partNames` 必须来自真实导入结果（`CadImportResult.meshes[].name`），
  `knownPoints` 必须来自真实 IO 表；两者缺省时不做存在性校验，但也不会伪造零件或点位。

## 坑点

1. **WebGL 不可用会直接抛 `THREE.WebGLRenderer: Error creating WebGL context`**：xvfb/无 GPU/RDP 常见。现在先用 `probeWebGL()` 探测，失败走降级面板（展示零件数/三角面/包围盒），不再崩溃。
2. **WASM 路径**：`occt-import-js.wasm` 必须由 Vite 复制到 `dist/`，并以 `locateFile` 指定；worker 里用 `?url` 导入，路径随 `assetsInlineLimit: 0` 保持独立文件。
3. **occt 返回的 `index` 是 Uint32**，转 `BufferAttribute` 时别用 Uint16，超过 65535 顶点会花屏。
4. **STEP 单位不一定是 mm**：当前按 mm 解释并在状态栏声明；后续要读 `OCCT` 的单位元数据（`cube-units` 测试文件可复现）。
5. **大模型主线程解析会假死**：必须留在 Worker；主线程只做 geometry 组装。
6. **三角形统计口径**：有 index 时 `index.length/3`，无 index 时 `positions.length/9`，两种都要覆盖（已单测）。

## 进度

- ✅ STEP/IGES/BREP 解析（实测 424 KB 装配 5040 面 / 559 ms）
- ✅ STL/OBJ/GLTF/GLB
- ✅ 零件树、三角面统计、包围盒测量、fit、线框、拖放导入
- ✅ WebGL 降级（3 条单测）
- ✅ 智能体占位件（20×20×20 mm 实体 + 线框）、按索引移除与重排、场景/选择/BOM 快照
- ✅ 运动学标注数据层（动件 → 轴/行程/方向/点位，校验 + 姿态解算 + 机型交叉核对，23 条单测）
- ⏳ DXF 二维图纸（`dxf-parser`，未接）
- ⏳ 剖切面、爆炸视图、装配树层级（当前是平铺 mesh 列表）

## 待办

1. 引入 DXF：图纸视图（白纸 + 墨线）与三维视图分离。
2. 单位识别 + 英寸/毫米切换。
3. 十万面以上模型的分块加载与 LOD（当前一次性建 geometry）。
4. 当前 BOM 是查看器快照（零件名/数量 1/材料 `—`），后续接入原型真实装配 BOM。
