export interface CadMeshData {
  name: string;
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint32Array | null;
  color?: [number, number, number];
}

export interface CadImportResult {
  meshes: CadMeshData[];
  stats: {
    meshCount: number;
    triangleCount: number;
    elapsedMs: number;
    format: string;
  };
}

export interface PackManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  vendor: string;
  version: string;
  license?: string;
  description?: string;
}

export interface ComponentPart {
  id: string;
  model: string;
  category: string;
  vendor?: string;
  /** 原理图符号键（如 qf1/km1/a1），缺省表示暂无符号 */
  symbol?: string;
  /** 器件本体外形尺寸（宽×高×深，mm）；source 记录官方文档或同系列参照 */
  dims?: { w: number; h: number; d: number; source?: string; estimated?: true };
  /** 是否 DIN 导轨安装 */
  railMount?: boolean;
  /** 模数宽（mm，1P=18）；面板开孔件可存开孔直径 */
  moduleWidth?: number;
  specs: Record<string, string | number>;
  asset?: string;
  thumbnail?: string;
  price?: number;
  packId?: string;
  packName?: string;
}

export interface PackInfo {
  id: string;
  name: string;
  vendor: string;
  version: string;
  description?: string;
  license?: string;
  enabled: boolean;
  builtin: boolean;
  path: string;
  partCount: number;
  error?: string;
}
