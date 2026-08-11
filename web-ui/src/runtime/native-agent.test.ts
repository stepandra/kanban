import { describe, expect, it } from "vitest";

import { getTaskAgentNavbarHint, isTaskAgentSetupSatisfied } from "@/runtime/native-agent";
import type { RuntimeConfigResponse } from "@/runtime/types";

function createRuntimeConfigResponse(
	selectedAgentId: RuntimeConfigResponse["selectedAgentId"],
	overrides?: Partial<RuntimeConfigResponse>,
): RuntimeConfigResponse {
	const nextConfig: RuntimeConfigResponse = {
		selectedAgentId,
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		effectiveCommand: selectedAgentId,
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project/.cline/kanban/config.json",
		readyForReviewNotificationsEnabled: true,
		detectedCommands: ["claude", "codex"],
		agents: [
			{
				id: "claude",
				label: "Claude Code",
				binary: "claude",
				command: "claude",
				defaultArgs: [],
				installed: true,
				configured: true,
			},
		],
		shortcuts: [],
		taskTemplates: [],
	};
	return {
		...nextConfig,
		...overrides,
	};
}

describe("native-agent helpers", () => {
	it("treats an installed launch-supported agent as task-ready", () => {
		expect(isTaskAgentSetupSatisfied(createRuntimeConfigResponse("claude"))).toBe(true);
		expect(isTaskAgentSetupSatisfied(null)).toBeNull();
	});

	it("requires setup when no launch-supported agent is installed", () => {
		const config = createRuntimeConfigResponse("claude", {
			agents: [
				{
					id: "claude",
					label: "Claude Code",
					binary: "claude",
					command: "claude",
					defaultArgs: [],
					installed: false,
					configured: true,
				},
			],
		});
		expect(isTaskAgentSetupSatisfied(config)).toBe(false);
	});

	it("does not show the navbar setup hint when a task agent is ready", () => {
		expect(getTaskAgentNavbarHint(createRuntimeConfigResponse("claude"))).toBeUndefined();
	});

	it("shows the navbar setup hint when no task agent path is ready", () => {
		const config = createRuntimeConfigResponse("claude", {
			agents: [],
		});
		expect(getTaskAgentNavbarHint(config)).toBe("No agent configured");
		expect(
			getTaskAgentNavbarHint(config, {
				shouldUseNavigationPath: true,
			}),
		).toBeUndefined();
	});

	it("ignores non-launch agents when checking native CLI availability", () => {
		const config = createRuntimeConfigResponse("claude");
		config.agents = [
			{
				id: "gemini",
				label: "Gemini CLI",
				binary: "gemini",
				command: "gemini",
				defaultArgs: [],
				installed: true,
				configured: false,
			},
		];
		expect(isTaskAgentSetupSatisfied(config)).toBe(false);
	});
});
