import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const requireFromHere = createRequire(import.meta.url);

function resolveShutdownIpcHookPath(): string {
	return resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs");
}

function resolveSentryStubHookPath(): string {
	return resolve(process.cwd(), "test/integration/sentry-stub-hook.mjs");
}

function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
	const checkout = spawnSync("git", ["checkout", "-B", "main"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (checkout.status !== 0) {
		throw new Error(`Failed to create main branch at ${path}`);
	}
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function commitAll(cwd: string, message: string): string {
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			resolveListen();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
	if (!port) {
		throw new Error("Could not allocate a test port.");
	}
	return port;
}

async function waitForServerStart(process: ChildProcess, timeoutMs = 30_000): Promise<void> {
	await new Promise<void>((resolveStart, rejectStart) => {
		if (!process.stdout || !process.stderr) {
			rejectStart(new Error("Expected child process stdout/stderr pipes to be available."));
			return;
		}
		let settled = false;
		let stdout = "";
		let stderr = "";
		const timeoutId = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			rejectStart(new Error(`Timed out waiting for server start.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, timeoutMs);
		const handleOutput = (chunk: Buffer, source: "stdout" | "stderr") => {
			const text = chunk.toString();
			if (source === "stdout") {
				stdout += text;
			} else {
				stderr += text;
			}
			if (!stdout.includes("Kanban running at ") || settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			resolveStart();
		};
		process.stdout.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stdout");
		});
		process.stderr.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stderr");
		});
		process.once("exit", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			rejectStart(
				new Error(
					`Server process exited before startup (code=${String(code)} signal=${String(signal)}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
		});
	});
}

function installBrowserOpenStub(binDir: string, logPath: string): void {
	mkdirSync(binDir, { recursive: true });
	const script = `#!/usr/bin/env sh
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
`;
	const commandNames = process.platform === "darwin" ? ["open"] : ["xdg-open"];
	for (const commandName of commandNames) {
		const scriptPath = join(binDir, commandName);
		writeFileSync(scriptPath, script, "utf8");
		chmodSync(scriptPath, 0o755);
	}
}

function readBrowserOpenLog(logPath: string): string[] {
	if (!existsSync(logPath)) {
		return [];
	}
	return readFileSync(logPath, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

async function waitForBrowserOpenCount(logPath: string, expectedCount: number, timeoutMs = 2_000): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (readBrowserOpenLog(logPath).length >= expectedCount) {
			return;
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 25);
		});
	}
	throw new Error(
		`Timed out waiting for browser open count ${expectedCount}. Current log: ${readBrowserOpenLog(logPath).join(", ")}`,
	);
}

async function waitForExit(process: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (process.exitCode !== null) {
		return true;
	}

	return await new Promise<boolean>((resolveExit) => {
		const handleExit = () => {
			clearTimeout(timeoutId);
			resolveExit(true);
		};
		const timeoutId = setTimeout(() => {
			process.removeListener("exit", handleExit);
			resolveExit(false);
		}, timeoutMs);
		process.once("exit", handleExit);
	});
}

async function requestGracefulShutdown(process: ChildProcess): Promise<void> {
	if (typeof process.send !== "function" || !process.connected) {
		process.kill("SIGINT");
		return;
	}

	await new Promise<void>((resolveSend) => {
		process.send?.({ type: "kanban.shutdown" }, () => {
			resolveSend();
		});
	});
}

function spawnSourceCli(
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdio?: ChildProcess["stdio"] },
) {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	return spawn(
		process.execPath,
		["--import", resolveSentryStubHookPath(), "--import", resolveTsxLoaderImportSpecifier(), cliEntrypoint, ...args],
		{
			cwd: options.cwd,
			env: options.env,
			stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
		},
	);
}

async function runCliCommandAndCollectOutput(options: {
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; didExit: boolean }> {
	const process = spawnSourceCli(options.args, {
		cwd: options.cwd,
		env: options.env,
	});

	let stdout = "";
	let stderr = "";
	process.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	process.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	const didExit = await waitForExit(process, options.timeoutMs ?? 15_000);
	if (!didExit) {
		process.kill("SIGKILL");
	}

	return {
		stdout,
		stderr,
		exitCode: process.exitCode,
		didExit,
	};
}

describe("source task commands", () => {
	it("exits after creating a task when the runtime server is already running", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-exit-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-exit-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Exit Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveSentryStubHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const commandProcess = spawnSourceCli(
					[
						"task",
						"create",
						"--prompt",
						"Add a demo banner component to the homepage that displays a welcome message and current weather summary",
						"--project-path",
						projectPath,
					],
					{
						cwd: projectPath,
						env,
					},
				);

				let stdout = "";
				let stderr = "";
				commandProcess.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				commandProcess.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});

				const didExit = await waitForExit(commandProcess, 15_000);
				if (!didExit) {
					commandProcess.kill("SIGKILL");
				}

				expect(didExit, `task create did not exit in time.\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(true);
				expect(commandProcess.exitCode).toBe(0);
				expect(stdout).toContain('"ok": true');
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it(
		"accepts a clean read-only report only for the exact Amp origin thread",
		{ timeout: 600_000 },
		async () => {
			const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-read-only-review-");
			const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-read-only-review-");
			try {
				initGitRepository(projectPath);
				writeFileSync(join(projectPath, "README.md"), "# Read-only review\n", "utf8");
				commitAll(projectPath, "init");
				const port = String(await getAvailablePort());
				const env = createGitTestEnv({
					HOME: homeDir,
					USERPROFILE: homeDir,
					KANBAN_RUNTIME_PORT: port,
				});
				const serverProcess = spawn(
					process.execPath,
					[
						"--require",
						resolveShutdownIpcHookPath(),
						"--import",
						resolveSentryStubHookPath(),
						"--import",
						resolveTsxLoaderImportSpecifier(),
						resolve(process.cwd(), "src/cli.ts"),
						"--no-open",
					],
					{ cwd: projectPath, env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
				);
				try {
					await waitForServerStart(serverProcess, 120_000);
					const created = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"create",
							"--prompt",
							"Audit without repository changes",
							"--deliverable-kind",
							"read_only_report",
							"--origin-amp-thread-id",
							"T-read-only-test",
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
						timeoutMs: 90_000,
					});
					expect(
						created.didExit,
						`task create did not exit in time.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
					).toBe(true);
					expect(created.exitCode, `task create failed.\nstderr:\n${created.stderr}`).toBe(0);
					const createdPayload = JSON.parse(created.stdout) as { task?: { id?: string } };
					const taskId = createdPayload.task?.id;
					if (!taskId) throw new Error("Expected created read-only task ID.");
					const prepared = await runCliCommandAndCollectOutput({
						args: ["task", "prepare", "--task-id", taskId, "--project-path", projectPath],
						cwd: projectPath,
						env,
						timeoutMs: 90_000,
					});
					expect(prepared.exitCode).toBe(0);
					const preparedPayload = JSON.parse(prepared.stdout) as { task?: { taskWorkspacePath?: string } };
					const taskWorkspacePath = preparedPayload.task?.taskWorkspacePath;
					if (!taskWorkspacePath) throw new Error("Expected task workspace path.");
					const reportPath = join(homeDir, "audit-report.md");
					writeFileSync(reportPath, "# Audit\n\nThe repository already satisfies the requirement.\n", "utf8");
					const dirtyPath = join(taskWorkspacePath, "unexpected.txt");
					writeFileSync(dirtyPath, "dirty\n", "utf8");
					const dirtySubmit = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"submit",
							"--task-id",
							taskId,
							"--report-file",
							reportPath,
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
						timeoutMs: 90_000,
					});
					expect(dirtySubmit.exitCode).toBe(1);
					expect(dirtySubmit.stdout).toContain("verified-clean");
					unlinkSync(dirtyPath);
					const submitted = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"submit",
							"--task-id",
							taskId,
							"--report-file",
							reportPath,
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
						timeoutMs: 90_000,
					});
					expect(
						submitted.exitCode,
						`clean read-only submission failed.\nstdout:\n${submitted.stdout}\nstderr:\n${submitted.stderr}`,
					).toBe(0);
					expect(submitted.stdout).toContain('"deliverableKind": "read_only_report"');
					expect(submitted.stdout).toContain('"column": "review"');
					const exposedReviewTasks = await runCliCommandAndCollectOutput({
						args: ["task", "list", "--column", "review", "--project-path", projectPath],
						cwd: projectPath,
						env,
						timeoutMs: 90_000,
					});
					expect(exposedReviewTasks.exitCode).toBe(0);
					const exposedReviewPayload = JSON.parse(exposedReviewTasks.stdout) as {
						tasks?: Array<{ id?: string; origin?: { kind?: string; threadId?: string } }>;
					};
					const exposedOriginThreadId = exposedReviewPayload.tasks?.find((task) => task.id === taskId)?.origin
						?.threadId;
					expect(exposedOriginThreadId).toBe("T-read-only-test");
					if (!exposedOriginThreadId) throw new Error("Expected list to expose the task's Amp origin thread ID.");
					const wrongThreadAcceptance = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"accept",
							"--task-id",
							taskId,
							"--origin-amp-thread-id",
							"T-wrong-thread",
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
						timeoutMs: 90_000,
					});
					expect(wrongThreadAcceptance.exitCode).toBe(1);
					expect(wrongThreadAcceptance.stdout).toContain("origin thread");

					const accepted = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"accept",
							"--task-id",
							taskId,
							"--origin-amp-thread-id",
							exposedOriginThreadId,
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
						timeoutMs: 90_000,
					});
					expect(accepted.exitCode).toBe(0);
					expect(accepted.stdout).toContain('"kind": "verified_no_change_report"');

					const archivedTasks = await runCliCommandAndCollectOutput({
						args: ["task", "list", "--column", "trash", "--project-path", projectPath],
						cwd: projectPath,
						env,
						timeoutMs: 90_000,
					});
					expect(archivedTasks.exitCode).toBe(0);
					const archivedPayload = JSON.parse(archivedTasks.stdout) as {
						tasks?: Array<{ id?: string; column?: string; acceptanceEvidence?: { kind?: string } }>;
					};
					expect(archivedPayload.tasks).toContainEqual(
						expect.objectContaining({
							id: taskId,
							column: "trash",
							acceptanceEvidence: expect.objectContaining({ kind: "verified_no_change_report" }),
						}),
					);
				} finally {
					await requestGracefulShutdown(serverProcess);
					if (!(await waitForExit(serverProcess, 5_000))) serverProcess.kill("SIGKILL");
				}
			} finally {
				cleanupProject();
				cleanupHome();
			}
		},
	);

	it("opens only for launch invocations", { timeout: 60_000 }, async () => {
		if (process.platform === "win32") {
			return;
		}

		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-root-launch-open-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-root-launch-open-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Root Launch Browser Open Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const browserStubBinDir = join(homeDir, "browser-bin");
			const browserOpenLogPath = join(homeDir, "browser-open.log");
			installBrowserOpenStub(browserStubBinDir, browserOpenLogPath);
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
				PATH: `${browserStubBinDir}:${process.env.PATH ?? ""}`,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveSentryStubHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				for (const [args, expectedOpenCount] of [
					[[], 1],
					[["task", "list", "--project-path", projectPath], 1],
					[["--agent", "codex"], 2],
					[["--port", port], 3],
				] as const) {
					const result = await runCliCommandAndCollectOutput({
						args: [...args],
						cwd: projectPath,
						env,
					});
					expect(result.didExit).toBe(true);
					expect(result.exitCode).toBe(0);
					await waitForBrowserOpenCount(browserOpenLogPath, expectedOpenCount);
					expect(readBrowserOpenLog(browserOpenLogPath)).toHaveLength(expectedOpenCount);
				}
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it(
		"supports claim, submit, explicit trash deletion, and keeps accept origin-fenced",
		{ timeout: 90_000 },
		async () => {
			const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-done-delete-");
			const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-done-delete-");

			try {
				initGitRepository(projectPath);
				writeFileSync(join(projectPath, "README.md"), "# Task Done Delete Test\n", "utf8");
				commitAll(projectPath, "init");

				const port = String(await getAvailablePort());
				const env = createGitTestEnv({
					HOME: homeDir,
					USERPROFILE: homeDir,
					KANBAN_RUNTIME_PORT: port,
				});

				const serverProcess = spawn(
					process.execPath,
					[
						"--require",
						resolveShutdownIpcHookPath(),
						"--import",
						resolveSentryStubHookPath(),
						"--import",
						resolveTsxLoaderImportSpecifier(),
						resolve(process.cwd(), "src/cli.ts"),
						"--no-open",
					],
					{
						cwd: projectPath,
						env,
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					},
				);

				try {
					await waitForServerStart(serverProcess, 30_000);

					const taskIds: string[] = [];
					for (const prompt of [
						"Create a temporary task for done and delete",
						"Create another temporary task for done and delete",
						"Create a legacy trash command task for done and delete",
					]) {
						const created = await runCliCommandAndCollectOutput({
							args: ["task", "create", "--prompt", prompt, "--project-path", projectPath],
							cwd: projectPath,
							env,
						});
						expect(
							created.didExit,
							`task create did not exit in time.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
						).toBe(true);
						expect(created.exitCode).toBe(0);

						const createdPayload = JSON.parse(created.stdout) as {
							ok?: boolean;
							task?: { id?: string };
						};
						expect(createdPayload.ok).toBe(true);
						expect(typeof createdPayload.task?.id).toBe("string");
						if (createdPayload.task?.id) {
							taskIds.push(createdPayload.task.id);
						}
					}
					expect(taskIds).toHaveLength(3);

					const prepared = await runCliCommandAndCollectOutput({
						args: ["task", "prepare", "--task-id", taskIds[0] ?? "", "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(prepared.didExit).toBe(true);
					expect(prepared.exitCode).toBe(0);
					const preparedPayload = JSON.parse(prepared.stdout) as {
						ok?: boolean;
						task?: { column?: string; projectPath?: string; taskWorkspacePath?: string };
					};
					expect(preparedPayload.ok).toBe(true);
					expect(preparedPayload.task?.column).toBe("in_progress");
					expect(preparedPayload.task?.projectPath).toBe(realpathSync(projectPath));
					expect(preparedPayload.task?.taskWorkspacePath).toBeTruthy();
					expect(existsSync(preparedPayload.task?.taskWorkspacePath ?? "")).toBe(true);
					const taskWorkspacePath = preparedPayload.task?.taskWorkspacePath;
					if (!taskWorkspacePath) {
						throw new Error("Expected prepared task workspace path.");
					}

					const listedPrepared = await runCliCommandAndCollectOutput({
						args: ["task", "list", "--column", "in_progress", "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(listedPrepared.didExit).toBe(true);
					expect(listedPrepared.exitCode).toBe(0);
					const listedPreparedPayload = JSON.parse(listedPrepared.stdout) as {
						tasks?: Array<{ id?: string; taskWorkspacePath?: string; taskWorkspaceExists?: boolean }>;
					};
					const listedPreparedTask = listedPreparedPayload.tasks?.find((task) => task.id === taskIds[0]);
					expect(listedPreparedTask?.taskWorkspacePath).toBe(preparedPayload.task?.taskWorkspacePath);
					expect(listedPreparedTask?.taskWorkspaceExists).toBe(true);

					const claimed = await runCliCommandAndCollectOutput({
						args: ["task", "claim", "--task-id", taskIds[0] ?? "", "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(claimed.didExit).toBe(true);
					expect(claimed.exitCode).toBe(0);
					expect(claimed.stdout).toContain('"column": "in_progress"');

					const submitted = await runCliCommandAndCollectOutput({
						args: ["task", "submit", "--task-id", taskIds[0] ?? "", "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(submitted.didExit).toBe(true);
					expect(submitted.exitCode).toBe(0);
					expect(submitted.stdout).toContain('"column": "review"');

					const movedByDoneAlias = await runCliCommandAndCollectOutput({
						args: ["task", "done", "--task-id", taskIds[0] ?? "", "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(
						movedByDoneAlias.didExit,
						`task done did not exit in time.\nstdout:\n${movedByDoneAlias.stdout}\nstderr:\n${movedByDoneAlias.stderr}`,
					).toBe(true);
					expect(movedByDoneAlias.exitCode).toBe(1);
					expect(`${movedByDoneAlias.stdout}\n${movedByDoneAlias.stderr}`).toContain("unknown command 'done'");

					const accepted = await runCliCommandAndCollectOutput({
						args: ["task", "accept", "--task-id", taskIds[0] ?? "", "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(accepted.didExit).toBe(true);
					expect(accepted.exitCode).toBe(1);
					expect(`${accepted.stdout}\n${accepted.stderr}`).toContain("required option '--origin-amp-thread-id");
					expect(existsSync(taskWorkspacePath)).toBe(true);

					const movedByTrashCommand = await runCliCommandAndCollectOutput({
						args: ["task", "trash", "--column", "backlog", "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(
						movedByTrashCommand.didExit,
						`task trash did not exit in time.\nstdout:\n${movedByTrashCommand.stdout}\nstderr:\n${movedByTrashCommand.stderr}`,
					).toBe(true);
					expect(movedByTrashCommand.exitCode).toBe(0);
					expect(movedByTrashCommand.stdout).toContain('"ok": true');
					expect(movedByTrashCommand.stdout).toContain('"column": "backlog"');
					expect(movedByTrashCommand.stdout).toContain('"count": 2');

					const listedTrashBeforeDelete = await runCliCommandAndCollectOutput({
						args: ["task", "list", "--column", "trash", "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(
						listedTrashBeforeDelete.didExit,
						`task list --column trash did not exit in time.\nstdout:\n${listedTrashBeforeDelete.stdout}\nstderr:\n${listedTrashBeforeDelete.stderr}`,
					).toBe(true);
					expect(listedTrashBeforeDelete.exitCode).toBe(0);
					expect(listedTrashBeforeDelete.stdout).toContain('"count": 2');

					const deletedTrash = await runCliCommandAndCollectOutput({
						args: ["task", "delete", "--column", "trash", "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(
						deletedTrash.didExit,
						`task delete --column trash did not exit in time.\nstdout:\n${deletedTrash.stdout}\nstderr:\n${deletedTrash.stderr}`,
					).toBe(true);
					expect(deletedTrash.exitCode).toBe(0);
					expect(deletedTrash.stdout).toContain('"ok": true');
					expect(deletedTrash.stdout).toContain('"column": "trash"');
					expect(deletedTrash.stdout).toContain('"count": 2');
					expect(existsSync(taskWorkspacePath)).toBe(true);

					const listedTrash = await runCliCommandAndCollectOutput({
						args: ["task", "list", "--column", "trash", "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(
						listedTrash.didExit,
						`task list --column trash did not exit in time.\nstdout:\n${listedTrash.stdout}\nstderr:\n${listedTrash.stderr}`,
					).toBe(true);
					expect(listedTrash.exitCode).toBe(0);
					expect(listedTrash.stdout).toContain('"count": 0');
				} finally {
					await requestGracefulShutdown(serverProcess);
					const stopped = await waitForExit(serverProcess, 5_000);
					if (!stopped) {
						serverProcess.kill("SIGKILL");
						await waitForExit(serverProcess, 5_000);
					}
				}
			} finally {
				cleanupProject();
				cleanupHome();
			}
		},
	);
});
