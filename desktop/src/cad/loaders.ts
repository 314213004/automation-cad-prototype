import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { CadImportResult, CadMeshData } from '../shared/types';

function attributeArray(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const result = new Float32Array(attribute.count * attribute.itemSize);
  for (let i = 0; i < attribute.count; i += 1) {
    result[i * attribute.itemSize] = attribute.getX(i);
    if (attribute.itemSize > 1) result[i * attribute.itemSize + 1] = attribute.getY(i);
    if (attribute.itemSize > 2) result[i * attribute.itemSize + 2] = attribute.getZ(i);
    if (attribute.itemSize > 3) result[i * attribute.itemSize + 3] = attribute.getW(i);
  }
  return result;
}

function materialColor(object: THREE.Object3D): [number, number, number] | undefined {
  const material = (object as THREE.Mesh).material;
  const first = Array.isArray(material) ? material[0] : material;
  if (first && 'color' in first && first.color instanceof THREE.Color) {
    return [first.color.r, first.color.g, first.color.b];
  }
  return undefined;
}

function objectToMeshes(root: THREE.Object3D, fallbackName: string): CadMeshData[] {
  root.updateMatrixWorld(true);
  const meshes: CadMeshData[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const position = geometry.getAttribute('position');
    if (!position) return;
    const normal = geometry.getAttribute('normal');
    const index = geometry.getIndex();
    const indices = index ? new Uint32Array(Array.from(index.array, (value) => Number(value))) : null;
    const color = materialColor(object);
    meshes.push({
      name: object.name || geometry.name || `${fallbackName} ${meshes.length + 1}`,
      positions: attributeArray(position),
      normals: normal ? attributeArray(normal) : null,
      indices,
      ...(color ? { color } : {})
    });
    geometry.dispose();
  });
  return meshes;
}

function finish(meshes: CadMeshData[], format: string, started: number): CadImportResult {
  if (meshes.length === 0) throw new Error('文件中没有可显示的网格');
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
      format
    }
  };
}

async function parseGltf(buffer: ArrayBuffer, name: string): Promise<THREE.Object3D> {
  const loader = new GLTFLoader();
  return await new Promise<THREE.Object3D>((resolve, reject) => {
    loader.parse(
      buffer,
      '',
      (gltf) => resolve(gltf.scene),
      (error) => reject(error instanceof Error ? error : new Error(String(error)))
    );
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GLTF/GLB 加载失败（${name}）：${message}`);
  });
}

export async function parseStandardCadBuffer(buffer: ArrayBuffer, fileName: string): Promise<CadImportResult> {
  const started = performance.now();
  const ext = fileName.toLowerCase().split('.').pop() || '';
  if (ext === 'stl') {
    const geometry = new STLLoader().parse(buffer);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const root = new THREE.Mesh(geometry);
    root.name = fileName;
    const result = finish(objectToMeshes(root, fileName), 'STL', started);
    geometry.dispose();
    return result;
  }
  if (ext === 'obj') {
    const text = new TextDecoder('utf-8').decode(buffer);
    const object = new OBJLoader().parse(text);
    return finish(objectToMeshes(object, fileName), 'OBJ', started);
  }
  if (ext === 'gltf' || ext === 'glb') {
    const scene = await parseGltf(buffer, fileName);
    return finish(objectToMeshes(scene, fileName), ext.toUpperCase(), started);
  }
  throw new Error(`不支持的 CAD 格式：${fileName}`);
}
