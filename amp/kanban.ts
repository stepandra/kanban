import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type { PluginAPI } from "@ampcode/plugin";

const KANBAN_TOOL_NAME = "kanban_tasks";
const KANBAN_BIN_ENV = "KANBAN_BIN";
const KANBAN_EXPECTED_REVISION_ENV = "KANBAN_EXPECTED_REVISION";
const KANBAN_REPOSITORY = "https://github.com/stepandra/kanban";
const KANBAN_PROVENANCE_SCHEMA = "stepandra-kanban-provenance/v1";
const KANBAN_PLUGIN_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXACT_GIT_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

type ProcessResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
	notFound: boolean;
};

interface KanbanProvenance {
	schema: typeof KANBAN_PROVENANCE_SCHEMA;
	repository: typeof KANBAN_REPOSITORY;
	version: string;
	revision: string;
}

export default function (amp: PluginAPI): void {
	const mediumAgent = amp.getBuiltinAgent("medium");

	amp.registerTool({
		name: KANBAN_TOOL_NAME,
		description:
			`Manage tasks with the installed stepandra/kanban application (${KANBAN_REPOSITORY}) for Amp's current workspace or an explicit Kanban project path. This never means Hermes or another task board. Kanban is the durable source of truth for task state, dependencies, workspaces, execution, review, and acceptance. Start assigned work only through this tool; do not launch an agent from Amp, Juja, Zellij, zmx, or a shell. Prefer Grok Build for implementation. For decomposition, create concrete independently executable tasks and link only real prerequisites: taskId waits on linkedTaskId. Actions other than list mutate the board.`,
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"list",
						"create",
						"update",
						"claim",
						"submit",
						"accept",
						"accept_read_only",
						"trash",
						"link",
						"unlink",
						"start",
					],
					description: "Kanban task operation to perform.",
				},
				taskId: {
					type: "string",
					description: "Task ID for update, claim, submit, accept, trash, link, or start.",
				},
				linkedTaskId: {
					type: "string",
					description: "Prerequisite task ID for link. taskId waits on linkedTaskId.",
				},
				dependencyId: { type: "string", description: "Dependency ID for unlink." },
				column: {
					type: "string",
					enum: ["backlog", "in_progress", "review", "trash"],
					description: "Optional list filter, or bulk target for trash.",
				},
				title: { type: "string", description: "Optional task title for create/update." },
				prompt: { type: "string", description: "Task instructions for create/update." },
				agentId: {
					type: "string",
					enum: ["grok", "kimi", "claude", "codex"],
					description: "Kanban implementation harness for create/update; prefer grok.",
				},
				baseRef: { type: "string", description: "Optional base revision for create/update." },
				deliverableKind: {
					type: "string",
					enum: ["change", "read_only_report"],
					description: "Explicit task deliverable contract for create/update.",
				},
				reportFile: {
					type: "string",
					description: "Outside-repository Markdown report path for submit.",
				},
				startInPlanMode: { type: "boolean", description: "Whether the task agent starts in plan mode." },
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
			const args = buildTaskArgs(
				input,
				workspacePath,
				action === "create" || action === "accept" || action === "accept_read_only" ? ctx.thread.id : undefined,
			);
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

function getProjectPath(input: Record<string, unknown>, workspacePath: string): string {
	const explicitProjectPath = optionalString(input.projectPath);
	return explicitProjectPath ? resolve(workspacePath, explicitProjectPath) : workspacePath;
}

export function buildTaskArgs(
	input: Record<string, unknown>,
	workspacePath: string,
	ampArchitectThreadId?: string,
): string[] {
	const action = requiredString(input, "action");
	const args = ["task", action === "accept_read_only" ? "accept" : action];

	switch (action) {
		case "list":
			appendStringOption(args, "--column", input.column);
			break;
		case "create":
			appendStringOption(args, "--title", input.title);
			args.push("--prompt", requiredString(input, "prompt"));
			appendTaskOptions(args, input);
			if (ampArchitectThreadId) {
				args.push("--origin-amp-thread-id", ampArchitectThreadId);
			}
			break;
		case "update":
			args.push("--task-id", requiredString(input, "taskId"));
			appendStringOption(args, "--title", input.title);
			appendStringOption(args, "--prompt", input.prompt);
			appendTaskOptions(args, input);
			break;
		case "claim":
			args.push("--task-id", requiredString(input, "taskId"));
			break;
		case "submit":
			args.push("--task-id", requiredString(input, "taskId"));
			appendStringOption(args, "--report-file", input.reportFile);
			break;
		case "accept":
		case "accept_read_only":
			args.push("--task-id", requiredString(input, "taskId"));
			if (!ampArchitectThreadId) {
				throw new Error("Acceptance requires the current Amp Architect thread context.");
			}
			args.push("--origin-amp-thread-id", ampArchitectThreadId);
			break;
		case "trash":
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
	appendStringOption(args, "--deliverable-kind", input.deliverableKind);
	appendBooleanOption(args, "--start-in-plan-mode", input.startInPlanMode);
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
	const provenanceResult = await runKanban(["provenance", "--json"], cwd);
	if (provenanceResult.exitCode !== 0) {
		throw new Error(
			provenanceResult.stderr.trim() ||
				provenanceResult.stdout.trim() ||
				"Kanban executable does not implement the required provenance contract.",
		);
	}
	const provenance = parseKanbanProvenance(provenanceResult.stdout);
	const expectedRevision = await resolveExpectedKanbanRevision();
	assertExpectedKanbanRevision(provenance, expectedRevision);
	const result = await runKanban(args, cwd);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `Kanban exited with code ${result.exitCode}.`);
	}
	return result;
}

export function assertExpectedKanbanRevision(provenance: KanbanProvenance, expectedRevision: string): void {
	if (provenance.revision !== expectedRevision) {
		throw new Error(
			`Refusing Kanban executable built from ${provenance.revision}; this plugin requires ${expectedRevision}. Rebuild and reinstall the exact checked-out revision.`,
		);
	}
}

async function resolveExpectedKanbanRevision(): Promise<string> {
	const configuredRevision = process.env[KANBAN_EXPECTED_REVISION_ENV]?.trim().toLowerCase();
	if (configuredRevision) {
		if (!EXACT_GIT_REVISION_PATTERN.test(configuredRevision)) {
			throw new Error(`${KANBAN_EXPECTED_REVISION_ENV} must be a full 40- or 64-character Git revision.`);
		}
		return configuredRevision;
	}
	const sourceRevision = await runProcess("git", ["rev-parse", "HEAD"], KANBAN_PLUGIN_REPOSITORY_ROOT);
	const normalizedRevision = sourceRevision.stdout.trim().toLowerCase();
	if (sourceRevision.exitCode === 0 && EXACT_GIT_REVISION_PATTERN.test(normalizedRevision)) {
		return normalizedRevision;
	}
	const jjRevision = await runProcess(
		"jj",
		["--no-pager", "log", "--no-graph", "-r", "@", "-T", "commit_id"],
		KANBAN_PLUGIN_REPOSITORY_ROOT,
	);
	const normalizedJjRevision = jjRevision.stdout.trim().toLowerCase();
	if (jjRevision.exitCode === 0 && EXACT_GIT_REVISION_PATTERN.test(normalizedJjRevision)) {
		return normalizedJjRevision;
	}
	throw new Error(
		`Cannot determine the exact Kanban revision required by this plugin. Set ${KANBAN_EXPECTED_REVISION_ENV} to the published revision.`,
	);
}

export function parseKanbanProvenance(stdout: string): KanbanProvenance {
	let payload: unknown;
	try {
		payload = JSON.parse(stdout);
	} catch {
		throw new Error("Kanban executable returned malformed provenance JSON.");
	}
	if (!payload || typeof payload !== "object") {
		throw new Error("Kanban executable returned invalid provenance data.");
	}
	const candidate = payload as Record<string, unknown>;
	if (candidate.schema !== KANBAN_PROVENANCE_SCHEMA || candidate.repository !== KANBAN_REPOSITORY) {
		throw new Error(
			`Refusing Kanban executable with provenance ${String(candidate.repository ?? "unknown")} / ${String(candidate.schema ?? "unknown")}; expected ${KANBAN_REPOSITORY} / ${KANBAN_PROVENANCE_SCHEMA}.`,
		);
	}
	if (
		typeof candidate.version !== "string" ||
		!candidate.version.trim() ||
		typeof candidate.revision !== "string" ||
		!candidate.revision.trim() ||
		candidate.revision === "unknown" ||
		candidate.revision === "development"
	) {
		throw new Error("Kanban executable provenance must include an exact release version and build revision.");
	}
	return {
		schema: KANBAN_PROVENANCE_SCHEMA,
		repository: KANBAN_REPOSITORY,
		version: candidate.version,
		revision: candidate.revision,
	};
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

		if (!child.stdout || !child.stderr) {
			reject(new Error("Kanban process did not expose stdout/stderr."));
			return;
		}

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
