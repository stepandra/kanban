import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { dispatchReviewFixer, type ReviewFixerSchedulerDeps, runReviewFixerProcess } from "../../src/core/review-fixer";
import { createTempDir } from "../utilities/temp-dir";

interface LaunchRecord {
	statePath: string;
	label: string;
}

function createSchedulerHarness(env: NodeJS.ProcessEnv) {
	const launches: LaunchRecord[] = [];
	const alivePids = new Set<number>();
	let nextPid = 4100;
	let tick = 0;
	const deps: ReviewFixerSchedulerDeps = {
		env,
		now: () => new Date(Date.UTC(2026, 6, 21, 12, 0, tick++)),
		isBinaryAvailable: () => true,
		isRunnerProcessAlive: (pid) => alivePids.has(pid),
		launchRunner: (input) => {
			launches.push({ statePath: input.statePath, label: input.label });
			const pid = nextPid++;
			alivePids.add(pid);
			return pid;
		},
	};
	return { deps, launches, alivePids };
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("dispatchReviewFixer", () => {
	it("enqueues and launches an isolated ar-fixer runner for a review card", async () => {
		const { path: root, cleanup } = createTempDir("kanban-review-fixer-");
		try {
			const projectPath = join(root, "project");
			const taskWorkspacePath = join(root, "task-workspace");
			mkdirSync(projectPath);
			mkdirSync(taskWorkspacePath);
			const env = { KANBAN_REVIEW_FIXER_DIR: join(root, "review-fixers") };
			const harness = createSchedulerHarness(env);

			const result = await dispatchReviewFixer(
				{
					taskId: "abc123",
					projectPath,
					taskWorkspacePath,
					title: "Fix the thing",
				},
				harness.deps,
			);

			expect(result).toMatchObject({
				ok: true,
				action: "review_handoff",
				taskId: "abc123",
				projectPath,
				taskWorkspacePath,
				state: "running",
				label: "ar-fixer-abc123",
			});
			expect(typeof result.logFile).toBe("string");

			expect(harness.launches).toHaveLength(1);
			expect(harness.launches[0]?.label).toBe("ar-fixer-abc123");

			const runningDir = join(root, "review-fixers", "running");
			const runningFiles = readdirSync(runningDir);
			expect(runningFiles).toEqual(["abc123.json"]);
			const state = readJson(join(runningDir, "abc123.json"));
			expect(state).toMatchObject({
				schema: 1,
				task_id: "abc123",
				project_path: projectPath,
				task_workspace_path: taskWorkspacePath,
				title: "Fix the thing",
				label: "ar-fixer-abc123",
				mode: "deep",
			});
			expect(typeof state.pid).toBe("number");
			expect(typeof state.started_at).toBe("string");

			const promptFile = String(state.prompt_file);
			const prompt = readFileSync(promptFile, "utf8");
			expect(prompt).toContain("[stepandra/kanban review-ready]");
			expect(prompt).toContain("Task abc123 — Fix the thing has moved to the Review column");
			expect(prompt).toContain(`Authoritative task workspace: ${taskWorkspacePath}`);
			expect(prompt).toContain("Act as the Fixer/Integrator for this task only.");
			expect(prompt).toContain("use Jujutsu only when `jj root` succeeds");
			expect(prompt).toContain("otherwise, when `git rev-parse --show-toplevel` succeeds, use plain Git");
			expect(prompt).toContain("git push origin kanban/abc123-review");
			expect(prompt).toContain("`action=accept`");
			expect(prompt).toContain("`acceptedRevision=<full verified commit ID>`");
			expect(prompt).toContain("Never use `action=done` to accept Review work.");
		} finally {
			cleanup();
		}
	});

	it("caps concurrent Fixers at two and drains queued cards in FIFO order as runners exit", async () => {
		const { path: root, cleanup } = createTempDir("kanban-review-fixer-cap-");
		try {
			const projectPath = join(root, "project");
			const taskWorkspacePath = join(root, "task-workspace");
			mkdirSync(projectPath);
			mkdirSync(taskWorkspacePath);
			const stateRoot = join(root, "review-fixers");
			const env = { KANBAN_REVIEW_FIXER_DIR: stateRoot };
			const harness = createSchedulerHarness(env);

			// Two Fixers already occupy both slots.
			const runningDir = join(stateRoot, "running");
			mkdirSync(runningDir, { recursive: true });
			harness.alivePids.add(7101);
			harness.alivePids.add(7102);
			writeFileSync(
				join(runningDir, "task-1.json"),
				JSON.stringify({ task_id: "task-1", label: "ar-fixer-task-1", pid: 7101 }),
			);
			writeFileSync(
				join(runningDir, "task-2.json"),
				JSON.stringify({ task_id: "task-2", label: "ar-fixer-task-2", pid: 7102 }),
			);

			const third = await dispatchReviewFixer({ taskId: "task-3", projectPath, taskWorkspacePath }, harness.deps);
			expect(third).toMatchObject({ ok: true, state: "queued", label: "ar-fixer-task-3" });
			expect(harness.launches).toHaveLength(0);
			expect(existsSync(join(stateRoot, "queue", "task-3.json"))).toBe(true);

			// One runner exits; the next submit drains the oldest queued card.
			harness.alivePids.delete(7101);
			const fourth = await dispatchReviewFixer({ taskId: "task-4", projectPath, taskWorkspacePath }, harness.deps);
			expect(fourth).toMatchObject({ ok: true, state: "queued", label: "ar-fixer-task-4" });
			expect(harness.launches).toHaveLength(1);
			expect(harness.launches[0]?.label).toBe("ar-fixer-task-3");
			expect(existsSync(join(stateRoot, "running", "task-3.json"))).toBe(true);
			expect(existsSync(join(stateRoot, "queue", "task-4.json"))).toBe(true);

			const exitedFiles = readdirSync(join(stateRoot, "exited"));
			expect(exitedFiles).toHaveLength(1);
			expect(exitedFiles[0]).toMatch(/^task-1\./);
			const exitedState = readJson(join(stateRoot, "exited", exitedFiles[0] ?? ""));
			expect(exitedState.task_id).toBe("task-1");
			expect(exitedState.exit_code).toBeNull();
			expect(typeof exitedState.ended_at).toBe("string");
		} finally {
			cleanup();
		}
	});

	it("deduplicates a repeat handoff for a task that already has a live Fixer", async () => {
		const { path: root, cleanup } = createTempDir("kanban-review-fixer-dedup-");
		try {
			const projectPath = join(root, "project");
			const taskWorkspacePath = join(root, "task-workspace");
			mkdirSync(projectPath);
			mkdirSync(taskWorkspacePath);
			const env = { KANBAN_REVIEW_FIXER_DIR: join(root, "review-fixers") };
			const harness = createSchedulerHarness(env);

			const first = await dispatchReviewFixer({ taskId: "dup1", projectPath, taskWorkspacePath }, harness.deps);
			expect(first.state).toBe("running");
			const second = await dispatchReviewFixer({ taskId: "dup1", projectPath, taskWorkspacePath }, harness.deps);
			expect(second).toMatchObject({ ok: true, state: "deduplicated", label: "ar-fixer-dup1" });
			expect(harness.launches).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	it("fails closed when the Fixer agent binary is not available", async () => {
		const { path: root, cleanup } = createTempDir("kanban-review-fixer-noamp-");
		try {
			const projectPath = join(root, "project");
			const taskWorkspacePath = join(root, "task-workspace");
			mkdirSync(projectPath);
			mkdirSync(taskWorkspacePath);
			const stateRoot = join(root, "review-fixers");
			const env = { KANBAN_REVIEW_FIXER_DIR: stateRoot };
			const harness = createSchedulerHarness(env);
			harness.deps.isBinaryAvailable = () => false;

			const result = await dispatchReviewFixer({ taskId: "nope1", projectPath, taskWorkspacePath }, harness.deps);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("amp is not available on PATH");
			expect(result.error).toContain("task is in review but its isolated Fixer was not queued");
			expect(harness.launches).toHaveLength(0);
			expect(existsSync(join(stateRoot, "queue"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("fails closed on an invalid configured Fixer mode", async () => {
		const { path: root, cleanup } = createTempDir("kanban-review-fixer-mode-");
		try {
			const projectPath = join(root, "project");
			const taskWorkspacePath = join(root, "task-workspace");
			mkdirSync(projectPath);
			mkdirSync(taskWorkspacePath);
			const env = {
				KANBAN_REVIEW_FIXER_DIR: join(root, "review-fixers"),
				KANBAN_REVIEW_FIXER_MODE: "ludicrous",
			};
			const harness = createSchedulerHarness(env);

			const result = await dispatchReviewFixer({ taskId: "mode1", projectPath, taskWorkspacePath }, harness.deps);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("unsupported Fixer mode 'ludicrous'");
			expect(harness.launches).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	it("fails closed when the task workspace cannot be resolved", async () => {
		const { path: root, cleanup } = createTempDir("kanban-review-fixer-nows-");
		try {
			const projectPath = join(root, "project");
			mkdirSync(projectPath);
			const env = {
				KANBAN_REVIEW_FIXER_DIR: join(root, "review-fixers"),
				XDG_DATA_HOME: join(root, "data-home"),
			};
			const harness = createSchedulerHarness(env);
			// No jj binary and no deterministic task-workspace directory exists.
			harness.deps.isBinaryAvailable = (binary) => binary === "amp";

			const result = await dispatchReviewFixer({ taskId: "miss1", projectPath }, harness.deps);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("review handoff task workspace does not exist");
			expect(harness.launches).toHaveLength(0);
		} finally {
			cleanup();
		}
	});
});

describe("runReviewFixerProcess", () => {
	it("runs the queued Fixer prompt through the agent binary and records the exit code", async () => {
		const { path: root, cleanup } = createTempDir("kanban-review-fixer-run-");
		try {
			const projectPath = join(root, "project");
			const taskWorkspacePath = join(root, "task-workspace");
			mkdirSync(projectPath);
			mkdirSync(taskWorkspacePath);
			const stateRoot = join(root, "review-fixers");
			const stdinCapture = join(root, "fake-amp-stdin.txt");
			const fakeAmpPath = join(root, "fake-amp");
			writeFileSync(fakeAmpPath, `#!/bin/sh\ncat > ${JSON.stringify(stdinCapture)}\necho "fake amp ran:$1 $2"\n`);
			chmodSync(fakeAmpPath, 0o755);
			const env = {
				KANBAN_REVIEW_FIXER_DIR: stateRoot,
				KANBAN_REVIEW_FIXER_AMP_BIN: fakeAmpPath,
				PATH: process.env.PATH ?? "",
			};
			const harness = createSchedulerHarness(env);

			const dispatch = await dispatchReviewFixer({ taskId: "run1", projectPath, taskWorkspacePath }, harness.deps);
			expect(dispatch.state).toBe("running");
			const runningStatePath = join(stateRoot, "running", "run1.json");

			const exitCode = await runReviewFixerProcess({
				statePath: runningStatePath,
				expectedLabel: "ar-fixer-run1",
				overrides: harness.deps,
			});
			expect(exitCode).toBe(0);

			expect(existsSync(runningStatePath)).toBe(false);
			const exitedFiles = readdirSync(join(stateRoot, "exited"));
			expect(exitedFiles).toHaveLength(1);
			const exitedState = readJson(join(stateRoot, "exited", exitedFiles[0] ?? ""));
			expect(exitedState.task_id).toBe("run1");
			expect(exitedState.exit_code).toBe(0);
			expect(typeof exitedState.ended_at).toBe("string");

			const prompt = readFileSync(stdinCapture, "utf8");
			expect(prompt).toContain("[stepandra/kanban review-ready]");
			expect(prompt).toContain("Task run1 has moved to the Review column");

			const logFile = String(exitedState.log_file);
			expect(readFileSync(logFile, "utf8")).toContain("fake amp ran:--mode deep");
		} finally {
			cleanup();
		}
	});

	it("rejects a label mismatch without running anything", async () => {
		const { path: root, cleanup } = createTempDir("kanban-review-fixer-label-");
		try {
			const runningDir = join(root, "review-fixers", "running");
			mkdirSync(runningDir, { recursive: true });
			const statePath = join(runningDir, "lbl1.json");
			writeFileSync(statePath, JSON.stringify({ task_id: "lbl1", label: "ar-fixer-lbl1" }));

			await expect(
				runReviewFixerProcess({
					statePath,
					expectedLabel: "ar-fixer-other",
					overrides: { env: { KANBAN_REVIEW_FIXER_DIR: join(root, "review-fixers") } },
				}),
			).rejects.toThrow("review-fixer-run label mismatch");
		} finally {
			cleanup();
		}
	});
});
