export const CAD_EXTENSIONS = [
  '.step',
  '.stp',
  '.iges',
  '.igs',
  '.brep',
  '.stl',
  '.obj',
  '.gltf',
  '.glb'
] as const;

export type CadExtension = (typeof CAD_EXTENSIONS)[number];

export function isCadExtension(extension: string): extension is CadExtension {
  return (CAD_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());
}

/**
 * 2D 图纸格式：按线段渲染（不是实体网格）。
 * DWG 需要外部转换器先转 DXF，见 electron/dwg.ts。
 */
export const DRAWING_EXTENSIONS = ['.dxf', '.dwg'] as const;

export type DrawingExtension = (typeof DRAWING_EXTENSIONS)[number];

export function isDrawingExtension(extension: string): extension is DrawingExtension {
  return (DRAWING_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());
}

/** 打开文件对话框里能选的全部扩展名 */
export const OPENABLE_EXTENSIONS = [...CAD_EXTENSIONS, ...DRAWING_EXTENSIONS] as const;
