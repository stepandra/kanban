import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadWorkspaceContext } from "../../src/state/workspace-state";
import { inspectJjRepositoryHealth } from "../../src/workspace/jj-doctor";
import { runJj } from "../../src/workspace/jj-utils";

vi.mock("../../src/state/workspace-state", () => ({
	detectRepositoryKind: vi.fn(() => "jj"),
	loadWorkspaceBoardById: vi.fn(async () => null),
	loadWorkspaceContext: vi.fn(),
}));

vi.mock("../../src/workspace/jj-utils", () => ({ runJj: vi.fn() }));

vi.mock("../../src/workspace/task-worktree", () => ({ getTaskWorkspacePathInfo: vi.fn() }));

const loadWorkspaceContextMock = vi.mocked(loadWorkspaceContext);
const runJjMock = vi.mocked(runJj);

describe("jj doctor parsing", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		loadWorkspaceContextMock.mockResolvedValue({
			vcs: "jj",
			repoPath: "/repo",
			workspaceId: "workspace",
			statePath: "/state",
			git: { currentBranch: null, defaultBranch: null, branches: [] },
		});
	});

	it("fails closed and skips rows with malformed workspace and head booleans", async () => {
		runJjMock.mockImplementation(async (_cwd, args) => {
			if (args.includes("workspace")) {
				return {
					ok: true,
					stdout: "default\tworkspace-change\tworkspace-commit\tfalse\tmalformed\tfalse\tfalse\n",
					stderr: "",
				};
			}
			if (args.includes("log")) {
				return { ok: true, stdout: "head-change\thead-commit\tunknown\thead description\n", stderr: "" };
			}
			return { ok: true, stdout: "jj 0.33.0", stderr: "" };
		});

		const report = await inspectJjRepositoryHealth({ cwd: "/repo" });

		expect(report.ok).toBe(true);
		expect(report.healthy).toBe(false);
		expect(report.workspaces).toEqual([]);
		expect(report.heads).toEqual([]);
		expect(report.gaps).toEqual(
			expect.arrayContaining([
				expect.stringContaining('invalid boolean conflicted="malformed"'),
				expect.stringContaining('invalid boolean empty="unknown"'),
			]),
		);
	});
});
