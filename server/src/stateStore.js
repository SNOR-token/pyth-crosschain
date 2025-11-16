import { loadJson, saveJson } from './utils.js';

const DEFAULT_STATE = {
  cycles: 0,
  totalLiquidations: 0,
  totalFailed: 0,
  lastSignature: null,
  lastError: null,
  realizedUsd: 0,
  settledLamports: '0',
  healthThreshold: null,
  liquidator: null,
};

export class StateStore {
  constructor(path) {
    this.path = path;
    this.state = { ...DEFAULT_STATE };
  }

  async load() {
    const fromDisk = await loadJson(this.path, null);
    if (fromDisk) this.state = { ...DEFAULT_STATE, ...fromDisk };
    return this.state;
  }

  async patch(updater) {
    const next = updater({ ...this.state });
    this.state = { ...this.state, ...next };
    await saveJson(this.path, this.state);
    return this.state;
  }

  snapshot() {
    return { ...this.state };
  }
}
