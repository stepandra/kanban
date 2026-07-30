import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadWorkspaceState } from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

async function withTemporaryHome<T>(run: (tempHome: string) => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-state-migration-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run(tempHome);
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanup();
	}
}

function createProject(sandboxRoot: string): string {
	const projectPath = join(sandboxRoot, "project");
	mkdirSync(projectPath, { recursive: true });
	const initialized = spawnSync("git", ["init"], {
		cwd: projectPath,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (initialized.status !== 0) {
		throw new Error(`Failed to initialize Git repository at ${projectPath}.`);
	}
	return realpathSync(projectPath);
}

describe.sequential("workspace state migrations", () => {
	it("neutralizes the removed Cline worker in persisted session summaries", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-state-migration-");
			try {
				const projectPath = createProject(sandboxRoot);
				const initial = await loadWorkspaceState(projectPath);
				mkdirSync(initial.statePath, { recursive: true });
				writeFileSync(
					join(initial.statePath, "sessions.json"),
					JSON.stringify({
						"legacy-cline-task": {
							taskId: "legacy-cline-task",
							state: "idle",
							agentId: "cline",
							workspacePath: null,
							pid: null,
							startedAt: null,
							updatedAt: 1,
							lastOutputAt: null,
							reviewReason: null,
							exitCode: null,
							lastHookAt: null,
							latestHookActivity: null,
						},
					}),
					"utf8",
				);

				const migrated = await loadWorkspaceState(projectPath);

				expect(migrated.sessions["legacy-cline-task"]?.agentId).toBeNull();
			} finally {
				cleanup();
			}
		});
	});
});
