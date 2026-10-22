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
