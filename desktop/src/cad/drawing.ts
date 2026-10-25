/**
 * 打开 2D 图纸（DXF / DWG）：DWG 先经主进程转 DXF，再解析成线段贴到 3D 视图。
 *
 * 不做的事（避免假装完整支持）：文字、标注、填充、图案不渲染，只统计后告知。
 */

import { parseDxf, type DxfDrawing } from './dxf.ts';
import type { OrbitView } from '../orbit/view.ts';
import type { DrawerHandle } from '../ui/panels.ts';

export interface DrawingImport {
  path: string;
  name: string;
  source: 'dxf' | 'dwg';
  converter: string | null;
  drawing: DxfDrawing;
  segmentsRendered: number;
}

export interface DrawingState {
  loaded: boolean;
  name: string | null;
  source: 'dxf' | 'dwg' | null;
  converter: string | null;
  segments: number;
  bounds: DxfDrawing['bounds'];
  stats: DxfDrawing['stats'] | null;
  layers: DxfDrawing['layers'];
  message: string | null;
}

export interface DrawingHandle {
  open(path: string): Promise<{ ok: boolean; message: string }>;
  clear(): void;
  state(): DrawingState;
  fit(): boolean;
  /** 图纸清单抽屉 */
  show(): void;
}

const state: DrawingState = {
  loaded: false,
  name: null,
  source: null,
  converter: null,
  segments: 0,
  bounds: null,
  stats: null,
  layers: [],
  message: null
};

let drawer: DrawerHandle | null = null;
let lastImport: DrawingImport | null = null;

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function describe(drawing: DxfDrawing): string {
  const { stats } = drawing;
  const parts = [
    `${drawing.segments.length} 条线段`,
    `LINE ${stats.lines}`,
    `圆/弧 ${stats.circles + stats.arcs}`,
    `多段线 ${stats.polylines}`,
    `块引用 ${stats.inserts}`
  ];
  const skipped: string[] = [];
  if (stats.skippedText) skipped.push(`文字 ${stats.skippedText}`);
  if (stats.skippedDimension) skipped.push(`标注 ${stats.skippedDimension}`);
  if (stats.skippedHatch) skipped.push(`填充 ${stats.skippedHatch}`);
  return `${parts.join(' · ')}${skipped.length ? `｜未绘制：${skipped.join('、')}` : ''}`;
}

export function initDrawingUi(options: {
  view: () => OrbitView | null;
  mountDrawer: (body: HTMLElement) => DrawerHandle;
  /** 打开图纸前先让 3D 覆盖层可见（否则线框加进去也看不到） */
  beforeOpen?: () => void;
}): DrawingHandle {
  const render = (): void => {
    if (!drawer) return;
    drawer.body.innerHTML = state.loaded
      ? `<div class="dw-head"><b>${state.name ?? ''}</b><span class="acp-pill">${state.source === 'dwg' ? `DWG→DXF〔${state.converter ?? '转换器'}〕` : 'DXF'}</span></div>
         <p class="asm-hint">${state.segments} 条线段已贴到 3D 视图（Z=0 平面）。</p>
         <div class="dw-layers">${state.layers.slice(0, 12).map((layer) => `<div><span>${layer.name}</span><b>${layer.segments}</b></div>`).join('')}</div>
         <p class="asm-hint">文字/标注/填充不参与几何，见统计：${state.message ?? ''}</p>
         <button type="button" class="acp-btn" id="dwFit">缩放到图纸</button>
         <button type="button" class="acp-btn" id="dwClear">移除图纸</button>`
      : '<p class="asm-hint">还没有打开图纸。支持 .dxf；.dwg 需要本机有 ODA File Converter 或 LibreDWG。</p>';
    drawer.body.querySelector('#dwFit')?.addEventListener('click', () => {
      options.view()?.fitDrawing();
    });
    drawer.body.querySelector('#dwClear')?.addEventListener('click', () => {
      handle.clear();
    });
  };

  const handle: DrawingHandle = {
    async open(path: string) {
      const api = window.desktop;
      if (!api?.openDrawing) return { ok: false, message: '桌面接口不可用' };
      const result = await api.openDrawing(path);
      if (!result.ok) {
        state.message = result.message;
        return { ok: false, message: result.message };
      }
      const drawing = parseDxf(result.text);
      if (drawing.segments.length === 0) {
        state.message = '图纸里没有可绘制的线段（可能只有文字/标注/填充）';
        return { ok: false, message: state.message };
      }
      options.beforeOpen?.();
      const view = options.view();
      const rendered = view?.setDrawingLayer(drawing.segments) ?? 0;
      view?.fitDrawing();
      lastImport = {
        path,
        name: fileNameOf(path),
        source: result.source,
        converter: result.converter,
        drawing,
        segmentsRendered: rendered
      };
      Object.assign(state, {
        loaded: true,
        name: lastImport.name,
        source: result.source,
        converter: result.converter,
        segments: rendered,
        bounds: drawing.bounds,
        stats: drawing.stats,
        layers: drawing.layers,
        message: describe(drawing)
      });
      render();
      return { ok: true, message: `${lastImport.name}：${describe(drawing)}` };
    },
    clear() {
      options.view()?.clearDrawingLayer();
      lastImport = null;
      Object.assign(state, {
        loaded: false, name: null, source: null, converter: null,
        segments: 0, bounds: null, stats: null, layers: [], message: null
      });
      render();
    },
    state: () => ({ ...state }),
    fit: () => options.view()?.fitDrawing() ?? false,
    show() {
      drawer = drawer ?? options.mountDrawer(document.createElement('div'));
      render();
      drawer.open();
    }
  };
  return handle;
}

export function drawingStyles(): string {
  return `
.dw-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.dw-layers{display:flex;flex-direction:column;gap:2px;max-height:180px;overflow:auto;font-size:11px;margin:6px 0}
.dw-layers div{display:flex;justify-content:space-between;color:var(--text-2)}
.dw-layers b{font-family:var(--mono,monospace);color:var(--text-3)}
.acp-btn{display:inline-block;margin:4px 6px 0 0;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--text-1);cursor:pointer;font-size:12px}
.acp-btn:hover{border-color:var(--accent)}
`;
}
