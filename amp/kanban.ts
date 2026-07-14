import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { PluginAPI } from "@ampcode/plugin";

const KANBAN_TOOL_NAME = "kanban_tasks";
const KANBAN_BIN_ENV = "KANBAN_BIN";

interface KanbanTask {
	id: string;
	prompt: string;
	title?: string;
	agentId?: string;
}

type ProcessResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
	notFound: boolean;
};

export default function (amp: PluginAPI): void {
	const mediumAgent = amp.getBuiltinAgent("medium");

	amp.registerTool({
		name: KANBAN_TOOL_NAME,
		description:
			"Manage tasks on the Kanban board for Amp's current workspace. Use this when the user explicitly asks to list, create, update, link, start, submit for review, accept, or delete Kanban tasks. Assign Amp Orb work with agentId=amp; Claude, Codex, Grok, Kimi, and other local agents use their matching agentId. Executors submit completed work to review; only an accepting reviewer uses done. For decomposition, create concrete independently executable tasks and link only real prerequisites: taskId waits on linkedTaskId. Actions other than list mutate the board.",
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
			},
			required: ["action"],
		},
		async execute(input, ctx) {
			const workspacePath = getWorkspacePath(amp);
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
			}
			const args = buildTaskArgs(input, workspacePath);
			const result = await runKanbanChecked(args, workspacePath);
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
		"Read/write authority: you may edit only files needed for this task. Preserve concurrent user and agent changes.",
		`If and only if the implementation is complete and validation passes, put this receipt on the final line of your final response: ${completionReceipt}`,
		"Do not emit the receipt when blocked, incomplete, cancelled, or validation fails.",
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
		await runKanbanChecked(["task", "submit", "--task-id", taskId, "--project-path", workspacePath], workspacePath);
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

	const npxResult = await runProcess("npx", ["-y", "kanban", ...args], cwd);
	if (npxResult.notFound) {
		throw new Error("Kanban requires either a `kanban` executable or `npx` on Amp's PATH.");
	}
	return npxResult;
}

async function runProcess(command: string, args: string[], cwd: string): Promise<ProcessResult> {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
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
