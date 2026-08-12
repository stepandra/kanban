import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";

const originalHome = process.env.HOME;
const originalAppData = process.env.APPDATA;
const originalLocalAppData = process.env.LOCALAPPDATA;
let tempHome: string | null = null;

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-agent-adapters-"));
	process.env.HOME = tempHome;
	return tempHome;
}
function getCodexConfigOverrideValues(args: string[], key: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "-c" || arg === "--config") {
			const next = args[index + 1];
			if (typeof next === "string" && next.startsWith(`${key}=`)) {
				values.push(next.slice(key.length + 1));
			}
			index += 1;
			continue;
		}
		if (arg.startsWith(`-c${key}=`)) {
			values.push(arg.slice(key.length + 3));
			continue;
		}
		if (arg.startsWith(`--config=${key}=`)) {
			values.push(arg.slice(key.length + 10));
		}
	}
	return values;
}

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
	if (originalAppData === undefined) {
		delete process.env.APPDATA;
	} else {
		process.env.APPDATA = originalAppData;
	}
	if (originalLocalAppData === undefined) {
		delete process.env.LOCALAPPDATA;
	} else {
		process.env.LOCALAPPDATA = originalLocalAppData;
	}
});

describe("prepareAgentLaunch hook strategies", () => {
	it("configures Codex hooks without legacy notify", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const launchCommand = [launch.binary ?? "", ...launch.args].join(" ");
		expect(launchCommand).toContain("codex");
		expect(launchCommand).toContain("codex-hook");
		expect(launchCommand).toContain("hooks.UserPromptSubmit");
		expect(launchCommand).toContain("hooks.Stop");
		expect(launchCommand).toContain("hooks.PermissionRequest");
		expect(getCodexConfigOverrideValues(launch.args, "features.hooks")).toEqual(["true"]);
		expect(getCodexConfigOverrideValues(launch.args, "features.codex_hooks")).toEqual([]);
		const hookTrustState = getCodexConfigOverrideValues(launch.args, "hooks.state");
		expect(hookTrustState).toHaveLength(1);
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:user_prompt_submit:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:stop:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:permission_request:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:pre_tool_use:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:post_tool_use:0:0"');
		expect(hookTrustState[0]).toContain('trusted_hash="sha256:');
		expect(launchCommand).toContain("timeout=5");
		expect(launchCommand).not.toContain("codex-wrapper");
		expect(launchCommand).not.toContain("notify=");

		const wrapperPath = join(homedir(), ".cline", "kanban", "hooks", "codex", "codex-wrapper.mjs");
		expect(existsSync(wrapperPath)).toBe(false);
	});

	it("disables inherited Codex hooks while adding trusted Kanban hooks", async () => {
		const home = setupTempHome();
		const codexHome = join(home, ".codex");
		mkdirSync(codexHome, { recursive: true });
		writeFileSync(
			join(codexHome, "config.toml"),
			`[hooks.state."/tmp/user-hooks.json:subagent_start:0:0"]
trusted_hash = "sha256:user-trusted-hash"
enabled = true
`,
		);

		const launch = await prepareAgentLaunch({
			taskId: "task-preserve-codex-trust",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const hookTrustState = getCodexConfigOverrideValues(launch.args, "hooks.state");
		expect(hookTrustState).toHaveLength(1);
		expect(hookTrustState[0]).toContain(
			'"/tmp/user-hooks.json:subagent_start:0:0"={trusted_hash="sha256:user-trusted-hash",enabled=false}',
		);
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:stop:0:0"');
	});

	it("surfaces the Codex startup hook review gate instead of reporting the worker as running", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-hook-review",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Fix the bug",
			workspaceId: "workspace-1",
		});
		const summary = {
			taskId: "task-hook-review",
			state: "running" as const,
			agentId: "codex" as const,
			workspacePath: "/tmp",
			pid: 123,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		};

		expect(launch.shouldInspectOutputForTransition?.(summary)).toBe(true);
		expect(launch.detectOutputTransition?.("Hooks need review\n1 hook is new or changed.", summary)).toEqual({
			type: "agent.attention-required",
		});
	});

	it("disables Codex startup update checks for Kanban-launched sessions", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-updates",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["false"]);
	});

	it("preserves an explicit Codex update-check override", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-custom-update-check",
			agentId: "codex",
			binary: "codex",
			args: ["-c", "check_for_update_on_startup=true"],
			cwd: "/tmp",
			prompt: "",
		});

		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["true"]);
	});

	it("writes Claude settings with explicit permission hook", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "Implement the task",
			workspaceId: "workspace-1",
			projectPath: "/tmp/project with spaces",
		});

		const settingsPath = join(homedir(), ".cline", "kanban", "hooks", "claude", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: Record<string, unknown>;
		};
		expect(settings.hooks?.PermissionRequest).toBeDefined();
		expect(settings.hooks?.PreToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUseFailure).toBeDefined();
		expect(launch.args.at(-1)).toContain("Implement the task");
		expect(launch.args.at(-1)).toContain("'task' 'submit' '--task-id' 'task-1'");
		expect(launch.args.at(-1)).toContain("'--project-path' '/tmp/project with spaces'");
		expect(launch.args.at(-1)).toContain("Do not accept, discard, commit, or push");
	});

	it("gives Grok and Kimi a task-scoped review submission command", async () => {
		setupTempHome();
		const grokLaunch = await prepareAgentLaunch({
			taskId: "task-grok",
			agentId: "grok",
			binary: "grok",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "Implement Grok task",
			workspaceId: "workspace-1",
			projectPath: "/tmp/project",
		});
		const kimiLaunch = await prepareAgentLaunch({
			taskId: "task-kimi",
			agentId: "kimi",
			binary: "kimi",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "Implement Kimi task",
			workspaceId: "workspace-1",
			projectPath: "/tmp/project",
		});

		expect(grokLaunch.args).toContain("--always-approve");
		expect(grokLaunch.args).not.toContain("--permission-mode");
		expect(grokLaunch.args).not.toContain("--prompt");
		expect(grokLaunch.args).not.toContain("-p");
		expect(grokLaunch.args).not.toContain("--single");
		expect(grokLaunch.args.at(-1)).toContain("'task' 'submit' '--task-id' 'task-grok'");
		expect(grokLaunch.args.at(-1)).toContain("'--project-path' '/tmp/project'");
		expect(grokLaunch.env.KANBAN_HOOK_TASK_ID).toBe("task-grok");
		expect(kimiLaunch.args).not.toContain("--yolo");
		expect(kimiLaunch.args).not.toContain("--auto");
		expect(kimiLaunch.args).toContain("--prompt");
		expect(kimiLaunch.args.at(-1)).toContain("'task' 'submit' '--task-id' 'task-kimi'");
		expect(kimiLaunch.args.at(-1)).toContain("'--project-path' '/tmp/project'");
		expect(kimiLaunch.env.KANBAN_HOOK_TASK_ID).toBe("task-kimi");
	});

	it("directs read-only workers to an outside-repository report and fenced submit command", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "audit-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-workspace",
			prompt: "Audit the implementation",
			deliverableKind: "read_only_report",
			workspaceId: "workspace-1",
			projectPath: "/tmp/project",
		});

		const workerPrompt = launch.args.at(-1) ?? "";
		expect(workerPrompt).toContain("This is a read-only deliverable. Do not modify repository files.");
		expect(workerPrompt).toContain("at most 262144 bytes");
		expect(workerPrompt).toContain(`'--report-file' '${join(tmpdir(), "kanban-review-reports", "audit-1.md")}'`);
		expect(workerPrompt).not.toContain("scrape");
	});

	it("starts Grok plan mode through its supported slash command", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-grok-plan",
			agentId: "grok",
			binary: "grok",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "Plan the Grok task",
			startInPlanMode: true,
			workspaceId: "workspace-1",
			projectPath: "/tmp/project",
		});

		expect(launch.args).toContain("--always-approve");
		expect(launch.args).not.toContain("--prompt");
		expect(launch.args).not.toContain("--permission-mode");
		expect(launch.deferredStartupInput).toContain("/plan Plan the Grok task");
		expect(launch.deferredStartupInput).toContain("'task' 'submit' '--task-id' 'task-grok-plan'");
	});

	it("defers Kimi plan prompts instead of combining conflicting flags", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-kimi-plan",
			agentId: "kimi",
			binary: "kimi",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "Plan the Kimi task",
			startInPlanMode: true,
			workspaceId: "workspace-1",
			projectPath: "/tmp/project",
		});

		expect(launch.args).toContain("--plan");
		expect(launch.args).not.toContain("--prompt");
		expect(launch.args).not.toContain("--yolo");
		expect(launch.deferredStartupInput).toContain("Plan the Kimi task");
		expect(launch.deferredStartupInput).toContain("'task' 'submit' '--task-id' 'task-kimi-plan'");
	});

	it("keeps Kimi interactive when autonomous mode is disabled", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-kimi-manual",
			agentId: "kimi",
			binary: "kimi",
			args: [],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "Implement with approvals",
			workspaceId: "workspace-1",
		});

		expect(launch.args).not.toContain("--prompt");
		expect(launch.deferredStartupInput).toContain("Implement with approvals");
	});

	it.each([
		["gemini", "gemini"],
		["opencode", "opencode"],
		["droid", "droid"],
		["kiro", "kiro-cli"],
	] as const)("blocks launch-disabled persisted %s agent IDs", async (agentId, binary) => {
		await expect(
			prepareAgentLaunch({
				taskId: `task-${agentId}`,
				agentId,
				binary,
				args: [],
				cwd: "/tmp",
				prompt: "Do not run",
			}),
		).rejects.toThrow(`Agent "${agentId}" is launch-disabled and retained only for persisted compatibility`);
	});

	it("keeps the persisted Amp ID behind a non-Orb compatibility fence", async () => {
		await expect(
			prepareAgentLaunch({
				taskId: "task-amp",
				agentId: "amp",
				binary: "amp",
				args: [],
				cwd: "/tmp",
				prompt: "Do not run",
			}),
		).rejects.toThrow("Amp task executor IDs are retained only for persisted compatibility");
	});

	it("materializes task images for CLI prompts", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-images",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Inspect the attached design",
			images: [
				{
					id: "img-1",
					data: Buffer.from("hello").toString("base64"),
					mimeType: "image/png",
					name: "diagram.png",
				},
			],
		});

		const initialPrompt = launch.args.at(-1) ?? "";
		expect(initialPrompt).toContain("Attached reference images:");
		expect(initialPrompt).toContain("Task:\nInspect the attached design");

		const imagePathMatch = initialPrompt.match(/1\. (.+?) \(diagram\.png\)/);
		expect(imagePathMatch?.[1]).toBeDefined();
		const imagePath = imagePathMatch?.[1] ?? "";
		expect(existsSync(imagePath)).toBe(true);
		expect(readFileSync(imagePath).toString("utf8")).toBe("hello");
	});

	it("defers Codex plan-mode startup input until startup UI is ready", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-plan",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Audit the deployment pipeline",
			startInPlanMode: true,
		});

		expect(launch.args).not.toContain("Audit the deployment pipeline");
		expect(launch.deferredStartupInput).toContain("\u001b[200~");
		expect(launch.deferredStartupInput).toContain("/plan Audit the deployment pipeline");
		expect(launch.deferredStartupInput?.endsWith("\r")).toBe(true);
	});

	it("defers a bare /plan command when Codex plan mode has no prompt text", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-plan-empty",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			startInPlanMode: true,
		});

		expect(launch.deferredStartupInput).toContain("/plan");
		expect(launch.deferredStartupInput).not.toContain("/plan ");
		expect(launch.deferredStartupInput?.endsWith("\r")).toBe(true);
	});

	it("adds resume flags for supported agents", async () => {
		setupTempHome();
		const grokLaunch = await prepareAgentLaunch({
			taskId: "task-grok",
			agentId: "grok",
			binary: "grok",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(grokLaunch.args).toContain("--continue");

		const kimiLaunch = await prepareAgentLaunch({
			taskId: "task-kimi",
			agentId: "kimi",
			binary: "kimi",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(kimiLaunch.args).toContain("--continue");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(codexLaunch.args).toEqual(expect.arrayContaining(["resume", "--last"]));

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(claudeLaunch.args).toContain("--continue");
	});

	it("places Codex hook config before the resume subcommand", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-resume-hooks",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
			workspaceId: "workspace-1",
		});

		const resumeIndex = launch.args.indexOf("resume");
		expect(resumeIndex).toBeGreaterThan(0);
		for (const key of [
			"features.hooks",
			"hooks.state",
			"hooks.UserPromptSubmit",
			"hooks.Stop",
			"hooks.PermissionRequest",
			"hooks.PreToolUse",
			"hooks.PostToolUse",
		]) {
			const configIndex = launch.args.findIndex((arg) => arg.startsWith(`${key}=`));
			expect(configIndex).toBeGreaterThan(-1);
			expect(configIndex).toBeLessThan(resumeIndex);
		}
	});

	it("applies autonomous mode flags in supported adapters", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-auto",
			agentId: "claude",
			binary: "claude",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		const permissionModeIndex = claudeLaunch.args.indexOf("--permission-mode");
		expect(permissionModeIndex).toBeGreaterThan(-1);
		expect(claudeLaunch.args[permissionModeIndex + 1]).toBe("auto");
		expect(claudeLaunch.args).not.toContain("--dangerously-skip-permissions");
		expect(claudeLaunch.env.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe("1");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-auto",
			agentId: "codex",
			binary: "codex",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).toContain("--dangerously-bypass-approvals-and-sandbox");
	});

	it("does not add a Claude permission mode when args already set one", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-explicit-mode",
			agentId: "claude",
			binary: "claude",
			args: ["--permission-mode", "acceptEdits"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(launch.args.filter((arg) => arg === "--permission-mode")).toHaveLength(1);
		expect(launch.args).not.toContain("auto");
	});

	it("starts Claude plan mode without bypass flags and keeps auto mode reachable", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-plan",
			agentId: "claude",
			binary: "claude",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
			startInPlanMode: true,
		});
		const permissionModeIndex = launch.args.indexOf("--permission-mode");
		expect(permissionModeIndex).toBeGreaterThan(-1);
		expect(launch.args[permissionModeIndex + 1]).toBe("plan");
		expect(launch.args).not.toContain("--dangerously-skip-permissions");
		expect(launch.args).not.toContain("--allow-dangerously-skip-permissions");
		expect(launch.env.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe("1");
	});

	it("strips an explicit Claude bypass arg in plan mode", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-plan-bypass",
			agentId: "claude",
			binary: "claude",
			args: ["--dangerously-skip-permissions"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
			startInPlanMode: true,
		});
		expect(launch.args).not.toContain("--dangerously-skip-permissions");
		expect(launch.args).not.toContain("--allow-dangerously-skip-permissions");
		const permissionModeIndex = launch.args.indexOf("--permission-mode");
		expect(launch.args[permissionModeIndex + 1]).toBe("plan");
	});

	it("preserves explicit autonomous args when autonomous mode is disabled", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-no-auto",
			agentId: "claude",
			binary: "claude",
			args: ["--dangerously-skip-permissions"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(claudeLaunch.args).toContain("--dangerously-skip-permissions");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-no-auto",
			agentId: "codex",
			binary: "codex",
			args: ["--dangerously-bypass-approvals-and-sandbox"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).toContain("--dangerously-bypass-approvals-and-sandbox");
	});
});
