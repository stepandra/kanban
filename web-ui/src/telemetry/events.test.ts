import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	toTelemetrySelectedAgentId,
	trackTaskCreated,
	trackTaskDependencyCreated,
	trackTaskResumedFromTrash,
} from "@/telemetry/events";

const captureMock = vi.hoisted(() => vi.fn());
const isTelemetryEnabledMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("posthog-js", () => ({
	default: {
		capture: captureMock,
	},
}));

vi.mock("@/telemetry/posthog-config", () => ({
	isTelemetryEnabled: isTelemetryEnabledMock,
}));

describe("telemetry events", () => {
	beforeEach(() => {
		captureMock.mockReset();
		isTelemetryEnabledMock.mockReset();
		isTelemetryEnabledMock.mockReturnValue(true);
	});

	it("captures task creation metadata", () => {
		trackTaskCreated({
			selected_agent_id: "unknown",
			start_in_plan_mode: true,
			prompt_character_count: 42,
		});

		expect(captureMock).toHaveBeenCalledWith("task_created", {
			selected_agent_id: "unknown",
			start_in_plan_mode: true,
			prompt_character_count: 42,
		});
	});

	it("captures task creation outside plan mode", () => {
		trackTaskCreated({
			selected_agent_id: "unknown",
			start_in_plan_mode: false,
			prompt_character_count: 12,
		});

		expect(captureMock).toHaveBeenCalledWith("task_created", {
			selected_agent_id: "unknown",
			start_in_plan_mode: false,
			prompt_character_count: 12,
		});
	});

	it("captures the new task workflow events", () => {
		trackTaskDependencyCreated();
		trackTaskResumedFromTrash();

		expect(captureMock).toHaveBeenNthCalledWith(1, "task_dependency_created", {});
		expect(captureMock).toHaveBeenNthCalledWith(2, "task_resumed_from_trash", {});
	});

	it("skips capture when telemetry is disabled", () => {
		isTelemetryEnabledMock.mockReturnValue(false);

		trackTaskDependencyCreated();

		expect(captureMock).not.toHaveBeenCalled();
	});

	it("normalizes nullable agent ids for telemetry", () => {
		expect(toTelemetrySelectedAgentId("codex")).toBe("codex");
		expect(toTelemetrySelectedAgentId(null)).toBe("unknown");
		expect(toTelemetrySelectedAgentId(undefined)).toBe("unknown");
	});
});
