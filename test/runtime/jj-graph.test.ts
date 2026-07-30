import { beforeEach, describe, expect, it, vi } from "vitest";

import { getJjGraph, parseJjGraphOutput } from "../../src/workspace/jj-graph";
import { runJj } from "../../src/workspace/jj-utils";

vi.mock("../../src/workspace/jj-utils", () => ({
	runJj: vi.fn(),
}));

const runJjMock = vi.mocked(runJj);

describe("jj graph", () => {
	beforeEach(() => {
		runJjMock.mockReset();
	});

	it("keeps graph edge rows while parsing structured change nodes", () => {
		const output = [
			'@  KANBAN_JJ_NODE\t{"changeId":"zzzz","commitId":"1111","parentCommitIds":["0000"],"description":"Current change","bookmarks":[],"workspaces":["default"],"currentWorkingCopy":true,"empty":false,"conflict":false}',
			'│ ○  KANBAN_JJ_NODE\t{"changeId":"yyyy","commitId":"2222","parentCommitIds":["0000"],"description":"","bookmarks":["main"],"workspaces":[],"currentWorkingCopy":false,"empty":true,"conflict":false}',
			"├─╯",
		].join("\n");

		expect(parseJjGraphOutput(output)).toEqual([
			expect.objectContaining({
				kind: "node",
				graphPrefix: "@  ",
				changeId: "zzzz",
				currentWorkingCopy: true,
			}),
			expect.objectContaining({
				kind: "node",
				graphPrefix: "│ ○  ",
				changeId: "yyyy",
				bookmarks: ["main"],
			}),
			{ kind: "edge", graphPrefix: "├─╯" },
		]);
	});

	it("returns a bounded read-only graph response", async () => {
		runJjMock.mockResolvedValue({
			ok: true,
			stdout:
				'@  KANBAN_JJ_NODE\t{"changeId":"zzzz","commitId":"1111","parentCommitIds":[],"description":"Current change","bookmarks":[],"workspaces":["default"],"currentWorkingCopy":true,"empty":false,"conflict":false}',
			stderr: "",
		});

		const response = await getJjGraph({ cwd: "/repo", maxCount: 1 });

		expect(runJjMock).toHaveBeenCalledWith("/repo", ["log", "-r", "all()", "-n", "1", "-T", expect.any(String)]);
		expect(response).toMatchObject({
			ok: true,
			changeCount: 1,
			truncated: true,
		});
	});
});
