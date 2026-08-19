import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { apply, DispatchLedger, ROLE_TOOL_DEFAULTS, buildRoleToolFilter, evaluatePresetRoster, isDelegatedAgent, movePendingSubagentReports, selectTaskExecution, validateTaskReport, wakeIdleParentForSubagentReport } from "../lib/index.js";
import { TaskScheduler } from "../lib/scheduler.js";
import { ArchitectStateStore, projectEstimate } from "../lib/state.js";

const execFileAsync = promisify(execFile);

test("role tool filters are deduplicated and fail closed when empty", () => {
  assert.deepEqual(buildRoleToolFilter({ toolAllow: ["read", "read"], toolDeny: ["bash", "bash"] }), {
    allow: ["read"],
    deny: ["bash"],
  });
  assert.equal(buildRoleToolFilter({ toolAllow: [], toolDeny: [] }), undefined);
});

test("task execution defaults use exact mountable preset ids", () => {
  assert.deepEqual(selectTaskExecution({ taskType: "plugin" }), { mode: "create", agentPreset: "cordis" });
  assert.deepEqual(selectTaskExecution({ taskType: "feature" }), { mode: "continuable", agentPreset: "standard" });
  assert.deepEqual(selectTaskExecution({ mode: "continuable", agentPreset: "code" }), { mode: "continuable", agentPreset: "code" });
  assert.equal(isDelegatedAgent({ session: { header: { origin: "subagent", delegationDepth: 1 } } }), true);
  assert.equal(isDelegatedAgent({ session: { header: {} } }), false);
});

test("preset roster validation rejects aliases, missing ids, and broken presets before launch", () => {
  const roster = [{ id: "standard" }, { id: "cordis" }, { id: "broken", broken: "invalid yaml" }];
  assert.equal(evaluatePresetRoster(roster, "cordis").ok, true);
  assert.deepEqual(evaluatePresetRoster(roster, "cordis/创造模式"), {
    ok: false,
    status: "invalid-preset",
    presetId: "cordis/创造模式",
    available: ["standard", "cordis"],
    message: "unknown agent preset cordis/创造模式",
  });
  assert.equal(evaluatePresetRoster(roster, "broken").status, "invalid-preset");
});

test("subagent reports wake only an idle parent and reuse native inbox", () => {
  let wakes = 0;
  const idle = { status: "idle", wakeDriver() { wakes += 1; } };
  const active = { status: "running", wakeDriver() { wakes += 1; } };
  const report = { message: { source: { kind: "subagent-report" } } };

  assert.equal(wakeIdleParentForSubagentReport({ ...report, agent: idle }), true);
  assert.equal(wakeIdleParentForSubagentReport({ ...report, agent: active }), false);
  assert.equal(wakeIdleParentForSubagentReport({ agent: idle, message: { source: { kind: "user" } } }), false);
  assert.equal(wakes, 1);
});

test("pending report messages move from next-turn to next-step without duplication", () => {
  const report = { id: "report-1", source: { kind: "subagent-report" } };
  const other = { id: "user-1", source: { kind: "user" } };
  const nextTurn = [report, other];
  const injected = [];
  const inbox = {
    nextTurn,
    remove(id) {
      const index = nextTurn.findIndex((message) => message.id === id);
      if (index < 0) return false;
      nextTurn.splice(index, 1);
      return true;
    },
  };
  const agent = { inbox, inject(message) { injected.push(message); } };

  assert.equal(movePendingSubagentReports(agent), 1);
  assert.deepEqual(nextTurn, [other]);
  assert.deepEqual(injected, [report]);
});

test("task scheduler queues dependencies and resumes them after completion", () => {
  const scheduler = new TaskScheduler(1);
  scheduler.enqueue({ taskId: "build", parentId: "parent", role: "developer", module: "build", prompt: "build" });
  scheduler.enqueue({ taskId: "qa", parentId: "parent", role: "qa", module: "qa", prompt: "qa", dependsOn: ["build"] });
  assert.equal(scheduler.nextReady("parent")[0].taskId, "build");
  assert.equal(scheduler.start("build", "child-build"), true);
  assert.equal(scheduler.nextReady("parent").length, 0);
  scheduler.bindChild("build", "child-build");
  scheduler.finish("child-build", "completed");
  assert.equal(scheduler.nextReady("parent")[0].taskId, "qa");
});

test("task completion requires an accepted structured report before dependencies unlock", () => {
  const scheduler = new TaskScheduler(2);
  scheduler.enqueue({ taskId: "build", parentId: "parent", role: "developer", module: "build", prompt: "build" });
  scheduler.enqueue({ taskId: "qa", parentId: "parent", role: "qa", module: "qa", prompt: "qa", dependsOn: ["build"] });
  scheduler.start("build", "child-build");
  scheduler.bindChild("build", "child-build");
  scheduler.recordReport("child-build", { outcome: "passed", summary: "done", tests: ["npm test"], evidence: ["commit abc"] });
  assert.equal(scheduler.get("build").status, "running");
  assert.equal(scheduler.nextReady("parent").length, 0);
  scheduler.settleReview("child-build", { outcome: "passed", stopReason: "accepted" });
  assert.equal(scheduler.get("build").status, "completed");
  assert.equal(scheduler.nextReady("parent")[0].taskId, "qa");
});

test("missing or rejected acceptance evidence fails a task and blocks dependents", () => {
  const scheduler = new TaskScheduler(2);
  scheduler.enqueue({ taskId: "build", parentId: "parent", role: "developer", module: "build", prompt: "build" });
  scheduler.enqueue({ taskId: "qa", parentId: "parent", role: "qa", module: "qa", prompt: "qa", dependsOn: ["build"] });
  scheduler.start("build", "child-build");
  scheduler.bindChild("build", "child-build");
  scheduler.settleReview("child-build", { outcome: "failed", stopReason: "missing-report", error: "no report" });
  assert.equal(scheduler.get("build").status, "failed");
  assert.equal(scheduler.markBlockedDependents("parent")[0].taskId, "qa");
  assert.equal(scheduler.get("qa").status, "blocked");
});

test("developer acceptance verifies report, commit, base delta, and clean worktree", async () => {
  const dir = await mkdtemp(join("/tmp", "dsh-architect-acceptance-"));
  const git = async (...args) => (await execFileAsync("git", ["-C", dir, ...args], { encoding: "utf8" })).stdout.trim();
  const task = { role: "developer", phase: "development", taskType: "feature", cwd: dir, base: "main" };
  const evidence = { outcome: "passed", summary: "implemented", tests: ["npm test"], evidence: ["behavior verified"] };
  try {
    await git("init", "-b", "main");
    await git("config", "user.email", "architect-test@example.invalid");
    await git("config", "user.name", "Architect Test");
    await writeFile(join(dir, "base.txt"), "base\n");
    await git("add", "base.txt");
    await git("commit", "-m", "base");

    assert.equal((await validateTaskReport(task, null)).stopReason, "missing-report");
    assert.match((await validateTaskReport(task, evidence)).error, /commit hash/);
    const baseHead = await git("rev-parse", "HEAD");
    assert.match((await validateTaskReport(task, { ...evidence, commit: baseHead })).error, /no commit beyond/);

    await git("checkout", "-b", "task");
    await writeFile(join(dir, "feature.txt"), "feature\n");
    await git("add", "feature.txt");
    await git("commit", "-m", "feature");
    const head = await git("rev-parse", "HEAD");

    assert.match((await validateTaskReport(task, { ...evidence, commit: "deadbeef" })).error, /not worktree HEAD/);
    assert.equal((await validateTaskReport(task, { ...evidence, commit: head.slice(0, 12) })).outcome, "passed");

    await writeFile(join(dir, "dirty.txt"), "dirty\n");
    assert.match((await validateTaskReport(task, { ...evidence, commit: head })).error, /not clean/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task activity lease is bounded and advances only for active children", () => {
  const scheduler = new TaskScheduler(1);
  scheduler.enqueue({ taskId: "task", parentId: "parent", prompt: "work", stallTimeoutMinutes: 1 });
  assert.equal(scheduler.get("task").stallTimeoutMinutes, 5);
  scheduler.start("task", "child");
  scheduler.bindChild("task", "child");
  const before = scheduler.get("task").lastActivityAt;
  assert.equal(scheduler.touch("child", before + 1000), true);
  assert.equal(scheduler.get("task").lastActivityAt, before + 1000);
  scheduler.settleReview("child", { outcome: "failed", error: "stalled" });
  assert.equal(scheduler.touch("child", before + 2000), false);
});

test("task scheduler restores queued and running work without duplicating child identity", () => {
  const first = new TaskScheduler(2);
  first.enqueue({ taskId: "one", parentId: "parent", role: "developer", module: "one", prompt: "one" });
  first.start("one", "child-one");
  first.bindChild("one", "child-one");
  first.enqueue({ taskId: "two", parentId: "parent", role: "developer", module: "two", prompt: "two", dependsOn: ["one"] });
  const restored = new TaskScheduler(2);
  restored.restore(first.serialize());
  assert.equal(restored.getByChild("child-one").taskId, "one");
  assert.equal(restored.get("two").status, "queued");
  assert.equal(restored.nextReady("parent").length, 0);
});

test("task scheduler rejects dependency cycles", () => {
  const scheduler = new TaskScheduler(1);
  scheduler.enqueue({ taskId: "a", parentId: "parent", role: "developer", module: "a", prompt: "a", dependsOn: ["b"] });
  assert.throws(() => scheduler.enqueue({ taskId: "b", parentId: "parent", role: "developer", module: "b", prompt: "b", dependsOn: ["a"] }), /cycle|dependency/i);
});

test("start failures retry only within the configured attempt budget", () => {
  const scheduler = new TaskScheduler(1);
  scheduler.enqueue({ taskId: "retry", parentId: "parent", role: "developer", module: "retry", prompt: "retry", maxAttempts: 2 });
  scheduler.start("retry", "pending:retry:1");
  assert.equal(scheduler.fail("retry", "temporary", "start-failed").status, "queued");
  scheduler.start("retry", "pending:retry:2");
  assert.equal(scheduler.fail("retry", "permanent", "start-failed").status, "failed");
});

test("production tasks wait for online verification and reload reconciliation requeues lost children", () => {
  const scheduler = new TaskScheduler(1);
  scheduler.enqueue({ taskId: "release", parentId: "parent", role: "release", module: "release", prompt: "release", releaseTarget: "production" });
  scheduler.start("release", "child-release");
  scheduler.bindChild("release", "child-release");
  scheduler.recordReport("child-release", { outcome: "passed", summary: "released", tests: ["smoke"], evidence: ["deployment id"] });
  scheduler.settleReview("child-release", { outcome: "passed", stopReason: "accepted" });
  assert.equal(scheduler.get("release").status, "awaiting-verification");
  assert.equal(scheduler.nextReady("parent").length, 0);
  const changed = scheduler.reconcile("parent", []);
  assert.equal(changed.length, 0, "verification-pending work is not requeued as a duplicate");
  scheduler.finalize("release", { status: "completed", verification: { status: "passed" } });
  assert.equal(scheduler.terminal("release"), true);
});

test("reload reconciliation returns active tasks without a durable child to the queue", () => {
  const scheduler = new TaskScheduler(1);
  scheduler.enqueue({ taskId: "lost", parentId: "parent", role: "developer", module: "lost", prompt: "lost" });
  scheduler.start("lost", "child-lost");
  scheduler.bindChild("lost", "child-lost");
  const changed = scheduler.reconcile("parent", []);
  assert.equal(changed[0].status, "queued");
  assert.equal(scheduler.get("lost").childId, null);
  assert.equal(scheduler.nextReady("parent")[0].taskId, "lost");
});

test("persistent state and estimate use recent project history", async () => {
  const dir = await mkdtemp(join("/tmp", "dsh-architect-state-"));
  const file = join(dir, "state.json");
  try {
    const store = new ArchitectStateStore(file);
    await store.replace({ version: 1, tasks: [], projects: [], changes: [], history: [{ projectId: "old", taskType: "feature", moduleCount: 2, sizeBucket: "small", actualMinutes: 40, phaseMinutes: { development: 25, qa: 15 }, completedAt: 1 }] });
    const loaded = new ArchitectStateStore(file);
    await loaded.ready;
    const estimate = projectEstimate(loaded.snapshot().history, { taskType: "feature", moduleCount: 2 });
    assert.equal(estimate.available, true);
    assert.equal(estimate.sampleCount, 1);
    assert.equal(estimate.estimateMinutes, 50);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("arch_dispatch opts into parallel tool scheduling", () => {
  const tools = [];
  const ctx = {
    reflect: { provide() {} },
    get() { return undefined; },
    effect(callback) { const disposer = callback(); return typeof disposer === "function" ? disposer : () => {}; },
    on() { return () => {}; },
    typert: { register() { return () => {}; } },
    tools: { register(definition) { tools.push(definition); return () => {}; }, schemas() { return []; } },
    subagents: {},
  };
  apply(ctx);
  const dispatch = tools.find((tool) => tool.name === "arch_dispatch");
  assert.ok(dispatch);
  assert.equal(dispatch.isConcurrencySafe({ module: "core", role: "developer", prompt: "test" }), true);
  assert.equal(tools.some((tool) => tool.name === "arch_change_control"), false);
});

test("architect reads persisted settings through its hard dependency", async () => {
  const tools = [];
  const configured = {
    executionModel: { provider: "rmb", model: "configured-executor", reasoningEffort: "high" },
    maxParallel: 5,
  };
  const settingsScope = { get() { return configured; }, watch() { return () => {}; } };
  const settings = {
    writable: true,
    register() { return settingsScope; },
    describe() { return [{ ns: "architect", revision: 7 }]; },
  };
  const ctx = {
    settings,
    reflect: { provide() {} },
    get() { return undefined; },
    effect(callback) { const disposer = callback(); return typeof disposer === "function" ? disposer : () => {}; },
    on() { return () => {}; },
    typert: { register() { return () => {}; } },
    tools: { register(definition) { tools.push(definition); return () => {}; }, schemas() { return []; } },
    subagents: {},
  };
  apply(ctx);
  const roles = tools.find((tool) => tool.name === "arch_roles");
  assert.deepEqual(await roles.execute({}), {
    ok: true,
    roles: {
      developer: { provider: "rmb", model: "configured-executor", reasoningEffort: "high", toolAllow: ROLE_TOOL_DEFAULTS.developer, toolDeny: [] },
      qa: { provider: "rmb", model: "configured-executor", reasoningEffort: "high", toolAllow: ROLE_TOOL_DEFAULTS.qa, toolDeny: [] },
      release: { provider: "rmb", model: "configured-executor", reasoningEffort: "high", toolAllow: ROLE_TOOL_DEFAULTS.release, toolDeny: [] },
    },
    maxParallel: 5,
    autonomous: true,
  });
});

test("dispatch ledger enforces a hard per-parent concurrency cap", () => {
  const ledger = new DispatchLedger(4);
  const accepted = [];
  for (let i = 0; i < 32; i += 1) {
    const childId = `child-${i}`;
    if (ledger.start("parent", { childId, role: "developer", module: `module-${i}` })) accepted.push(childId);
  }
  assert.equal(accepted.length, 4);
  assert.equal(ledger.activeCount("parent"), 4);
  assert.equal(ledger.start("parent", { childId: "overflow", role: "developer", module: "overflow" }), false);

  ledger.finish(accepted[0], "completed");
  ledger.finish(accepted[1], "failed");
  assert.equal(ledger.activeCount("parent"), 2);
  assert.equal(ledger.start("parent", { childId: "child-next-1", role: "qa", module: "next-1" }), true);
  assert.equal(ledger.start("parent", { childId: "child-next-2", role: "qa", module: "next-2" }), true);
  assert.equal(ledger.activeCount("parent"), 4);

  const snapshot = ledger.list("parent");
  assert.equal(snapshot.length, 6);
  assert.equal(snapshot.filter((row) => row.status === "completed").length, 1);
  assert.equal(snapshot.filter((row) => row.status === "failed").length, 1);
  assert.equal(snapshot.filter((row) => row.status === "running").length, 4);
});

test("ledger reserves slots before async child creation and releases failures", () => {
  const ledger = new DispatchLedger(2);
  const first = ledger.reserve("parent");
  const second = ledger.reserve("parent");
  assert.ok(first);
  assert.ok(second);
  assert.equal(ledger.reserve("parent"), null);
  assert.equal(ledger.activeCount("parent"), 2);

  assert.equal(ledger.commit("parent", first, { childId: "child-1", role: "developer", module: "one" }), true);
  assert.equal(ledger.release("parent", second), true);
  assert.equal(ledger.activeCount("parent"), 1);
  assert.equal(ledger.list("parent").length, 1);
  assert.equal(ledger.release("parent", second), false);
});

test("ledger isolates concurrent parents", () => {
  const ledger = new DispatchLedger(2);
  assert.equal(ledger.start("a", { childId: "a-1", role: "developer", module: "one" }), true);
  assert.equal(ledger.start("a", { childId: "a-2", role: "developer", module: "two" }), true);
  assert.equal(ledger.start("a", { childId: "a-3", role: "developer", module: "three" }), false);
  assert.equal(ledger.start("b", { childId: "b-1", role: "qa", module: "one" }), true);
  assert.equal(ledger.activeCount("a"), 2);
  assert.equal(ledger.activeCount("b"), 1);
});
