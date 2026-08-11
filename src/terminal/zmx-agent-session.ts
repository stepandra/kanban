import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { isDurableAgentSessionEligible } from "../core/agent-catalog";
import type { RuntimeAgentId } from "../core/api-contract";

// zmx session-name contract (canonical documentation: docs/zmx-session-names.md).
// Consumers outside this repo (e.g. juja/zellij/bin/kanban-zmx-view)
// parse these names; any change here must update that doc and the loud-failure
// format test in test/runtime/terminal/zmx-agent-session.test.ts.
//
// Format:
//   kanban.<workspace>.<agent>.<task>.<sha256[:12]>
//
// Segment rules:
// - <workspace> and <task> are sanitized by safeSegment: lowercased, every run
//   of characters outside [a-z0-9._-] replaced with a single "-", leading and
//   trailing "-" trimmed, truncated to 36 chars, falling back to "unknown"
//   when nothing remains. Segments MAY contain dots, so positional splitting
//   on "." is unsafe — parse with the fixed "kanban." prefix, the exact
//   ".<agent>." marker, and the trailing digest instead.
// - <agent> is the RuntimeAgentId, emitted verbatim (all ids are [a-z] only).
// - <sha256[:12]> is the first 12 lowercase hex chars of
//   sha256("<workspaceId>\0<taskId>") over the RAW (unsanitized) values, making
//   names unique and deterministic per (workspace, task) pair.

export interface ZmxAgentSessionInput {
	agentId: RuntimeAgentId;
	binary: string;
	args: string[];
	taskId: string;
	workspaceId?: string;
	zmxAvailable: boolean;
}

export interface ZmxAgentSessionLaunch {
	binary: "zmx";
	args: string[];
	sessionName: string;
}

function safeSegment(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 36);
	return normalized || "unknown";
}

export function buildZmxWorkspaceSessionPrefix(workspaceId: string): string | null {
	const normalizedWorkspaceId = workspaceId.trim();
	return normalizedWorkspaceId ? `kanban.${safeSegment(normalizedWorkspaceId)}.` : null;
}

export function prepareZmxAgentSession(input: ZmxAgentSessionInput): ZmxAgentSessionLaunch | null {
	const workspaceId = input.workspaceId?.trim();
	if (!input.zmxAvailable || !workspaceId || !isDurableAgentSessionEligible(input.agentId)) {
		return null;
	}
	const digest = createHash("sha256").update(`${workspaceId}\0${input.taskId}`).digest("hex").slice(0, 12);
	const workspacePrefix = buildZmxWorkspaceSessionPrefix(workspaceId);
	if (!workspacePrefix) {
		return null;
	}
	const sessionName = `${workspacePrefix}${input.agentId}.${safeSegment(input.taskId)}.${digest}`;
	return {
		binary: "zmx",
		args: ["attach", sessionName, input.binary, ...input.args],
		sessionName,
	};
}

// Minimal async control surface over the zmx CLI. All durable-session
// management (startup reconciliation, orphan reaping, session teardown) goes
// through this interface so tests can stub it — zmx is an optional external
// binary and must never be required to exist. Operations are Promise-based so
// callers never block the event loop on a subprocess.
export interface ZmxSessionControl {
	listSessionNames(): Promise<string[]>;
	killSession(sessionName: string): Promise<void>;
}

function formatZmxCommandError(command: string, stderr: string, exitCode: number | null): Error {
	const detail = stderr.trim();
	return new Error(
		detail
			? `"${command}" exited with code ${exitCode ?? "unknown"}: ${detail}`
			: `"${command}" exited with code ${exitCode ?? "unknown"}.`,
	);
}

function runZmxCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("zmx", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			reject(error);
		});
		child.on("close", (exitCode) => {
			if (exitCode === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(formatZmxCommandError(`zmx ${args.join(" ")}`, stderr, exitCode));
		});
	});
}

export function parseZmxListShortOutput(output: string): string[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

export function createZmxSessionControl(): ZmxSessionControl {
	return {
		async listSessionNames() {
			const { stdout } = await runZmxCommand(["list", "--short"]);
			return parseZmxListShortOutput(stdout);
		},
		async killSession(sessionName) {
			await runZmxCommand(["kill", sessionName, "--force"]);
		},
	};
}
