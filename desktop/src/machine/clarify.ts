// 追问策略：纯函数，只判断「会不会显著改变方案」的三项：工艺、工位、节拍。
// 最多问 2 项；一次只生成一个问题。用户不答时由调用方使用模板/解析默认值继续，
// 并在 synthMachine 的 assumptions 中说明缺省。

import {
  DEFAULT_NOTE_STATIONS,
  MACHINE_DEFAULT_CYCLE_PER_MIN,
  type MachineBrief
} from './spec.ts';
import { templateFor } from './templates.ts';

export type MachineClarifyNeed = 'process' | 'stations' | 'cycle';

export interface MachineClarify {
  needs: MachineClarifyNeed[];
  question: string | null;
}

const MAX_NEEDS = 2;

function processQuestion(): string {
  return '这台机器做哪类工艺？可选锁螺丝、点胶、装配、检测或包装；未回答按通用工艺生成。';
}

function stationQuestion(brief: MachineBrief): string {
  const fallback = templateFor(brief.process).stations;
  return `这台机器做几个工位？默认按 ${fallback} 工位生成。`;
}

function cycleQuestion(): string {
  return `目标节拍是多少（件/分钟）？默认按 ${MACHINE_DEFAULT_CYCLE_PER_MIN} 件/分钟生成。`;
}

export function buildClarify(brief: MachineBrief): MachineClarify {
  const unresolved: MachineClarifyNeed[] = [];
  if (brief.process === 'unknown') unresolved.push('process');
  if (brief.notes.includes(DEFAULT_NOTE_STATIONS)) unresolved.push('stations');
  if (brief.cyclePerMin === null) unresolved.push('cycle');

  const needs = unresolved.slice(0, MAX_NEEDS);
  if (needs.length === 0) return { needs, question: null };

  const questions = needs.map((need) => {
    if (need === 'process') return processQuestion();
    if (need === 'stations') return stationQuestion(brief);
    return cycleQuestion();
  });
  return { needs, question: questions.join(' ') };
}
