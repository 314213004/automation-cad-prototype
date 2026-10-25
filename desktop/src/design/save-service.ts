import type { MachineDesign } from '../machine/synth.ts';

export interface DesignProjectPayload {
  name: string;
  process: string;
  params: Record<string, number>;
  parts: number;
  massKg: null;
  envelope: [number, number, number];
  material: string[];
  design: MachineDesign;
  config: MachineDesign['config'];
  stlData?: Uint8Array;
  partData?: Array<{ name: string; data: Uint8Array }>;
  placements?: unknown[];
}

export async function saveDesignProject(
  save: (payload: DesignProjectPayload) => Promise<{ ok: boolean; record?: { id: string }; message?: string }>,
  clearDraft: () => Promise<unknown>,
  payload: DesignProjectPayload
): Promise<{ ok: boolean; id?: string; message?: string }> {
  const result = await save(payload);
  if (!result.ok || !result.record) return { ok: false, message: result.message ?? '保存工程失败' };
  await clearDraft();
  return { ok: true, id: result.record.id };
}
