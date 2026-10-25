import type { Placement } from '../enclosure/layout.ts';
import type { StationDraft } from './wizard-state.ts';

export interface DesignCanvasSize { width: number; height: number }
export interface LayoutConflict { a: string; b: string }
export interface LayoutReport {
  placements: number;
  stations: number;
  overlaps: LayoutConflict[];
  outOfBounds: string[];
  utilization: number;
}

export function snapRail(value: number, pitch = 35): number {
  if (!Number.isFinite(value)) throw new Error('坐标必须是有限数值');
  return Math.round(value / pitch) * pitch;
}

export function findOverlaps(placements: readonly Placement[]): LayoutConflict[] {
  const conflicts: LayoutConflict[] = [];
  for (let left = 0; left < placements.length; left += 1) {
    const a = placements[left];
    if (!a) continue;
    for (let right = left + 1; right < placements.length; right += 1) {
      const b = placements[right];
      if (!b) continue;
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
        conflicts.push({ a: a.id, b: b.id });
      }
    }
  }
  return conflicts;
}

export function outOfBounds(placements: readonly Placement[], canvas: DesignCanvasSize): string[] {
  return placements.filter((item) => item.x < 0 || item.y < 0 || item.x + item.w > canvas.width || item.y + item.h > canvas.height)
    .map((item) => item.id);
}

export function inspectLayout(placements: readonly Placement[], canvas: DesignCanvasSize): LayoutReport {
  const area = placements.reduce((sum, item) => sum + item.w * item.h, 0);
  return {
    placements: placements.length,
    stations: placements.filter((item) => item.id.startsWith('station:')).length,
    overlaps: findOverlaps(placements),
    outOfBounds: outOfBounds(placements, canvas),
    utilization: canvas.width > 0 && canvas.height > 0 ? Math.round(area / (canvas.width * canvas.height) * 1000) / 10 : 0
  };
}

export function autoLayout(stations: readonly StationDraft[], canvas: DesignCanvasSize): Placement[] {
  const result: Placement[] = [];
  const width = Math.max(140, Math.min(280, (canvas.width - 35 * (stations.length + 1)) / Math.max(1, stations.length)));
  for (const [index, station] of stations.entries()) {
    const x = snapRail(35 + index * (width + 35));
    const y = 35;
    const id = `station:${station.id}`;
    result.push({ id, partId: id, model: station.name, x, y, w: width, h: 140, tag: 'station', note: '工位' });
    const items = [
      ...station.actuators.map((item) => ({ ...item, kindLabel: item.kind })),
      ...station.sensors.map((item) => ({ ...item, id: `sensor-${item.point}`, kindLabel: 'sensor', name: item.point }))
    ];
    for (const [itemIndex, item] of items.entries()) {
      const column = itemIndex % 2;
      const row = Math.floor(itemIndex / 2);
      result.push({
        id: `part:${station.id}:${item.id || item.point}`,
        partId: item.partId || item.id,
        model: item.model || item.name,
        x: snapRail(x + column * 105),
        y: snapRail(210 + row * 70),
        w: 70,
        h: 35,
        tag: item.kindLabel,
        note: station.name
      });
    }
  }
  return result;
}

export function movePlacement(placement: Placement, x: number, y: number): Placement {
  return { ...placement, x: snapRail(x), y: snapRail(y) };
}
