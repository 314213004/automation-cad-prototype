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
