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

const previousJujaBin = process.env.JUJA_BIN;

describe("enqueueAbsurdTaskStart", () => {
	beforeEach(() => {
		childProcessMocks.execFile.mockReset();
		childProcessMocks.execFilePromise.mockReset();
		process.env.JUJA_BIN = "/tmp/juja";
	});

	afterEach(() => {
		if (previousJujaBin === undefined) {
			delete process.env.JUJA_BIN;
		} else {
			process.env.JUJA_BIN = previousJujaBin;
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
			"/tmp/juja",
			["kanban-enqueue", "--task-id", "task-1~g4~q123~resume", "--project-path", "/tmp/repo", "--agent", "codex"],
			{ encoding: "utf8", timeout: 30_000 },
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
