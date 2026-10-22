import occtimportjs, { type OcctModule } from 'occt-import-js';
import type { CadImportResult, CadMeshData } from '../shared/types';

export interface ParseOcctOptions {
  wasmUrl?: string;
  occt?: OcctModule;
}

let occtPromise: Promise<OcctModule> | null = null;
let occtWasmUrl: string | undefined;

function loadOcct(options: ParseOcctOptions): Promise<OcctModule> {
  if (options.occt) return Promise.resolve(options.occt);
  if (!occtPromise) {
    occtWasmUrl = options.wasmUrl;
    occtPromise = occtimportjs(
      occtWasmUrl
        ? { locateFile: (path: string) => (path.endsWith('.wasm') ? occtWasmUrl! : path) }
        : undefined
    );
  }
  return occtPromise;
}

export function occtFormatForFile(name: string): 'step' | 'iges' | 'brep' | null {
  const ext = name.toLowerCase().split('.').pop() || '';
  if (ext === 'step' || ext === 'stp') return 'step';
  if (ext === 'iges' || ext === 'igs') return 'iges';
  if (ext === 'brep') return 'brep';
  return null;
}

function toFloat32Array(values: number[]): Float32Array {
  return new Float32Array(values);
}

function toIndexArray(values: number[], vertexCount: number): Uint32Array | null {
  if (values.length === 0) return null;
  const maxIndex = values.reduce((max, value) => Math.max(max, value), 0);
  const result = maxIndex > 65535 || vertexCount > 65535 ? new Uint32Array(values) : new Uint16Array(values);
  return new Uint32Array(result);
}

export async function parseOcctBuffer(
  buffer: ArrayBuffer,
  fileName: string,
  options: ParseOcctOptions = {}
): Promise<CadImportResult> {
  const started = performance.now();
  const format = occtFormatForFile(fileName);
  if (!format) {
    throw new Error(`不支持的 OCCT 文件格式：${fileName}`);
  }

  const occt = await loadOcct(options);
  const bytes = new Uint8Array(buffer);
  const params = {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.001,
    angularDeflection: 0.5
  };

  let raw;
  if (format === 'step') raw = occt.ReadStepFile(bytes, params);
  else if (format === 'iges') raw = occt.ReadIgesFile(bytes, params);
  else raw = occt.ReadBrepFile(bytes, params);

  if (!raw.success) {
    throw new Error(`CAD 解析失败：${fileName}`);
  }

  const meshes: CadMeshData[] = raw.meshes.map((mesh, index) => {
    const positions = toFloat32Array(mesh.attributes.position.array);
    const normalValues = mesh.attributes.normal?.array;
    const normals = normalValues && normalValues.length > 0 ? toFloat32Array(normalValues) : null;
    const indices = toIndexArray(mesh.index.array, positions.length / 3);
    return {
      name: mesh.name || `零件 ${index + 1}`,
      positions,
      normals,
      indices,
      ...(mesh.color ? { color: mesh.color } : {})
    };
  });

  const triangleCount = meshes.reduce((sum, mesh) => {
    if (mesh.indices) return sum + Math.floor(mesh.indices.length / 3);
    return sum + Math.floor(mesh.positions.length / 9);
  }, 0);

  return {
    meshes,
    stats: {
      meshCount: meshes.length,
      triangleCount,
      elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      format: format.toUpperCase()
    }
  };
}

export function getOcctWasmUrl(): string | undefined {
  return occtWasmUrl;
}
