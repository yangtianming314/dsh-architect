/**
 * dsh-architect - AI 架构师编排插件（Host 半）。
 *
 * M3/M4 能力：
 *   - architect settings 命名空间：统一执行模型与并发上限
 *   - arch_dispatch：按内部角色启动 continuable 子代理，并在创建边界应用原生 toolFilter
 *   - arch_status：查看角色、模块、活动状态和并发占用
 *   - architect Typert Remote：设置页的 Host/Client 只读与写入边界
 *   - persistent task ledger：依赖队列、重载恢复、变更记录与交付估时
 *   - agent/request：按角色覆盖 provider/model/reasoningEffort
 *   - isolated Agent creation：任务 cwd 和创造模式 preset 使用真实 session meta
 * 设计约束：
 *   - toolFilter 由 dsh-subagent 在子代理创建和冷恢复时重新应用，既影响提示词又拒绝执行
 *   - 并发限制是调度器硬上限，不要求产品经理在中途确认；达到上限时模型收到可恢复结果
 *   - durable task state is owned by the Architect data file; transient Agent objects are reconciled on reload
 */
import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { TaskScheduler } from "./scheduler.js";
import { ArchitectStateStore, projectEstimate } from "./state.js";

export const name = "architect";
export const inject = ["subagents", "tools", "typert", "settings"];

const SETTINGS_NS = "architect";
const DEFAULT_MAX_PARALLEL = 3;
const MAX_PARALLEL_LIMIT = 32;
const execFileAsync = promisify(execFile);

// 这些名称来自当前 AI 架构师预设与 Host profile 的正式工具表。
// allow 为空时不传 filter，避免 tools.restrict({}) 变成配置错误。
export const ROLE_TOOL_DEFAULTS = {
  developer: ["read", "write", "edit", "grep", "glob", "bash", "wt_status", "wt_diff", "wt_stage", "wt_commit", "todo_write"],
  qa: ["read", "grep", "glob", "bash", "wt_status", "wt_diff", "todo_write"],
  release: ["read", "grep", "glob", "bash", "wt_add_repo", "wt_list", "wt_branches", "wt_status", "wt_diff", "wt_stage", "wt_unstage", "wt_commit", "wt_open", "wt_release", "arch_finalize", "arch_post_release", "todo_write"],
};

const KNOWN_TOOL_NAMES = [
  "read", "write", "edit", "grep", "glob", "bash", "web_search", "skill", "ask_user_question",
  "todo_write", "job_output", "job_list", "job_kill",
  "wt_add_repo", "wt_list", "wt_create", "wt_remove", "wt_release", "wt_branches", "wt_status", "wt_diff", "wt_stage", "wt_unstage", "wt_commit", "wt_open",
  "arch_dispatch", "arch_status", "arch_roles", "arch_project", "arch_estimate", "arch_post_release", "arch_finalize",
];

const DEFAULT_EXECUTION_MODEL = {
  provider: "rmb",
  model: "deepseek-v4-flash",
  reasoningEffort: "high",
};

const DEFAULT_ROLES = {
  developer: {
    ...DEFAULT_EXECUTION_MODEL,
    toolAllow: [...ROLE_TOOL_DEFAULTS.developer],
    toolDeny: [],
  },
  qa: {
    ...DEFAULT_EXECUTION_MODEL,
    toolAllow: [...ROLE_TOOL_DEFAULTS.qa],
    toolDeny: [],
  },
  release: {
    ...DEFAULT_EXECUTION_MODEL,
    toolAllow: [...ROLE_TOOL_DEFAULTS.release],
    toolDeny: [],
  },
};

const ROLE_PERSONAS = {
  developer: "You are the implementation Developer for one assigned module. Work directly in the assigned worktree, implement the complete contract, run focused tests, commit every intended change, and finish with the structured report tool. Do not delegate, coordinate other agents, or stop after analysis/scaffolding unless the task explicitly asks only for research.",
  qa: "You are the independent QA engineer. Do not implement features or delegate. Review the merged behavior against the stated DoD, run the required tests and adversarial checks, and finish with the structured report tool. Report failed when any acceptance item lacks evidence.",
  release: "You are the Release engineer. Do not implement feature code or delegate. Integrate only verified commits, run release checks, preserve rollback evidence, and finish with the structured report tool. Production actions still require the configured human confirmation boundary.",
};

const DEFAULT_SETTINGS = {
  executionModel: { ...DEFAULT_EXECUTION_MODEL },
  maxParallel: DEFAULT_MAX_PARALLEL,
};

// schemastery v3：统一执行模型由 Settings 管理，角色工具权限保持 Host 内部策略。
const EXECUTION_MODEL_SCHEMA = z.object({
  provider: z.string().default("rmb"),
  model: z.string().default("deepseek-v4-flash"),
  reasoningEffort: z.string().default("high"),
});

const ArchSettingsSchema = z.object({
  executionModel: EXECUTION_MODEL_SCHEMA,
  maxParallel: z.number().step(1).min(1).max(MAX_PARALLEL_LIMIT).default(DEFAULT_MAX_PARALLEL),
});

function cloneExecutionModel(source) {
  return {
    provider: source?.provider ?? DEFAULT_EXECUTION_MODEL.provider,
    model: source?.model ?? DEFAULT_EXECUTION_MODEL.model,
    reasoningEffort: source?.reasoningEffort ?? DEFAULT_EXECUTION_MODEL.reasoningEffort,
  };
}

function cloneRole(role, sharedModel) {
  return {
    ...cloneExecutionModel(sharedModel ?? role),
    toolAllow: Array.isArray(role?.toolAllow) ? [...role.toolAllow] : [],
    toolDeny: Array.isArray(role?.toolDeny) ? [...role.toolDeny] : [],
  };
}

function cloneRoles(source) {
  const sharedModel = cloneExecutionModel(source?.developer ?? DEFAULT_EXECUTION_MODEL);
  const out = {};
  for (const key of Object.keys(DEFAULT_ROLES)) out[key] = cloneRole(source?.[key] ?? DEFAULT_ROLES[key], sharedModel);
  return out;
}

function normalizeMaxParallel(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_MAX_PARALLEL;
  return Math.min(n, MAX_PARALLEL_LIMIT);
}

function validateArchitectSettings(value) {
  const model = value?.executionModel;
  if (!model || !model.provider || !model.model || !model.reasoningEffort) {
    throw new Error("architect executionModel must include provider, model and reasoningEffort");
  }
}

/** Convert one role config into the native subagent tool restriction. */
export function buildRoleToolFilter(role) {
  const allow = Array.isArray(role?.toolAllow) ? role.toolAllow.filter((name) => typeof name === "string" && name.length > 0) : [];
  const deny = Array.isArray(role?.toolDeny) ? role.toolDeny.filter((name) => typeof name === "string" && name.length > 0) : [];
  if (allow.length === 0 && deny.length === 0) return undefined;
  return {
    ...(allow.length > 0 ? { allow: [...new Set(allow)] } : {}),
    ...(deny.length > 0 ? { deny: [...new Set(deny)] } : {}),
  };
}

export function selectTaskExecution(args = {}) {
  const mode = args.mode ?? (args.taskType === "plugin" ? "create" : "continuable");
  return { mode, agentPreset: args.agentPreset || (mode === "create" ? "cordis" : "standard") };
}

export function isDelegatedAgent(agent) {
  const header = agent?.session?.header ?? {};
  return header.origin === "subagent" || Number(header.delegationDepth || 0) > 0;
}

export function evaluatePresetRoster(roster, presetId) {
  const entries = Array.isArray(roster) ? roster : [];
  const available = entries.filter((entry) => !entry?.broken).map((entry) => entry.id);
  const match = entries.find((entry) => entry.id === presetId);
  if (!match) return { ok: false, status: "invalid-preset", presetId, available, message: `unknown agent preset ${presetId}` };
  if (match.broken) return { ok: false, status: "invalid-preset", presetId, available, message: `agent preset ${presetId} is broken: ${match.broken}` };
  return { ok: true, presetId, available };
}

export function taskRequiresCommit(task) {
  return task.role === "developer" && task.phase === "development" && task.taskType !== "research";
}

async function gitOutput(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return String(stdout).trim();
}

export async function validateTaskReport(task, report) {
  if (!report) return { outcome: "failed", stopReason: "missing-report", error: "child became idle without a structured report" };
  if (report.outcome !== "passed") {
    return { outcome: report.outcome, stopReason: `reported-${report.outcome}`, error: report.summary || `task reported ${report.outcome}`, report };
  }
  const evidence = Array.isArray(report.evidence) ? report.evidence.filter(Boolean) : [];
  const tests = Array.isArray(report.tests) ? report.tests.filter(Boolean) : [];
  if (!String(report.summary || "").trim()) return { outcome: "failed", stopReason: "acceptance-failed", error: "report summary is required", report };
  if (evidence.length === 0) return { outcome: "failed", stopReason: "acceptance-failed", error: "at least one acceptance evidence item is required", report };
  if (tests.length === 0) return { outcome: "failed", stopReason: "acceptance-failed", error: "at least one executed test or verification command is required", report };
  if (taskRequiresCommit(task)) {
    if (!task.cwd) return { outcome: "failed", stopReason: "acceptance-failed", error: "development completion requires an isolated worktree", report };
    if (!String(report.commit || "").trim()) return { outcome: "failed", stopReason: "acceptance-failed", error: "development completion requires a commit hash", report };
    try {
      const [head, status] = await Promise.all([
        gitOutput(task.cwd, ["rev-parse", "HEAD"]),
        gitOutput(task.cwd, ["status", "--porcelain"]),
      ]);
      if (status) return { outcome: "failed", stopReason: "acceptance-failed", error: "worktree is not clean after the reported commit", report, head };
      if (!head.startsWith(String(report.commit).trim())) return { outcome: "failed", stopReason: "acceptance-failed", error: `reported commit ${report.commit} is not worktree HEAD ${head}`, report, head };
      if (task.base) {
        const baseHead = await gitOutput(task.cwd, ["rev-parse", task.base]);
        if (head === baseHead) return { outcome: "failed", stopReason: "acceptance-failed", error: `development task produced no commit beyond ${task.base}`, report, head };
      }
      return { outcome: "passed", stopReason: "accepted", report, head, evidence, tests };
    } catch (error) {
      return { outcome: "failed", stopReason: "acceptance-failed", error: `git acceptance check failed: ${error?.message ?? error}`, report };
    }
  }
  return { outcome: "passed", stopReason: "accepted", report, evidence, tests };
}

/** Move pending report messages to the native next-step inbox. */
export function movePendingSubagentReports(agent) {
  const inbox = agent?.inbox;
  if (!inbox || !Array.isArray(inbox.nextTurn) || typeof inbox.remove !== "function" || typeof agent.inject !== "function") return 0;
  let moved = 0;
  for (const message of [...inbox.nextTurn]) {
    if (message?.source?.kind !== "subagent-report") continue;
    if (!inbox.remove(message.id)) continue;
    agent.inject(message);
    moved += 1;
  }
  return moved;
}

/**
 * Resume a parent after a subagent report was inserted.
 * Reports are moved from a queued next turn to the native next-step inbox;
 * active parents consume them at the next step and idle parents are woken.
 */
export function wakeIdleParentForSubagentReport(info) {
  const agent = info?.agent;
  if (info?.message?.source?.kind !== "subagent-report") return false;
  const moved = movePendingSubagentReports(agent);
  if (!agent || agent.status !== "idle" || typeof agent.wakeDriver !== "function") return moved > 0;
  try {
    agent.wakeDriver();
    return true;
  } catch {
    return moved > 0;
  }
}

/**
 * Small per-parent ledger used by dispatch, status and tests.
 * It deliberately retains settled rows so the final delivery summary remains visible.
 */
export class DispatchLedger {
  constructor(maxParallel = DEFAULT_MAX_PARALLEL) {
    this.maxParallel = normalizeMaxParallel(maxParallel);
    this.entries = new Map();
    this.reservations = new Map();
    this.nextReservationId = 1;
  }

  setMaxParallel(value) {
    this.maxParallel = normalizeMaxParallel(value);
  }

  activeCount(parentId) {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.parentId === parentId && (entry.status === "starting" || entry.status === "running")) count += 1;
    }
    for (const reservation of this.reservations.values()) if (reservation.parentId === parentId) count += 1;
    return count;
  }

  canStart(parentId) {
    return this.activeCount(parentId) < this.maxParallel;
  }

  reserve(parentId) {
    if (!this.canStart(parentId)) return null;
    const id = `reservation-${this.nextReservationId++}`;
    this.reservations.set(id, { parentId });
    return id;
  }

  release(parentId, reservationId) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.parentId !== parentId) return false;
    this.reservations.delete(reservationId);
    return true;
  }

  recordAccepted(parentId, entry) {
    this.entries.set(entry.childId, {
      parentId,
      childId: entry.childId,
      role: entry.role,
      module: entry.module,
      label: entry.label ?? null,
      cwd: entry.cwd ?? null,
      status: "running",
      stopReason: null,
      startedAt: entry.startedAt ?? Date.now(),
      endedAt: null,
    });
    return true;
  }

  commit(parentId, reservationId, entry) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.parentId !== parentId) return false;
    this.reservations.delete(reservationId);
    return this.recordAccepted(parentId, entry);
  }

  start(parentId, entry) {
    if (!this.canStart(parentId)) return false;
    return this.recordAccepted(parentId, entry);
  }

  finish(childId, stopReason) {
    const entry = this.entries.get(childId);
    if (!entry) return;
    entry.status = stopReason === "completed" ? "completed" : "failed";
    entry.stopReason = stopReason ?? null;
    entry.endedAt = Date.now();
  }

  get(childId) {
    return this.entries.get(childId);
  }

  list(parentId) {
    return [...this.entries.values()]
      .filter((entry) => entry.parentId === parentId)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((entry) => ({ ...entry }));
  }
}

function cleanRole(role) {
  const value = cloneRole(role);
  return {
    provider: value.provider || null,
    model: value.model || null,
    reasoningEffort: value.reasoningEffort || null,
    toolAllow: value.toolAllow,
    toolDeny: value.toolDeny,
  };
}

function cleanRoles(roles) {
  const out = {};
  for (const key of Object.keys(DEFAULT_ROLES)) out[key] = cleanRole(roles[key]);
  return out;
}

function settingPathAllowed(path) {
  if (!Array.isArray(path) || path.length === 0 || path.some((part) => typeof part !== "string")) return false;
  if (path.length === 1) return path[0] === "maxParallel";
  return path.length === 2 && path[0] === "executionModel" &&
    ["provider", "model", "reasoningEffort"].includes(path[1]);
}

const codec = (symbol) => ({ mode: "strict", typeSymbol: symbol, schema: { parse: (value) => value } });

const MANIFEST = {
  package: "dsh-architect",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-architect#architect/settings",
      service: "architect",
      namespace: "architect",
      method: "settings",
      invocation: { kind: "direct" },
      parameters: [],
      result: codec("dsh-architect#ArchitectSettingsResult"),
    },
    {
      id: "dsh-architect#architect/catalog",
      service: "architect",
      namespace: "architect",
      method: "catalog",
      invocation: { kind: "direct" },
      parameters: [{ name: "sessionId", wire: "sessionId", source: "json", codec: codec("dsh-architect#SessionId") }],
      result: codec("dsh-architect#ArchitectCatalogResult"),
    },
    {
      id: "dsh-architect#architect/mutateSettings",
      service: "architect",
      namespace: "architect",
      method: "mutateSettings",
      invocation: { kind: "direct" },
      parameters: [
        { name: "ops", wire: "ops", source: "json", codec: codec("dsh-architect#SettingsOperations") },
        { name: "expectedRevision", wire: "expectedRevision", source: "json", codec: codec("dsh-architect#SettingsRevision") },
      ],
      result: codec("dsh-architect#ArchitectSettingsResult"),
    },
  ],
  model: { services: [], events: [], objects: [] },
};

class ArchitectGateway extends TypertRemoteService {
  constructor(ctx, handlers) {
    super(ctx, "architect");
    this.handlers = handlers;
  }

  settings() {
    return this.handlers.settings();
  }

  catalog(sessionId) {
    return this.handlers.catalog(sessionId);
  }

  mutateSettings(ops, expectedRevision) {
    return this.handlers.mutateSettings(ops, expectedRevision);
  }
}

export function apply(ctx) {
  const roles = cloneRoles(DEFAULT_ROLES);
  const scheduler = new TaskScheduler(DEFAULT_MAX_PARALLEL);
  const stateStore = new ArchitectStateStore();
  const settings = ctx.settings;
  const llm = ctx.get("llm");
  const agents = ctx.get("agents");
  const agentLoop = ctx.get("agentLoop");
  const userQuestions = ctx.get("userQuestions");
  const scheduleLocks = new Map();
  let projectState = { projects: [], history: [], changes: [] };
  let maxParallel = DEFAULT_MAX_PARALLEL;
  const autonomous = true;
  const stateReady = stateStore.ready.then((snapshot) => {
    scheduler.restore(snapshot.tasks);
    projectState = {
      projects: Array.isArray(snapshot.projects) ? snapshot.projects : [],
      history: Array.isArray(snapshot.history) ? snapshot.history : [],
      changes: Array.isArray(snapshot.changes) ? snapshot.changes : [],
    };
  });

  let persistChain = Promise.resolve();
  let stallTimer = null;
  let disposed = false;

  function persistState() {
    if (disposed) return Promise.resolve();
    const next = persistChain.catch(() => {}).then(async () => {
      await stateReady;
      if (disposed) return;
      const snapshot = stateStore.snapshot();
      snapshot.tasks = scheduler.serialize();
      snapshot.projects = projectState.projects;
      snapshot.history = projectState.history;
      snapshot.changes = projectState.changes;
      await stateStore.replace(snapshot);
    });
    persistChain = next;
    return next;
  }

  function activeTaskDeadline(task) {
    const activity = Number(task.lastActivityAt ?? task.startedAt ?? Date.now());
    return activity + Number(task.stallTimeoutMinutes || 45) * 60_000;
  }

  function armStallTimer() {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    if (disposed) return;
    const active = scheduler.serialize().filter((task) => task.status === "starting" || task.status === "running");
    if (active.length === 0) return;
    const deadline = Math.min(...active.map(activeTaskDeadline));
    const delay = Math.max(1, Math.min(2_147_000_000, deadline - Date.now()));
    stallTimer = setTimeout(() => {
      stallTimer = null;
      processStalledTasks().catch((error) => console.error("arch:stall", error));
    }, delay);
    stallTimer.unref?.();
  }

  async function processStalledTasks() {
    if (disposed) return;
    const now = Date.now();
    const stale = scheduler.serialize().filter((task) => (task.status === "starting" || task.status === "running") && activeTaskDeadline(task) <= now);
    for (const task of stale) {
      const child = task.childId ? agents?.get(task.childId) : undefined;
      try { child?.cancel?.({ kind: "hook", reason: "architect-task-stalled" }); } catch {}
      const finished = scheduler.settleReview(task.childId, {
        outcome: "failed",
        stopReason: "stalled",
        error: `no Agent/session activity for ${task.stallTimeoutMinutes || 45} minutes`,
      });
      if (!finished) continue;
      await completeTaskLifecycle(finished);
      const parent = agents?.get(finished.parentId);
      if (parent) {
        parent.followup(createUserMessage({
          content: [{ type: "text", text: `Architect task ${finished.taskId} failed as stalled after ${finished.stallTimeoutMinutes || 45} minutes without activity.` }],
          source: { kind: "subagent-report", form: "relay", senderSessionId: task.childId },
        }));
      }
    }
    armStallTimer();
  }

  ctx.effect(() => () => {
    disposed = true;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  }, "architect:stall-timer");

  function syncSettings(value) {
    if (!value || typeof value !== "object") return;
    // Accept the old developer role as a one-time migration source, but keep one shared model thereafter.
    const persistedModel = value.executionModel ?? value.roles?.developer ?? DEFAULT_EXECUTION_MODEL;
    const sharedModel = cloneExecutionModel(persistedModel);
    for (const key of Object.keys(DEFAULT_ROLES)) Object.assign(roles[key], sharedModel);
    maxParallel = normalizeMaxParallel(value.maxParallel);
    scheduler.setMaxParallel(maxParallel);
  }

  let settingsScope;
  if (settings !== undefined) {
    settingsScope = settings.register(settingsNamespace(SETTINGS_NS), ArchSettingsSchema, {
      base: {
        executionModel: { ...DEFAULT_EXECUTION_MODEL },
        maxParallel: DEFAULT_MAX_PARALLEL,
      },
      validate: validateArchitectSettings,
    });
    syncSettings(settingsScope.get());
    ctx.effect(() => settingsScope.watch((next) => syncSettings(next)), "architect:settings-watch");
  } else {
    syncSettings(DEFAULT_SETTINGS);
  }

  function settingsRevision() {
    if (settings === undefined) return 0;
    const descriptor = settings.describe({ redactSecrets: true }).find((entry) => String(entry.ns) === SETTINGS_NS);
    return descriptor?.revision ?? 0;
  }

  function settingsSnapshot() {
    return {
      revision: settingsRevision(),
      writable: settings?.writable === true,
      settings: {
        executionModel: cloneExecutionModel(roles.developer),
        maxParallel,
      },
      defaults: {
        executionModel: { ...DEFAULT_EXECUTION_MODEL },
        maxParallel: DEFAULT_MAX_PARALLEL,
      },
    };
  }

  function visibleToolNames(agent) {
    const names = new Set(KNOWN_TOOL_NAMES);
    try {
      for (const schema of ctx.tools.schemas(agent)) if (schema && typeof schema.name === "string") names.add(schema.name);
    } catch {
      // The catalog remains useful while a session is between creation/disposal.
    }
    return [...names].sort();
  }

  async function validateAgentPreset(agent, presetId) {
    const presets = agent?.ctx?.get("agentPresets") ?? ctx.get("agentPresets");
    if (!presets || typeof presets.list !== "function") {
      return { ok: false, status: "preset-catalog-unavailable", message: "agent preset roster is unavailable" };
    }
    try {
      return evaluatePresetRoster(await presets.list(), presetId);
    } catch (error) {
      return { ok: false, status: "preset-catalog-error", presetId, message: String(error?.message ?? error) };
    }
  }

  async function modelCatalog() {
    const providers = [];
    if (llm !== undefined) {
      let listed = [];
      try { listed = llm.listProviders(); } catch { listed = []; }
      for (const provider of listed) {
        const providerId = provider?.id;
        if (typeof providerId !== "string") continue;
        let models = [];
        try { models = await llm.listModels(providerId); } catch { models = []; }
        const cleanModels = [];
        for (const model of models ?? []) {
          if (!model || typeof model.id !== "string") continue;
          let resolved;
          try { resolved = await llm.resolveModelInfo(providerId, model.id); } catch { resolved = undefined; }
          const efforts = Array.isArray(resolved?.reasoning?.efforts)
            ? resolved.reasoning.efforts.map((effort) => ({ id: String(effort.id), name: String(effort.name ?? effort.id) }))
            : [];
          cleanModels.push({
            id: model.id,
            name: model.name ?? model.id,
            description: model.description ?? null,
            efforts,
            defaultEffort: resolved?.reasoning?.defaultEffort ?? null,
          });
        }
        providers.push({ id: providerId, name: provider?.name ?? providerId, models: cleanModels });
      }
    }
    return { providers, tools: visibleToolNames(undefined) };
  }

  const gateway = new ArchitectGateway(ctx, {
    settings: () => settingsSnapshot(),
    catalog: async (sessionId) => {
      const agent = agents && typeof sessionId === "string" ? agents.get(sessionId) : undefined;
      const catalog = await modelCatalog();
      return { ...catalog, tools: visibleToolNames(agent) };
    },
    mutateSettings: async (ops, expectedRevision) => {
      if (settings === undefined || settingsScope === undefined) return { ok: false, error: "architect settings unavailable" };
      if (!settings.writable) return { ok: false, error: "settings provider is read-only" };
      const operations = Array.isArray(ops) ? ops : [];
      for (const operation of operations) {
        if (!settingPathAllowed(operation?.path)) return { ok: false, error: "settings path is not editable" };
        if (operation.op !== "set" && operation.op !== "unset") return { ok: false, error: "settings operation must be set or unset" };
      }
      try {
        await settings.mutate(SETTINGS_NS, operations, Number.isInteger(expectedRevision) ? expectedRevision : undefined);
        return { ok: true, ...settingsSnapshot() };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error), ...settingsSnapshot() };
      }
    },
  });
  ctx.effect(() => ctx.typert.register(MANIFEST), "architect: typert manifest");

  async function settleIsolatedTask(parent, childId) {
    if (disposed) return;
    const task = scheduler.getByChild(childId);
    if (!task) return;
    const acceptance = await validateTaskReport(task, task.report);
    const finished = scheduler.settleReview(childId, acceptance);
    if (!finished) return;
    await completeTaskLifecycle(finished);
    const message = createUserMessage({
      content: [{ type: "text", text: `Architect task ${finished.taskId} settled as ${finished.status}: ${acceptance.error || acceptance.report?.summary || acceptance.stopReason}` }],
      source: { kind: "subagent-report", form: "relay", senderSessionId: childId },
    });
    parent.followup(message);
  }

  function installIsolatedReport(childCtx, childId) {
    let hasReport = false;
    try { hasReport = childCtx.tools.schemas(childCtx.agent).some((schema) => schema?.name === "report"); } catch {}
    if (hasReport) return;
    childCtx.systemPrompt?.section({
      name: "architect:isolated-report",
      order: 117,
      text: "Call report exactly once as your final action. A passed report requires a concise summary, the exact commit for development work, executed tests, and concrete evidence. Becoming idle without this report fails the task.",
    });
    childCtx.tools.register(defineTool({
      name: "report",
      description: "Submit the structured final delivery report for Architect acceptance.",
      parameters: {
        outcome: { type: "string", required: true, enum: ["passed", "failed", "blocked"] },
        summary: { type: "string", required: true },
        commit: { type: "string" },
        tests: { type: "array", required: true, items: { type: "string" } },
        evidence: { type: "array", required: true, items: { type: "string" } },
        rollback: { type: "string" },
      },
      output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
      async execute(args) {
        const recorded = scheduler.recordReport(childId, args);
        if (!recorded) return { accepted: false, status: "task-not-running" };
        await persistState();
        return { accepted: true, taskId: recorded.taskId, status: "report-recorded" };
      },
    }));
  }

  async function startIsolatedTask(task, parent, signal) {
    if (disposed) throw new Error("architect scheduler generation is disposed");
    if (!agentLoop || typeof agentLoop.createAgent !== "function") throw new Error("agentLoop.createAgent is required for cwd/preset-isolated tasks");
    const childId = randomUUID();
    scheduler.bindChild(task.taskId, childId);
    const parentHeader = parent.session?.header ?? {};
    const requestedPreset = task.agentPreset || "standard";
    const parentDepth = Number(parentHeader.delegationDepth) || 0;
    const conf = roles[task.role] ?? {};
    const filter = buildRoleToolFilter(conf);
    const agentOptions = {
      ...(conf.provider ? { provider: conf.provider } : {}),
      ...(conf.model ? { model: conf.model } : {}),
      subagentDepth: parentDepth + 1,
    };
    const handle = await agentLoop.createAgent(ctx, {
      sessionId: childId,
      meta: {
        ...(task.cwd ? { cwd: task.cwd } : parentHeader.cwd ? { cwd: parentHeader.cwd } : {}),
        ...(requestedPreset ? { agentPreset: requestedPreset } : {}),
        parentSession: parent.id,
        origin: "subagent",
        delegationDepth: parentDepth + 1,
      },
      agentOptions,
      signal,
      setup: async (childCtx) => {
        const presets = childCtx.get("agentPresets");
        if (!presets || typeof presets.mount !== "function") throw new Error("agentPresets.mount is unavailable for isolated child preset");
        await presets.mount(childCtx, requestedPreset);
        childCtx.systemPrompt?.context({
          name: "architect:delegation",
          order: 120,
          text: `${ROLE_PERSONAS[task.role] || ROLE_PERSONAS.developer}\nAssigned taskId=${task.taskId}, role=${task.role}, module=${task.module}, worktree=${task.cwd || "none"}. Stay inside this contract and do not create child agents.`,
        });
        installIsolatedReport(childCtx, childId);
        if (filter) childCtx.tools.restrict(filter);
      },
    });
    const child = handle.agent;
    child.followup(createUserMessage({ content: [{ type: "text", text: task.prompt }], source: { kind: "user" } }));
    child.whenIdle().then(() => settleIsolatedTask(parent, childId)).catch(async (error) => {
      const finished = scheduler.settleReview(childId, { outcome: "failed", stopReason: "agent-error", error: error?.message ?? error });
      if (finished) await completeTaskLifecycle(finished);
    });
    return { childId, messageId: null, isolated: true };
  }

  async function startTask(task, parent, signal) {
    if (disposed) return null;
    const startSignal = signal ?? new AbortController().signal;
    const conf = roles[task.role];
    const filter = buildRoleToolFilter(conf);
    const agentOptions = {};
    if (conf?.provider) agentOptions.provider = conf.provider;
    if (conf?.model) agentOptions.model = conf.model;
    const worktreeNotice = task.cwd
      ? `\n\nWorktree contract: work only in ${task.cwd}. Use absolute paths or pass this directory as every command workdir; do not modify the parent checkout.`
      : "";
    const presetNotice = task.agentPreset ? `\n\nRequested child preset: ${task.agentPreset}.` : "";
    const reservationId = `pending:${task.taskId}:${task.attempts + 1}`;
    if (!scheduler.start(task.taskId, reservationId)) return null;
    if (task.cwd || task.agentPreset) {
      await persistState();
      try {
        const isolated = await startIsolatedTask(task, parent, startSignal);
        await persistState();
        armStallTimer();
        return isolated;
      } catch (error) {
        scheduler.fail(task.taskId, error?.message ?? error, "start-failed");
        await persistState();
        throw error;
      }
    }
    await persistState();
    try {
      const start = await ctx.subagents.startContinuable({
        provider: "spawn",
        label: task.label || `[${task.role}] ${task.module}`,
        request: {
          parent,
          prompt: [{ type: "text", text: `${task.prompt}${worktreeNotice}${presetNotice}` }],
          ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
          ...(filter ? { toolFilter: filter } : {}),
          // Native continuable backends currently inherit the parent session cwd;
          // the scheduler records and validates this contract until a backend with
          // per-child cwd metadata is selected.
          ...(task.cwd ? { cwd: task.cwd } : {}),
          ...(task.agentPreset ? { agentPreset: task.agentPreset } : {}),
        },
        signal: startSignal,
      });
      scheduler.bindChild(task.taskId, start.childId);
      await persistState();
      armStallTimer();
      return start;
    } catch (error) {
      scheduler.fail(task.taskId, error?.message ?? error, "start-failed");
      await persistState();
      throw error;
    }
  }

  async function drainParent(parentId, signal) {
    if (disposed) return { started: [], blocked: [] };
    await stateReady;
    if (disposed) return { started: [], blocked: [] };
    const parent = agents?.get(parentId);
    if (!parent) return { started: [], blocked: [] };
    const blocked = scheduler.markBlockedDependents(parentId);
    if (blocked.length > 0) await persistState();
    const started = [];
    while (!disposed && scheduler.activeCount(parentId) < maxParallel) {
      const task = scheduler.nextReady(parentId)[0];
      if (!task) break;
      try {
        const start = await startTask(task, parent, signal);
        if (!start) break;
        started.push({ taskId: task.taskId, childId: start.childId, messageId: start.messageId });
      } catch (error) {
        console.error(`arch:task/start-failed task=${task.taskId}`, error);
      }
    }
    return { started, blocked };
  }

  function scheduleParent(parentId, signal) {
    if (disposed) return Promise.resolve({ started: [], blocked: [] });
    const previous = scheduleLocks.get(parentId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => drainParent(parentId, signal));
    scheduleLocks.set(parentId, next);
    next.finally(() => {
      if (scheduleLocks.get(parentId) === next) scheduleLocks.delete(parentId);
    }).catch(() => {});
    return next;
  }

  async function recoverParent(parentId) {
    if (disposed) return { started: [], blocked: [] };
    await stateReady;
    if (disposed) return { started: [], blocked: [] };
    const live = agents?.list?.() ?? [];
    const known = new Set(live.map((agent) => agent.id));
    for (const agent of live) scheduler.touch(agent.id);
    try {
      const children = await ctx.subagents.listChildren(parentId);
      for (const child of children || []) if (child?.id) known.add(child.id);
    } catch {
      // A parent can be restored before its child catalog is available; live agents remain authoritative.
    }
    const changed = scheduler.reconcile(parentId, known);
    if (changed.length > 0) await persistState();
    armStallTimer();
    return scheduleParent(parentId);
  }

  // ── routing and lifecycle ──────────────────────────────────────────────────
  ctx.on("agent/request", async (payload, next) => {
    const base = await next();
    const entry = scheduler.getByChild(payload.agent.id);
    if (!entry) return base;
    const conf = roles[entry.role];
    if (!conf) return base;
    const out = { ...base };
    let changed = false;
    if (conf.model && out.model !== conf.model) { out.model = conf.model; changed = true; }
    if (conf.provider && out.provider !== conf.provider) { out.provider = conf.provider; changed = true; }
    if (conf.reasoningEffort && out.reasoningEffort !== conf.reasoningEffort) { out.reasoningEffort = conf.reasoningEffort; changed = true; }
    if (changed) console.log(`arch:route ${entry.module}(${entry.role}) -> provider=${out.provider} model=${out.model} effort=${out.reasoningEffort}`);
    return changed ? out : base;
  });

  ctx.on("subagent/start", (info) => {
    scheduler.markRunning(info.id);
    persistState().catch((error) => console.error("arch:state/persist-start", error));
    console.log(`arch:subagent/start id=${info.id} provider=${info.provider}`);
  });
  ctx.on("subagent/end", (info) => {
    const entry = scheduler.getByChild(info.id);
    const finished = info.stopReason === "completed"
      ? scheduler.settleReview(info.id, { outcome: "failed", stopReason: "missing-structured-report", error: "legacy child ended without Architect acceptance evidence" })
      : scheduler.finish(info.id, info.stopReason);
    if (entry && finished) completeTaskLifecycle(finished).catch((error) => console.error("arch:schedule", error));
    console.log(`arch:subagent/end id=${info.id} stop=${info.stopReason}`);
  });
  ctx.on("agent/status", ({ agent }) => {
    if (scheduler.touch(agent.id)) armStallTimer();
  });
  ctx.on("session/event", (session) => {
    if (scheduler.touch(session.id)) armStallTimer();
  });
  // `tool-subagent-report` may have inserted a next-turn message before this
  // plugin was hot-reloaded. Move those reports first so the current session
  // receives the same dynamic-injection behavior as new sessions.
  ctx.on("agent/inbox/inserted", wakeIdleParentForSubagentReport);
  const liveAgents = ctx.get("agents");
  if (liveAgents && typeof liveAgents.list === "function") {
    for (const agent of liveAgents.list()) {
      const moved = movePendingSubagentReports(agent);
      if (moved > 0 && agent.status === "idle" && typeof agent.wakeDriver === "function") agent.wakeDriver();
    }
  }
  stateReady.then(() => {
    const parents = new Set(scheduler.serialize().map((task) => task.parentId));
    for (const parentId of parents) recoverParent(parentId).catch((error) => console.error("arch:state/recover", error));
  }).catch((error) => console.error("arch:state/load", error));
  ctx.on("agent/created", ({ agent }) => {
    recoverParent(agent.id).catch((error) => console.error("arch:agent/recover", error));
  });

  function findProject(projectId) {
    return projectState.projects.find((project) => project.projectId === projectId);
  }

  function taskPhaseMinutes(parentId, projectId) {
    const totals = {};
    for (const task of scheduler.list(parentId).filter((entry) => entry.projectId === projectId && taskDuration(entry) > 0)) {
      totals[task.phase] = (totals[task.phase] ?? 0) + taskDuration(task);
    }
    return Object.fromEntries(Object.entries(totals).map(([phase, minutes]) => [phase, Math.round(minutes)]));
  }

  function taskDuration(task) {
    if (!task.startedAt) return 0;
    const end = task.endedAt ?? Date.now();
    return Math.max(0, (end - task.startedAt) / 60000);
  }

  async function validateTaskCwd(cwd) {
    if (!cwd) return null;
    const value = String(cwd);
    if (!value.startsWith("/") || value === "/") return "cwd must be a non-root absolute path";
    try {
      const directory = await stat(value);
      if (!directory.isDirectory()) return "cwd is not a directory";
      await access(value);
      const gitMarker = await stat(join(value, ".git"));
      if (!gitMarker.isFile() && !gitMarker.isDirectory()) return "cwd is not a Git worktree";
      return null;
    } catch (error) {
      return `cwd is not an enterable Git worktree: ${String(error?.message ?? error)}`;
    }
  }

  function changeRequiresHuman(kind, riskTier, directRelease) {
    if (kind === "internal-fix" && riskTier === "low") return false;
    if (kind === "production-release" && riskTier === "low" && directRelease === true) return false;
    return true;
  }

  async function requestChangeDecision(parent, details, signal) {
    await stateReady;
    const requestId = details.requestId || `change-${randomUUID()}`;
    const existing = projectState.changes.find((change) => change.requestId === requestId);
    if (existing?.decision === "approved" || existing?.decision === "rejected") return existing;
    const record = {
      requestId,
      parentId: parent.id,
      kind: details.kind,
      riskTier: details.riskTier ?? "normal",
      summary: details.summary,
      impact: details.impact ?? null,
      proposedAction: details.proposedAction ?? null,
      requestedAt: existing?.requestedAt ?? Date.now(),
      decision: "awaiting-human",
    };
    if (!changeRequiresHuman(record.kind, record.riskTier, details.directRelease)) {
      record.decision = "approved";
      record.decisionSource = "policy:auto-low-risk";
      projectState.changes = [...projectState.changes.filter((change) => change.requestId !== requestId), record];
      await persistState();
      return record;
    }
    if (!userQuestions || typeof userQuestions.ask !== "function") {
      projectState.changes = [...projectState.changes.filter((change) => change.requestId !== requestId), record];
      await persistState();
      return record;
    }
    const answer = await userQuestions.ask({
      agent: parent,
      signal,
      questions: [{
        id: "decision",
        header: "交付变更确认",
        question: `是否批准：${record.summary}`,
        detail: `${record.impact || "未提供影响说明"}${record.proposedAction ? `\n\n拟执行：${record.proposedAction}` : ""}`,
        options: [{ label: "批准执行" }, { label: "拒绝并暂停" }],
      }],
    });
    const item = answer?.answers?.find((entry) => entry.id === "decision");
    record.decision = item?.selected?.includes("批准执行") ? "approved" : "rejected";
    record.decisionSource = "human";
    record.decidedAt = Date.now();
    projectState.changes = [...projectState.changes.filter((change) => change.requestId !== requestId), record];
    await persistState();
    return record;
  }

  async function ensureReleaseApproval(parent, details, signal) {
    if (details.releaseTarget !== "production") return { approved: true, decision: "not-required", requestId: null };
    const taskId = String(details.taskId || `${details.module || "release"}-${randomUUID()}`);
    return requestChangeDecision(parent, {
      requestId: details.requestId || `release:${taskId}`,
      kind: "production-release",
      riskTier: details.riskTier ?? "normal",
      summary: details.summary || details.prompt || `生产发布任务 ${taskId}`,
      impact: details.impact || `目标：${details.module || "未指定模块"}`,
      proposedAction: details.proposedAction || details.prompt || "执行生产发布，并在发布后完成线上回归。",
      directRelease: details.directRelease === true,
    }, signal);
  }

  async function executeNestedTool(name, args, exec) {
    if (!ctx.tools || typeof ctx.tools.execute !== "function") throw new Error(`nested tool runtime unavailable: ${name}`);
    const signal = exec.signal ?? new AbortController().signal;
    const result = await ctx.tools.execute({
      callId: `${exec.callId || "arch"}:${name}:${randomUUID()}`,
      name,
      arguments: args,
      agent: exec.agent,
      signal,
    });
    if (result?.isError) throw new Error(result.error?.message || `${name} failed`);
    return result?.value;
  }

  async function completeTaskLifecycle(finished) {
    if (disposed || !finished) return;
    if (finished.status === "completed" && finished.role === "release" && finished.autoReleaseWorktree && finished.cwd && finished.base && finished.worktreeReleased !== true) {
      const parent = agents?.get(finished.parentId);
      if (parent) {
        try {
          const release = await executeNestedTool("wt_release", { path: finished.cwd, base: finished.base, deleteBranch: true }, { agent: parent, callId: `arch:auto-release:${finished.taskId}` });
          if (release?.ok) scheduler.finalize(finished.taskId, { merged: true, mergedAt: Date.now(), worktreeReleased: true, cleanupError: null, cleanupEvidence: release });
          else scheduler.finalize(finished.taskId, { worktreeReleased: false, cleanupError: release?.error || "wt_release returned failure" });
        } catch (error) {
          scheduler.finalize(finished.taskId, { worktreeReleased: false, cleanupError: String(error?.message ?? error) });
        }
      }
    }
    await persistState();
    armStallTimer();
    scheduleParent(finished.parentId).catch((error) => console.error("arch:task/lifecycle", error));
  }

  ctx.tools.register(defineTool({
    name: "arch_dispatch",
    description: "将一个受角色权限约束的任务加入自动调度队列。依赖未完成或并发已满时保持 queued；依赖完成、容量释放后由事件自动启动，不要轮询 Git 或重复派发。",
    parameters: {
      taskId: { type: "string", description: "稳定任务 ID；用于依赖、恢复和幂等重试" },
      projectId: { type: "string", description: "所属项目 ID，用于交付历史和估时" },
      taskType: { type: "string", enum: ["feature", "research", "bugfix", "plugin", "maintenance", "release"], description: "项目/任务类型" },
      module: { type: "string", required: true, description: "模块标识，如 core / cli" },
      role: { type: "string", required: true, enum: ["developer", "qa", "release"], description: "角色：developer / qa / release" },
      label: { type: "string", description: "子代理显示标签，默认 [role] module" },
      prompt: { type: "string", required: true, description: "完整任务说明，包含接口契约、DoD、验证方式和回滚条件" },
      cwd: { type: "string", description: "目标 worktree 绝对路径；任务会记录并强制要求子代理使用该目录" },
      base: { type: "string", description: "合并和 worktree release 的目标分支" },
      dependsOn: { type: "array", items: { type: "string" }, description: "前置 taskId；全部完成后才自动启动" },
      priority: { type: "integer", description: "同一就绪队列中的优先级，数值越大越先执行" },
      phase: { type: "string", enum: ["analysis", "development", "integration", "qa", "release"], description: "交付阶段，用于历史耗时拆分" },
      mode: { type: "string", enum: ["continuable", "create"], description: "continuable 为普通连续子代理；create 为插件开发场景的创造模式子代理" },
      agentPreset: { type: "string", description: "子代理 preset 的精确 ID；插件创造模式使用 cordis，普通角色默认 standard" },
      riskTier: { type: "string", enum: ["low", "normal", "high"], description: "风险等级；production release 默认要求真人确认" },
      releaseTarget: { type: "string", enum: ["none", "staging", "production"], description: "发布目标" },
      directRelease: { type: "boolean", description: "仅 low-risk production 且明确指定时跳过真人确认" },
      maxAttempts: { type: "integer", description: "启动失败时的最大尝试次数，默认 1" },
      stallTimeoutMinutes: { type: "number", description: "完全无 Agent/session 活动后判定停滞的分钟数，5-240，默认 45" },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error("arch_dispatch 需要调用方 agent");
      if (isDelegatedAgent(parent)) {
        return { ok: false, status: "nested-dispatch-forbidden", message: "Only the root Architect session may dispatch delivery tasks. Report the proposed task to the root instead of creating another coordinator layer." };
      }
      const role = roles[args.role];
      if (!role) throw new Error(`未知架构师角色：${args.role}`);
      if (args.cwd !== undefined) {
        const cwdError = await validateTaskCwd(args.cwd);
        if (cwdError) return { ok: false, status: "invalid-cwd", message: cwdError };
      }
      const taskId = String(args.taskId || `${args.module}-${randomUUID()}`);
      const existing = scheduler.get(taskId);
      if (existing) {
        if (existing.parentId !== parent.id) return { ok: false, status: "task-id-conflict", taskId };
        return { ok: true, created: false, taskId, status: existing.status, childId: existing.childId, note: "同一 taskId 已存在，保持幂等，不重复创建子代理。" };
      }
      const dependencies = [...new Set(Array.isArray(args.dependsOn) ? args.dependsOn.map(String) : [])];
      const unknownDependencies = dependencies.filter((dependency) => !scheduler.get(dependency));
      if (unknownDependencies.length > 0) {
        return { ok: false, status: "unknown-dependency", taskId, dependencies: unknownDependencies, message: "前置任务尚未登记；先登记依赖任务，再提交当前任务。" };
      }
      const execution = selectTaskExecution(args);
      const requestedMode = execution.mode;
      const requestedAgentPreset = execution.agentPreset;
      const presetDecision = await validateAgentPreset(parent, requestedAgentPreset);
      if (!presetDecision.ok) return { ...presetDecision, taskId };
      const filter = buildRoleToolFilter(role);
      const available = new Set(visibleToolNames(parent));
      const requestedNames = [...(filter?.allow ?? []), ...(filter?.deny ?? [])];
      const unknownTools = requestedNames.filter((toolName) => !available.has(toolName));
      if (unknownTools.length > 0) {
        return { ok: false, status: "invalid-tool-filter", role: args.role, unknownTools: [...new Set(unknownTools)], message: "角色工具限制包含当前会话不可用的工具名；请在设置页修正后重试。" };
      }
      const releaseDecision = await ensureReleaseApproval(parent, args, exec.signal);
      if (!releaseDecision.approved) {
        return { ok: false, status: releaseDecision.decision || "awaiting-human", taskId, requestId: releaseDecision.requestId, message: "生产发布尚未获得产品经理确认，任务不会进入执行队列。" };
      }
      const queued = scheduler.enqueue({
        taskId,
        parentId: parent.id,
        projectId: args.projectId ?? null,
        taskType: args.taskType ?? null,
        module: args.module,
        role: args.role,
        label: args.label || `[${args.role}] ${args.module}`,
        prompt: args.prompt,
        cwd: args.cwd ?? null,
        base: args.base ?? null,
        dependsOn: dependencies,
        priority: args.priority,
        phase: args.phase,
        mode: requestedMode,
        agentPreset: requestedAgentPreset,
        riskTier: args.riskTier,
        releaseTarget: args.releaseTarget,
        directRelease: args.directRelease,
        maxAttempts: args.maxAttempts,
        stallTimeoutMinutes: args.stallTimeoutMinutes,
      });
      await persistState();
      const drained = await scheduleParent(parent.id, exec.signal);
      const task = scheduler.get(taskId);
      const started = drained.started.find((item) => item.taskId === taskId);
      return {
        ok: true,
        created: queued.created,
        taskId,
        childId: task?.childId && !String(task.childId).startsWith("pending:") ? task.childId : null,
        status: task?.status ?? "queued",
        dependsOn: task?.dependsOn ?? dependencies,
        active: scheduler.activeCount(parent.id),
        maxParallel,
        started: started ?? null,
        note: "任务已进入事件驱动队列；没有立即整合工作时结束当前回合，依赖完成或容量释放后会自动启动。",
      };
    },
  }));

  // ── arch_status ─────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "arch_status",
    description: "汇总当前会话的子代理状态、角色、模块和并发占用；仅在收到子代理回报或需要整合时读取，不用于空转轮询。",
    parameters: {},
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error("arch_status 需要调用方 agent");
      const children = await ctx.subagents.listChildren(parent.id, exec.signal);
      const rows = children.filter((child) => child.kind === "child").map((child) => {
        const entry = scheduler.getByChild(child.id);
        return {
          id: child.id,
          mode: child.mode,
          label: child.label || entry?.label || null,
          activity: child.activity,
          hasChildren: child.hasChildren,
          taskId: entry?.taskId ?? null,
          role: entry?.role ?? null,
          module: entry?.module ?? null,
          status: entry?.status ?? (child.activity === "running" ? "running" : "unknown"),
          cwd: entry?.cwd ?? null,
        };
      });
      const tasks = scheduler.list(parent.id);
      return {
        ok: true,
        count: rows.length,
        active: scheduler.activeCount(parent.id),
        queued: tasks.filter((task) => task.status === "queued").length,
        blocked: tasks.filter((task) => task.status === "blocked").length,
        maxParallel,
        children: rows,
        tasks,
      };
    },
  }));

  // ── arch_project / arch_estimate ───────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "arch_project",
    description: "创建或完成一个交付项目记录；start 会基于最近同类项目历史返回 Lead Time 估算，complete 会沉淀实际耗时和阶段拆分。",
    parameters: {
      action: { type: "string", required: true, enum: ["start", "complete"] },
      projectId: { type: "string", required: true },
      taskType: { type: "string", required: true, enum: ["feature", "research", "bugfix", "plugin", "maintenance", "release"] },
      summary: { type: "string", required: true },
      moduleCount: { type: "integer" },
      plannedMinutes: { type: "number" },
      actualMinutes: { type: "number" },
      evidence: { type: "string" },
      processFlow: { type: "array", items: { type: "string" } },
    },
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      await stateReady;
      const now = Date.now();
      const moduleCount = Number(args.moduleCount) || 0;
      const sizeBucket = moduleCount <= 2 ? "small" : moduleCount <= 5 ? "medium" : "large";
      const existing = findProject(args.projectId);
      if (args.action === "start") {
        const project = {
          ...(existing || {}),
          projectId: args.projectId,
          taskType: args.taskType,
          summary: args.summary,
          moduleCount,
          sizeBucket,
          status: "active",
          startedAt: existing?.startedAt ?? now,
          plannedMinutes: Number.isFinite(Number(args.plannedMinutes)) ? Number(args.plannedMinutes) : null,
          processFlow: Array.isArray(args.processFlow) ? args.processFlow : existing?.processFlow ?? ["analysis", "development", "integration", "qa", "release"],
        };
        projectState.projects = [...projectState.projects.filter((item) => item.projectId !== args.projectId), project];
        await persistState();
        return { ok: true, project, estimate: projectEstimate(projectState.history, { taskType: args.taskType, moduleCount }) };
      }
      if (!existing) return { ok: false, status: "unknown-project", projectId: args.projectId };
      const completedAt = now;
      const actualMinutes = Number.isFinite(Number(args.actualMinutes))
        ? Number(args.actualMinutes)
        : Math.max(0, (completedAt - existing.startedAt) / 60000);
      const taskRecords = scheduler.list(exec.agent?.id).filter((task) => task.projectId === args.projectId);
      const record = {
        projectId: args.projectId,
        taskType: existing.taskType,
        summary: existing.summary,
        moduleCount: existing.moduleCount,
        sizeBucket: existing.sizeBucket,
        plannedMinutes: existing.plannedMinutes,
        actualMinutes: Math.round(actualMinutes * 10) / 10,
        phaseMinutes: taskPhaseMinutes(exec.agent?.id, args.projectId),
        taskCount: taskRecords.length,
        model: roles.developer.model,
        processFlow: existing.processFlow,
        startedAt: existing.startedAt,
        completedAt,
        evidence: args.evidence ?? null,
      };
      projectState.history = [record, ...projectState.history.filter((item) => item.projectId !== args.projectId)].slice(0, 100);
      projectState.projects = [...projectState.projects.filter((item) => item.projectId !== args.projectId), { ...existing, status: "completed", completedAt, actualMinutes: record.actualMinutes }];
      await persistState();
      return { ok: true, project: record, nextEstimate: projectEstimate(projectState.history, existing) };
    },
  }));

  ctx.tools.register(defineTool({
    name: "arch_estimate",
    description: "根据最近同类型项目历史估算开发、测试和交付耗时；没有历史时明确返回 no-baseline，不伪造精度。",
    parameters: {
      taskType: { type: "string", required: true, enum: ["feature", "research", "bugfix", "plugin", "maintenance", "release"] },
      moduleCount: { type: "integer" },
      limit: { type: "integer" },
    },
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }] },
    async execute(args) {
      await stateReady;
      return { ok: true, ...projectEstimate(projectState.history, args) };
    },
  }));

  // ── arch_post_release ──────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "arch_post_release",
    description: "记录生产发布后的线上回归结果；production 任务在通过验证前不会完成，也不会释放其后继依赖。",
    parameters: {
      taskId: { type: "string", required: true },
      status: { type: "string", required: true, enum: ["passed", "failed"] },
      evidence: { type: "string", required: true },
      checks: { type: "array", items: { type: "string" } },
      rollbackExecuted: { type: "boolean" },
    },
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }] },
    async execute(args) {
      await stateReady;
      const task = scheduler.get(args.taskId);
      if (!task) return { ok: false, status: "unknown-task", taskId: args.taskId };
      const nextStatus = args.status === "passed" ? "completed" : "failed";
      const updated = scheduler.finalize(args.taskId, {
        status: nextStatus,
        verification: { status: args.status, evidence: args.evidence, checks: args.checks ?? [], rollbackExecuted: args.rollbackExecuted === true, verifiedAt: Date.now() },
        stopReason: args.status === "passed" ? "completed" : "post-release-regression-failed",
      });
      await persistState();
      if (updated) completeTaskLifecycle(updated).catch((error) => console.error("arch:post-release/lifecycle", error));
      return { ok: args.status === "passed", task: updated };
    },
  }));

  // ── arch_finalize ────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "arch_finalize",
    description: "完成合并验证后释放目标 worktree；只允许 clean 且已合并到 base 的工作树进入自动清理。",
    parameters: {
      taskId: { type: "string", required: true },
      base: { type: "string", description: "已合并的目标分支；省略时使用任务记录的 base" },
      releaseWorktree: { type: "boolean", description: "是否调用 wt_release 删除 worktree 和已合并任务分支，默认 true" },
      evidence: { type: "string", required: true, description: "合并、验证和清理证据" },
    },
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      await stateReady;
      const task = scheduler.get(args.taskId);
      if (!task) return { ok: false, status: "unknown-task", taskId: args.taskId };
      if (task.status !== "completed") return { ok: false, status: "not-completed", task: { taskId: task.taskId, status: task.status }, message: "任务必须先完成开发、QA 和必要的线上回归。" };
      if (task.merged === true && (args.releaseWorktree === false || task.worktreeReleased === true)) return { ok: true, idempotent: true, task };
      const base = args.base ?? task.base;
      if (args.releaseWorktree !== false && (!task.cwd || !base)) return { ok: false, status: "missing-release-contract", message: "自动释放需要任务记录中的 worktree cwd 和 base。" };
      let release = null;
      if (args.releaseWorktree !== false) {
        try {
          release = await executeNestedTool("wt_release", { path: task.cwd, base, deleteBranch: true }, exec);
          if (!release?.ok) return { ok: false, status: "worktree-release-failed", release };
        } catch (error) {
          return { ok: false, status: "worktree-release-unavailable", error: String(error?.message ?? error) };
        }
      }
      const updated = scheduler.finalize(args.taskId, { merged: true, mergedAt: Date.now(), mergeEvidence: args.evidence, worktreeReleased: release?.released === true });
      await persistState();
      return { ok: true, task: updated, release };
    },
  }));

  // ── arch_roles ──────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "arch_roles",
    description: "查看角色路由、硬工具权限和当前并发配置。",
    parameters: {},
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    execute() {
      return {
        ok: true,
        roles: cleanRoles(roles),
        maxParallel,
        autonomous,
      };
    },
  }));
}
