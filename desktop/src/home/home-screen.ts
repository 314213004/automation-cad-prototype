// 启动首页（工作台首页）：最近工程 + 新建入口，首屏不出现示例装配
//
// 为什么单独一层：原型 app.js 一加载就是「滑台气缸装配体」示例工程（树/属性/BOM/3D 全是硬编码常量），
// 首屏直接看到它等于把演示数据当真实工程。这里在启动时盖一层首页，用户先选「新建」或「打开最近工程」，
// 收起后才露出原型界面；示例装配仍可从顶部「载入示例」进（明确标注为演示）。
//
// 纯逻辑（排序/裁剪/时间格式化/空态文案）在 model.ts，可单测；这层只管 DOM。
import { buildHomeModel, type HomeModel, type HomeProjectInput } from './model.ts';

export interface HomeScreenOptions {
  onNewBlank: () => void;
  onNewDemo: () => void;
  onOpenCanvas: () => void;
  onOpenProject: (id: string) => Promise<void> | void;
  onEnterClassic: () => void;
}

export interface HomeScreenHandle {
  open(): void;
  /** 底部提示行（首页「空白画布」清草稿前的二次确认提示用） */
  message(text: string, warn?: boolean): void;
  close(): void;
  isOpen(): boolean;
  refresh(): Promise<void>;
}

const STYLE_ID = 'home-screen-styles';

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
  .home-root { position: fixed; inset: 0; z-index: 2147483000; display: flex; flex-direction: column;
    background: radial-gradient(1200px 600px at 20% -10%, #16324a 0%, #0d1117 55%, #0b0e13 100%);
    color: #dfe7f3; font: 13px/1.6 "Segoe UI", "PingFang SC", sans-serif; }
  .home-root[hidden] { display: none !important; }
  /* 首页打开时把原型界面压成透明：不能用 visibility/display 隐藏——
     3D 视口要按容器尺寸挂 WebGL，藏起来会量到 0×0，整机视图直接降级成 fallback */
  body.home-open #app { opacity: 0 !important; pointer-events: none !important; }
  .home-bar { display: flex; align-items: center; gap: 10px; padding: 14px 28px; border-bottom: 1px solid #1d2836; }
  .home-logo { width: 26px; height: 26px; border-radius: 7px; background: linear-gradient(135deg, #35c7b3, #2f7fd8);
    display: grid; place-items: center; font-weight: 700; color: #06231f; }
  .home-bar b { font-size: 14px; letter-spacing: .3px; }
  .home-bar .home-ver { margin-left: auto; color: #7d8b9c; font-size: 11px; }
  .home-body { flex: 1; overflow: auto; padding: 28px 28px 40px; display: grid; gap: 26px; max-width: 1180px; margin: 0 auto; width: 100%; }
  .home-hero h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: .5px; }
  .home-hero p { margin: 0; color: #93a1b3; max-width: 720px; }
  .home-section h2 { margin: 0 0 10px; font-size: 13px; color: #9fb0c4; font-weight: 600; letter-spacing: .4px; }
  .home-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
  .home-card { text-align: left; padding: 14px 16px; border-radius: 10px; cursor: pointer;
    border: 1px solid #22303f; background: #121a24; color: inherit; transition: border-color .15s, transform .15s, background .15s; }
  .home-card:hover { border-color: #35c7b3; transform: translateY(-1px); background: #14202c; }
  .home-card b { display: block; font-size: 14px; margin-bottom: 4px; }
  .home-card span { color: #8b98a9; font-size: 12px; }
  .home-card .home-tag { display: inline-block; margin-top: 8px; padding: 1px 7px; border-radius: 9px;
    border: 1px solid #2f4a5f; color: #8fd8ff; font-size: 10px; }
  .home-list { display: grid; gap: 6px; }
  .home-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #1e2a37; background: #101820; cursor: pointer; text-align: left; color: inherit; width: 100%; }
  .home-row:hover { border-color: #2f7fd8; background: #121e2b; }
  .home-row b { font-weight: 600; }
  .home-row .home-meta { margin-left: auto; color: #7d8b9c; font-size: 11px; white-space: nowrap; }
  .home-empty { padding: 18px; border: 1px dashed #2a3846; border-radius: 10px; color: #8593a5; }
  .home-foot { display: flex; align-items: center; gap: 12px; padding: 12px 28px; border-top: 1px solid #1d2836; }
  .home-link { background: none; border: none; color: #6fb6ff; cursor: pointer; padding: 0; font: inherit; }
  .home-link:hover { text-decoration: underline; }
  .home-hint { color: #7d8b9c; font-size: 11px; margin-left: auto; }
  .home-warn { color: #ffb86b; }
  `;
  document.head.appendChild(style);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let root: HTMLElement | null = null;
let listHost: HTMLElement | null = null;
let versionHost: HTMLElement | null = null;
let messageHost: HTMLElement | null = null;
let lastModel: HomeModel | null = null;
let optionsRef: HomeScreenOptions | null = null;

function setMessage(text: string, warn = false): void {
  if (!messageHost) return;
  messageHost.textContent = text;
  messageHost.classList.toggle('home-warn', warn);
}

function renderProjects(model: HomeModel): void {
  if (!listHost) return;
  listHost.textContent = '';
  if (model.projects.length === 0) {
    listHost.appendChild(el('div', 'home-empty', model.emptyHint));
    return;
  }
  for (const project of model.projects) {
    const row = el('button', 'home-row') as HTMLButtonElement;
    row.type = 'button';
    row.dataset.projectId = project.id;
    row.appendChild(el('b', undefined, project.name));
    row.appendChild(el('span', 'home-meta', project.meta));
    row.addEventListener('click', () => {
      if (!optionsRef) return;
      setMessage(`正在打开「${project.name}」…`);
      void Promise.resolve(optionsRef.onOpenProject(project.id))
        .then(() => setMessage(`已打开「${project.name}」`))
        .catch((error: unknown) => {
          setMessage(`打开失败：${error instanceof Error ? error.message : String(error)}`, true);
        });
    });
    listHost.appendChild(row);
  }
}

export function initHomeScreen(options: HomeScreenOptions): HomeScreenHandle {
  injectStyles();
  optionsRef = options;
  if (!root) {
    root = el('section', 'home-root');
    root.id = 'homeScreen';
    root.setAttribute('aria-label', '工作台首页');

    const bar = el('header', 'home-bar');
    bar.appendChild(el('div', 'home-logo', 'A'));
    bar.appendChild(el('b', undefined, '自动化设计工作台'));
    versionHost = el('span', 'home-ver', '');
    bar.appendChild(versionHost);
    root.appendChild(bar);

    const body = el('div', 'home-body');

    const hero = el('div', 'home-hero');
    hero.appendChild(el('h1', undefined, '从这里开始'));
    hero.appendChild(el('p', undefined, '新建一个画布方案，或打开最近工程。非标整机从工位拓扑开始：端口不匹配就插转接板，产能走 evaluateFlow，成本只算查得到价的项。'));
    body.appendChild(hero);

    const startSection = el('section', 'home-section');
    startSection.appendChild(el('h2', undefined, '新建'));
    const cards = el('div', 'home-cards');

    const blank = el('button', 'home-card') as HTMLButtonElement;
    blank.type = 'button';
    blank.dataset.homeAction = 'new-blank';
    blank.appendChild(el('b', undefined, '空白画布'));
    blank.appendChild(el('span', undefined, '从模组库拖件开始，端口五字段全等才能直连'));
    blank.appendChild(el('span', 'home-tag', 'linear · 0 节点'));
    blank.addEventListener('click', () => options.onNewBlank());

    const demo = el('button', 'home-card') as HTMLButtonElement;
    demo.type = 'button';
    demo.dataset.homeAction = 'new-demo';
    demo.appendChild(el('b', undefined, '演示拓扑（6 工位）'));
    demo.appendChild(el('span', undefined, '三轴龙门视觉贴合机：含 1 处真实端口不匹配，可直接插板'));
    demo.appendChild(el('span', 'home-tag', '演示数据'));
    demo.addEventListener('click', () => options.onNewDemo());

    const canvas = el('button', 'home-card') as HTMLButtonElement;
    canvas.type = 'button';
    canvas.dataset.homeAction = 'open-canvas';
    canvas.appendChild(el('b', undefined, '打开画布工作台'));
    canvas.appendChild(el('span', undefined, '接着上次的草稿继续（草稿存在工程目录，清缓存也在）'));
    canvas.appendChild(el('span', 'home-tag', '继续编辑'));
    canvas.addEventListener('click', () => options.onOpenCanvas());

    cards.append(blank, demo, canvas);
    startSection.appendChild(cards);
    body.appendChild(startSection);

    const recent = el('section', 'home-section');
    recent.appendChild(el('h2', undefined, '最近工程'));
    listHost = el('div', 'home-list');
    recent.appendChild(listHost);
    body.appendChild(recent);

    root.appendChild(body);

    const foot = el('footer', 'home-foot');
    const classic = el('button', 'home-link', '进入经典原型界面（含示例装配）') as HTMLButtonElement;
    classic.type = 'button';
    classic.addEventListener('click', () => options.onEnterClassic());
    foot.appendChild(classic);
    messageHost = el('span', 'home-hint', '');
    foot.appendChild(messageHost);
    root.appendChild(foot);

    document.body.appendChild(root);
  }

  const handle: HomeScreenHandle = {
    message(text: string, warn = false): void {
      setMessage(text, warn);
    },
    open(): void {
      if (!root) return;
      root.hidden = false;
      document.body.classList.add('home-open');
      void handle.refresh();
    },
    close(): void {
      if (!root) return;
      root.hidden = true;
      document.body.classList.remove('home-open');
    },
    isOpen(): boolean {
      return Boolean(root && !root.hidden);
    },
    async refresh(): Promise<void> {
      let projects: HomeProjectInput[] = [];
      let error: string | null = null;
      try {
        const api = window.desktop?.projects;
        if (api) {
          const list = await api.list();
          projects = list.map((record) => ({
            id: record.id,
            name: record.name,
            process: record.process,
            parts: record.parts,
            createdAt: record.createdAt
          }));
        } else {
          error = '当前环境没有工程接口（浏览器模式）：只能新建画布';
        }
      } catch (cause) {
        error = `读取最近工程失败：${cause instanceof Error ? cause.message : String(cause)}`;
      }
      lastModel = buildHomeModel(projects, { now: new Date(), error });
      if (versionHost) versionHost.textContent = lastModel.versionLabel;
      renderProjects(lastModel);
      setMessage(error ? error : lastModel.footerHint, Boolean(error));
    }
  };

  return handle;
}
