import { describe, expect, it } from "vitest";

import {
	buildTaskGitActionPrompt,
	TASK_GIT_BASE_REF_PROMPT_VARIABLE,
} from "@/git-actions/build-task-git-action-prompt";

describe("buildTaskGitActionPrompt", () => {
	it("interpolates the shared base ref variable into custom templates", () => {
		expect(
			buildTaskGitActionPrompt({
				action: "commit",
				workspaceInfo: {
					taskId: "task-123",
					path: "/tmp/task-123",
					exists: true,
					baseRef: "main",
					branch: null,
					isDetached: true,
					headCommit: "abc123",
				},
				templates: {
					commitPromptTemplate: `Commit onto ${TASK_GIT_BASE_REF_PROMPT_VARIABLE.token}.`,
				},
			}),
		).toBe("Commit onto main.");
	});

	it("falls back to the default action prompt when no template is configured", () => {
		expect(
			buildTaskGitActionPrompt({
				action: "pr",
				workspaceInfo: {
					taskId: "task-123",
					path: "/tmp/task-123",
					exists: true,
					baseRef: "main",
					branch: null,
					isDetached: true,
					headCommit: "abc123",
				},
			}),
		).toBe("Handle this pull request action using the provided git context.");
	});

	it("uses jj commit semantics without creating a bookmark for commit-only actions", () => {
		const prompt = buildTaskGitActionPrompt({
			action: "commit",
			vcs: "jj",
			workspaceInfo: {
				taskId: "task-123",
				path: "/tmp/task-123",
				exists: true,
				baseRef: "trunk()",
				branch: null,
				isDetached: false,
				headCommit: "abc123",
			},
		});

		expect(prompt).toContain('jj commit -m "<concise task summary>"');
		expect(prompt).toContain("completed task change is now `@-`");
		expect(prompt).not.toContain("jj bookmark set");
		expect(prompt).not.toContain("git commit");
	});

	it("publishes a task bookmark from the completed jj change before opening a PR", () => {
		const prompt = buildTaskGitActionPrompt({
			action: "pr",
			vcs: "jj",
			workspaceInfo: {
				taskId: "task-123",
				path: "/tmp/task-123",
				exists: true,
				baseRef: "@",
				branch: null,
				isDetached: false,
				headCommit: "abc123",
			},
		});

		expect(prompt).toContain('jj bookmark set "kanban/task-123" -r @-');
		expect(prompt).toContain('jj git push --bookmark "kanban/task-123"');
		expect(prompt).toContain('gh pr create --head "kanban/task-123"');
		expect(prompt).toContain("A GitHub PR base must be a branch name");
	});
});
