import {
  detectInterferences,
  interferencePairKey,
  type InterferenceHit,
  type InterferencePart
} from './interference';

const IGNORE_KEY = 'automationcad.interference.ignored.v1';

export interface InterferencePanelOptions {
  container: HTMLElement;
  getParts(): InterferencePart[];
  highlight(names: readonly string[]): boolean;
  clearHighlight(): void;
  notify(message: string, error?: boolean): void;
  onCount?(count: number): void;
}

export interface InterferencePanelHandle {
  run(parts?: readonly InterferencePart[]): InterferenceHit[];
  getHits(): InterferenceHit[];
  hasRun(): boolean;
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return entities[character] ?? character;
  });
}

function readIgnored(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(IGNORE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch (error) {
    console.warn('[interference] 读取忽略记录失败，按空列表处理', error);
    return [];
  }
}

function writeIgnored(pairs: string[]): void {
  try {
    localStorage.setItem(IGNORE_KEY, JSON.stringify([...new Set(pairs)]));
  } catch (error) {
    throw new Error(`无法保存干涉忽略记录：${error instanceof Error ? error.message : String(error)}`);
  }
}

function severityLabel(severity: InterferenceHit['severity']): string {
  return severity === 'error' ? '严重' : '警告';
}

export function initInterferencePanel(options: InterferencePanelOptions): InterferencePanelHandle {
  let hits: InterferenceHit[] = [];
  let currentParts: readonly InterferencePart[] = [];
  let hasRun = false;
  options.container.innerHTML = `<div class="cad-interference-actions">
      <button type="button" class="cad-btn cad-btn-primary" data-interference-run>运行检测</button>
      <button type="button" class="cad-btn" data-interference-clear>清除高亮</button>
    </div>
    <div class="cad-interference-note">包围盒级初筛 · 相切不计 · 点击结果定位两件</div>
    <div class="cad-interference-list" data-interference-list>
      <div class="cad-interference-empty">打开 CAD 模型后运行检测</div>
    </div>`;

  const list = options.container.querySelector<HTMLElement>('[data-interference-list]');
  if (!list) throw new Error('干涉面板节点缺失');

  const render = (): void => {
    list.innerHTML = hits.length === 0
      ? `<div class="cad-interference-empty">${currentParts.length < 2 ? '当前模型零件不足 2 件' : '未发现包围盒级碰撞候选（AABB 初筛，不代表无干涉；螺栓联接/轴孔配合等正常叠层本来就重叠）'}</div>`
      : hits.map((hit, index) => `<div class="cad-interference-hit" data-hit-index="${index}" data-severity="${hit.severity}" tabindex="0" role="button">
          <span class="cad-hit-sev">${severityLabel(hit.severity)}</span>
          <span class="cad-hit-name">${escapeText(hit.a)} ↔ ${escapeText(hit.b)}</span>
          <span class="cad-hit-metric cad-hit-overlap">Δ ${hit.overlap.map((value) => value.toFixed(2)).join(' × ')} mm</span>
          <span class="cad-hit-metric cad-hit-volume">${hit.volumeApprox.toFixed(1)} mm³</span>
          <button type="button" class="cad-hit-ignore" data-ignore-index="${index}" title="忽略并记录">忽略</button>
        </div>`).join('');
    options.onCount?.(hits.length);
  };

  const run = (parts?: readonly InterferencePart[]): InterferenceHit[] => {
    const source = parts ?? options.getParts();
    const ignored = readIgnored();
    currentParts = source.map((part) => ({
      name: part.name,
      bbox: { min: [...part.bbox.min], max: [...part.bbox.max] }
    }));
    try {
      hasRun = true;
      hits = detectInterferences(currentParts, { ignoredPairs: ignored });
    } catch (error) {
      hits = [];
      render();
      const message = error instanceof Error ? error.message : String(error);
      options.notify(`干涉检测失败：${message}`, true);
      throw error;
    }
    render();
    return hits.map((hit) => ({ ...hit, overlap: [...hit.overlap], center: [...hit.center] }));
  };

  options.container.querySelector('[data-interference-run]')?.addEventListener('click', () => {
    try {
      const result = run();
      options.notify(
        result.length > 0
          ? `干涉初筛完成：${result.length} 处疑似（AABB），需人工确认`
          : '干涉初筛完成：未发现疑似（AABB 初筛，不代表无干涉）'
      );
    } catch (error) {
      // run() 已给出中文提示。
      console.warn(`[INTERFERENCE_UI_RUN_FAILED]`, { site: 'desktop/src/mech/interference-ui.ts:114' }, error);
    }
  });

  options.container.querySelector('[data-interference-clear]')?.addEventListener('click', () => {
    options.clearHighlight();
    options.container.querySelectorAll('.cad-interference-hit').forEach((row) => row.classList.remove('is-active'));
  });

  list.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const ignore = target.closest<HTMLElement>('[data-ignore-index]');
    if (ignore) {
      event.stopPropagation();
      const index = Number(ignore.dataset.ignoreIndex);
      const hit = hits[index];
      if (!hit) return;
      try {
        writeIgnored([...readIgnored(), interferencePairKey(hit.a, hit.b)]);
        run(currentParts);
        options.notify(`已忽略：${hit.a} ↔ ${hit.b}`);
      } catch (error) {
        options.notify(error instanceof Error ? error.message : String(error), true);
      }
      return;
    }
    const row = target.closest<HTMLElement>('[data-hit-index]');
    if (!row) return;
    const hit = hits[Number(row.dataset.hitIndex)];
    if (!hit) return;
    list.querySelectorAll('.cad-interference-hit').forEach((item) => item.classList.remove('is-active'));
    row.classList.add('is-active');
    if (!options.highlight([hit.a, hit.b])) {
      options.notify('当前环境无法高亮模型（WebGL 不可用或零件已卸载）', true);
    }
  });

  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-hit-index]');
    if (!row) return;
    event.preventDefault();
    row.click();
  });

  return {
    run,
    getHits(): InterferenceHit[] {
      return hits.map((hit) => ({ ...hit, overlap: [...hit.overlap], center: [...hit.center] }));
    },
    hasRun(): boolean {
      return hasRun;
    }
  };
}
