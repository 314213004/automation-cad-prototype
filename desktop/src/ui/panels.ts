import panelStyles from './panels.css?inline';
import { drawerIdForEntry } from './drawer-ids.ts';

let stylesInjected = false;
let toastTimer = 0;

export function ensurePanelStyles(): void {
  if (stylesInjected || document.getElementById('acp-panel-styles')) {
    stylesInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'acp-panel-styles';
  style.textContent = panelStyles;
  document.head.appendChild(style);
  stylesInjected = true;
}

function closeDrawerElement(element: HTMLElement): void {
  element.hidden = true;
  element.classList.remove('is-open');
}

/**
 * 收起除 keep 之外所有已打开的抽屉。
 * 所有抽屉停靠在同一个位置，同时打开只会互相遮挡，所以打开新的必须先收起旧的。
 * 返回被收起的数量，便于调用方与测试断言。
 */
export function closeOtherDrawers(keep: HTMLElement | null = null): number {
  let closed = 0;
  document.querySelectorAll<HTMLElement>('.acp-drawer').forEach((element) => {
    if (element === keep || element.hidden) return;
    closeDrawerElement(element);
    closed += 1;
  });
  return closed;
}

export function buildEntryButton(id: string, label: string, icon: string, onClick: () => void): HTMLButtonElement | null {
  const existing = document.getElementById(id);
  if (existing instanceof HTMLButtonElement) return existing;
  const target = document.querySelector('.tb-right');
  if (!target) return null;
  const button = document.createElement('button');
  button.id = id;
  button.type = 'button';
  button.className = 'acp-entry-btn';
  button.title = label;
  button.innerHTML = `${icon}<span>${label}</span>`;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // 同一个入口再点一次 = 收起当前抽屉（切换标签时上一个必须缩回，而不是层层叠加）。
    const drawerId = drawerIdForEntry(id);
    const openDrawer = drawerId ? document.getElementById(drawerId) : null;
    if (openDrawer instanceof HTMLElement && !openDrawer.hidden) {
      closeDrawerElement(openDrawer);
      return;
    }
    onClick();
  });
  target.appendChild(button);
  return button;
}

export interface DrawerHandle {
  root: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

export function createDrawer(id: string, title: string, subtitle: string): DrawerHandle {
  const existing = document.getElementById(id);
  const root = existing instanceof HTMLElement ? existing : document.createElement('div');
  if (!existing) {
    root.id = id;
    root.className = 'acp-drawer';
    root.hidden = true;
    root.innerHTML = `
      <header class="acp-drawer-head">
        <div>
          <h2 class="acp-drawer-title"></h2>
          <p class="acp-drawer-sub"></p>
        </div>
        <button type="button" class="acp-icon-btn" data-acp-close aria-label="关闭">×</button>
      </header>
      <div class="acp-drawer-body"></div>
      <footer class="acp-drawer-foot"></footer>`;
    document.body.appendChild(root);
  }
  const titleElement = root.querySelector<HTMLElement>('.acp-drawer-title');
  const subtitleElement = root.querySelector<HTMLElement>('.acp-drawer-sub');
  if (titleElement) titleElement.textContent = title;
  if (subtitleElement) subtitleElement.textContent = subtitle;
  const body = root.querySelector<HTMLElement>('.acp-drawer-body');
  const footer = root.querySelector<HTMLElement>('.acp-drawer-foot');
  if (!body || !footer) throw new Error(`面板结构不完整：${id}`);

  const close = (): void => {
    root.hidden = true;
    root.classList.remove('is-open');
  };
  root.querySelector('[data-acp-close]')?.addEventListener('click', close);
  root.addEventListener('pointerdown', (event) => event.stopPropagation());
  root.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !root.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }, true);

  return {
    root,
    body,
    footer,
    open(): void {
      closeOtherDrawers(root);
      root.hidden = false;
      root.classList.add('is-open');
    },
    close,
    isOpen(): boolean {
      return !root.hidden;
    }
  };
}

export function notify(message: string, error = false): void {
  ensurePanelStyles();
  let toast = document.getElementById('acpToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'acpToast';
    toast.className = 'acp-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.toggle('is-error', error);
  toast.classList.add('is-on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast?.classList.remove('is-on'), 3800);
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '');
}

export function escapeHtml(value: string): string {
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
