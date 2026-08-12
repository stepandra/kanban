import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	RuntimeAgentId,
	RuntimeHookEvent,
	RuntimeTaskDeliverableKind,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { buildKanbanCommandParts } from "../core/kanban-command";
import { quoteShellArg } from "../core/shell";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import { configureCodexHooks, hasCodexConfigOverride } from "./codex-hook-config";
import { createHookRuntimeEnv } from "./hook-runtime-context";
import { stripAnsi } from "./output-utils";
import type { SessionTransitionEvent } from "./session-state-machine";
import { prepareTaskPromptWithImages } from "./task-image-prompt";

export interface AgentAdapterLaunchInput {
	taskId: string;
	agentId: RuntimeAgentId;
	binary?: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	projectPath?: string;
	deliverableKind?: RuntimeTaskDeliverableKind;
}

export type AgentOutputTransitionDetector = (
	data: string,
	summary: RuntimeTaskSessionSummary,
) => SessionTransitionEvent | null;

export type AgentOutputTransitionInspectionPredicate = (summary: RuntimeTaskSessionSummary) => boolean;

export interface PreparedAgentLaunch {
	binary?: string;
	args: string[];
	env: Record<string, string | undefined>;
	cleanup?: () => Promise<void>;
	deferredStartupInput?: string;
	detectOutputTransition?: AgentOutputTransitionDetector;
	shouldInspectOutputForTransition?: AgentOutputTransitionInspectionPredicate;
}

interface HookContext {
	taskId: string;
	workspaceId: string;
}

interface HookCommandMetadata {
	source?: string;
	activityText?: string;
	hookEventName?: string;
	notificationType?: string;
}

interface AgentSessionAdapter {
	prepare(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch>;
}

function resolveHookContext(input: AgentAdapterLaunchInput): HookContext | null {
	const workspaceId = input.workspaceId?.trim();
	if (!workspaceId) {
		return null;
	}
	return {
		taskId: input.taskId,
		workspaceId,
	};
}

function buildHookCommand(event: RuntimeHookEvent, metadata?: HookCommandMetadata): string {
	const parts = buildHooksCommandParts(["ingest", "--event", event]);
	if (metadata?.source) {
		parts.push("--source", metadata.source);
	}
	if (metadata?.activityText) {
		parts.push("--activity-text", metadata.activityText);
	}
	if (metadata?.hookEventName) {
		parts.push("--hook-event-name", metadata.hookEventName);
	}
	if (metadata?.notificationType) {
		parts.push("--notification-type", metadata.notificationType);
	}
	return parts.map(quoteShellArg).join(" ");
}

function buildHooksCommandParts(args: string[]): string[] {
	return buildKanbanCommandParts(["hooks", ...args]);
}

function hasCliOption(args: string[], optionName: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === optionName || arg.startsWith(`${optionName}=`)) {
			return true;
		}
	}
	return false;
}

function getHookAgentDirectory(agentId: RuntimeAgentId): string {
	return join(getRuntimeHomePath(), "hooks", agentId);
}

async function ensureTextFile(filePath: string, content: string, executable = false): Promise<void> {
	await lockedFileSystem.writeTextFileAtomic(filePath, content, {
		executable,
	});
}

function withPrompt(args: string[], prompt: string, mode: "append" | "flag", flag?: string): PreparedAgentLaunch {
	const trimmed = prompt.trim();
	if (!trimmed) {
		return {
			args,
			env: {},
		};
	}
	if (mode === "flag" && flag) {
		args.push(flag, trimmed);
	} else {
		args.push(trimmed);
	}
	return {
		args,
		env: {},
	};
}

function withReviewSubmission(prompt: string, input: AgentAdapterLaunchInput): string {
	const projectPath = input.projectPath?.trim();
	if (!projectPath) {
		return prompt;
	}
	const reportPath = join(tmpdir(), "kanban-review-reports", `${input.taskId.replace(/[^A-Za-z0-9._-]/gu, "_")}.md`);
	const submissionParts = ["task", "submit", "--task-id", input.taskId, "--project-path", projectPath];
	if (input.deliverableKind === "read_only_report") {
		submissionParts.push("--report-file", reportPath);
	}
	const command = buildKanbanCommandParts(submissionParts)
		.map((part) => quoteShellArg(part))
		.join(" ");
	const readOnlyInstructions =
		input.deliverableKind === "read_only_report"
			? [
					"This is a read-only deliverable. Do not modify repository files.",
					`Write a non-empty Markdown audit report of at most 262144 bytes to this exact outside-repository path: ${reportPath}`,
				]
			: [];
	return [
		prompt.trim(),
		...readOnlyInstructions,
		"When implementation and validation are complete, you are authorized to run this exact command before your final response:",
		command,
		"This submits the task to Review. Do not accept, discard, commit, or push it yourself.",
	].join("\n\n");
}

function toBracketedPasteSubmission(command: string): string {
	return `\u001b[200~${command}\u001b[201~\r`;
}

const claudeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {
			FORCE_HYPERLINK: "1",
		};
		if (input.autonomousModeEnabled) {
			// Auto mode is gated behind this env var on Bedrock/Vertex/Foundry; the Anthropic API ignores it.
			env.CLAUDE_CODE_ENABLE_AUTO_MODE = "1";
		}
		if (
			input.autonomousModeEnabled &&
			!input.startInPlanMode &&
			!hasCliOption(args, "--permission-mode") &&
			!hasCliOption(args, "--dangerously-skip-permissions")
		) {
			args.push("--permission-mode", "auto");
		}
		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}
		if (input.startInPlanMode) {
			const withoutImmediateBypass = args.filter((arg) => arg !== "--dangerously-skip-permissions");
			args.length = 0;
			args.push(...withoutImmediateBypass);
			args.push("--permission-mode", "plan");
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const settingsPath = join(getHookAgentDirectory("claude"), "settings.json");
			const hooksSettings = {
				hooks: {
					Stop: [{ hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }] }],
					SubagentStop: [
						{ hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }] },
					],
					PreToolUse: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					PermissionRequest: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
					],
					PostToolUse: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					PostToolUseFailure: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					Notification: [
						{
							matcher: "permission_prompt",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					UserPromptSubmit: [
						{
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
				},
			};
			await ensureTextFile(settingsPath, JSON.stringify(hooksSettings, null, 2));
			args.push("--settings", settingsPath);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		const withPromptLaunch = withPrompt(args, input.prompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

const grokAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};
		if (input.autonomousModeEnabled && !hasCliOption(args, "--always-approve")) {
			args.push("--always-approve");
		}
		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			Object.assign(env, createHookRuntimeEnv(hooks));
		}
		const prompt = input.prompt;
		if (input.startInPlanMode) {
			return {
				binary: input.binary,
				args,
				env,
				deferredStartupInput: toBracketedPasteSubmission(`/plan ${prompt}`),
			};
		}
		// Current grok CLI has no `--prompt`. Positional PROMPT starts a durable
		// TUI session; `-p`/`--single` and `--prompt-file` are one-shot and exit.
		const launch = withPrompt(args, prompt, "append");
		return {
			...launch,
			env: { ...launch.env, ...env },
		};
	},
};

const kimiAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};
		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			Object.assign(env, createHookRuntimeEnv(hooks));
		}
		const prompt = input.prompt;
		if (input.startInPlanMode) {
			if (!hasCliOption(args, "--plan")) {
				args.push("--plan");
			}
			return {
				binary: input.binary,
				args,
				env,
				deferredStartupInput: toBracketedPasteSubmission(prompt),
			};
		}
		if (!input.autonomousModeEnabled) {
			return {
				binary: input.binary,
				args,
				env,
				deferredStartupInput: toBracketedPasteSubmission(prompt),
			};
		}
		// Kimi prompt mode is already autonomous and rejects --prompt when
		// combined with either --auto or --yolo.
		const launch = withPrompt(args, prompt, "flag", "--prompt");
		return {
			...launch,
			env: { ...launch.env, ...env },
		};
	},
};

const ampAdapter: AgentSessionAdapter = {
	async prepare() {
		throw new Error(
			"Amp task executor IDs are retained only for persisted compatibility. Amp no longer launches per-task workers; reassign this task to grok, kimi, claude, or codex before starting it.",
		);
	},
};

const launchDisabledCompatibilityAdapter: AgentSessionAdapter = {
	async prepare(input) {
		throw new Error(
			`Agent "${input.agentId}" is launch-disabled and retained only for persisted compatibility. Reassign this task to grok, kimi, claude, or codex before starting it.`,
		);
	},
};

function codexPromptDetector(data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null {
	const stripped = stripAnsi(data);
	if (summary.state === "running" && /Hooks need review|hooks? (?:is|are) new or changed/i.test(stripped)) {
		return { type: "agent.attention-required" };
	}
	if (summary.state !== "awaiting_review") {
		return null;
	}
	if (summary.reviewReason !== "attention" && summary.reviewReason !== "hook") {
		return null;
	}
	if (/(?:^|\n)\s*›/.test(stripped)) {
		return { type: "agent.prompt-ready" };
	}
	return null;
}

function shouldInspectCodexOutputForTransition(summary: RuntimeTaskSessionSummary): boolean {
	return (
		summary.state === "running" ||
		(summary.state === "awaiting_review" &&
			(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error"))
	);
}

const codexAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const codexArgs = [...input.args];
		const env: Record<string, string | undefined> = {};
		const binary = input.binary;
		let deferredStartupInput: string | undefined;

		if (!hasCodexConfigOverride(codexArgs, "check_for_update_on_startup")) {
			codexArgs.push("-c", "check_for_update_on_startup=false");
		}

		if (input.autonomousModeEnabled && !hasCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox")) {
			codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
		}

		if (input.resumeFromTrash) {
			if (!codexArgs.includes("resume")) {
				codexArgs.push("resume");
			}
			if (!hasCliOption(codexArgs, "--last")) {
				codexArgs.push("--last");
			}
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			configureCodexHooks(codexArgs);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		const trimmed = input.prompt.trim();
		if (input.startInPlanMode) {
			const planCommand = trimmed ? `/plan ${trimmed}` : "/plan";
			deferredStartupInput = toBracketedPasteSubmission(planCommand);
		} else if (trimmed) {
			codexArgs.push(trimmed);
		}

		if (hooks) {
			return {
				binary,
				args: codexArgs,
				env,
				deferredStartupInput,
				detectOutputTransition: codexPromptDetector,
				shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
			};
		}

		return {
			binary,
			args: codexArgs,
			env,
			deferredStartupInput,
			detectOutputTransition: codexPromptDetector,
			shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
		};
	},
};

function getAgentSessionAdapter(agentId: RuntimeAgentId): AgentSessionAdapter {
	switch (agentId) {
		case "grok":
			return grokAdapter;
		case "kimi":
			return kimiAdapter;
		case "claude":
			return claudeAdapter;
		case "codex":
			return codexAdapter;
		case "amp":
			return ampAdapter;
		case "gemini":
		case "opencode":
		case "droid":
		case "kiro":
			return launchDisabledCompatibilityAdapter;
	}
}

export async function prepareAgentLaunch(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> {
	const adapter = getAgentSessionAdapter(input.agentId);
	if (adapter === ampAdapter || adapter === launchDisabledCompatibilityAdapter) {
		return await adapter.prepare(input);
	}
	const preparedPrompt = await prepareTaskPromptWithImages({
		prompt: input.prompt,
		images: input.images,
	});
	return await adapter.prepare({
		...input,
		prompt: withReviewSubmission(preparedPrompt, input),
	});
}
