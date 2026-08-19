import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const ARCHITECT_STATE_VERSION = 1;
export const DEFAULT_ARCHITECT_STATE_PATH = join(homedir(), ".dsh", "data", "dsh-architect", "state.json");

function emptyState() {
  return { version: ARCHITECT_STATE_VERSION, tasks: [], projects: [], history: [], changes: [] };
}

function normalizeState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    version: ARCHITECT_STATE_VERSION,
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    projects: Array.isArray(state.projects) ? state.projects : [],
    history: Array.isArray(state.history) ? state.history : [],
    changes: Array.isArray(state.changes) ? state.changes : [],
  };
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

export class ArchitectStateStore {
  constructor(file = DEFAULT_ARCHITECT_STATE_PATH) {
    this.file = file;
    this.state = emptyState();
    this.writeChain = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    try {
      const raw = await readFile(this.file, "utf8");
      this.state = normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        try { await rename(this.file, `${this.file}.corrupt-${Date.now()}`); } catch {}
        this.state = emptyState();
      }
    }
    return copy(this.state);
  }

  snapshot() {
    return copy(this.state);
  }

  async replace(next) {
    await this.ready;
    this.state = normalizeState(next);
    const payload = JSON.stringify(this.state, null, 2) + "\n";
    const target = this.file;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
      await rename(temp, target);
    });
    await this.writeChain;
    return this.snapshot();
  }

  async update(mutator) {
    await this.ready;
    const next = this.snapshot();
    await mutator(next);
    return this.replace(next);
  }
}

export function projectEstimate(history, input = {}) {
  const type = input.taskType ?? input.projectType ?? null;
  const moduleCount = Number(input.moduleCount) || 0;
  const bucket = moduleCount <= 2 ? "small" : moduleCount <= 5 ? "medium" : "large";
  const candidates = (Array.isArray(history) ? history : [])
    .filter((record) => !type || record.taskType === type)
    .filter((record) => !record.sizeBucket || record.sizeBucket === bucket)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .slice(0, Math.max(1, Number(input.limit) || 8));
  const durations = candidates.map((record) => Number(record.actualMinutes)).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (durations.length === 0) {
    return { available: false, sampleCount: 0, taskType: type, sizeBucket: bucket, estimateMinutes: null, confidence: "none", recent: [] };
  }
  const median = durations[Math.floor((durations.length - 1) / 2)];
  const p75 = durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.75) - 1)];
  const buffer = durations.length < 3 ? 1.25 : durations.length < 6 ? 1.15 : 1.1;
  const phaseTotals = {};
  for (const record of candidates) {
    for (const [phase, minutes] of Object.entries(record.phaseMinutes ?? {})) {
      phaseTotals[phase] = (phaseTotals[phase] ?? 0) + Number(minutes || 0);
    }
  }
  const phaseMinutes = Object.fromEntries(Object.entries(phaseTotals).map(([phase, total]) => [phase, Math.round(total / candidates.length)]));
  return {
    available: true,
    sampleCount: durations.length,
    taskType: type,
    sizeBucket: bucket,
    estimateMinutes: Math.max(1, Math.round(median * buffer)),
    medianMinutes: Math.round(median),
    p75Minutes: Math.round(p75),
    confidence: durations.length >= 6 ? "high" : durations.length >= 3 ? "medium" : "low",
    phaseMinutes,
    recent: candidates.map((record) => ({ id: record.projectId, summary: record.summary, actualMinutes: record.actualMinutes, completedAt: record.completedAt })),
  };
}
