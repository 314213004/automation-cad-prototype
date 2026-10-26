// 转接板配套紧固件 BOM（P0，见架构文档第 12.1 节第 3 小节）
//
// 每新增一块转接板节点，向 BOM 注入对应的国标螺丝、弹垫与定位销。
// 注意口径：这里的 unitPriceYuan 是文档给出的参考价，仅用于估算；
// 正式报价仍以价格簿为准（见 cost/pricebook.ts），不要把参考价当成已询价。
export interface FastenerBomItem {
  partId: string;
  name: string;
  category: string;
  qty: number;
  spec?: string;
  /** 参考单价（元），文档参考值，非价格簿权威价。 */
  unitPriceYuan: number;
  /** 所属转接板节点 id。 */
  parentNodeId: string;
}

function assertBolt(bolt: string): void {
  if (!/^M[34568]$/.test(bolt)) throw new Error(`不支持的螺栓规格：${bolt}`);
}

export function buildFastenerBomItems(
  adapterId: string,
  inBolt: string,
  outBolt: string
): FastenerBomItem[] {
  if (!adapterId) throw new Error('转接板 id 不能为空');
  assertBolt(inBolt);
  assertBolt(outBolt);
  return [
    {
      partId: `GB70.1-${inBolt}x16`,
      name: `内六角圆柱头螺钉 ${inBolt}×16 (12.9级) + 弹垫`,
      qty: 4,
      category: '标准紧固件',
      spec: `转接板 ${adapterId} · 母件侧`,
      unitPriceYuan: 0.85,
      parentNodeId: adapterId
    },
    {
      partId: `GB70.1-${outBolt}x12`,
      name: `内六角圆柱头螺钉 ${outBolt}×12 (12.9级) + 弹垫`,
      qty: 4,
      category: '标准紧固件',
      spec: `转接板 ${adapterId} · 子件侧`,
      unitPriceYuan: 0.75,
      parentNodeId: adapterId
    },
    {
      partId: 'GB120.2-D4x14',
      name: '内螺纹圆柱定位销 Ø4×14 (HRC58)',
      qty: 2,
      category: '标准紧固件',
      spec: `转接板 ${adapterId} · 定位销`,
      unitPriceYuan: 2.2,
      parentNodeId: adapterId
    }
  ];
}
