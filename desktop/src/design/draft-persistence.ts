export type DraftSaveState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; error: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serializes autosaves and always drains the newest snapshot before reporting success.
 * A failed write remains dirty so an explicit retry or a later edit can recover it.
 */
export class DraftPersistence<T> {
  private readonly write: (snapshot: T) => Promise<void>;
  private readonly clone: (value: T) => T;
  private readonly onState: (state: DraftSaveState) => void;
  private revision = 0;
  private savedRevision = 0;
  private latest: T | undefined;
  private active: Promise<void> | null = null;
  private currentState: DraftSaveState = { status: 'idle' };

  constructor(
    write: (snapshot: T) => Promise<void>,
    clone: (value: T) => T,
    onState: (state: DraftSaveState) => void = () => undefined
  ) {
    this.write = write;
    this.clone = clone;
    this.onState = onState;
  }

  get state(): DraftSaveState {
    return this.currentState;
  }

  get hasPendingChanges(): boolean {
    return this.savedRevision < this.revision;
  }

  private setState(state: DraftSaveState): void {
    this.currentState = state;
    this.onState(state);
  }

  markSaved(value: T): void {
    this.revision = 0;
    this.savedRevision = 0;
    this.latest = this.clone(value);
    this.setState({ status: 'saved' });
  }

  markDirty(value: T): void {
    this.latest = this.clone(value);
    this.revision += 1;
    this.setState({ status: 'pending' });
  }

  reset(): void {
    this.revision = 0;
    this.savedRevision = 0;
    this.latest = undefined;
    this.setState({ status: 'idle' });
  }

  /** Waits for a current write without forcing unsaved edits to be written (used by discard). */
  async waitForCurrentWrite(): Promise<void> {
    try {
      await this.active;
    } catch {
      // An explicit discard clears the draft even if its last autosave failed.
    }
  }

  async flush(): Promise<void> {
    if (this.active) {
      await this.active;
      if (this.hasPendingChanges) await this.flush();
      return;
    }
    if (!this.hasPendingChanges) return;

    const task = this.drainLatest();
    this.active = task;
    try {
      await task;
    } finally {
      if (this.active === task) this.active = null;
    }
  }

  private async drainLatest(): Promise<void> {
    while (this.hasPendingChanges) {
      const revision = this.revision;
      const snapshot = this.clone(this.latest as T);
      this.setState({ status: 'saving' });
      try {
        await this.write(snapshot);
      } catch (error) {
        // If a newer edit arrived during this failed write, try that latest snapshot once
        // through the same drain loop; otherwise surface the failure to the UI/close flow.
        if (revision !== this.revision) continue;
        const message = errorText(error);
        this.setState({ status: 'error', error: message });
        throw error;
      }
      this.savedRevision = revision;
      this.setState(this.hasPendingChanges ? { status: 'pending' } : { status: 'saved' });
    }
  }
}
