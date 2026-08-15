import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { Command } from "commander";

import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardDependency,
	RuntimeTaskDeliverableKind,
	RuntimeTaskOrigin,
	RuntimeTaskReviewSubmission,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { runtimeAgentIdSchema, runtimeAmpThreadIdSchema, runtimeTaskDeliverableKindSchema } from "../core/api-contract";
import { buildKanbanRuntimeUrl, getKanbanRuntimeOrigin, getRuntimeFetch } from "../core/runtime-endpoint";
import {
	addTaskDependency,
	addTaskToColumn,
	deleteTasksFromBoard,
	discardTask,
	getTaskColumnId,
	moveTaskToColumn,
	type RuntimeAddTaskDependencyResult,
	removeTaskDependency,
	submitTaskReview,
	updateTask,
} from "../core/task-board-mutations";
import {
	assertCurrentTaskExecutionAttempt,
	assertCurrentTaskExecutionReference,
	parseTaskExecutionReference,
	resolveTaskGeneration,
	waitForCurrentTaskExecutionAttempt,
} from "../core/task-execution-reference";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceContext, mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeAppRouter } from "../trpc/app-router";
import { inspectReviewWorkspace } from "../workspace/review-workspace-receipt";
import { acceptTaskFromTrustedLocalControlPlane } from "../workspace/task-acceptance";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";

const LIST_TASK_COLUMNS = ["backlog", "in_progress", "review", "trash"] as const;
type ListTaskColumn = (typeof LIST_TASK_COLUMNS)[number];
type TaskCommandTarget = { taskId?: string; column?: ListTaskColumn };

type ResolvedTaskCommandTarget =
	| {
			kind: "task";
			taskId: string;
	  }
	| {
			kind: "column";
			column: ListTaskColumn;
	  };

interface RuntimeWorkspaceMutationResult<T> {
	board: RuntimeWorkspaceStateResponse["board"];
	value: T;
}

type JsonRecord = Record<string, unknown>;

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseListColumn(value: string | undefined): ListTaskColumn | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "backlog" || value === "in_progress" || value === "review" || value === "trash") {
		return value;
	}
	throw new Error(`Invalid column "${value}". Expected one of: ${LIST_TASK_COLUMNS.join(", ")}.`);
}

const VALID_AGENT_IDS = runtimeAgentIdSchema.options;
const VALID_DELIVERABLE_KINDS = runtimeTaskDeliverableKindSchema.options;

function parseAgentId(value: string | undefined): RuntimeAgentId | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "default") {
		return null;
	}
	const result = runtimeAgentIdSchema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new Error(`Invalid agent ID "${value}". Expected one of: ${VALID_AGENT_IDS.join(", ")}, default.`);
}

function parseDeliverableKind(value: string | undefined): RuntimeTaskDeliverableKind | undefined {
	if (value === undefined) return undefined;
	const parsed = runtimeTaskDeliverableKindSchema.safeParse(value.trim());
	if (parsed.success) return parsed.data;
	throw new Error(`Invalid deliverable kind "${value}". Expected one of: ${VALID_DELIVERABLE_KINDS.join(", ")}.`);
}

function parseAmpArchitectOrigin(threadId: string | undefined): RuntimeTaskOrigin | undefined {
	if (threadId === undefined) {
		return undefined;
	}
	const parsed = runtimeAmpThreadIdSchema.safeParse(threadId.trim());
	if (!parsed.success) {
		throw new Error(`Invalid Amp Architect thread ID "${threadId}".`);
	}
	return {
		kind: "amp_architect",
		threadId: parsed.data,
	};
}

function resolveTaskCommandTarget(input: TaskCommandTarget, commandName: string): ResolvedTaskCommandTarget {
	const taskId = input.taskId?.trim();
	const column = input.column;
	if (taskId && column) {
		throw new Error(`${commandName} accepts exactly one of --task-id or --column.`);
	}
	if (taskId) {
		return {
			kind: "task",
			taskId,
		};
	}
	if (column) {
		return {
			kind: "column",
			column,
		};
	}
	throw new Error(`${commandName} requires either --task-id or --column.`);
}

function createRuntimeTrpcClient(workspaceId: string | null) {
	return createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: buildKanbanRuntimeUrl("/api/trpc"),
				headers: () => (workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}),
				fetch: async (url, options) => {
					const runtimeFetch = await getRuntimeFetch();
					return runtimeFetch(url, options);
				},
			}),
		],
	});
}

async function resolveRuntimeWorkspace(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
) {
	const normalizedProjectPath = (projectPath ?? "").trim();
	const resolvedPath = normalizedProjectPath ? resolveProjectInputPath(normalizedProjectPath, cwd) : cwd;
	return await loadWorkspaceContext(resolvedPath, {
		autoCreateIfMissing: options.autoCreateIfMissing ?? true,
	});
}

async function resolveWorkspaceRepoPath(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
): Promise<string> {
	const workspace = await resolveRuntimeWorkspace(projectPath, cwd, options);
	return workspace.repoPath;
}

async function ensureRuntimeWorkspace(workspaceRepoPath: string): Promise<string> {
	const runtimeClient = createRuntimeTrpcClient(null);
	const added = await runtimeClient.projects.add.mutate({
		path: workspaceRepoPath,
	});
	if (!added.ok || !added.project) {
		throw new Error(added.error ?? `Could not register project ${workspaceRepoPath} in Kanban runtime.`);
	}
	return added.project.id;
}

async function notifyRuntimeWorkspaceStateUpdated(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
): Promise<void> {
	await runtimeClient.workspace.notifyStateUpdated.mutate().catch(() => null);
}

async function updateRuntimeWorkspaceState<T>(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	workspaceRepoPath: string,
	mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceMutationResult<T>,
): Promise<T> {
	const mutationResponse = await mutateWorkspaceState(workspaceRepoPath, (state) => {
		const mutation = mutate(state);
		return {
			board: mutation.board,
			value: mutation.value,
		};
	});

	if (mutationResponse.saved) {
		await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	}

	return mutationResponse.value;
}

function resolveTaskBaseRef(state: RuntimeWorkspaceStateResponse): string {
	return state.git.currentBranch ?? state.git.defaultBranch ?? state.git.branches[0] ?? "";
}

function findTaskRecord(
	state: RuntimeWorkspaceStateResponse,
	taskId: string,
): { task: RuntimeBoardCard; columnId: RuntimeBoardColumnId } | null {
	for (const column of state.board.columns) {
		const task = column.cards.find((candidate) => candidate.id === taskId);
		if (task) {
			return {
				task,
				columnId: column.id,
			};
		}
	}
	return null;
}

function formatTaskRecord(
	state: RuntimeWorkspaceStateResponse,
	task: RuntimeBoardCard,
	columnId: RuntimeBoardColumnId,
): JsonRecord {
	const session = state.sessions[task.id] ?? null;
	return {
		id: task.id,
		prompt: task.prompt,
		column: columnId,
		baseRef: task.baseRef,
		startInPlanMode: task.startInPlanMode,
		...(task.agentId ? { agentId: task.agentId } : {}),
		...(task.origin ? { origin: task.origin } : {}),
		...(task.deliverableKind ? { deliverableKind: task.deliverableKind } : {}),
		...(task.submission ? { submission: task.submission } : {}),
		...(task.acceptanceEvidence ? { acceptanceEvidence: task.acceptanceEvidence } : {}),
		generation: resolveTaskGeneration(task.generation),
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		session: session
			? {
					state: session.state,
					agentId: session.agentId,
					pid: session.pid,
					startedAt: session.startedAt,
					updatedAt: session.updatedAt,
					lastOutputAt: session.lastOutputAt,
					reviewReason: session.reviewReason,
					exitCode: session.exitCode,
				}
			: null,
	};
}

async function formatTaskRecordWithWorkspace(
	state: RuntimeWorkspaceStateResponse,
	task: RuntimeBoardCard,
	columnId: RuntimeBoardColumnId,
	workspaceRepoPath: string,
): Promise<JsonRecord> {
	const taskWorkspace = await getTaskWorkspacePathInfo({
		cwd: workspaceRepoPath,
		taskId: task.id,
		baseRef: task.baseRef,
	});
	return {
		...formatTaskRecord(state, task, columnId),
		taskWorkspacePath: taskWorkspace.path,
		taskWorkspaceExists: taskWorkspace.exists,
	};
}

function formatDependencyRecord(
	state: RuntimeWorkspaceStateResponse,
	dependency: RuntimeBoardDependency,
): Record<string, unknown> {
	return {
		id: dependency.id,
		backlogTaskId: dependency.fromTaskId,
		backlogTaskColumn: getTaskColumnId(state.board, dependency.fromTaskId),
		linkedTaskId: dependency.toTaskId,
		linkedTaskColumn: getTaskColumnId(state.board, dependency.toTaskId),
		createdAt: dependency.createdAt,
	};
}

function getLinkFailureMessage(reason: RuntimeAddTaskDependencyResult["reason"]): string {
	if (reason === "same_task") {
		return "A task cannot be linked to itself.";
	}
	if (reason === "duplicate") {
		return "These tasks are already linked.";
	}
	if (reason === "trash_task") {
		return "Links cannot include archived tasks.";
	}
	if (reason === "non_backlog") {
		return "Links require at least one backlog task.";
	}
	if (reason === "task_admitted") {
		return "A dependency cannot be added after a task execution has been admitted.";
	}
	return "One or both tasks could not be found.";
}

function findTasksInColumn(
	state: RuntimeWorkspaceStateResponse,
	columnId: ListTaskColumn,
): Array<{ task: RuntimeBoardCard; columnId: RuntimeBoardColumnId }> {
	const column = state.board.columns.find((candidate) => candidate.id === columnId);
	if (!column) {
		return [];
	}
	return column.cards.map((task) => ({
		task,
		columnId: column.id,
	}));
}

async function listTasks(input: { cwd: string; projectPath?: string; column?: ListTaskColumn }): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();

	const taskRecords = state.board.columns.flatMap((boardColumn) => {
		if (!input.column && boardColumn.id === "trash") {
			return [];
		}
		if (input.column && boardColumn.id !== input.column) {
			return [];
		}
		return boardColumn.cards.map((task) => ({ task, columnId: boardColumn.id }));
	});
	const tasks = await Promise.all(
		taskRecords.map(
			async ({ task, columnId }) => await formatTaskRecordWithWorkspace(state, task, columnId, workspace.repoPath),
		),
	);

	return {
		ok: true,
		workspacePath: workspace.repoPath,
		column: input.column ?? null,
		tasks,
		dependencies: state.board.dependencies.map((dependency) => formatDependencyRecord(state, dependency)),
		count: tasks.length,
	};
}

async function stopTaskRuntimeSession(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	taskId: string,
	executionAttemptId?: string | null,
): Promise<void> {
	const stopped = await runtimeClient.runtime.stopTaskSession.mutate({ taskId, executionAttemptId });
	if (!stopped.ok && stopped.error) {
		throw new Error(`Could not stop task session "${taskId}": ${stopped.error}`);
	}
}

async function deleteTaskWorkspace(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	taskId: string,
): Promise<{ removed: boolean; error?: string }> {
	try {
		const deleted = await runtimeClient.workspace.deleteWorktree.mutate({ taskId });
		return {
			removed: deleted.removed,
			error: deleted.ok ? undefined : deleted.error,
		};
	} catch (error) {
		return {
			removed: false,
			error: toErrorMessage(error),
		};
	}
}

async function createTask(input: {
	cwd: string;
	title?: string;
	prompt: string;
	projectPath?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	agentId?: RuntimeAgentId;
	origin?: RuntimeTaskOrigin;
	deliverableKind?: RuntimeTaskDeliverableKind;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const created = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (state) => {
		const resolvedBaseRef = (input.baseRef ?? "").trim() || resolveTaskBaseRef(state);
		if (!resolvedBaseRef) {
			throw new Error("Could not determine task base branch for this workspace.");
		}
		const result = addTaskToColumn(
			state.board,
			"backlog",
			{
				title: input.title,
				prompt: input.prompt,
				startInPlanMode: input.startInPlanMode,
				agentId: input.agentId,
				origin: input.origin,
				deliverableKind: input.deliverableKind,
				baseRef: resolvedBaseRef,
			},
			() => globalThis.crypto.randomUUID(),
		);
		return {
			board: result.board,
			value: result.task,
		};
	});

	return {
		ok: true,
		task: {
			id: created.id,
			column: "backlog",
			workspacePath: workspaceRepoPath,
			title: created.title,
			prompt: created.prompt,
			baseRef: created.baseRef,
			startInPlanMode: created.startInPlanMode,
			...(created.agentId ? { agentId: created.agentId } : {}),
			...(created.origin ? { origin: created.origin } : {}),
			...(created.deliverableKind ? { deliverableKind: created.deliverableKind } : {}),
			generation: resolveTaskGeneration(created.generation),
		},
	};
}

async function updateTaskCommand(input: {
	cwd: string;
	taskId: string;
	title?: string;
	projectPath?: string;
	prompt?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	agentId?: RuntimeAgentId | null;
	deliverableKind?: RuntimeTaskDeliverableKind;
}): Promise<JsonRecord> {
	if (
		input.title === undefined &&
		input.prompt === undefined &&
		input.baseRef === undefined &&
		input.startInPlanMode === undefined &&
		input.agentId === undefined &&
		input.deliverableKind === undefined
	) {
		throw new Error("task update requires at least one field to change.");
	}

	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const updated = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const taskRecord = findTaskRecord(runtimeState, input.taskId);
		if (!taskRecord) {
			throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
		}
		const updatedTask = updateTask(runtimeState.board, input.taskId, {
			title: input.title ?? taskRecord.task.title,
			prompt: input.prompt ?? taskRecord.task.prompt,
			baseRef: input.baseRef ?? taskRecord.task.baseRef,
			startInPlanMode: input.startInPlanMode ?? taskRecord.task.startInPlanMode,
			agentId: input.agentId,
			deliverableKind: input.deliverableKind,
		});
		if (!updatedTask.updated || !updatedTask.task) {
			throw new Error(`Task "${input.taskId}" could not be updated.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: updatedTask.board,
		};

		return {
			board: updatedTask.board,
			value: formatTaskRecord(nextState, updatedTask.task, taskRecord.columnId),
		};
	});

	return {
		ok: true,
		task: updated,
		workspacePath: workspaceRepoPath,
	};
}

async function linkTasks(input: {
	cwd: string;
	taskId: string;
	linkedTaskId: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const dependency = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const linked = addTaskDependency(runtimeState.board, input.taskId, input.linkedTaskId);
		if (!linked.added || !linked.dependency) {
			throw new Error(getLinkFailureMessage(linked.reason));
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: linked.board,
		};
		return {
			board: linked.board,
			value: formatDependencyRecord(nextState, linked.dependency),
		};
	});
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		dependency,
	};
}

async function unlinkTasks(input: { cwd: string; dependencyId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const removedDependency = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const dependency =
			runtimeState.board.dependencies.find((candidate) => candidate.id === input.dependencyId) ?? null;
		if (!dependency) {
			throw new Error(`Dependency "${input.dependencyId}" was not found in workspace ${workspaceRepoPath}.`);
		}

		const unlinked = removeTaskDependency(runtimeState.board, input.dependencyId);
		if (!unlinked.removed) {
			throw new Error(`Dependency "${input.dependencyId}" could not be removed.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: unlinked.board,
		};
		return {
			board: unlinked.board,
			value: formatDependencyRecord(nextState, dependency),
		};
	});
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		removedDependency,
	};
}

async function enqueueTaskStart(input: { cwd: string; taskId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const runtimeState = await runtimeClient.workspace.getState.query();
	const record = findTaskRecord(runtimeState, input.taskId);
	if (!record) {
		throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
	}
	if (record.columnId !== "backlog" && record.columnId !== "in_progress") {
		throw new Error(
			`Task "${input.taskId}" is in "${record.columnId}" and can only be started from backlog or in_progress.`,
		);
	}
	if (record.task.removedAgentId === "cline") {
		throw new Error(
			`Task "${record.task.id}" still references the removed Cline worker. Assign a supported worker before starting it.`,
		);
	}

	const enqueued = await runtimeClient.runtime.enqueueTaskExecution.mutate({
		taskId: record.task.id,
	});
	if (!enqueued.ok || !enqueued.task || !enqueued.attempt) {
		throw new Error(enqueued.error ?? `Task "${record.task.id}" could not be queued.`);
	}
	return {
		ok: true,
		state: enqueued.state,
		task: {
			id: record.task.id,
			column: record.columnId,
			agentId: record.task.agentId,
			generation: enqueued.task.generation,
			workspacePath: workspaceRepoPath,
		},
		attempt: enqueued.attempt,
		orchestration: {
			attemptId: enqueued.attempt.attemptId,
		},
	};
}

function canStartTaskExecutionFromColumn(columnId: RuntimeBoardColumnId, resumeFromTrash: boolean): boolean {
	return (
		columnId === "backlog" ||
		columnId === "in_progress" ||
		(resumeFromTrash && (columnId === "trash" || columnId === "review"))
	);
}

async function startTaskDirect(input: {
	cwd: string;
	taskId: string;
	attemptId: string;
	projectPath?: string;
	grokHome?: string;
}): Promise<JsonRecord> {
	const executionReference = parseTaskExecutionReference(input.taskId);
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const loadStartCandidate = async () => {
		const runtimeState = await runtimeClient.workspace.getState.query();
		const currentRecord = findTaskRecord(runtimeState, executionReference.taskId);
		if (!currentRecord) {
			throw new Error(`Task "${executionReference.taskId}" was not found in workspace ${workspaceRepoPath}.`);
		}
		if (!canStartTaskExecutionFromColumn(currentRecord.columnId, executionReference.resumeFromTrash)) {
			throw new Error(
				`Task "${executionReference.taskId}" is in "${currentRecord.columnId}" and cannot be ${
					executionReference.resumeFromTrash ? "resumed" : "started"
				}.`,
			);
		}
		if (runtimeState.board.dependencies.some((dependency) => dependency.fromTaskId === currentRecord.task.id)) {
			throw new Error(
				`Task "${currentRecord.task.id}" cannot be started until all of its prerequisites are accepted.`,
			);
		}
		if (currentRecord.task.removedAgentId === "cline") {
			throw new Error(
				`Task "${currentRecord.task.id}" still references the removed Cline worker. Assign a supported worker before starting it.`,
			);
		}
		assertCurrentTaskExecutionReference(executionReference, currentRecord.task.id, currentRecord.task.generation);
		return currentRecord;
	};
	await waitForCurrentTaskExecutionAttempt(
		executionReference,
		input.attemptId,
		async () => (await loadStartCandidate()).task.execution,
	);
	const currentRecord = await loadStartCandidate();
	const task = currentRecord.task;
	assertCurrentTaskExecutionAttempt(executionReference, task.execution, input.attemptId);

	// startTaskSession is idempotent for a live manager and reattaches a durable
	// zmx-backed session after a runtime restart. Do not trust a persisted
	// "running" summary as proof that this process is still attached.
	{
		const ensured = await runtimeClient.workspace.ensureWorktree.mutate({
			taskId: task.id,
			baseRef: task.baseRef,
		});
		if (!ensured.ok) {
			throw new Error(ensured.error ?? "Could not ensure task workspace.");
		}

		const started = await runtimeClient.runtime.startTaskSession.mutate({
			taskId: task.id,
			prompt: executionReference.resumeFromTrash ? "" : task.prompt,
			taskTitle: task.title,
			images: executionReference.resumeFromTrash ? undefined : task.images,
			startInPlanMode: executionReference.resumeFromTrash ? undefined : task.startInPlanMode,
			resumeFromTrash: executionReference.resumeFromTrash || undefined,
			baseRef: task.baseRef,
			agentId: task.agentId,
			deliverableKind: task.deliverableKind,
			executionAttempt: task.execution,
			grokHome: input.grokHome,
		});
		if (!started.ok || !started.summary) {
			throw new Error(started.error ?? "Could not start task session.");
		}
	}

	let moved: ReturnType<typeof moveTaskToColumn>;
	try {
		moved = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (latestState) => {
			const latestRecord = findTaskRecord(latestState, executionReference.taskId);
			if (!latestRecord) {
				throw new Error(`Task "${executionReference.taskId}" could not be resolved.`);
			}
			assertCurrentTaskExecutionReference(executionReference, latestRecord.task.id, latestRecord.task.generation);
			assertCurrentTaskExecutionAttempt(executionReference, latestRecord.task.execution, input.attemptId);
			if (!canStartTaskExecutionFromColumn(latestRecord.columnId, executionReference.resumeFromTrash)) {
				throw new Error(`Task "${executionReference.taskId}" changed while its worker session was starting.`);
			}
			const targetColumnId = executionReference.resumeFromTrash ? "review" : "in_progress";
			const movement = moveTaskToColumn(latestState.board, executionReference.taskId, targetColumnId);
			if (!movement.task) {
				throw new Error(`Task "${executionReference.taskId}" could not be resolved.`);
			}
			if (!movement.moved) {
				return {
					board: latestState.board,
					value: movement,
				};
			}
			return {
				board: movement.board,
				value: movement,
			};
		});
	} catch (error) {
		await stopTaskRuntimeSession(runtimeClient, task.id, input.attemptId).catch(() => undefined);
		throw error;
	}

	if (!moved.moved) {
		return {
			ok: true,
			message: executionReference.resumeFromTrash
				? `Task "${executionReference.taskId}" is already in review.`
				: `Task "${executionReference.taskId}" is already in progress.`,
			task: {
				id: task.id,
				prompt: task.prompt,
				column: executionReference.resumeFromTrash ? "review" : "in_progress",
				workspacePath: workspaceRepoPath,
			},
		};
	}

	return {
		ok: true,
		task: {
			id: task.id,
			prompt: task.prompt,
			column: executionReference.resumeFromTrash ? "review" : "in_progress",
			workspacePath: workspaceRepoPath,
		},
	};
}

async function prepareExternalTask(input: { cwd: string; taskId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const runtimeState = await runtimeClient.workspace.getState.query();
	const record = findTaskRecord(runtimeState, input.taskId);
	if (!record) {
		throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
	}
	if (record.columnId !== "backlog" && record.columnId !== "in_progress" && record.columnId !== "review") {
		throw new Error(
			`Task "${input.taskId}" is in "${record.columnId}" and cannot be prepared for an external executor.`,
		);
	}

	const ensured = await runtimeClient.workspace.ensureWorktree.mutate({
		taskId: record.task.id,
		baseRef: record.task.baseRef,
	});
	if (!ensured.ok) {
		throw new Error(ensured.error ?? "Could not ensure task workspace.");
	}
	const claimed = await transitionExternalTask({
		cwd: input.cwd,
		taskId: input.taskId,
		projectPath: workspaceRepoPath,
		action: "claim",
	});

	return {
		ok: true,
		task: {
			...formatTaskRecord(runtimeState, record.task, "in_progress"),
			column: "in_progress",
			projectPath: workspaceRepoPath,
			taskWorkspacePath: ensured.path,
		},
		claim: claimed.task,
	};
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
	const pathFromParent = relative(parentPath, candidatePath);
	return (
		pathFromParent === "" ||
		(pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent))
	);
}

async function readBoundedExternalReport(input: {
	reportFile: string;
	cwd: string;
	workspaceRepoPath: string;
	taskWorkspacePath: string;
}): Promise<{ path: string; markdown: string }> {
	const requestedPath = resolve(input.cwd, input.reportFile);
	const reportPath = await realpath(requestedPath).catch(() => {
		throw new Error(`Review report file does not exist: ${requestedPath}`);
	});
	const reportStat = await stat(reportPath);
	if (!reportStat.isFile()) throw new Error(`Review report path is not a file: ${reportPath}`);
	if (reportStat.size > 262_144) throw new Error("Review report exceeds the 262144-byte limit.");
	const [projectRoot, taskRoot] = await Promise.all([
		realpath(input.workspaceRepoPath),
		realpath(input.taskWorkspacePath),
	]);
	if (isPathWithin(projectRoot, reportPath) || isPathWithin(taskRoot, reportPath)) {
		throw new Error("Review report must be written outside both the project and task repositories.");
	}
	const markdown = await readFile(reportPath, "utf8");
	if (!markdown.trim()) throw new Error("Review report must contain non-empty Markdown.");
	return { path: reportPath, markdown };
}

async function submitExternalTask(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	reportFile?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const initialState = await runtimeClient.workspace.getState.query();
	const record = findTaskRecord(initialState, input.taskId);
	if (!record) throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
	const deliverableKind = record.task.deliverableKind ?? "change";
	if (!input.reportFile) {
		if (deliverableKind === "read_only_report") {
			throw new Error("Read-only task submission requires --report-file with a bounded Markdown report.");
		}
		return transitionExternalTask({ ...input, action: "submit" });
	}
	if (record.columnId !== "in_progress" && record.columnId !== "review") {
		throw new Error(`Task "${input.taskId}" cannot be submitted from ${record.columnId}.`);
	}
	const taskWorkspace = await getTaskWorkspacePathInfo({
		cwd: workspaceRepoPath,
		taskId: record.task.id,
		baseRef: record.task.baseRef,
	});
	if (!taskWorkspace.exists) throw new Error(`Task workspace is missing: ${taskWorkspace.path}`);
	const report = await readBoundedExternalReport({
		reportFile: input.reportFile,
		cwd: input.cwd,
		workspaceRepoPath,
		taskWorkspacePath: taskWorkspace.path,
	});
	const inspection = await inspectReviewWorkspace({
		cwd: taskWorkspace.path,
		baseRef: record.task.baseRef,
		baseResolutionCwd: workspaceRepoPath,
	});
	const submission: RuntimeTaskReviewSubmission = {
		taskId: record.task.id,
		generation: resolveTaskGeneration(record.task.generation),
		executionAttemptId: record.task.execution?.attemptId ?? null,
		deliverableKind,
		reportMarkdown: report.markdown,
		reportDigest: createHash("sha256").update(report.markdown).digest("hex"),
		submittedAt: Date.now(),
		workspace: {
			taskId: record.task.id,
			path: taskWorkspace.path,
			vcs: inspection.vcs,
			baseRef: record.task.baseRef,
		},
		receipt: inspection.receipt,
	};
	const mutation = await mutateWorkspaceState(workspaceRepoPath, (latestState) => {
		const submitted = submitTaskReview(latestState.board, record.task.id, submission, {
			reportDigest: createHash("sha256").update(submission.reportMarkdown).digest("hex"),
		});
		if (!submitted.task) throw new Error(`Task "${record.task.id}" could not be submitted.`);
		const nextState: RuntimeWorkspaceStateResponse = { ...latestState, board: submitted.board };
		return {
			board: submitted.board,
			value: formatTaskRecord(nextState, submitted.task, "review"),
		};
	});
	if (mutation.saved) await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	return {
		ok: true,
		task: {
			...mutation.value,
			taskWorkspacePath: taskWorkspace.path,
			taskWorkspaceExists: true,
		},
		workspacePath: workspaceRepoPath,
		reportFile: report.path,
	};
}

async function acceptExternalTask(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	originAmpThreadId: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const origin = parseAmpArchitectOrigin(input.originAmpThreadId);
	if (!origin) throw new Error("Amp Architect origin thread is required.");
	const workspace = await resolveRuntimeWorkspace(workspaceRepoPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const accepted = await acceptTaskFromTrustedLocalControlPlane({
		workspaceRepoPath,
		taskId: input.taskId,
		architectThreadId: origin.threadId,
	});
	await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	const latestState = await runtimeClient.workspace.getState.query();
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		task: formatTaskRecord(latestState, accepted.task, "trash"),
		acceptanceEvidence: accepted.evidence,
	};
}

async function transitionExternalTask(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	action: "claim" | "submit";
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const targetColumnId: RuntimeBoardColumnId = input.action === "claim" ? "in_progress" : "review";
	const allowedSourceColumns: RuntimeBoardColumnId[] =
		input.action === "claim" ? ["backlog", "in_progress", "review"] : ["in_progress", "review"];

	let taskBaseRef = "";
	const mutation = await mutateWorkspaceState(workspaceRepoPath, (latestState) => {
		const record = findTaskRecord(latestState, input.taskId);
		if (!record) {
			throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
		}
		if (!allowedSourceColumns.includes(record.columnId)) {
			throw new Error(
				`Task "${input.taskId}" is in "${record.columnId}" and cannot be ${input.action === "claim" ? "claimed" : "submitted"}.`,
			);
		}
		taskBaseRef = record.task.baseRef;
		if (record.columnId === targetColumnId) {
			return {
				board: latestState.board,
				value: formatTaskRecord(latestState, record.task, record.columnId),
				save: false,
			};
		}

		const moved = moveTaskToColumn(latestState.board, input.taskId, targetColumnId);
		if (!moved.moved || !moved.task) {
			throw new Error(`Task "${input.taskId}" could not be moved to ${targetColumnId}.`);
		}
		const nextState: RuntimeWorkspaceStateResponse = {
			...latestState,
			board: moved.board,
		};
		return {
			board: moved.board,
			value: formatTaskRecord(nextState, moved.task, targetColumnId),
		};
	});

	if (mutation.saved) {
		await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	}
	const taskWorkspace = await getTaskWorkspacePathInfo({
		cwd: workspaceRepoPath,
		taskId: input.taskId,
		baseRef: taskBaseRef,
	});

	return {
		ok: true,
		task: {
			...mutation.value,
			taskWorkspacePath: taskWorkspace.path,
			taskWorkspaceExists: taskWorkspace.exists,
		},
		workspacePath: workspaceRepoPath,
		taskWorkspacePath: taskWorkspace.path,
	};
}

interface TrashTaskExecutionResult {
	task: JsonRecord;
	taskId: string;
	previousColumnId: ListTaskColumn;
	alreadyInTrash: boolean;
}

interface TrashTaskMutationValue {
	task: JsonRecord;
	previousColumnId: ListTaskColumn;
	executionAttemptId: string | null;
	alreadyInTrash: boolean;
}

function columnCanHaveLiveTaskSession(columnId: ListTaskColumn): boolean {
	return columnId === "in_progress" || columnId === "review";
}

async function trashTaskById(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	workspaceRepoPath: string;
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>;
}): Promise<TrashTaskExecutionResult> {
	const mutation = await mutateWorkspaceState<TrashTaskMutationValue>(input.workspaceRepoPath, (latestState) => {
		const latestRecord = findTaskRecord(latestState, input.taskId);
		if (!latestRecord) {
			throw new Error(`Task "${input.taskId}" was not found in workspace ${input.workspaceRepoPath}.`);
		}
		if (latestRecord.columnId === "trash") {
			return {
				board: latestState.board,
				value: {
					task: formatTaskRecord(latestState, latestRecord.task, latestRecord.columnId),
					previousColumnId: latestRecord.columnId,
					executionAttemptId: latestRecord.task.execution?.attemptId ?? null,
					alreadyInTrash: true,
				},
				save: false,
			};
		}
		const trashed = discardTask(latestState.board, input.taskId);
		if (!trashed.moved || !trashed.task) {
			throw new Error(`Task "${input.taskId}" could not be archived.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...latestState,
			board: trashed.board,
		};
		return {
			board: trashed.board,
			value: {
				task: formatTaskRecord(nextState, trashed.task, "trash"),
				previousColumnId: latestRecord.columnId,
				executionAttemptId: latestRecord.task.execution?.attemptId ?? null,
				alreadyInTrash: false,
			},
		};
	});

	if (mutation.saved) {
		await notifyRuntimeWorkspaceStateUpdated(input.runtimeClient);
	}

	if (mutation.value.alreadyInTrash) {
		return {
			task: mutation.value.task,
			taskId: input.taskId,
			previousColumnId: mutation.value.previousColumnId,
			alreadyInTrash: true,
		};
	}

	if (columnCanHaveLiveTaskSession(mutation.value.previousColumnId)) {
		await stopTaskRuntimeSession(input.runtimeClient, input.taskId, mutation.value.executionAttemptId);
	}

	return {
		task: mutation.value.task,
		taskId: input.taskId,
		previousColumnId: mutation.value.previousColumnId,
		alreadyInTrash: false,
	};
}

async function trashTask(input: {
	cwd: string;
	taskId?: string;
	column?: ListTaskColumn;
	projectPath?: string;
}): Promise<JsonRecord> {
	const target = resolveTaskCommandTarget(input, "task trash");
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);

	if (target.kind === "task") {
		const trashed = await trashTaskById({
			cwd: input.cwd,
			taskId: target.taskId,
			projectPath: input.projectPath,
			workspaceRepoPath,
			runtimeClient,
		});
		if (trashed.alreadyInTrash) {
			return {
				ok: true,
				message: `Task "${target.taskId}" is already in trash.`,
				task: trashed.task,
				workspacePath: workspaceRepoPath,
			};
		}
		return {
			ok: true,
			task: trashed.task,
			workspacePath: workspaceRepoPath,
			workspaceRetained: true,
		};
	}

	const initialState = await runtimeClient.workspace.getState.query();
	const targetTasks = findTasksInColumn(initialState, target.column);
	if (targetTasks.length === 0) {
		return {
			ok: true,
			column: target.column,
			workspacePath: workspaceRepoPath,
			trashedTasks: [],
			alreadyTrashedTasks: [],
			count: 0,
		};
	}

	const results: TrashTaskExecutionResult[] = [];
	for (const { task } of targetTasks) {
		results.push(
			await trashTaskById({
				cwd: input.cwd,
				taskId: task.id,
				projectPath: input.projectPath,
				workspaceRepoPath,
				runtimeClient,
			}),
		);
	}

	const trashedTasks = results.filter((result) => !result.alreadyInTrash);
	const alreadyTrashedTasks = results.filter((result) => result.alreadyInTrash);

	return {
		ok: true,
		column: target.column,
		workspacePath: workspaceRepoPath,
		trashedTasks: trashedTasks.map((result) => result.task),
		alreadyTrashedTasks: alreadyTrashedTasks.map((result) => result.task),
		workspacesRetained: trashedTasks.map((result) => result.taskId),
		count: trashedTasks.length,
	};
}

async function deleteTaskCommand(input: {
	cwd: string;
	taskId?: string;
	column?: ListTaskColumn;
	projectPath?: string;
}): Promise<JsonRecord> {
	const target = resolveTaskCommandTarget(input, "task delete");
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const mutation = await mutateWorkspaceState(workspaceRepoPath, (latestState) => {
		const latestTargetRecords =
			target.kind === "task"
				? (() => {
						const record = findTaskRecord(latestState, target.taskId);
						if (!record) {
							throw new Error(`Task "${target.taskId}" was not found in workspace ${workspaceRepoPath}.`);
						}
						return [record];
					})()
				: findTasksInColumn(latestState, target.column);

		if (latestTargetRecords.length === 0) {
			return {
				board: latestState.board,
				value: {
					deletedTaskIds: [] as string[],
					taskIdsRequiringStop: [] as string[],
					deletedTasks: [] as JsonRecord[],
				},
				save: false,
			};
		}

		const deleted = deleteTasksFromBoard(
			latestState.board,
			latestTargetRecords.map(({ task }) => task.id),
		);
		if (deleted.blockedTaskIds.length > 0) {
			throw new Error(
				`Cannot permanently delete linked task${deleted.blockedTaskIds.length === 1 ? "" : "s"} ${deleted.blockedTaskIds
					.map((taskId) => `"${taskId}"`)
					.join(", ")}. Remove the dependency explicitly or delete the complete linked task set.`,
			);
		}
		if (!deleted.deleted) {
			return {
				board: latestState.board,
				value: {
					deletedTaskIds: [] as string[],
					taskIdsRequiringStop: [] as string[],
					deletedTasks: [] as JsonRecord[],
				},
				save: false,
			};
		}

		const deletedTasks = latestTargetRecords.map(({ task, columnId }) =>
			formatTaskRecord(latestState, task, columnId),
		);
		const taskIdsRequiringStop = latestTargetRecords
			.filter(({ columnId }) => columnCanHaveLiveTaskSession(columnId))
			.map(({ task }) => task.id);
		return {
			board: deleted.board,
			value: {
				deletedTaskIds: deleted.deletedTaskIds,
				taskIdsRequiringStop,
				deletedTasks,
			},
		};
	});

	if (mutation.saved) {
		await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	}

	if (mutation.value.deletedTaskIds.length === 0) {
		return {
			ok: true,
			workspacePath: workspaceRepoPath,
			column: target.kind === "column" ? target.column : null,
			deletedTasks: [],
			count: 0,
		};
	}

	await Promise.all(
		mutation.value.taskIdsRequiringStop.map(async (taskId) => await stopTaskRuntimeSession(runtimeClient, taskId)),
	);

	const workspaceCleanupResults = await Promise.all(
		mutation.value.deletedTaskIds.map(async (taskId) => ({
			taskId,
			...(await deleteTaskWorkspace(runtimeClient, taskId)),
		})),
	);

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		column: target.kind === "column" ? target.column : null,
		deletedTasks: mutation.value.deletedTasks,
		count: mutation.value.deletedTaskIds.length,
		worktreeCleanup: workspaceCleanupResults,
	};
}

function parseOptionalBooleanOption(value: unknown, flagName: string): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === true || value === false) {
		return value;
	}
	if (typeof value !== "string") {
		throw new Error(`Invalid boolean value for ${flagName}. Use true or false.`);
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return true;
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return false;
	}
	throw new Error(`Invalid boolean value for ${flagName}: "${value}". Use true or false.`);
}

async function runTaskCommand(handler: () => Promise<JsonRecord>): Promise<void> {
	try {
		printJson(await handler());
	} catch (error) {
		printJson({
			ok: false,
			error: `Task command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}

export function registerTaskCommand(program: Command): void {
	const task = program.command("task").alias("tasks").description("Manage Kanban board tasks from the CLI.");

	task
		.command("list")
		.description("List Kanban tasks for a workspace.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--column <column>", "Filter column: backlog | in_progress | review | trash.", parseListColumn)
		.action(async (options: { projectPath?: string; column?: ListTaskColumn }) => {
			await runTaskCommand(
				async () =>
					await listTasks({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						column: options.column,
					}),
			);
		});

	task
		.command("create")
		.description("Create a task in backlog.")
		.option("--title <text>", "Task title.")
		.requiredOption("--prompt <text>", "Task prompt text.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--base-ref <branch>", "Task base branch/ref.")
		.option("--start-in-plan-mode [value]", "Set plan mode (true|false). Flag-only implies true.")
		.option("--agent-id <id>", `Agent override: ${VALID_AGENT_IDS.join(" | ")} | default.`)
		.option("--deliverable-kind <kind>", `Deliverable contract: ${VALID_DELIVERABLE_KINDS.join(" | ")}.`)
		.option("--origin-amp-thread-id <thread-id>", "Amp Architect provenance supplied by the Amp plugin.")
		.action(
			async (options: {
				title?: string;
				prompt: string;
				projectPath?: string;
				baseRef?: string;
				startInPlanMode?: unknown;
				agentId?: string;
				deliverableKind?: string;
				originAmpThreadId?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await createTask({
							cwd: process.cwd(),
							title: options.title,
							prompt: options.prompt,
							projectPath: options.projectPath,
							baseRef: options.baseRef,
							startInPlanMode: parseOptionalBooleanOption(options.startInPlanMode, "--start-in-plan-mode"),
							agentId: parseAgentId(options.agentId) ?? undefined,
							deliverableKind: parseDeliverableKind(options.deliverableKind),
							origin: parseAmpArchitectOrigin(options.originAmpThreadId),
						}),
				);
			},
		);

	task
		.command("update")
		.description("Update an existing task.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--title <text>", "Replacement task title.")
		.option("--prompt <text>", "Replacement task prompt.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--base-ref <branch>", "Replacement base branch/ref.")
		.option("--start-in-plan-mode [value]", "Set plan mode (true|false). Flag-only implies true.")
		.option("--agent-id <id>", `Agent override: ${VALID_AGENT_IDS.join(" | ")}. Use "default" to clear.`)
		.option("--deliverable-kind <kind>", `Replacement deliverable contract: ${VALID_DELIVERABLE_KINDS.join(" | ")}.`)
		.action(
			async (options: {
				taskId: string;
				title?: string;
				prompt?: string;
				projectPath?: string;
				baseRef?: string;
				startInPlanMode?: unknown;
				agentId?: string;
				deliverableKind?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await updateTaskCommand({
							cwd: process.cwd(),
							taskId: options.taskId,
							title: options.title,
							projectPath: options.projectPath,
							prompt: options.prompt,
							baseRef: options.baseRef,
							startInPlanMode: parseOptionalBooleanOption(options.startInPlanMode, "--start-in-plan-mode"),
							agentId: parseAgentId(options.agentId),
							deliverableKind: parseDeliverableKind(options.deliverableKind),
						}),
				);
			},
		);

	task
		.command("trash")
		.description("Discard a task or an entire column without satisfying dependencies or deleting workspaces.")
		.option("--task-id <id>", "Task ID.")
		.option("--column <column>", "Column to discard: backlog | in_progress | review | trash.", parseListColumn)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId?: string; column?: ListTaskColumn; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await trashTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						column: options.column,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("delete")
		.description("Permanently delete a task or every task in a column.")
		.option("--task-id <id>", "Task ID to permanently delete.")
		.option("--column <column>", "Column to bulk-delete: backlog | in_progress | review | trash.", parseListColumn)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId?: string; column?: ListTaskColumn; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await deleteTaskCommand({
						cwd: process.cwd(),
						taskId: options.taskId,
						column: options.column,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("link")
		.description("Link two tasks so one task waits on another.")
		.requiredOption("--task-id <id>", "One of the two task IDs to link.")
		.requiredOption("--linked-task-id <id>", "The other task ID to link.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.addHelpText(
			"after",
			[
				"",
				"Dependency direction:",
				"  If both linked tasks are in backlog, Kanban preserves the order you pass:",
				"  --task-id waits on --linked-task-id, and on the board the arrow points into",
				"  --linked-task-id.",
				"  Once only one linked task remains in backlog, Kanban reorients the saved link",
				"  so the backlog task is the waiting dependent task and the other task is the",
				"  prerequisite.",
				"  When the prerequisite is explicitly accepted, the waiting backlog",
				"  task becomes ready to start.",
				"",
			].join("\n"),
		)
		.action(async (options: { taskId: string; linkedTaskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await linkTasks({
						cwd: process.cwd(),
						taskId: options.taskId,
						linkedTaskId: options.linkedTaskId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("unlink")
		.description("Remove an existing dependency link.")
		.requiredOption("--dependency-id <id>", "Dependency ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { dependencyId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await unlinkTasks({
						cwd: process.cwd(),
						dependencyId: options.dependencyId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("claim")
		.description("Move a task to in_progress without starting a local agent session.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await transitionExternalTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
						action: "claim",
					}),
			);
		});

	task
		.command("submit")
		.description("Submit an in-progress task for review without accepting or cleaning it up.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--report-file <path>", "Bounded Markdown report file outside the project and task repositories.")
		.action(async (options: { taskId: string; projectPath?: string; reportFile?: string }) => {
			await runTaskCommand(
				async () =>
					await submitExternalTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
						reportFile: options.reportFile,
					}),
			);
		});

	const registerAcceptCommand = (name: "accept" | "accept-read-only", compatibilityAlias = false) => {
		task
			.command(name, compatibilityAlias ? { hidden: true } : undefined)
			.description(
				compatibilityAlias
					? "Compatibility alias for task accept."
					: "Accept a Review task through the trusted local single-user control plane.",
			)
			.requiredOption("--task-id <id>", "Task ID.")
			.requiredOption("--origin-amp-thread-id <thread-id>", "Amp Architect thread to match to immutable task origin.")
			.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
			.action(async (options: { taskId: string; originAmpThreadId: string; projectPath?: string }) => {
				await runTaskCommand(
					async () =>
						await acceptExternalTask({
							cwd: process.cwd(),
							taskId: options.taskId,
							projectPath: options.projectPath,
							originAmpThreadId: options.originAmpThreadId,
						}),
				);
			});
	};
	registerAcceptCommand("accept");
	registerAcceptCommand("accept-read-only", true);

	task
		.command("prepare")
		.description("Ensure a task workspace and claim it for an external interactive executor.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await prepareExternalTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("start")
		.description("Queue a task session through durable orchestration.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await enqueueTaskStart({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("start-direct", { hidden: true })
		.description("Internal Absurd worker entrypoint for starting a task session.")
		.requiredOption("--task-id <reference>", "Generation-fenced task execution reference.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; projectPath?: string }) => {
			await runTaskCommand(async () => {
				const attemptId = process.env.KANBAN_ABSURD_TASK_ID?.trim();
				if (!attemptId) {
					throw new Error("start-direct requires KANBAN_ABSURD_TASK_ID.");
				}
				const grokHome = process.env.KANBAN_GROK_HOME?.trim();
				return await startTaskDirect({
					cwd: process.cwd(),
					taskId: options.taskId,
					attemptId,
					projectPath: options.projectPath,
					grokHome: grokHome || undefined,
				});
			});
		});
}
