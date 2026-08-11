// Coordinates the runtime-side TRPC handlers used by the browser.
// This is the main backend entrypoint for sessions, settings, git, and
// workspace actions, but detailed terminal and config behavior should stay
// in focused services instead of accumulating here.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import type { RuntimeConfigState } from "../config/runtime-config";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config";
import type {
	RuntimeBoardCard,
	RuntimeCommandRunResponse,
	RuntimeRunUpdateResponse,
	RuntimeSystemReadinessResponse,
	RuntimeTaskExecutionAttemptReference,
	RuntimeTaskExecutionProjectionResponse,
	RuntimeTracksProjection,
	RuntimeUpdateStatusResponse,
	RuntimeWorkerCommandLogResponse,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import {
	parseCommandRunRequest,
	parseRuntimeConfigSaveRequest,
	parseShellSessionStartRequest,
	parseTaskSessionInputRequest,
	parseTaskSessionStartRequest,
	parseTaskSessionStopRequest,
} from "../core/api-validation";
import { recordTaskExecutionAttempt } from "../core/task-board-mutations";
import { formatTaskExecutionReference, resolveTaskGeneration } from "../core/task-execution-reference";
import { buildTracksProjection } from "../core/tracks-projection";
import { enqueueAbsurdTaskStart } from "../orchestration/absurd-task-start";
import { getAbsurdTaskProjections, getSystemReadiness } from "../orchestration/absurd-task-status";
import { openInBrowser } from "../server/browser";
import type {
	RuntimeWorkspaceAtomicMutationResponse,
	RuntimeWorkspaceAtomicMutationResult,
} from "../state/workspace-state";
import { getLegacyTaskWorktreesHomePath, getTaskWorkspacesHomePath } from "../state/workspace-state";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../terminal/agent-registry";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { resolveTaskCwd } from "../workspace/task-worktree";
import { captureBestEffortTurnCheckpoint } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

export interface CreateRuntimeApiDependencies {
	getActiveWorkspaceId: () => string | null;
	getActiveRuntimeConfig?: () => RuntimeConfigState;
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	prepareForStateReset?: () => Promise<void>;
	getUpdateStatus: () => RuntimeUpdateStatusResponse;
	runUpdateNow: () => Promise<RuntimeRunUpdateResponse>;
	buildWorkspaceStateSnapshot: (workspaceId: string, workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
	mutateWorkspaceState: <T>(
		workspacePath: string,
		mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceAtomicMutationResult<T>,
	) => Promise<RuntimeWorkspaceAtomicMutationResponse<T>>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
}

const ABSURD_WORKER_AGENT_IDS = new Set(["claude", "codex", "grok", "kimi"]);

function findBoardTask(
	state: RuntimeWorkspaceStateResponse,
	taskId: string,
): { card: RuntimeBoardCard; columnId: string } | null {
	for (const column of state.board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return { card, columnId: column.id };
		}
	}
	return null;
}

async function resolveExistingTaskCwdOrEnsure(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<string> {
	try {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: false,
		});
	} catch {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: true,
		});
	}
}

export function createRuntimeApi(deps: CreateRuntimeApiDependencies): RuntimeTrpcContext["runtimeApi"] {
	const lastAllocatedAttemptQueuedAtByTask = new Map<string, number>();
	const debugResetTargetPaths = [
		join(homedir(), ".cline", "kanban"),
		getTaskWorkspacesHomePath(),
		getLegacyTaskWorktreesHomePath(),
	] as const;

	return {
		loadConfig: async (workspaceScope) => {
			const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
			if (!workspaceScope && !activeRuntimeConfig) {
				throw new Error("No active runtime config provider is available.");
			}
			let scopedRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			} else if (activeRuntimeConfig) {
				scopedRuntimeConfig = activeRuntimeConfig;
			} else {
				throw new Error("No active runtime config provider is available.");
			}
			return buildRuntimeConfigResponse(scopedRuntimeConfig);
		},
		saveConfig: async (workspaceScope, input) => {
			const parsed = parseRuntimeConfigSaveRequest(input);
			let nextRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				nextRuntimeConfig = await updateRuntimeConfig(workspaceScope.workspacePath, parsed);
			} else {
				const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
				if (!activeRuntimeConfig) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "No active runtime config is available.",
					});
				}
				nextRuntimeConfig = await updateGlobalRuntimeConfig(activeRuntimeConfig, parsed);
			}
			if (workspaceScope && workspaceScope.workspaceId === deps.getActiveWorkspaceId()) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			if (!workspaceScope) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			return buildRuntimeConfigResponse(nextRuntimeConfig);
		},
		enqueueTaskExecution: async (workspaceScope, input) => {
			try {
				const taskId = input.taskId.trim();
				if (!taskId) {
					throw new Error("Task execution taskId cannot be empty.");
				}
				const state = await deps.buildWorkspaceStateSnapshot(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				const record = findBoardTask(state, taskId);
				if (!record) {
					throw new Error(`Task "${taskId}" was not found.`);
				}
				const allowedColumns = input.resumeFromTrash
					? new Set(["trash", "review", "in_progress"])
					: new Set(["backlog", "in_progress"]);
				if (!allowedColumns.has(record.columnId)) {
					throw new Error(
						`Task "${taskId}" is in "${record.columnId}" and cannot be ${input.resumeFromTrash ? "resumed" : "started"}.`,
					);
				}
				if (state.board.dependencies.some((dependency) => dependency.fromTaskId === taskId)) {
					throw new Error(`Task "${taskId}" cannot be started until all of its prerequisites are accepted.`);
				}
				if (record.card.removedAgentId === "cline") {
					throw new Error(
						`Task "${taskId}" still references the removed Cline worker. Assign a supported worker before starting it.`,
					);
				}
				const runtimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				const agentId = record.card.agentId ?? runtimeConfig.selectedAgentId;
				if (!ABSURD_WORKER_AGENT_IDS.has(agentId)) {
					throw new Error(
						`Worker "${agentId}" is not supported by the Absurd Kanban execution queue. Assign Claude, Codex, Grok, or Kimi.`,
					);
				}
				const generation = resolveTaskGeneration(record.card.generation);
				const allocationKey = `${workspaceScope.workspaceId}\u0000${taskId}\u0000${generation}`;
				const queuedAt = Math.max(
					Date.now(),
					record.card.execution?.generation === generation ? record.card.execution.queuedAt + 1 : 0,
					(lastAllocatedAttemptQueuedAtByTask.get(allocationKey) ?? 0) + 1,
				);
				lastAllocatedAttemptQueuedAtByTask.set(allocationKey, queuedAt);
				const receipt = await enqueueAbsurdTaskStart({
					taskExecutionReference: formatTaskExecutionReference(record.card.id, generation, {
						queuedAt,
						resumeFromTrash: input.resumeFromTrash,
					}),
					projectPath: workspaceScope.workspacePath,
					agentId,
				});
				const attempt: RuntimeTaskExecutionAttemptReference = {
					attemptId: receipt.attemptId,
					generation,
					queuedAt,
				};
				const persistedAttempt = await deps.mutateWorkspaceState(workspaceScope.workspacePath, (latestState) => {
					const latestRecord = findBoardTask(latestState, taskId);
					if (!latestRecord) {
						throw new Error(`Task "${taskId}" changed while its execution attempt was being queued.`);
					}
					if (!allowedColumns.has(latestRecord.columnId)) {
						throw new Error(`Task "${taskId}" changed while its execution attempt was being queued.`);
					}
					if (latestState.board.dependencies.some((dependency) => dependency.fromTaskId === taskId)) {
						throw new Error(`Task "${taskId}" cannot be started until all of its prerequisites are accepted.`);
					}
					const recorded = recordTaskExecutionAttempt(latestState.board, taskId, attempt);
					if (!recorded.recorded) {
						throw new Error(`Task "${taskId}" changed while its execution attempt was being queued.`);
					}
					return {
						board: recorded.board,
						value: recorded.task,
						save: recorded.updated,
					};
				});
				if (persistedAttempt.saved) {
					await deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				return {
					ok: true,
					state: "queued",
					task: {
						id: record.card.id,
						generation,
					},
					attempt,
				};
			} catch (error) {
				return {
					ok: false,
					state: null,
					task: null,
					attempt: null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
		getTaskExecutionProjections: async (_workspaceScope, input): Promise<RuntimeTaskExecutionProjectionResponse> => ({
			generatedAt: Date.now(),
			attempts: await getAbsurdTaskProjections(input.attempts),
		}),
		getSystemReadiness: async (workspaceScope): Promise<RuntimeSystemReadinessResponse> => ({
			generatedAt: Date.now(),
			checks: await getSystemReadiness(workspaceScope.workspacePath),
		}),
		getWorkerCommandLog: async (workspaceScope): Promise<RuntimeWorkerCommandLogResponse> => {
			const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
			return {
				generatedAt: Date.now(),
				entries: terminalManager.listWorkerCommandLog(),
			};
		},
		getTracksProjection: async (workspaceScope): Promise<RuntimeTracksProjection> => {
			const state = await deps.buildWorkspaceStateSnapshot(workspaceScope.workspaceId, workspaceScope.workspacePath);
			return buildTracksProjection({
				projectRef: workspaceScope.workspaceId,
				revision: state.revision,
				board: state.board,
			});
		},
		startTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStartRequest(input);
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				const taskCwd = await resolveExistingTaskCwdOrEnsure({
					cwd: workspaceScope.workspacePath,
					taskId: body.taskId,
					baseRef: body.baseRef,
				});
				const shouldCaptureTurnCheckpoint = !body.resumeFromTrash;

				// Per-task config source-of-truth precedence:
				//
				// agentId resolution (which agent runtime to use):
				//   1. previousTerminalAgentId — persisted in the terminal session summary from
				//      the last run; ensures trash-restore resumes with the same agent runtime.
				//   2. body.agentId — the card's current per-task agent override.
				//   3. scopedRuntimeConfig.selectedAgentId — the workspace-level default.
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const previousTerminalAgentId = body.resumeFromTrash
					? (terminalManager.getSummary(body.taskId)?.agentId ?? null)
					: null;
				const effectiveAgentId = previousTerminalAgentId ?? body.agentId ?? scopedRuntimeConfig.selectedAgentId;

				const resolvedConfig =
					effectiveAgentId !== scopedRuntimeConfig.selectedAgentId
						? { ...scopedRuntimeConfig, selectedAgentId: effectiveAgentId }
						: scopedRuntimeConfig;
				const resolved = resolveAgentCommand(resolvedConfig);
				if (!resolved) {
					return {
						ok: false,
						summary: null,
						error: "No runnable agent command is configured. Open Settings, install a supported CLI, and select it.",
					};
				}
				const summary = await terminalManager.startTaskSession({
					taskId: body.taskId,
					agentId: resolved.agentId,
					binary: resolved.binary,
					args: resolved.args,
					autonomousModeEnabled: scopedRuntimeConfig.agentAutonomousModeEnabled,
					cwd: taskCwd,
					prompt: body.prompt,
					images: body.images,
					startInPlanMode: body.startInPlanMode,
					resumeFromTrash: body.resumeFromTrash,
					cols: body.cols,
					rows: body.rows,
					workspaceId: workspaceScope.workspaceId,
					projectPath: workspaceScope.workspacePath,
					executionAttempt: body.executionAttempt,
				});

				let nextSummary = summary;
				if (shouldCaptureTurnCheckpoint) {
					const checkpoint = await captureBestEffortTurnCheckpoint({
						cwd: taskCwd,
						taskId: body.taskId,
						latestTurnCheckpoint: summary.latestTurnCheckpoint,
					});
					if (checkpoint) {
						nextSummary = terminalManager.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
					}
				}
				return {
					ok: true,
					summary: nextSummary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		stopTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStopRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = await terminalManager.stopTaskSession(body.taskId, body.executionAttemptId);
				return {
					ok: Boolean(summary),
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		sendTaskSessionInput: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionInputRequest(input);
				const payloadText = body.appendNewline ? `${body.text}\n` : body.text;
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.writeInput(body.taskId, Buffer.from(payloadText, "utf8"));
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		startShellSession: async (workspaceScope, input) => {
			try {
				const body = parseShellSessionStartRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const shell = deps.resolveInteractiveShellCommand();
				const shellCwd = body.workspaceTaskId
					? await resolveTaskCwd({
							cwd: workspaceScope.workspacePath,
							taskId: body.workspaceTaskId,
							baseRef: body.baseRef,
							ensure: true,
						})
					: workspaceScope.workspacePath;
				const summary = await terminalManager.startShellSession({
					taskId: body.taskId,
					cwd: shellCwd,
					cols: body.cols,
					rows: body.rows,
					binary: shell.binary,
					args: shell.args,
				});
				return {
					ok: true,
					summary,
					shellBinary: shell.binary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					shellBinary: null,
					error: message,
				};
			}
		},
		runCommand: async (workspaceScope, input) => {
			try {
				const body = parseCommandRunRequest(input);
				return await deps.runCommand(body.command, workspaceScope.workspacePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message,
				});
			}
		},
		resetAllState: async (_workspaceScope) => {
			await deps.prepareForStateReset?.();
			await Promise.all(
				debugResetTargetPaths.map(async (path) => {
					await rm(path, { recursive: true, force: true });
				}),
			);
			return {
				ok: true,
				clearedPaths: [...debugResetTargetPaths],
			};
		},
		openFile: async (input) => {
			const filePath = input.filePath.trim();
			if (!filePath) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "File path cannot be empty.",
				});
			}
			openInBrowser(filePath);
			return { ok: true };
		},
		getUpdateStatus: async () => {
			return deps.getUpdateStatus();
		},
		runUpdateNow: async () => {
			return await deps.runUpdateNow();
		},
	};
}
