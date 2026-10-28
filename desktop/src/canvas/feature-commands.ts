// UI 重构第 2 步（机械侧 only）：顶部命令管理器描述。
//
// 命令条只做入口：点击调现有特征与操作，不新增内核功能。
// 标签页按 Sean 的范围只含机械侧：特征 / 装配 / 工程图，
// 没有电气标签页（电气侧不动，电气标签页是后续另行立项的事）。
// 每个命令带一个 target：特征命令对应现有 FeatureType，
// 转接板命令对应 adapter 节点创建，工程图命令对应现有 DXF 导出视图。

export interface FeatureCommand {
  id: string;
  label: string;
  /** 现有特征类型；'adapter' = 转接板节点；'drawing' = 工程图视图。 */
  target: string;
}

export interface CommandTab {
  id: string;
  label: string;
  commands: FeatureCommand[];
}

export const COMMAND_TABS: CommandTab[] = [
  {
    id: 'feature',
    label: '特征',
    commands: [
      { id: 'cmd-box', label: '拉伸', target: 'box' },
      { id: 'cmd-cylinder', label: '拉伸（圆柱）', target: 'cylinder' },
      { id: 'cmd-holes', label: '孔', target: 'holes' },
      { id: 'cmd-counterbore', label: '沉孔', target: 'counterbore' },
      { id: 'cmd-slot', label: '槽', target: 'slot' },
      { id: 'cmd-fillet', label: '圆角/倒角', target: 'fillet' },
      { id: 'cmd-adapter', label: '转接板', target: 'adapter' }
    ]
  },
  {
    id: 'assembly',
    label: '装配',
    commands: [
      { id: 'cmd-mate', label: '配合', target: 'mate' },
      { id: 'cmd-suppress', label: '压缩', target: 'suppress' },
      { id: 'cmd-rename', label: '重命名', target: 'rename' },
      { id: 'cmd-delete', label: '删除', target: 'delete' }
    ]
  },
  {
    id: 'drawing',
    label: '工程图',
    commands: [{ id: 'cmd-drawing', label: '打开工程图', target: 'drawing' }]
  }
];

export function commandForTarget(target: string): FeatureCommand | null {
  for (const tab of COMMAND_TABS) {
    const found = tab.commands.find((command) => command.target === target);
    if (found) return found;
  }
  return null;
}
