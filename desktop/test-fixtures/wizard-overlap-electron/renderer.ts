import { initDesignWizard } from '../../src/design/wizard-ui.ts';
import {
  briefToMachineBrief,
  initialDraft,
  nextStep,
  selectCandidate,
  withBrief,
  withCandidates,
  withPlacements,
  withStations
} from '../../src/design/wizard-state.ts';
import { generateCandidates } from '../../src/design/candidates.ts';
import { geometryForDesign } from '../../src/design/footprint.ts';
import type { DesignDraft } from '../../src/design/wizard-state.ts';
import type { Placement } from '../../src/enclosure/layout.ts';

const fixtureWindow = window as typeof window & {
  desktop?: Record<string, any>;
  __wizardFixtureReady?: boolean;
  __wizardTestNotices?: Array<{ message: string; error: boolean }>;
  __resetWizard?: (mode: 'clear' | 'overlap' | 'out-of-bounds' | 'identity-warning') => Promise<void>;
  __wizardStoredDraft?: () => DesignDraft | null;
  __reopenWizard?: () => void;
};

const fixedNow = new Date('2026-10-25T08:00:00+08:00');
let storedDraft: DesignDraft | null = null;
fixtureWindow.__wizardTestNotices = [];
fixtureWindow.desktop = {
  packs: { listParts: async () => [] },
  design: {
    loadDraft: async () => ({ draft: clone(storedDraft), recovered: false }),
    saveDraft: async (draft: DesignDraft) => {
      storedDraft = clone(draft);
      return { ok: true };
    },
    clearDraft: async () => {
      storedDraft = null;
      return { ok: true };
    },
    settings: async () => ({ ok: false })
  }
};

const wizard = initDesignWizard({
  onSaved: async () => undefined,
  openProject: async () => undefined,
  sceneInfo: () => ({ source: 'empty' }),
  importCad: async () => false,
  notify: (message, error = false) => fixtureWindow.__wizardTestNotices?.push({ message, error })
});
fixtureWindow.__wizardStoredDraft = () => clone(storedDraft);
fixtureWindow.__reopenWizard = () => wizard.open();

fixtureWindow.__resetWizard = async (mode: 'clear' | 'overlap' | 'out-of-bounds' | 'identity-warning') => {
  await wizard.close();
  storedDraft = makeStepFourDraft(mode);
  fixtureWindow.__wizardTestNotices = [];
  wizard.open();
  await waitForStepFour();
};
fixtureWindow.__wizardFixtureReady = true;

function makeStepFourDraft(mode: 'clear' | 'overlap' | 'out-of-bounds' | 'identity-warning'): DesignDraft {
  const initial = initialDraft(fixedNow);
  const brief = {
    ...initial.brief,
    name: 'DOM 布局冲突回归',
    cyclePerMin: 10,
    stations: 2
  };
  let draft = withBrief(initial, brief, fixedNow);
  draft = withCandidates(draft, generateCandidates(briefToMachineBrief(brief)), fixedNow);
  draft = selectCandidate(draft, 0, fixedNow);
  draft = nextStep(draft, fixedNow);
  draft = nextStep(draft, fixedNow);
  draft = nextStep(draft, fixedNow);

  const envelope = geometryForDesign(draft.design!).envelope;
  const canvasWidth = Math.ceil(envelope[0] / 35) * 35;
  const canvasHeight = Math.ceil(envelope[1] / 35) * 35;
  const width = Math.max(1, Math.min(70, Math.floor(canvasWidth / 4)));
  const height = Math.max(1, Math.min(70, Math.floor(canvasHeight / 4)));
  const firstStation = draft.stations[0];
  const secondStation = draft.stations[1];
  if (!firstStation || !secondStation) throw new Error('fixture 需要候选生成两个工位');

  const first: Placement = {
    id: `station:${firstStation.id}`,
    partId: `station:${firstStation.id}`,
    model: '测试工位 1',
    x: 0,
    y: 0,
    w: width,
    h: height,
    tag: 'station',
    note: 'DOM 回归 fixture'
  };
  const second: Placement = {
    id: `station:${secondStation.id}`,
    partId: `station:${secondStation.id}`,
    model: '测试工位 2',
    x: canvasWidth - width,
    y: canvasHeight - height,
    w: width,
    h: height,
    tag: 'station',
    note: 'DOM 回归 fixture'
  };

  const placements = mode === 'clear' || mode === 'identity-warning'
    ? [first]
    : mode === 'overlap'
      ? [first, { ...second, x: Math.max(0, Math.floor(width / 3)), y: Math.max(0, Math.floor(height / 3)) }]
      : [
          first,
          { ...second, x: canvasWidth + 1, y: 0 },
          {
            ...second,
            id: `part:${secondStation.id}:fixture-overlap`,
            partId: secondStation.id,
            model: '越界组件',
            x: canvasWidth + 5,
            y: 0,
            tag: 'fixture-part'
          }
        ];

  draft = withPlacements(draft, placements, fixedNow);
  draft = withStations(draft, draft.stations, fixedNow);
  if (mode === 'identity-warning' && draft.design) {
    const warning = '旧版工位偏移已安全清除，请在第 4 步重新定位。';
    draft.design.stationGeometryWarning = warning;
    draft.stationIdentityNotice = warning;
  }
  return { ...draft, step: 4 };
}

async function waitForStepFour(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const active = document.querySelector<HTMLElement>('#designWizard .design-steps li.active');
    if (!document.querySelector('#designWizard')?.hidden && active?.dataset.step === '4') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('fixture 等待生产向导进入第 4 步超时');
}

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
