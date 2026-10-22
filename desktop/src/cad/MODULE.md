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
- ⏳ DXF 二维图纸（`dxf-parser`，未接）
- ⏳ 剖切面、爆炸视图、装配树层级（当前是平铺 mesh 列表）

## 待办

1. 引入 DXF：图纸视图（白纸 + 墨线）与三维视图分离。
2. 单位识别 + 英寸/毫米切换。
3. 十万面以上模型的分块加载与 LOD（当前一次性建 geometry）。
