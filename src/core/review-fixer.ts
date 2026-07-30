import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";
import { buildKanbanCommandParts } from "./kanban-command";

// First-party replacement for the external `zj-agent review-handoff` bash
// entrypoint. The on-disk state schema intentionally stays byte-compatible
// with the harness (schema 1, snake_case fields, same directory layout) so a
// shared review-fixers state dir remains interoperable during migration.
const REVIEW_FIXER_STATE_SCHEMA = 1;
const REVIEW_FIXER_QUEUE_DIR = "queue";
const REVIEW_FIXER_RUNNING_DIR = "running";
const REVIEW_FIXER_EXITED_DIR = "exited";
const REVIEW_FIXER_PROMPT_DIR = "prompts";
const REVIEW_FIXER_LOG_DIR = "logs";
const REVIEW_FIXER_SCHEDULER_LOG = "scheduler.log";

const REVIEW_FIXER_DIR_ENV = "KANBAN_REVIEW_FIXER_DIR";
const REVIEW_FIXER_AMP_BIN_ENV = "KANBAN_REVIEW_FIXER_AMP_BIN";
const REVIEW_FIXER_MODE_ENV = "KANBAN_REVIEW_FIXER_MODE";
const REVIEW_FIXER_MAX_CONCURRENCY_ENV = "KANBAN_REVIEW_FIXER_MAX_CONCURRENCY";

const DEFAULT_REVIEW_FIXER_AMP_BIN = "amp";
const DEFAULT_REVIEW_FIXER_MODE = "deep";
const DEFAULT_REVIEW_FIXER_MAX_CONCURRENCY = 2;
const REVIEW_FIXER_MODES = ["deep", "low", "medium", "high"] as const;

type ReviewFixerMode = (typeof REVIEW_FIXER_MODES)[number];

export interface ReviewFixerDispatchInput {
	taskId: string;
	projectPath: string;
	taskWorkspacePath?: string;
	title?: string;
}

export type ReviewFixerDispatchState = "running" | "queued" | "deduplicated";

export interface ReviewFixerDispatchResult {
	ok: boolean;
	action?: "review_handoff";
	taskId?: string;
	projectPath?: string;
	taskWorkspacePath?: string;
	state?: ReviewFixerDispatchState;
	label?: string;
	logFile?: string;
	error?: string;
}

interface ReviewFixerStateFile {
	schema: number;
	task_id: string;
	project_path: string;
	task_workspace_path: string;
	title: string | null;
	label: string;
	prompt_file: string;
	log_file: string;
	mode: string;
	enqueued_at: string;
	pid?: number;
	started_at?: string;
	ended_at?: string;
	exit_code?: number | null;
}

export interface ReviewFixerSchedulerDeps {
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
	isBinaryAvailable?: (binary: string) => boolean;
	isRunnerProcessAlive?: (pid: number, label: string) => boolean;
	launchRunner?: (input: { statePath: string; label: string; schedulerLogPath: string }) => number;
}

interface ReviewFixerDirs {
	root: string;
	queue: string;
	running: string;
	exited: string;
	prompts: string;
	logs: string;
	schedulerLog: string;
}

function getDeps(overrides?: ReviewFixerSchedulerDeps): Required<ReviewFixerSchedulerDeps> {
	return {
		env: overrides?.env ?? process.env,
		now: overrides?.now ?? (() => new Date()),
		isBinaryAvailable: overrides?.isBinaryAvailable ?? isBinaryAvailableOnPath,
		isRunnerProcessAlive: overrides?.isRunnerProcessAlive ?? defaultIsRunnerProcessAlive,
		launchRunner: overrides?.launchRunner ?? defaultLaunchRunner,
	};
}

function safeName(value: string): string {
	const normalized = value
		.replace(/[^A-Za-z0-9_.-]+/g, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "");
	return normalized || "task";
}

function formatUtcTimestamp(date: Date): string {
	return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatCompactUtcTimestamp(date: Date): string {
	return formatUtcTimestamp(date).replace(/[-:]/g, "");
}

function resolveDataHome(env: NodeJS.ProcessEnv): string {
	const configuredDataHome = env.XDG_DATA_HOME?.trim();
	return configuredDataHome ? resolve(configuredDataHome) : join(homedir(), ".local", "share");
}

function resolveReviewFixerDirs(env: NodeJS.ProcessEnv): ReviewFixerDirs {
	const configuredRoot = env[REVIEW_FIXER_DIR_ENV]?.trim();
	const root = configuredRoot ? resolve(configuredRoot) : join(resolveDataHome(env), "kanban", "review-fixers");
	return {
		root,
		queue: join(root, REVIEW_FIXER_QUEUE_DIR),
		running: join(root, REVIEW_FIXER_RUNNING_DIR),
		exited: join(root, REVIEW_FIXER_EXITED_DIR),
		prompts: join(root, REVIEW_FIXER_PROMPT_DIR),
		logs: join(root, REVIEW_FIXER_LOG_DIR),
		schedulerLog: join(root, REVIEW_FIXER_SCHEDULER_LOG),
	};
}

async function ensureReviewFixerDirs(dirs: ReviewFixerDirs): Promise<void> {
	await mkdir(dirs.queue, { recursive: true });
	await mkdir(dirs.running, { recursive: true });
	await mkdir(dirs.exited, { recursive: true });
	await mkdir(dirs.prompts, { recursive: true });
	await mkdir(dirs.logs, { recursive: true });
}

function resolveReviewFixerMode(env: NodeJS.ProcessEnv): ReviewFixerMode {
	const mode = (env[REVIEW_FIXER_MODE_ENV]?.trim() || DEFAULT_REVIEW_FIXER_MODE) as ReviewFixerMode;
	if (!REVIEW_FIXER_MODES.includes(mode)) {
		throw new Error(`unsupported Fixer mode '${mode}'; expected deep, low, medium, or high`);
	}
	return mode;
}

function resolveReviewFixerMaxConcurrency(env: NodeJS.ProcessEnv): number {
	const value = env[REVIEW_FIXER_MAX_CONCURRENCY_ENV]?.trim() || String(DEFAULT_REVIEW_FIXER_MAX_CONCURRENCY);
	if (value !== "1" && value !== "2") {
		throw new Error(`Fixer concurrency must be 1 or 2 (got '${value}')`);
	}
	return Number(value);
}

function resolveReviewFixerAmpBin(env: NodeJS.ProcessEnv): string {
	return env[REVIEW_FIXER_AMP_BIN_ENV]?.trim() || DEFAULT_REVIEW_FIXER_AMP_BIN;
}

async function pathIsDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function readStateFile(path: string): Promise<ReviewFixerStateFile | null> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ReviewFixerStateFile>;
		if (typeof parsed.task_id !== "string" || typeof parsed.label !== "string") {
			return null;
		}
		return parsed as ReviewFixerStateFile;
	} catch {
		return null;
	}
}

async function writeStateFile(path: string, state: ReviewFixerStateFile): Promise<void> {
	await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function defaultIsRunnerProcessAlive(pid: number, label: string): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	if (process.platform === "win32") {
		return true;
	}
	const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
	if (result.status !== 0) {
		return false;
	}
	return (result.stdout || "").includes(label);
}

function defaultLaunchRunner(input: { statePath: string; label: string; schedulerLogPath: string }): number {
	const commandParts = buildKanbanCommandParts([
		"task",
		"review-fixer-run",
		"--state",
		input.statePath,
		"--label",
		input.label,
	]);
	const logFd = openSync(input.schedulerLogPath, "a");
	try {
		const child = spawn(commandParts[0], commandParts.slice(1), {
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: process.env,
		});
		child.on("error", (error) => {
			void appendFile(
				input.schedulerLogPath,
				`[${formatUtcTimestamp(new Date())}] failed to launch Fixer runner for ${input.statePath}: ${error.message}\n`,
			).catch(() => undefined);
		});
		child.unref();
		if (typeof child.pid !== "number") {
			throw new Error("Fixer runner process did not report a pid.");
		}
		return child.pid;
	} finally {
		try {
			closeSync(logFd);
		} catch {
			// Best effort: the descriptor is inherited by the child already.
		}
	}
}

function buildReviewFixerPrompt(input: {
	taskId: string;
	projectPath: string;
	taskWorkspacePath: string;
	title?: string;
}): string {
	const label = input.title?.trim() ? ` — ${input.title.trim()}` : "";
	const taskId = input.taskId;
	const projectPath = input.projectPath;
	const taskWorkspacePath = input.taskWorkspacePath;
	return `[stepandra/kanban review-ready]
Task ${taskId}${label} has moved to the Review column for project ${projectPath}.

Authoritative task workspace: ${taskWorkspacePath}
This thread is isolated to Kanban task ${taskId}. Do not inspect, review, accept, or discuss any other task.
The project path above scopes the Kanban board; it is not the submitted task workspace. Run every code read, edit, VCS operation, and validation command with workdir exactly ${taskWorkspacePath}. Do not modify the project-root working copy and do not infer a project-local \`.worktrees/\` path. If this is a Jujutsu workspace and jj reports it stale, update only this registered task workspace with \`jj workspace update-stale\` before continuing.

Act as the Fixer/Integrator for this task only. The installed stepandra/kanban fork is the only task, workspace, review, and acceptance source of truth; this process state and its exit code are telemetry only. This Amp thread starts from ${projectPath} only so the plugin can resolve the Kanban board. For every \`kanban_tasks\` call, still pass \`projectPath=${projectPath}\` explicitly, and target every code read, edit, VCS command, and test at ${taskWorkspacePath}. At the start, confirm task ${taskId} is still in Review; if not, exit without mutation.

This is a headless review process with no interactive confirmation channel. First detect the task workspace's existing VCS backend: use Jujutsu only when \`jj root\` succeeds there; otherwise, when \`git rev-parse --show-toplevel\` succeeds, use plain Git. Do not initialize or convert a repository during review.

For a Jujutsu workspace, the task-authorized publication sequence is \`jj describe\`, task-specific bookmark mutation, and \`jj git push\` through \`shell_command\` in ${taskWorkspacePath}; do not invoke confirmation-gated \`jj_describe\`, \`jj_git_push\`, or equivalent interactive tools. Write the task-specific bookmark literally in every mutating or push command (for example, \`jj git push --remote origin --bookmark kanban/${taskId}-...\`); never hide it behind a shell variable, because the headless safety matcher must validate the concrete task ID before execution. Run \`jj git push --remote origin --bookmark kanban/${taskId}-...\` as a standalone shell command, then run remote/hash/bookmark verification in a separate read-only shell command. Never run \`jj git fetch\`, including with \`--dry-run\`, during review publication.

For a plain Git workspace, inspect the current branch/worktree and existing remote first, stage only the reviewed task files, commit them with a task-specific message, create or reset only the local task branch \`kanban/${taskId}-review\` at that verified commit, and run \`git push origin kanban/${taskId}-review\` as a standalone shell command. Never push or move the shared base branch. Verify the exact remote ref and hash separately with \`git ls-remote origin refs/heads/kanban/${taskId}-review\` before acceptance.

The review contract authorizes only the task-specific revision and expected remote/ref. It does not authorize force-push, remote changes, destructive jj or Git operations, unrelated revisions, or any broader confirmation bypass.

Inspect the task-workspace diff and evidence. Repair ordinary in-scope defects yourself; do not return broken work to an unattached writer. Rerun the narrowest checks that establish confidence. Do not accept merely because a worker exited or reported success. An acceptable review must finish through a meaningful description/commit and a confirmed push to the existing expected remote/ref before reviewer-only acceptance. Isolate the task revision from unrelated parent or working-copy changes; use a task-specific bookmark or branch rather than moving a shared base. Never force-push, alter remotes, or mix unrelated changes. Immediately before acceptance, confirm through Kanban again that task ${taskId} is still in Review. If implementation, validation, commit, or push is blocked, leave task ${taskId} in Review and return the one concrete blocker. Only after the exact task-specific remote ref resolves to the verified full commit ID, use \`kanban_tasks\` with \`action=accept\`, \`taskId=${taskId}\`, \`acceptedRevision=<full verified commit ID>\`, \`remoteRef=<exact refs/heads/kanban/${taskId}-... ref>\`, and \`projectPath=${projectPath}\`, then report both commit ID and remote ref. Never use \`action=done\` to accept Review work.`;
}

async function resolveTaskWorkspacePath(
	input: ReviewFixerDispatchInput,
	deps: Required<ReviewFixerSchedulerDeps>,
): Promise<string> {
	if (input.taskWorkspacePath) {
		return input.taskWorkspacePath;
	}
	// Manual recovery path: resolve the jj workspace registry first, then fall
	// back to Kanban's deterministic task-workspace path (and its legacy cline
	// location). Never silently point the Fixer at the board/project root.
	if (deps.isBinaryAvailable("jj")) {
		const resolved = spawnSync("jj", ["workspace", "root", "--name", `kanban-${input.taskId}`], {
			cwd: input.projectPath,
			encoding: "utf8",
		});
		const candidate = resolved.status === 0 ? (resolved.stdout || "").trim() : "";
		if (candidate && (await pathIsDirectory(candidate))) {
			return candidate;
		}
	}
	const dataHome = resolveDataHome(deps.env);
	const modern = join(dataHome, "kanban", "task-workspaces", input.taskId, basename(input.projectPath));
	if (await pathIsDirectory(modern)) {
		return modern;
	}
	const legacy = join(homedir(), ".cline", "worktrees", input.taskId, basename(input.projectPath));
	return legacy;
}

async function finalizeStateLocked(
	dirs: ReviewFixerDirs,
	statePath: string,
	exitCode: number | null,
	deps: Required<ReviewFixerSchedulerDeps>,
): Promise<void> {
	const state = await readStateFile(statePath);
	if (!state) {
		return;
	}
	state.ended_at = formatUtcTimestamp(deps.now());
	state.exit_code = exitCode;
	await writeStateFile(statePath, state);
	const destination = join(
		dirs.exited,
		`${safeName(state.task_id)}.${formatCompactUtcTimestamp(deps.now())}.${process.pid}.json`,
	);
	await rename(statePath, destination);
}

async function reapStaleRunnersLocked(dirs: ReviewFixerDirs, deps: Required<ReviewFixerSchedulerDeps>): Promise<void> {
	for (const entry of await readdir(dirs.running)) {
		if (!entry.endsWith(".json")) {
			continue;
		}
		const statePath = join(dirs.running, entry);
		const state = await readStateFile(statePath);
		if (!state || typeof state.pid !== "number" || !deps.isRunnerProcessAlive(state.pid, state.label)) {
			await finalizeStateLocked(dirs, statePath, null, deps);
		}
	}
}

async function countActiveRunnersLocked(
	dirs: ReviewFixerDirs,
	deps: Required<ReviewFixerSchedulerDeps>,
): Promise<number> {
	let count = 0;
	for (const entry of await readdir(dirs.running)) {
		if (!entry.endsWith(".json")) {
			continue;
		}
		const state = await readStateFile(join(dirs.running, entry));
		if (state && typeof state.pid === "number" && deps.isRunnerProcessAlive(state.pid, state.label)) {
			count += 1;
		}
	}
	return count;
}

async function nextQueuedStateLocked(dirs: ReviewFixerDirs): Promise<string | null> {
	const candidates: Array<{ enqueuedAt: string; name: string; path: string }> = [];
	for (const entry of await readdir(dirs.queue)) {
		if (!entry.endsWith(".json")) {
			continue;
		}
		const path = join(dirs.queue, entry);
		const state = await readStateFile(path);
		if (state) {
			candidates.push({ enqueuedAt: state.enqueued_at || "", name: entry, path });
		}
	}
	candidates.sort((left, right) => {
		const byTime = left.enqueuedAt.localeCompare(right.enqueuedAt);
		return byTime !== 0 ? byTime : left.name.localeCompare(right.name);
	});
	// TODO(BA-16): once the dependency-ordering API lands in
	// src/core/task-board-mutations.ts, prefer dependency-ready queued cards
	// here instead of plain FIFO.
	return candidates[0]?.path ?? null;
}

async function launchQueuedRunnerLocked(
	dirs: ReviewFixerDirs,
	queuedStatePath: string,
	deps: Required<ReviewFixerSchedulerDeps>,
): Promise<void> {
	const state = await readStateFile(queuedStatePath);
	if (!state) {
		throw new Error(`queued Fixer state is missing task_id: ${queuedStatePath}`);
	}
	const runningStatePath = join(dirs.running, basename(queuedStatePath));
	await rename(queuedStatePath, runningStatePath);
	try {
		const pid = deps.launchRunner({
			statePath: runningStatePath,
			label: state.label,
			schedulerLogPath: dirs.schedulerLog,
		});
		state.pid = pid;
		state.started_at = formatUtcTimestamp(deps.now());
		await writeStateFile(runningStatePath, state);
	} catch (error) {
		// Launch failed: requeue so the next drain retries instead of losing the card.
		await rename(runningStatePath, queuedStatePath);
		throw error;
	}
}

async function drainReviewFixerQueue(dirs: ReviewFixerDirs, deps: Required<ReviewFixerSchedulerDeps>): Promise<void> {
	await lockedFileSystem.withLock({ path: dirs.root, type: "directory" }, async () => {
		await reapStaleRunnersLocked(dirs, deps);
		const max = resolveReviewFixerMaxConcurrency(deps.env);
		let active = await countActiveRunnersLocked(dirs, deps);
		while (active < max) {
			const next = await nextQueuedStateLocked(dirs);
			if (!next) {
				break;
			}
			await launchQueuedRunnerLocked(dirs, next, deps);
			active += 1;
		}
	});
}

/**
 * Queue an isolated per-task Fixer after a task enters Review and drain the
 * scheduler up to the concurrency cap. Never accepts the task here; the
 * Fixer/Integrator owns done/commit/push.
 */
export async function dispatchReviewFixer(
	input: ReviewFixerDispatchInput,
	overrides?: ReviewFixerSchedulerDeps,
): Promise<ReviewFixerDispatchResult> {
	const deps = getDeps(overrides);
	const taskId = input.taskId.trim();
	if (!taskId) {
		return { ok: false, error: "review handoff requires a task id" };
	}
	const projectPath = input.projectPath;
	if (!(await pathIsDirectory(projectPath))) {
		return { ok: false, error: `review handoff project path does not exist: ${projectPath}` };
	}
	const taskWorkspacePath = await resolveTaskWorkspacePath({ ...input, taskId }, deps);
	if (!(await pathIsDirectory(taskWorkspacePath))) {
		return { ok: false, error: `review handoff task workspace does not exist: ${taskWorkspacePath}` };
	}

	let mode: ReviewFixerMode;
	try {
		mode = resolveReviewFixerMode(deps.env);
		resolveReviewFixerMaxConcurrency(deps.env);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}

	const ampBin = resolveReviewFixerAmpBin(deps.env);
	if (!deps.isBinaryAvailable(ampBin)) {
		return {
			ok: false,
			error: `${ampBin} is not available on PATH; task is in review but its isolated Fixer was not queued`,
		};
	}

	const dirs = resolveReviewFixerDirs(deps.env);
	const safeTask = safeName(taskId);
	const label = `ar-fixer-${safeTask}`;
	const queueStatePath = join(dirs.queue, `${safeTask}.json`);
	const runningStatePath = join(dirs.running, `${safeTask}.json`);

	try {
		await ensureReviewFixerDirs(dirs);
		let deduplicated = false;
		await lockedFileSystem.withLock({ path: dirs.root, type: "directory" }, async () => {
			await reapStaleRunnersLocked(dirs, deps);
			const queuedState = await readStateFile(queueStatePath);
			const runningState = await readStateFile(runningStatePath);
			if (
				queuedState ||
				(runningState &&
					typeof runningState.pid === "number" &&
					deps.isRunnerProcessAlive(runningState.pid, runningState.label))
			) {
				deduplicated = true;
				return;
			}
			const attempt = `${formatCompactUtcTimestamp(deps.now())}.${process.pid}`;
			const promptFile = join(dirs.prompts, `${safeTask}.${attempt}.prompt`);
			const logFile = join(dirs.logs, `${safeTask}.${attempt}.log`);
			await writeFile(promptFile, `${buildReviewFixerPrompt({ ...input, taskId, taskWorkspacePath })}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			const state: ReviewFixerStateFile = {
				schema: REVIEW_FIXER_STATE_SCHEMA,
				task_id: taskId,
				project_path: projectPath,
				task_workspace_path: taskWorkspacePath,
				title: input.title?.trim() || null,
				label,
				prompt_file: promptFile,
				log_file: logFile,
				mode,
				enqueued_at: formatUtcTimestamp(deps.now()),
			};
			await writeStateFile(queueStatePath, state);
		});
		await drainReviewFixerQueue(dirs, deps);

		let state: ReviewFixerDispatchState = "queued";
		if (deduplicated) {
			state = "deduplicated";
		} else {
			const runningState = await readStateFile(runningStatePath);
			if (
				runningState &&
				typeof runningState.pid === "number" &&
				deps.isRunnerProcessAlive(runningState.pid, runningState.label)
			) {
				state = "running";
			}
		}
		const stateFile = (await readStateFile(runningStatePath)) ?? (await readStateFile(queueStatePath));
		return {
			ok: true,
			action: "review_handoff",
			taskId,
			projectPath,
			taskWorkspacePath,
			state,
			label,
			logFile: stateFile?.log_file,
		};
	} catch (error) {
		return {
			ok: false,
			error: `task is in review but its isolated Fixer was not queued: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Runner for a single queued Fixer. Executes the headless Amp review with the
 * stored prompt, records the exit code into the state file, then drains the
 * queue so the next Review card gets its Fixer. Returns the Amp exit code.
 */
export async function runReviewFixerProcess(input: {
	statePath: string;
	expectedLabel: string;
	overrides?: ReviewFixerSchedulerDeps;
}): Promise<number> {
	const deps = getDeps(input.overrides);
	const state = await readStateFile(input.statePath);
	if (!state) {
		throw new Error("review-fixer-run state file is missing");
	}
	if (state.label !== input.expectedLabel) {
		throw new Error("review-fixer-run label mismatch");
	}
	if (!(await pathIsDirectory(state.project_path))) {
		throw new Error(`review-fixer-run project path does not exist: ${state.project_path}`);
	}
	if (!(await pathIsDirectory(state.task_workspace_path))) {
		throw new Error(`review-fixer-run task workspace does not exist: ${state.task_workspace_path}`);
	}
	const mode = state.mode as ReviewFixerMode;
	if (!REVIEW_FIXER_MODES.includes(mode)) {
		throw new Error(`invalid stored Fixer mode: ${state.mode}`);
	}
	const ampBin = resolveReviewFixerAmpBin(deps.env);
	const dirs = resolveReviewFixerDirs(deps.env);

	// Amp discovers the Kanban project/plugin context from the project root.
	// The review prompt requires every code/jj/test tool call to target the
	// separate authoritative task workspace explicitly.
	const env: NodeJS.ProcessEnv = { ...deps.env };
	delete env.ZELLIJ;
	delete env.ZELLIJ_SESSION_NAME;
	delete env.ZELLIJ_PANE_ID;
	env.KANBAN_REVIEW_TASK_ID = state.task_id;
	env.KANBAN_REVIEW_PROJECT_PATH = state.project_path;
	env.KANBAN_REVIEW_TASK_WORKSPACE_PATH = state.task_workspace_path;

	const promptFd = openSync(state.prompt_file, "r");
	const logFd = openSync(state.log_file, "a");
	let exitCode: number;
	try {
		exitCode = await new Promise<number>((resolveRun, rejectRun) => {
			const child = spawn(
				ampBin,
				[
					"--mode",
					mode,
					"-x",
					"--plugin-ready-timeout",
					"30",
					"--no-archive-after-execute",
					"--no-notifications",
					"--label",
					state.label,
					"--label",
					"kanban-review",
				],
				{
					cwd: state.project_path,
					stdio: [promptFd, logFd, logFd],
					env,
				},
			);
			let settled = false;
			const settle = (callback: () => void) => {
				if (settled) {
					return;
				}
				settled = true;
				callback();
			};
			child.on("error", (error) => {
				settle(() => rejectRun(error));
			});
			child.on("close", (code) => {
				settle(() => resolveRun(code ?? 1));
			});
		});
	} finally {
		closeSync(promptFd);
		closeSync(logFd);
	}

	await lockedFileSystem.withLock({ path: dirs.root, type: "directory" }, async () => {
		await finalizeStateLocked(dirs, input.statePath, exitCode, deps);
	});
	try {
		await drainReviewFixerQueue(dirs, deps);
	} catch (error) {
		await appendFile(
			dirs.schedulerLog,
			`[${formatUtcTimestamp(deps.now())}] post-run drain failed: ${error instanceof Error ? error.message : String(error)}\n`,
		).catch(() => undefined);
	}
	return exitCode;
}
