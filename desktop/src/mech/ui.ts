import {
  boltPreload,
  cantileverDeflection,
  cylinderForce,
  type BoltGrade,
  type BoltSize,
  type StressResult
} from './stress';

export interface StressConclusion {
  name: string;
  result: StressResult;
}

interface FieldDef {
  key: string;
  label: string;
  value: string;
  unit: string;
  step: string;
  kind?: 'number' | 'select';
  options?: { value: string; label: string }[];
}

interface CalculatorDef {
  id: string;
  name: string;
  subtitle: string;
  fields: FieldDef[];
  compute(values: Record<string, string>): StressResult;
}

const CALCULATORS: CalculatorDef[] = [
  {
    id: 'cylinder',
    name: '气缸推力',
    subtitle: 'F = p·A·η · 拉力按 0.85 推力估算',
    fields: [
      { key: 'bore', label: '缸径 D', value: '32', unit: 'mm', step: '0.1' },
      { key: 'pressure', label: '压力 p', value: '0.5', unit: 'MPa', step: '0.01' },
      { key: 'efficiency', label: '效率 η', value: '0.85', unit: '', step: '0.01' },
      { key: 'load', label: '负载', value: '300', unit: 'N', step: '1' }
    ],
    compute(values) {
      return cylinderForce({
        bore: Number(values.bore),
        pressure: Number(values.pressure),
        efficiency: Number(values.efficiency),
        load: Number(values.load)
      });
    }
  },
  {
    id: 'cantilever',
    name: '悬臂梁',
    subtitle: 'δ = FL³/(3EI) · 许用 L/500',
    fields: [
      { key: 'force', label: '集中力 F', value: '100', unit: 'N', step: '1' },
      { key: 'length', label: '长度 L', value: '500', unit: 'mm', step: '1' },
      { key: 'E', label: '弹性模量 E', value: '70000', unit: 'MPa', step: '100' },
      { key: 'width', label: '截面宽 w', value: '20', unit: 'mm', step: '0.1' },
      { key: 'height', label: '截面高 h', value: '10', unit: 'mm', step: '0.1' }
    ],
    compute(values) {
      return cantileverDeflection({
        force: Number(values.force),
        length: Number(values.length),
        E: Number(values.E),
        width: Number(values.width),
        height: Number(values.height)
      });
    }
  },
  {
    id: 'bolt',
    name: '螺栓预紧',
    subtitle: 'F0 = 0.7·σy·As · 安全系数 ≥ 1.5',
    fields: [
      {
        key: 'size', label: '规格', value: 'M6', unit: '', step: '1', kind: 'select',
        options: ['M4', 'M5', 'M6', 'M8'].map((value) => ({ value, label: value }))
      },
      {
        key: 'grade', label: '等级', value: '8.8', unit: '', step: '1', kind: 'select',
        options: [{ value: '8.8', label: '8.8' }, { value: '10.9', label: '10.9' }]
      },
      { key: 'load', label: '工作负载', value: '5000', unit: 'N', step: '100' }
    ],
    compute(values) {
      const size = (['M4', 'M5', 'M6', 'M8'] as const).includes(values.size as BoltSize)
        ? values.size as BoltSize
        : 'M6';
      return boltPreload({
        size,
        grade: (Number(values.grade) >= 10 ? 10.9 : 8.8) as BoltGrade,
        load: Number(values.load)
      });
    }
  }
];

function fieldMarkup(field: FieldDef): string {
  if (field.kind === 'select') {
    return `<label class="cad-calc-field"><span>${field.label}</span>
      <span class="cad-calc-input"><select name="${field.key}">${(field.options ?? []).map((option) =>
        `<option value="${option.value}"${option.value === field.value ? ' selected' : ''}>${option.label}</option>`).join('')}</select></span>
    </label>`;
  }
  return `<label class="cad-calc-field"><span>${field.label}</span>
    <span class="cad-calc-input"><input type="number" name="${field.key}" value="${field.value}" step="${field.step}" inputmode="decimal"><i>${field.unit}</i></span>
  </label>`;
}

function inputValue(form: HTMLFormElement, key: string): string {
  const input = form.elements.namedItem(key);
  if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) return input.value;
  return '';
}

function renderResult(target: HTMLElement, result: StressResult | null, error?: string): void {
  target.classList.toggle('is-pass', Boolean(result?.pass));
  target.classList.toggle('is-fail', result ? !result.pass : Boolean(error));
  target.classList.toggle('is-error', Boolean(error));
  if (error) {
    target.innerHTML = `<div class="cad-calc-verdict is-error"></div><div class="cad-calc-formula"></div><dl class="cad-calc-outputs"></dl>`;
    const verdict = target.querySelector<HTMLElement>('.cad-calc-verdict');
    if (verdict) verdict.textContent = error;
    return;
  }
  if (!result) return;
  target.innerHTML = `<div class="cad-calc-verdict"></div><div class="cad-calc-formula"></div><dl class="cad-calc-outputs"></dl>`;
  const verdict = target.querySelector<HTMLElement>('.cad-calc-verdict');
  if (verdict) {
    verdict.textContent = `${result.pass ? '通过' : '不通过'} · 安全系数 ${result.safetyFactor} · ${result.verdict}`;
  }
  const formula = target.querySelector<HTMLElement>('.cad-calc-formula');
  if (formula) formula.textContent = result.formula;
  const outputs = target.querySelector<HTMLElement>('.cad-calc-outputs');
  if (outputs) {
    for (const output of result.outputs) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = output.label;
      dd.textContent = `${output.value} ${output.unit}`.trim();
      row.append(dt, dd);
      outputs.appendChild(row);
    }
  }
}

export function initStressPanel(container: HTMLElement, onChange?: (results: StressConclusion[]) => void): void {
  container.innerHTML = `<div class="cad-stress-head"><span>受力校核</span><b>输入即算 · 150ms</b></div>
    <div class="cad-stress-list">${CALCULATORS.map((calculator) => `<form class="cad-calc" data-calc="${calculator.id}">
      <header><b>${calculator.name}</b><span>${calculator.subtitle}</span></header>
      <div class="cad-calc-fields">${calculator.fields.map(fieldMarkup).join('')}</div>
      <div class="cad-calc-result" data-calc-result="${calculator.id}"></div>
    </form>`).join('')}</div>`;

  const latest = new Map<string, StressConclusion>();
  let timer = 0;

  const calculate = (): void => {
    for (const calculator of CALCULATORS) {
      const form = container.querySelector<HTMLFormElement>(`form[data-calc="${calculator.id}"]`);
      const target = container.querySelector<HTMLElement>(`[data-calc-result="${calculator.id}"]`);
      if (!form || !target) continue;
      const values: Record<string, string> = {};
      for (const field of calculator.fields) values[field.key] = inputValue(form, field.key);
      try {
        const result = calculator.compute(values);
        latest.set(calculator.id, { name: calculator.name, result });
        renderResult(target, result);
      } catch (error) {
        latest.delete(calculator.id);
        renderResult(target, null, error instanceof Error ? error.message : String(error));
      }
    }
    onChange?.(CALCULATORS.flatMap((calculator) => {
      const entry = latest.get(calculator.id);
      return entry ? [entry] : [];
    }));
  };

  const schedule = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(calculate, 150);
  };

  container.addEventListener('input', schedule);
  container.addEventListener('change', schedule);
  calculate();
}
