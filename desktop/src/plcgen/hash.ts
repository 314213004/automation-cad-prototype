import { createHash } from 'node:crypto';

/** 输入 JSON 的 SHA-256；保持原对象键序，header 只取前 12 位。 */
export function inputJsonHash(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('PLC 生成输入无法序列化为 JSON');
  return createHash('sha256').update(json, 'utf8').digest('hex');
}
