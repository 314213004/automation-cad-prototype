/** 设计同步端到端测试用的最小设计包素材：一行会变数量的 BOM + 最小 GLB 头。 */

export const GLB_FIXTURE = Uint8Array.from([
  0x67, 0x6c, 0x54, 0x46,
  0x02, 0x00, 0x00, 0x00,
  0x40, 0x00, 0x00, 0x00,
  ...new Array(52).fill(0)
]);

export function bomRows(qty = 2) {
  return [
    { no: 1, name: '底板', spec: 'BASE-01', qty: 1, mat: 'AL6061' },
    { no: 2, name: '气缸', spec: 'MXQ20-50', qty, mat: '铝合金' }
  ];
}

export function bomCsv(qty = 2) {
  return `序号,名称,规格,数量,材质\n1,底板,BASE-01,1,AL6061\n2,气缸,MXQ20-50,${qty},铝合金\n`;
}
