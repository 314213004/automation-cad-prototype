import type { PlcKind, PlcStatus, PlcValue } from '../plc/types.ts';
import type { StepResult } from './sequence.ts';

export interface CommissionStepReport {
  stepId: string;
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
  durationMs: number;
  message?: string;
}

export interface CommissionCaseReport {
  id: string;
  name: string;
  pass: boolean;
  at: string;
  durationMs: number;
  results: CommissionStepReport[];
}

export interface CommissionPointReport {
  id: string;
  name: string;
  value: PlcValue;
  unit?: string;
}

export interface CommissionReport {
  plcKind: PlcKind | null;
  plcStatus: PlcStatus;
  startedAt: string;
  completedAt: string;
  powerUp: {
    pass: boolean;
    results: CommissionStepReport[];
  };
  cases: CommissionCaseReport[];
  points: CommissionPointReport[];
}

export function toStepReport(result: StepResult): CommissionStepReport {
  return {
    stepId: result.stepId,
    name: result.name,
    pass: result.pass,
    expected: result.expected,
    actual: result.actual,
    durationMs: result.durationMs,
    ...(result.message ? { message: result.message } : {})
  };
}
