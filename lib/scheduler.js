const TERMINAL = new Set(["completed", "failed", "blocked", "cancelled"]);
const ACTIVE = new Set(["starting", "running"]);
const WAITING = new Set(["awaiting-review", "awaiting-verification"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeTask(input) {
  const now = Date.now();
  const taskId = String(input.taskId || "").trim();
  if (!taskId) throw new Error("taskId required");
  return {
    taskId,
    childId: input.childId ?? null,
    parentId: String(input.parentId || ""),
    role: input.role ?? "developer",
    module: input.module ?? taskId,
    label: input.label ?? null,
    prompt: input.prompt ?? "",
    cwd: input.cwd ?? null,
    dependsOn: [...new Set(Array.isArray(input.dependsOn) ? input.dependsOn.map(String) : [])],
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
    phase: input.phase ?? (input.role === "qa" ? "qa" : input.role === "release" ? "release" : "development"),
    mode: input.mode ?? "continuable",
    agentPreset: input.agentPreset ?? null,
    projectId: input.projectId ?? null,
    taskType: input.taskType ?? null,
    riskTier: input.riskTier ?? "normal",
    releaseTarget: input.releaseTarget ?? "none",
    directRelease: input.directRelease === true,
    base: input.base ?? null,
    autoReleaseWorktree: input.autoReleaseWorktree !== false,
    worktreeReleased: input.worktreeReleased === true,
    cleanupError: input.cleanupError ?? null,
    cleanupEvidence: input.cleanupEvidence ?? null,
    mergedAt: input.mergedAt ?? null,
    mergeEvidence: input.mergeEvidence ?? null,
    status: input.status ?? "queued",
    attempts: Number.isInteger(input.attempts) ? input.attempts : 0,
    maxAttempts: Number.isInteger(input.maxAttempts) ? Math.max(1, input.maxAttempts) : 1,
    stallTimeoutMinutes: Number.isFinite(Number(input.stallTimeoutMinutes)) ? Math.max(5, Math.min(240, Number(input.stallTimeoutMinutes))) : 45,
    createdAt: input.createdAt ?? now,
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
    stopReason: input.stopReason ?? null,
    error: input.error ?? null,
    merged: input.merged === true,
    verification: input.verification ?? null,
    report: input.report ?? null,
    acceptance: input.acceptance ?? null,
    lastActivityAt: input.lastActivityAt ?? input.startedAt ?? null,
  };
}

export class TaskScheduler {
  constructor(maxParallel = 3) {
    this.maxParallel = Math.max(1, Number(maxParallel) || 3);
    this.tasks = new Map();
    this.childToTask = new Map();
  }

  setMaxParallel(value) {
    const next = Number(value);
    if (Number.isInteger(next) && next > 0) this.maxParallel = next;
  }

  restore(snapshot) {
    this.tasks.clear();
    this.childToTask.clear();
    for (const raw of Array.isArray(snapshot) ? snapshot : []) {
      let task;
      try { task = normalizeTask(raw); } catch { continue; }
      if (!task.parentId) continue;
      this.tasks.set(task.taskId, task);
      if (task.childId) this.childToTask.set(task.childId, task.taskId);
    }
  }

  serialize() {
    return [...this.tasks.values()].map((task) => clone(task));
  }

  get(taskId) {
    return this.tasks.get(String(taskId));
  }

  getByChild(childId) {
    const taskId = this.childToTask.get(String(childId));
    return taskId ? this.tasks.get(taskId) : undefined;
  }

  list(parentId) {
    return [...this.tasks.values()]
      .filter((task) => task.parentId === parentId)
      .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt))
      .map((task) => clone(task));
  }

  dependsOn(taskId, targetId, seen = new Set()) {
    const source = this.tasks.get(String(taskId));
    if (!source) return false;
    if (source.dependsOn.includes(String(targetId))) return true;
    if (seen.has(source.taskId)) return false;
    seen.add(source.taskId);
    return source.dependsOn.some((dependency) => this.dependsOn(dependency, targetId, seen));
  }

  enqueue(input) {
    const task = normalizeTask(input);
    const existing = this.tasks.get(task.taskId);
    if (existing) return { task: clone(existing), created: false };
    for (const dependency of task.dependsOn) {
      if (dependency === task.taskId) throw new Error(`task ${task.taskId} cannot depend on itself`);
      if (this.dependsOn(dependency, task.taskId)) throw new Error(`task ${task.taskId} would create a dependency cycle through ${dependency}`);
    }
    this.tasks.set(task.taskId, task);
    return { task: clone(task), created: true };
  }

  activeCount(parentId) {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.parentId === parentId && ACTIVE.has(task.status)) count += 1;
    }
    return count;
  }

  terminal(taskId) {
    return TERMINAL.has(this.tasks.get(String(taskId))?.status);
  }

  dependencyState(task) {
    const missing = [];
    const blocked = [];
    const pending = [];
    for (const dependencyId of task.dependsOn) {
      const dependency = this.tasks.get(dependencyId);
      if (!dependency) missing.push(dependencyId);
      else if (dependency.status === "failed" || dependency.status === "blocked" || dependency.status === "cancelled") blocked.push(dependencyId);
      else if (!TERMINAL.has(dependency.status)) pending.push(dependencyId);
    }
    return { missing, blocked, pending, ready: missing.length === 0 && blocked.length === 0 && pending.length === 0 };
  }

  nextReady(parentId) {
    return [...this.tasks.values()]
      .filter((task) => task.parentId === parentId && task.status === "queued")
      .filter((task) => this.dependencyState(task).ready)
      .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));
  }

  markBlockedDependents(parentId) {
    const changed = [];
    for (const task of this.tasks.values()) {
      if (task.parentId !== parentId || task.status !== "queued") continue;
      const state = this.dependencyState(task);
      if (state.blocked.length > 0 || state.missing.length > 0) {
        task.status = "blocked";
        task.endedAt = Date.now();
        task.stopReason = state.missing.length > 0 ? "missing-dependency" : "dependency-failed";
        task.error = [...state.missing, ...state.blocked].join(", ");
        changed.push(clone(task));
      }
    }
    return changed;
  }

  start(taskId, childId) {
    const task = this.tasks.get(String(taskId));
    if (!task || task.status !== "queued") return false;
    if (!this.dependencyState(task).ready || this.activeCount(task.parentId) >= this.maxParallel) return false;
    task.status = "starting";
    task.childId = String(childId);
    task.attempts += 1;
    task.startedAt = task.startedAt ?? Date.now();
    task.lastActivityAt = Date.now();
    task.stopReason = null;
    task.error = null;
    task.report = null;
    task.acceptance = null;
    this.childToTask.set(task.childId, task.taskId);
    return true;
  }

  reconcile(parentId, knownChildIds) {
    const known = new Set([...knownChildIds].map(String));
    const changed = [];
    for (const task of this.tasks.values()) {
      if (task.parentId !== parentId || !ACTIVE.has(task.status)) continue;
      if (task.childId && known.has(String(task.childId))) continue;
      if (task.childId) this.childToTask.delete(String(task.childId));
      task.childId = null;
      task.status = "queued";
      task.stopReason = "recovered-after-reload";
      task.error = "previous child is no longer live; task returned to the durable queue";
      changed.push(clone(task));
    }
    return changed;
  }

  bindChild(taskId, childId) {
    const task = this.tasks.get(String(taskId));
    if (!task) return false;
    if (task.childId) this.childToTask.delete(task.childId);
    task.childId = String(childId);
    this.childToTask.set(task.childId, task.taskId);
    task.status = "running";
    task.lastActivityAt = Date.now();
    return true;
  }

  touch(childId, at = Date.now()) {
    const task = this.getByChild(childId);
    if (!task || !ACTIVE.has(task.status)) return false;
    task.lastActivityAt = at;
    return true;
  }

  recordReport(childId, report) {
    const task = this.getByChild(childId);
    if (!task || TERMINAL.has(task.status) || WAITING.has(task.status)) return undefined;
    task.report = clone(report);
    task.lastActivityAt = Date.now();
    return clone(task);
  }

  settleReview(childId, acceptance = {}) {
    const task = this.getByChild(childId);
    if (!task || TERMINAL.has(task.status) || task.status === "awaiting-verification") return undefined;
    const outcome = acceptance.outcome ?? task.report?.outcome ?? "failed";
    task.acceptance = clone(acceptance);
    task.stopReason = acceptance.stopReason ?? outcome;
    task.error = acceptance.error ? String(acceptance.error) : null;
    task.endedAt = Date.now();
    if (outcome === "passed") {
      task.status = task.releaseTarget === "production" ? "awaiting-verification" : "completed";
    } else if (outcome === "blocked") {
      task.status = "blocked";
    } else {
      task.status = "failed";
    }
    return clone(task);
  }

  fail(taskId, error, stopReason = "error") {
    const task = this.tasks.get(String(taskId));
    if (!task) return undefined;
    if (stopReason === "start-failed" && task.attempts < task.maxAttempts) {
      if (task.childId) this.childToTask.delete(task.childId);
      task.childId = null;
      task.status = "queued";
      task.stopReason = stopReason;
      task.error = error ? String(error) : null;
      return clone(task);
    }
    task.status = "failed";
    task.stopReason = stopReason;
    task.error = error ? String(error) : null;
    task.endedAt = Date.now();
    return clone(task);
  }

  markRunning(childId) {
    const task = this.getByChild(childId);
    if (!task) return false;
    if (task.status === "starting") task.status = "running";
    return true;
  }

  finish(childId, stopReason, error) {
    const task = this.getByChild(childId);
    if (!task || TERMINAL.has(task.status) || task.status === "awaiting-verification") return undefined;
    task.status = stopReason === "completed"
      ? task.releaseTarget === "production" ? "awaiting-verification" : "completed"
      : "failed";
    task.stopReason = stopReason ?? null;
    task.error = error ? String(error) : null;
    task.endedAt = Date.now();
    return clone(task);
  }

  cancel(taskId, reason = "cancelled") {
    const task = this.tasks.get(String(taskId));
    if (!task || TERMINAL.has(task.status)) return false;
    task.status = "cancelled";
    task.stopReason = reason;
    task.endedAt = Date.now();
    return true;
  }

  finalize(taskId, fields = {}) {
    const task = this.tasks.get(String(taskId));
    if (!task) return undefined;
    Object.assign(task, fields);
    if (fields.status && TERMINAL.has(fields.status)) task.endedAt = task.endedAt ?? Date.now();
    return clone(task);
  }
}

export { ACTIVE, TERMINAL, WAITING };
