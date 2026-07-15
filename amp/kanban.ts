import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { PluginAPI } from "@ampcode/plugin";

const KANBAN_TOOL_NAME = "kanban_tasks";
const KANBAN_BIN_ENV = "KANBAN_BIN";
const ZJ_AGENT_BIN_ENV = "ZJ_AGENT_BIN";
const INTERACTIVE_ZELLIJ_AGENTS = new Set(["claude", "codex", "grok", "kimi"]);
const KANBAN_REPOSITORY = "https://github.com/stepandra/kanban";
const KANBAN_CONTEXT = `[stepandra/kanban]
In this environment, Kanban means the installed stepandra/kanban fork of cline/kanban, not upstream cline/kanban and not Hermes.
The kanban_tasks tool and local kanban CLI are the durable source of truth for tasks, dependencies, task workspaces, review, and acceptance.
Interactive Codex, Claude, Grok, and Kimi task execution is handed to the zj-agent native Zellij controller after Kanban prepares the task workspace.
Submitting a task to Review hands it to an isolated per-task Fixer Amp thread; the worker never accepts its own task.`;

interface KanbanTask {
	id: string;
	prompt: string;
	title?: string;
	agentId?: string;
	startInPlanMode?: boolean;
	taskWorkspacePath?: string;
	taskWorkspaceExists?: boolean;
}

interface PreparedKanbanTask extends KanbanTask {
	projectPath: string;
	taskWorkspacePath: string;
}

type ProcessResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
	notFound: boolean;
};

export default function (amp: PluginAPI): void {
	const mediumAgent = amp.getBuiltinAgent("medium");

	amp.on("agent.start", async () => ({
		message: {
			content: KANBAN_CONTEXT,
			display: false,
		},
	}));

	amp.registerTool({
		name: KANBAN_TOOL_NAME,
		description:
			`Manage tasks with the installed stepandra/kanban fork of cline/kanban (${KANBAN_REPOSITORY}) for Amp's current workspace or an explicit Kanban project path. This never means Hermes or upstream cline/kanban. Use this when the user explicitly asks to list, create, update, link, start, submit for review, accept, or delete Kanban tasks. Assign Amp Orb work with agentId=amp; Claude, Codex, Grok, Kimi, and other local agents use their matching agentId. Executors submit completed work to review, which hands the task to an isolated per-task Fixer Amp thread; only that accepting reviewer uses done. For decomposition, create concrete independently executable tasks and link only real prerequisites: taskId waits on linkedTaskId. Actions other than list mutate the board.`,
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["list", "create", "update", "claim", "submit", "done", "delete", "link", "unlink", "start"],
					description: "Kanban task operation to perform.",
				},
				taskId: { type: "string", description: "Task ID for update, claim, submit, done, delete, link, or start." },
				linkedTaskId: {
					type: "string",
					description: "Prerequisite task ID for link. taskId waits on linkedTaskId.",
				},
				dependencyId: { type: "string", description: "Dependency ID for unlink." },
				column: {
					type: "string",
					enum: ["backlog", "in_progress", "review", "done", "trash"],
					description: "Optional list filter, or bulk target for done/delete.",
				},
				title: { type: "string", description: "Optional task title for create/update." },
				prompt: { type: "string", description: "Task instructions for create/update." },
				agentId: {
					type: "string",
					enum: ["amp", "claude", "codex", "grok", "kimi", "cline", "droid", "kiro", "gemini", "opencode"],
					description: "Executor for create/update. amp runs the task in an Orb; other values select a local Kanban agent.",
				},
				baseRef: { type: "string", description: "Optional base revision for create/update." },
				startInPlanMode: { type: "boolean", description: "Whether the task agent starts in plan mode." },
				autoReviewEnabled: {
					type: "boolean",
					description: "Whether Kanban automatically commits or opens a PR after review.",
				},
				autoReviewMode: {
					type: "string",
					enum: ["commit", "pr"],
					description: "Automatic review action.",
				},
				projectPath: {
					type: "string",
					description:
						"Explicit Kanban project/board root. Use this from a task workspace so board operations remain scoped to the owning project.",
				},
			},
			required: ["action"],
		},
		async execute(input, ctx) {
			const workspacePath = getProjectPath(input, getWorkspacePath(amp));
			const action = requiredString(input, "action");
			if (action === "start") {
				const taskId = requiredString(input, "taskId");
				const task = await getTask(taskId, workspacePath);
				if (task.agentId === "amp") {
					const completionReceipt = `[kanban:submit:${taskId}:${randomUUID()}]`;
					const thread = await mediumAgent.createThread({
						parentThreadID: ctx.thread.id,
						executor: "orb",
					});
					await runKanbanChecked(["task", "claim", "--task-id", taskId, "--project-path", workspacePath], workspacePath);
					await thread.appendUserMessage({
						type: "user-message",
						content: buildAmpTaskPrompt(task, completionReceipt),
					});
					void watchAmpTask(amp, thread, taskId, workspacePath, completionReceipt);
					return JSON.stringify({
						ok: true,
						taskId,
						column: "in_progress",
						agentId: "amp",
						executor: "orb",
						threadId: thread.id,
					});
				}
				if (task.agentId && INTERACTIVE_ZELLIJ_AGENTS.has(task.agentId)) {
					await runZjAgentChecked(["controller", "inspect", task.agentId], workspacePath);
					const prepared = await prepareInteractiveTask(taskId, workspacePath);
					const workerPrompt = buildInteractiveTaskPrompt(prepared);
					const result = await runZjAgentChecked(
						[
							"controller",
							"spawn",
							"--agent",
							task.agentId,
							"--lane",
							task.agentId,
							"--cwd",
							prepared.taskWorkspacePath,
							"--task-id",
							taskId,
							"--project-path",
							workspacePath,
							"--prompt-file",
							"-",
						],
						workspacePath,
						prepared.startInPlanMode ? `/plan ${workerPrompt}` : workerPrompt,
					);
					return result.stdout.trim() || "Interactive Zellij worker started.";
				}
			}
			const transitionedTask =
				(action === "submit" || action === "done") && typeof input.taskId === "string"
					? await getTask(input.taskId, workspacePath)
					: undefined;
			const args = buildTaskArgs(input, workspacePath);
			const result = await runKanbanChecked(args, workspacePath);
			// `kanban task submit` owns the isolated per-task review handoff (fail-closed in CLI).
			// Surface a failed handoff from the CLI JSON when present; do not double-nudge.
			if (action === "submit") {
				const handoffStatus = parseReviewHandoffStatus(result.stdout);
				if (handoffStatus && handoffStatus.ok === false) {
					amp.logger.log(
						`Kanban submitted task ${transitionedTask?.id ?? "unknown"} to review, but its isolated Fixer handoff failed: ${String(handoffStatus.error ?? "unknown")}`,
					);
				}
			}
			if (transitionedTask?.agentId && INTERACTIVE_ZELLIJ_AGENTS.has(transitionedTask.agentId)) {
				const controllerAction = action === "submit" ? "review" : "release";
				try {
					await runZjAgentChecked(
						["controller", controllerAction, "--task-id", transitionedTask.id],
						workspacePath,
					);
				} catch (error) {
					amp.logger.log(
						`Kanban moved task ${transitionedTask.id} with ${action}, but its Zellij lane could not enter ${controllerAction}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			return result.stdout.trim() || "Kanban command completed.";
		},
	});

	amp.registerCommand(
		"decompose-into-kanban-tasks",
		{
			title: "Decompose into tasks",
			category: "Kanban",
			description: "Open a native Amp medium thread that turns a request into Kanban tasks.",
		},
		async (ctx) => {
			const workspacePath = getWorkspacePath(amp);
			const request = await ctx.ui.input({
				title: "What should Amp decompose?",
				helpText: `Tasks will be created in the Kanban board for ${workspacePath}.`,
				submitButtonText: "Plan tasks",
			});
			if (!request?.trim()) {
				return;
			}

			const thread = await mediumAgent.createThread({
				parentThreadID: ctx.thread?.id,
				show: true,
			});
			await thread.appendUserMessage({
				type: "user-message",
				content: [
					"Decompose the request below into the smallest useful set of concrete Kanban tasks.",
					"Inspect the workspace only as needed to make task boundaries accurate; do not implement the work.",
					`Use the ${KANBAN_TOOL_NAME} tool to create the tasks now. Make independent work parallel and link only real prerequisites (taskId waits on linkedTaskId).`,
					"Do not start tasks unless the request explicitly asks you to start them.",
					"",
					request.trim(),
				].join("\n"),
			});
		},
	);
}

function getWorkspacePath(amp: PluginAPI): string {
	const workspaceRoot = amp.system.workspaceRoot;
	if (!workspaceRoot) {
		throw new Error("Open a workspace in Amp before using Kanban.");
	}
	return amp.helpers.filePathFromURI(workspaceRoot);
}

function getProjectPath(input: Record<string, unknown>, workspacePath: string): string {
	const explicitProjectPath = optionalString(input.projectPath);
	return explicitProjectPath ? resolve(workspacePath, explicitProjectPath) : workspacePath;
}

function buildTaskArgs(input: Record<string, unknown>, workspacePath: string): string[] {
	const action = requiredString(input, "action");
	const args = ["task", action];

	switch (action) {
		case "list":
			appendStringOption(args, "--column", input.column);
			break;
		case "create":
			appendStringOption(args, "--title", input.title);
			args.push("--prompt", requiredString(input, "prompt"));
			appendTaskOptions(args, input);
			break;
		case "update":
			args.push("--task-id", requiredString(input, "taskId"));
			appendStringOption(args, "--title", input.title);
			appendStringOption(args, "--prompt", input.prompt);
			appendTaskOptions(args, input);
			break;
		case "claim":
		case "submit":
			args.push("--task-id", requiredString(input, "taskId"));
			break;
		case "done":
		case "delete":
			appendExactlyOneTarget(args, input);
			break;
		case "link":
			args.push("--task-id", requiredString(input, "taskId"));
			args.push("--linked-task-id", requiredString(input, "linkedTaskId"));
			break;
		case "unlink":
			args.push("--dependency-id", requiredString(input, "dependencyId"));
			break;
		case "start":
			args.push("--task-id", requiredString(input, "taskId"));
			break;
		default:
			throw new Error(`Unsupported Kanban action: ${action}`);
	}

	args.push("--project-path", workspacePath);
	return args;
}

function appendTaskOptions(args: string[], input: Record<string, unknown>): void {
	appendStringOption(args, "--base-ref", input.baseRef);
	appendStringOption(args, "--agent-id", input.agentId);
	appendBooleanOption(args, "--start-in-plan-mode", input.startInPlanMode);
	appendBooleanOption(args, "--auto-review-enabled", input.autoReviewEnabled);
	appendStringOption(args, "--auto-review-mode", input.autoReviewMode);
}

function appendExactlyOneTarget(args: string[], input: Record<string, unknown>): void {
	const taskId = optionalString(input.taskId);
	const column = optionalString(input.column);
	if (Boolean(taskId) === Boolean(column)) {
		throw new Error("Provide exactly one of taskId or column.");
	}
	if (taskId) {
		args.push("--task-id", taskId);
	} else if (column) {
		args.push("--column", column);
	}
}

function appendStringOption(args: string[], flag: string, value: unknown): void {
	const normalized = optionalString(value);
	if (normalized) {
		args.push(flag, normalized);
	}
}

function appendBooleanOption(args: string[], flag: string, value: unknown): void {
	if (typeof value === "boolean") {
		args.push(flag, String(value));
	}
}

function requiredString(input: Record<string, unknown>, key: string): string {
	const value = optionalString(input[key]);
	if (!value) {
		throw new Error(`Missing required ${key}.`);
	}
	return value;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function runKanbanChecked(args: string[], cwd: string): Promise<ProcessResult> {
	const result = await runKanban(args, cwd);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `Kanban exited with code ${result.exitCode}.`);
	}
	return result;
}

async function getTask(taskId: string, workspacePath: string): Promise<KanbanTask> {
	const result = await runKanbanChecked(["task", "list", "--project-path", workspacePath], workspacePath);
	let payload: unknown;
	try {
		payload = JSON.parse(result.stdout);
	} catch {
		throw new Error("Kanban returned invalid JSON while resolving the task.");
	}
	if (!isRecord(payload) || !Array.isArray(payload.tasks)) {
		throw new Error("Kanban task list response is missing tasks.");
	}
	const task = payload.tasks.find((candidate): candidate is KanbanTask => {
		return isRecord(candidate) && candidate.id === taskId && typeof candidate.prompt === "string";
	});
	if (!task) {
		throw new Error(`Kanban task "${taskId}" was not found.`);
	}
	return task;
}

async function prepareInteractiveTask(taskId: string, workspacePath: string): Promise<PreparedKanbanTask> {
	const result = await runKanbanChecked(
		["task", "prepare", "--task-id", taskId, "--project-path", workspacePath],
		workspacePath,
	);
	let payload: unknown;
	try {
		payload = JSON.parse(result.stdout);
	} catch {
		throw new Error("Kanban returned invalid JSON while preparing the task workspace.");
	}
	if (!isRecord(payload) || !isRecord(payload.task)) {
		throw new Error("Kanban task prepare response is missing the task.");
	}
	const task = payload.task;
	if (
		typeof task.id !== "string" ||
		typeof task.prompt !== "string" ||
		typeof task.projectPath !== "string" ||
		typeof task.taskWorkspacePath !== "string"
	) {
		throw new Error("Kanban task prepare response has an invalid task shape.");
	}
	return task as unknown as PreparedKanbanTask;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildAmpTaskPrompt(task: KanbanTask, completionReceipt: string): string {
	return [
		"Role: bounded implementation worker.",
		`Goal: ${task.title?.trim() || task.prompt.trim()}`,
		`Scope: implement only this Kanban task in the current repository.\n\n${task.prompt.trim()}`,
		"Non-goals: do not create or accept Kanban tasks, broaden scope, or modify unrelated work.",
		"Expected output: the implementation, the narrowest relevant validation, and a concise handoff with files changed and any blocker.",
		"Timeout/budget: one bounded implementation run; stop and report instead of silently broadening scope or looping on a failed check.",
		"Read/write authority: you may edit only files needed for this task. Preserve concurrent user and agent changes.",
		`If and only if the implementation is complete and validation passes, put this receipt on the final line of your final response: ${completionReceipt}`,
		"Do not emit the receipt when blocked, incomplete, cancelled, or validation fails.",
	].join("\n\n");
}

function buildInteractiveTaskPrompt(task: PreparedKanbanTask): string {
	const submitCommand = [
		"kanban task submit",
		`--task-id ${shellQuote(task.id)}`,
		`--project-path ${shellQuote(task.projectPath)}`,
	].join(" ");
	return [
		"Role: bounded implementation worker in an interactive Zellij lane.",
		`Goal: ${task.title?.trim() || task.prompt.trim()}`,
		`Scope: implement only this Kanban task in the current task workspace.\n\n${task.prompt.trim()}`,
		"Non-goals: do not create, accept, or mark Kanban tasks done; do not broaden scope or modify unrelated work.",
		"Expected output: the implementation, the narrowest relevant validation, and a concise handoff with files changed and any blocker.",
		"Shared-host validation budget: run exact affected tests first (cap Vitest at 2 workers); run a package-wide test suite or production build at most once, only after focused checks pass, and never loop on a saturated or stalled full check. Report shared-host contention honestly instead of spending the task budget rerunning it.",
		"Timeout/budget: one bounded implementation run; stop and report instead of silently broadening scope or looping on a failed check.",
		"Read/write authority: you may edit only files needed for this task. Preserve concurrent user and agent changes.",
		`When and only when implementation and validation are complete, submit the task for review with:\n${submitCommand}`,
		"That submit moves the card to Review and automatically queues an isolated per-task Fixer thread; do not call review-handoff yourself unless submit reports handoff failure.",
		`Then update the ephemeral cockpit indicator (best effort only):\nzj-agent controller review --task-id ${shellQuote(task.id)} || true`,
		"If blocked, incomplete, cancelled, or validation fails, leave the task in progress and report the blocker. Never run `kanban task done`; acceptance belongs to the reviewer.",
	].join("\n\n");
}

async function watchAmpTask(
	amp: PluginAPI,
	thread: Awaited<ReturnType<ReturnType<PluginAPI["getBuiltinAgent"]>["createThread"]>>,
	taskId: string,
	workspacePath: string,
	completionReceipt: string,
): Promise<void> {
	try {
		const response = await thread.waitForResponse({ timeoutMs: 24 * 60 * 60 * 1_000 });
		const text = response.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		if (!text.trimEnd().endsWith(completionReceipt)) {
			amp.logger.log(`Amp Orb thread ${thread.id} left Kanban task ${taskId} in progress.`);
			return;
		}
		const submitResult = await runKanbanChecked(
			["task", "submit", "--task-id", taskId, "--project-path", workspacePath],
			workspacePath,
		);
		const handoffStatus = parseReviewHandoffStatus(submitResult.stdout);
		if (handoffStatus && handoffStatus.ok === false) {
			amp.logger.log(
				`Amp Orb thread ${thread.id} submitted Kanban task ${taskId}, but its isolated Fixer did not receive the review handoff: ${String(handoffStatus.error ?? "unknown")}`,
			);
			return;
		}
		amp.logger.log(`Amp Orb thread ${thread.id} submitted Kanban task ${taskId} for review.`);
	} catch (error) {
		amp.logger.log(
			`Amp Orb thread ${thread.id} did not submit Kanban task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function runKanban(args: string[], cwd: string): Promise<ProcessResult> {
	const configuredBinary = process.env[KANBAN_BIN_ENV]?.trim();
	if (configuredBinary) {
		const configuredResult = await runProcess(configuredBinary, args, cwd);
		if (configuredResult.notFound) {
			throw new Error(`${KANBAN_BIN_ENV} points to a missing executable: ${configuredBinary}`);
		}
		return configuredResult;
	}

	const installedResult = await runProcess("kanban", args, cwd);
	if (!installedResult.notFound) {
		return installedResult;
	}

	throw new Error(
		`The stepandra/kanban fork is not installed on Amp's PATH. Install ${KANBAN_REPOSITORY} or set ${KANBAN_BIN_ENV} to its executable; refusing to fall back to an unrelated npm package.`,
	);
}

async function runZjAgentChecked(args: string[], cwd: string, stdin?: string): Promise<ProcessResult> {
	const command = process.env[ZJ_AGENT_BIN_ENV]?.trim() || "zj-agent";
	const result = await runProcess(command, args, cwd, stdin);
	if (result.notFound) {
		throw new Error(`${command} is not available on Amp's PATH.`);
	}
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `zj-agent exited with code ${result.exitCode}.`);
	}
	return result;
}

function parseReviewHandoffStatus(stdout: string): { ok?: boolean; error?: unknown } | undefined {
	const trimmed = stdout.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(trimmed) as { reviewHandoff?: { ok?: boolean; error?: unknown } };
		return parsed.reviewHandoff;
	} catch {
		return undefined;
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function runProcess(command: string, args: string[], cwd: string, stdin?: string): Promise<ProcessResult> {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: process.env,
			stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		if (stdin !== undefined) {
			child.stdin?.end(stdin);
		}
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (settled) {
				return;
			}
			settled = true;
			if (error.code === "ENOENT") {
				resolve({ exitCode: 127, stdout, stderr, notFound: true });
				return;
			}
			reject(error);
		});
		child.on("close", (exitCode) => {
			if (settled) {
				return;
			}
			settled = true;
			resolve({ exitCode: exitCode ?? 1, stdout, stderr, notFound: false });
		});
	});
}
