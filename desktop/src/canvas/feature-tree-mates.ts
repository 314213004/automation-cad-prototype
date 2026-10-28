// UI 重构第 2 步（机械侧 only）：配合面板描述。
//
// 一条边就是一个配合：from.portOut 对接 to.portIn。
// 兼容判定沿用 graph.ts 的 portsCompatible 规则——
// family / holeDiaMm / pitchXMm / pitchYMm / count 五字段全等才兼容，
// 这里只把“哪几个字段不同”算出来给面板标红，不改内核判定，
// 不引入新的约束求解器。电气侧不在本模块。

export interface MountPortLike {
  family: string;
  holeDiaMm: number;
  pitchXMm: number;
  pitchYMm: number;
  count: number;
}

export interface MatePanelItem {
  edgeId: string;
  label: string;
  compatible: boolean;
  /** 不相等的字段（空 = 全等兼容），面板按此逐字段标红。 */
  diffFields: string[];
}

const PORT_FIELDS = ['family', 'holeDiaMm', 'pitchXMm', 'pitchYMm', 'count'] as const;

export function mateDiffFields(outPort: MountPortLike, inPort: MountPortLike): string[] {
  return PORT_FIELDS.filter((field) => outPort[field] !== inPort[field]);
}

/** MachineGraph -> 配合面板：每条边一项，含兼容状态与差异字段。 */
export function buildMatePanel(graph: {
  nodes: Array<{ id: string; name: string; portIn: MountPortLike; portOut: MountPortLike }>;
  edges: Array<{ id: string; from: string; to: string }>;
}): MatePanelItem[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges.map((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      return { edgeId: edge.id, label: `配合 ${edge.from} → ${edge.to}`, compatible: false, diffFields: ['missing-node'] };
    }
    const diffFields = mateDiffFields(from.portOut, to.portIn);
    return {
      edgeId: edge.id,
      label: `配合 ${from.name} → ${to.name}`,
      compatible: diffFields.length === 0,
      diffFields
    };
  });
}
