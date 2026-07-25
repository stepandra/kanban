import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeHookEvent } from "../core/api-contract";
import { buildKanbanCommandParts } from "../core/kanban-command";
import { quoteShellArg } from "../core/shell";

const CODEX_HOOK_TIMEOUT_SECONDS = 5;

type CodexHookConfigEvent = "PermissionRequest" | "PostToolUse" | "PreToolUse" | "Stop" | "UserPromptSubmit";

type JsonValue = JsonPrimitive | JsonArray | JsonObject;
type JsonPrimitive = boolean | null | number | string;
type JsonArray = JsonValue[];
interface JsonObject {
	[key: string]: JsonValue;
}

interface CodexHookConfig {
	eventName: CodexHookConfigEvent;
	matcher?: string;
	command: string;
}

interface CodexHookTrustEntry {
	key: string;
	trustedHash: string;
	enabled?: boolean;
}

export function hasCodexConfigOverride(args: string[], key: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "-c" || arg === "--config") {
			const next = args[i + 1];
			if (typeof next === "string" && next.startsWith(`${key}=`)) {
				return true;
			}
			i += 1;
			continue;
		}
		if (arg.startsWith(`-c${key}=`) || arg.startsWith(`--config=${key}=`)) {
			return true;
		}
	}
	return false;
}

function findCodexConfigOverrideInsertIndex(args: string[]): number {
	const subcommandIndex = args.findIndex((arg) => arg === "resume" || arg === "fork");
	return subcommandIndex === -1 ? args.length : subcommandIndex;
}

function addCodexConfigOverrideBeforeSubcommand(args: string[], key: string, value: string): void {
	if (hasCodexConfigOverride(args, key)) {
		return;
	}
	args.splice(findCodexConfigOverrideInsertIndex(args), 0, "-c", `${key}=${value}`);
}

function buildCodexHookCommand(event: RuntimeHookEvent): string {
	return buildKanbanCommandParts(["hooks", "codex-hook", "--event", event, "--source", "codex"])
		.map(quoteShellArg)
		.join(" ");
}

function buildCodexHookConfigValue(command: string, matcher?: string): string {
	const matcherConfig = matcher ? `matcher=${JSON.stringify(matcher)},` : "";
	const commandConfig = JSON.stringify(command);
	return `[{${matcherConfig}hooks=[{type="command",command=${commandConfig},timeout=${CODEX_HOOK_TIMEOUT_SECONDS}}]}]`;
}

function codexSessionFlagsConfigSource(): string {
	return process.platform === "win32" ? String.raw`C:\<session-flags>\config.toml` : "/<session-flags>/config.toml";
}

function codexHookEventKeyLabel(eventName: CodexHookConfigEvent): string {
	switch (eventName) {
		case "PermissionRequest":
			return "permission_request";
		case "PostToolUse":
			return "post_tool_use";
		case "PreToolUse":
			return "pre_tool_use";
		case "Stop":
			return "stop";
		case "UserPromptSubmit":
			return "user_prompt_submit";
	}
}

function canonicalizeJson(value: JsonValue): JsonValue {
	if (Array.isArray(value)) {
		return value.map(canonicalizeJson);
	}
	if (value !== null && typeof value === "object") {
		const sorted: JsonObject = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = canonicalizeJson(value[key]);
		}
		return sorted;
	}
	return value;
}

function versionForCodexHookIdentity(value: JsonObject): string {
	const canonical = canonicalizeJson(value);
	const serialized = JSON.stringify(canonical);
	const hash = createHash("sha256").update(serialized).digest("hex");
	return `sha256:${hash}`;
}

function buildCodexHookTrustEntry(config: CodexHookConfig): CodexHookTrustEntry {
	const handler: JsonObject = {
		async: false,
		command: config.command,
		timeout: CODEX_HOOK_TIMEOUT_SECONDS,
		type: "command",
	};
	const group: JsonObject = {
		hooks: [handler],
	};
	if (config.matcher !== undefined) {
		group.matcher = config.matcher;
	}
	const eventKeyLabel = codexHookEventKeyLabel(config.eventName);
	const identity: JsonObject = {
		event_name: eventKeyLabel,
		...group,
	};
	return {
		key: `${codexSessionFlagsConfigSource()}:${eventKeyLabel}:0:0`,
		trustedHash: versionForCodexHookIdentity(identity),
	};
}

function parseTomlBasicString(value: string): string | null {
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "string" ? parsed : null;
	} catch {
		return null;
	}
}

function readPersistedCodexHookTrustEntries(): CodexHookTrustEntry[] {
	const configuredHome = process.env.CODEX_HOME?.trim();
	const configPath = join(configuredHome || join(homedir(), ".codex"), "config.toml");
	let config: string;
	try {
		config = readFileSync(configPath, "utf8");
	} catch {
		return [];
	}

	const entries: CodexHookTrustEntry[] = [];
	let current: Partial<CodexHookTrustEntry> | null = null;
	const flushCurrent = (): void => {
		if (current?.key && current.trustedHash) {
			entries.push({
				key: current.key,
				trustedHash: current.trustedHash,
				enabled: false,
			});
		}
		current = null;
	};

	for (const line of config.split(/\r?\n/u)) {
		const sectionMatch = line.match(/^\s*\[hooks\.state\.("(?:[^"\\]|\\.)*")\]\s*$/u);
		if (sectionMatch) {
			flushCurrent();
			const key = parseTomlBasicString(sectionMatch[1]);
			current = key ? { key } : null;
			continue;
		}
		if (/^\s*\[/u.test(line)) {
			flushCurrent();
			continue;
		}
		if (!current) {
			continue;
		}
		const trustedHashMatch = line.match(/^\s*trusted_hash\s*=\s*("(?:[^"\\]|\\.)*")\s*$/u);
		if (trustedHashMatch) {
			const trustedHash = parseTomlBasicString(trustedHashMatch[1]);
			if (trustedHash) {
				current.trustedHash = trustedHash;
			}
		}
	}
	flushCurrent();
	return entries;
}

function buildCodexHookTrustStateConfigValue(entries: CodexHookTrustEntry[]): string {
	const entriesByKey = new Map(entries.map((entry) => [entry.key, entry]));
	const states = [...entriesByKey.values()].map((entry) => {
		const enabled = entry.enabled === undefined ? "" : `,enabled=${String(entry.enabled)}`;
		return `${JSON.stringify(entry.key)}={trusted_hash=${JSON.stringify(entry.trustedHash)}${enabled}}`;
	});
	return `{${states.join(",")}}`;
}

export function configureCodexHooks(args: string[]): void {
	const inProgressHook: CodexHookConfig = {
		eventName: "UserPromptSubmit",
		command: buildCodexHookCommand("to_in_progress"),
	};
	const reviewHook: CodexHookConfig = {
		eventName: "Stop",
		command: buildCodexHookCommand("to_review"),
	};
	const permissionRequestHook: CodexHookConfig = {
		eventName: "PermissionRequest",
		command: buildCodexHookCommand("to_review"),
		matcher: "*",
	};
	const preToolUseActivityHook: CodexHookConfig = {
		eventName: "PreToolUse",
		command: buildCodexHookCommand("activity"),
		matcher: "*",
	};
	const postToolUseActivityHook: CodexHookConfig = {
		eventName: "PostToolUse",
		command: buildCodexHookCommand("activity"),
		matcher: "*",
	};
	const trustStateConfigValue = buildCodexHookTrustStateConfigValue([
		...readPersistedCodexHookTrustEntries(),
		...[inProgressHook, reviewHook, permissionRequestHook, preToolUseActivityHook, postToolUseActivityHook].map(
			buildCodexHookTrustEntry,
		),
	]);

	addCodexConfigOverrideBeforeSubcommand(args, "features.hooks", "true");
	addCodexConfigOverrideBeforeSubcommand(args, "hooks.state", trustStateConfigValue);
	addCodexConfigOverrideBeforeSubcommand(
		args,
		"hooks.UserPromptSubmit",
		buildCodexHookConfigValue(inProgressHook.command),
	);
	addCodexConfigOverrideBeforeSubcommand(args, "hooks.Stop", buildCodexHookConfigValue(reviewHook.command));
	addCodexConfigOverrideBeforeSubcommand(
		args,
		"hooks.PermissionRequest",
		buildCodexHookConfigValue(permissionRequestHook.command, permissionRequestHook.matcher),
	);
	addCodexConfigOverrideBeforeSubcommand(
		args,
		"hooks.PreToolUse",
		buildCodexHookConfigValue(preToolUseActivityHook.command, preToolUseActivityHook.matcher),
	);
	addCodexConfigOverrideBeforeSubcommand(
		args,
		"hooks.PostToolUse",
		buildCodexHookConfigValue(postToolUseActivityHook.command, postToolUseActivityHook.matcher),
	);
}
