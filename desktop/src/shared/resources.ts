// 显式资源计数：测试不必依赖 process._getActiveHandles（Electron/Windows 上不稳定）。
// 所有会被关闭路径管理的周期性/延迟任务都应通过这里创建。

type TimerHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

const timeouts = new Set<TimerHandle>();
const intervals = new Set<IntervalHandle>();

export function trackedSetTimeout(callback: () => void, ms: number): TimerHandle {
  const handle = setTimeout(() => {
    timeouts.delete(handle);
    callback();
  }, ms);
  timeouts.add(handle);
  return handle;
}

export function trackedClearTimeout(handle: TimerHandle | null | undefined): void {
  if (!handle) return;
  timeouts.delete(handle);
  clearTimeout(handle);
}

export function trackedSetInterval(callback: () => void, ms: number): IntervalHandle {
  const handle = setInterval(callback, ms);
  intervals.add(handle);
  return handle;
}

export function trackedClearInterval(handle: IntervalHandle | null | undefined): void {
  if (!handle) return;
  intervals.delete(handle);
  clearInterval(handle);
}

export function activeTimeoutCount(): number {
  return timeouts.size;
}

export function activeIntervalCount(): number {
  return intervals.size;
}

export function activeTrackedTimers(): number {
  return timeouts.size + intervals.size;
}

export function disposeTrackedTimers(): void {
  for (const handle of timeouts) clearTimeout(handle);
  for (const handle of intervals) clearInterval(handle);
  timeouts.clear();
  intervals.clear();
}
