import type { Object3D } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';

export type MeshFormat = 'glb' | 'obj';

export async function toMeshBlob(root: Object3D, format: MeshFormat): Promise<Blob> {
  if (!root) throw new Error('没有可导出的 3D 场景');
  if (format === 'glb') {
    const exporter = new GLTFExporter();
    const output = await exporter.parseAsync(root, { binary: true, onlyVisible: false });
    if (!(output instanceof ArrayBuffer)) throw new Error('GLB 导出结果不是二进制数据');
    return new Blob([output], { type: 'model/gltf-binary' });
  }
  if (format === 'obj') {
    const text = new OBJExporter().parse(root);
    if (!text.trim()) throw new Error('OBJ 导出结果为空');
    return new Blob([text], { type: 'text/plain;charset=utf-8' });
  }
  throw new Error(`不支持的网格导出格式：${String(format)}`);
}
