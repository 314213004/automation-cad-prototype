declare module 'occt-import-js' {
  export interface OcctMesh {
    name: string;
    color?: [number, number, number];
    attributes: {
      position: { array: number[] };
      normal?: { array: number[] };
    };
    index: { array: number[] };
  }

  export interface OcctNode {
    name: string;
    meshes: number[];
    children: OcctNode[];
  }

  export interface OcctImportResult {
    success: boolean;
    meshes: OcctMesh[];
    /** 装配层级；只含零件的子装配会被 occt-import-js 压平到上一级。 */
    root?: OcctNode;
  }

  export interface OcctModule {
    ReadStepFile(buffer: Uint8Array, params: Record<string, unknown> | null): OcctImportResult;
    ReadIgesFile(buffer: Uint8Array, params: Record<string, unknown> | null): OcctImportResult;
    ReadBrepFile(buffer: Uint8Array, params: Record<string, unknown> | null): OcctImportResult;
  }

  export interface OcctFactoryOptions {
    locateFile?: (path: string, prefix: string) => string;
  }

  export default function occtimportjs(options?: OcctFactoryOptions): Promise<OcctModule>;
}
