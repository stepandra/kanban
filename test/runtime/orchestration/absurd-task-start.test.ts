import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	execFilePromise: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: Object.assign(childProcessMocks.execFile, {
		[promisify.custom]: childProcessMocks.execFilePromise,
	}),
}));

import { enqueueAbsurdTaskStart } from "../../../src/orchestration/absurd-task-start";

const previousZjAgentBin = process.env.ZJ_AGENT_BIN;

describe("enqueueAbsurdTaskStart", () => {
	beforeEach(() => {
		childProcessMocks.execFile.mockReset();
		childProcessMocks.execFilePromise.mockReset();
		process.env.ZJ_AGENT_BIN = "/tmp/zj-agent";
	});

	afterEach(() => {
		if (previousZjAgentBin === undefined) {
			delete process.env.ZJ_AGENT_BIN;
		} else {
			process.env.ZJ_AGENT_BIN = previousZjAgentBin;
		}
	});

	it("passes the opaque generation-fenced reference to the Absurd boundary", async () => {
		childProcessMocks.execFilePromise.mockResolvedValue({
			stdout: '{"task_id":"absurd-1"}\n',
			stderr: "",
		});

		await expect(
			enqueueAbsurdTaskStart({
				taskExecutionReference: "task-1~g4~q123~resume",
				projectPath: "/tmp/repo",
				agentId: "codex",
			}),
		).resolves.toEqual({ attemptId: "absurd-1", raw: { task_id: "absurd-1" } });
		expect(childProcessMocks.execFilePromise).toHaveBeenCalledWith(
			"/tmp/zj-agent",
			["kanban-enqueue", "--task-id", "task-1~g4~q123~resume", "--project-path", "/tmp/repo", "--agent", "codex"],
			{ encoding: "utf8", timeout: 10_000 },
		);
	});

	it("fails closed when the enqueue receipt is not JSON", async () => {
		childProcessMocks.execFilePromise.mockResolvedValue({
			stdout: "not-json",
			stderr: "",
		});

		await expect(
			enqueueAbsurdTaskStart({
				taskExecutionReference: "task-1~g1",
				projectPath: "/tmp/repo",
				agentId: "codex",
			}),
		).rejects.toThrow("Absurd enqueue returned invalid JSON or no task ID.");
	});
});
