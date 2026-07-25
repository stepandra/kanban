import { useCallback, useEffect, useRef } from "react";

import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { findCardSelection } from "@/state/board-state";
import { getTaskWorkspaceSnapshot, subscribeToAnyTaskMetadata } from "@/stores/workspace-metadata-store";
import type { BoardCard, BoardColumnId, BoardData, TaskAutoReviewMode } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";

const AUTO_REVIEW_ACTION_DELAY_MS = 500;

type ScheduledAutoReviewAction = TaskAutoReviewMode | "move_to_done_after_git_action";

/**
 * Explicit auto-review state machine (one instance per task in the review column).
 *
 * Happy path:
 *   idle -> scheduled-git-action -> awaiting-clean -> scheduled-move-to-done -> moving-to-done -> idle
 * Failure path:
 *   awaiting-clean -> failed (git action did not trigger; the recorded attempt key guards
 *   against the silent-retry-loop bug class by refusing to re-arm until the workspace
 *   snapshot changes) -> scheduled-git-action -> ...
 */
export type AutoReviewTaskState =
	| { kind: "idle" }
	| { kind: "scheduled-git-action"; action: TaskGitAction; timerId: number }
	| { kind: "awaiting-clean"; action: TaskGitAction }
	| { kind: "scheduled-move-to-done"; action: TaskGitAction; timerId: number }
	| { kind: "moving-to-done"; action: TaskGitAction }
	| { kind: "failed"; attemptKey: string };

export type AutoReviewTaskEvent =
	| { type: "schedule"; action: ScheduledAutoReviewAction; timerId: number }
	| { type: "cancel-schedule" }
	| { type: "git-action-fired" }
	| { type: "git-action-triggered" }
	| { type: "git-action-failed"; action: TaskGitAction; attemptKey: string | null }
	| { type: "move-to-done-fired" }
	| { type: "move-to-done-settled" }
	| { type: "reset" };

export const IDLE_AUTO_REVIEW_TASK_STATE: AutoReviewTaskState = { kind: "idle" };

function isScheduledState(
	state: AutoReviewTaskState,
): state is Extract<AutoReviewTaskState, { kind: "scheduled-git-action" | "scheduled-move-to-done" }> {
	return state.kind === "scheduled-git-action" || state.kind === "scheduled-move-to-done";
}

function getScheduledAction(state: AutoReviewTaskState): ScheduledAutoReviewAction | null {
	if (state.kind === "scheduled-git-action") {
		return state.action;
	}
	if (state.kind === "scheduled-move-to-done") {
		return "move_to_done_after_git_action";
	}
	return null;
}

export function autoReviewTaskReducer(state: AutoReviewTaskState, event: AutoReviewTaskEvent): AutoReviewTaskState {
	switch (event.type) {
		case "reset":
			return IDLE_AUTO_REVIEW_TASK_STATE;
		case "schedule":
			if (event.action === "move_to_done_after_git_action") {
				return state.kind === "awaiting-clean"
					? { kind: "scheduled-move-to-done", action: state.action, timerId: event.timerId }
					: state;
			}
			return { kind: "scheduled-git-action", action: event.action, timerId: event.timerId };
		case "cancel-schedule":
			if (state.kind === "scheduled-git-action") {
				return IDLE_AUTO_REVIEW_TASK_STATE;
			}
			if (state.kind === "scheduled-move-to-done") {
				return { kind: "awaiting-clean", action: state.action };
			}
			return state;
		case "git-action-fired":
			return state.kind === "scheduled-git-action" ? { kind: "awaiting-clean", action: state.action } : state;
		case "git-action-triggered":
			// The task stays armed (awaiting-clean); any stale failure for the same attempt is superseded.
			return state;
		case "git-action-failed":
			if (state.kind === "awaiting-clean" && state.action === event.action) {
				return event.attemptKey ? { kind: "failed", attemptKey: event.attemptKey } : IDLE_AUTO_REVIEW_TASK_STATE;
			}
			return state;
		case "move-to-done-fired":
			return state.kind === "scheduled-move-to-done" ? { kind: "moving-to-done", action: state.action } : state;
		case "move-to-done-settled":
			return state.kind === "awaiting-clean" || isScheduledMoveOrMoving(state) ? IDLE_AUTO_REVIEW_TASK_STATE : state;
	}
}

function isScheduledMoveOrMoving(
	state: AutoReviewTaskState,
): state is Extract<AutoReviewTaskState, { kind: "scheduled-move-to-done" | "moving-to-done" }> {
	return state.kind === "scheduled-move-to-done" || state.kind === "moving-to-done";
}

function getAutoReviewAttemptKey(task: BoardCard, action: TaskGitAction): string | null {
	const snapshot = getTaskWorkspaceSnapshot(task.id);
	if (!snapshot) {
		return null;
	}
	return [
		action,
		snapshot.path,
		snapshot.branch ?? "",
		snapshot.headCommit ?? "",
		snapshot.changedFiles ?? "",
		snapshot.additions ?? "",
		snapshot.deletions ?? "",
	].join("\u0000");
}

function isTaskAutoReviewEnabled(task: BoardCard): boolean {
	return task.autoReviewEnabled === true;
}

interface TaskGitActionLoadingStateLike {
	commitSource: string | null;
	prSource: string | null;
}

interface RequestMoveTaskToTrashOptions {
	skipWorkingChangeWarning?: boolean;
}

interface UseReviewAutoActionsOptions {
	board: BoardData;
	taskGitActionLoadingByTaskId: Record<string, TaskGitActionLoadingStateLike>;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
	requestMoveTaskToTrash: (
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: RequestMoveTaskToTrashOptions,
	) => Promise<void>;
	resetKey?: string | null;
}

export function useReviewAutoActions({
	board,
	taskGitActionLoadingByTaskId,
	runAutoReviewGitAction,
	requestMoveTaskToTrash,
	resetKey,
}: UseReviewAutoActionsOptions): void {
	const boardRef = useRef<BoardData>(board);
	const runAutoReviewGitActionRef = useRef(runAutoReviewGitAction);
	const requestMoveTaskToTrashRef = useRef(requestMoveTaskToTrash);
	const taskStateByIdRef = useRef<Record<string, AutoReviewTaskState>>({});

	useEffect(() => {
		boardRef.current = board;
	}, [board]);

	useEffect(() => {
		runAutoReviewGitActionRef.current = runAutoReviewGitAction;
	}, [runAutoReviewGitAction]);

	useEffect(() => {
		requestMoveTaskToTrashRef.current = requestMoveTaskToTrash;
	}, [requestMoveTaskToTrash]);

	const getTaskState = useCallback((taskId: string): AutoReviewTaskState => {
		return taskStateByIdRef.current[taskId] ?? IDLE_AUTO_REVIEW_TASK_STATE;
	}, []);

	const dispatchTaskEvent = useCallback((taskId: string, event: AutoReviewTaskEvent) => {
		const nextState = autoReviewTaskReducer(taskStateByIdRef.current[taskId] ?? IDLE_AUTO_REVIEW_TASK_STATE, event);
		if (nextState.kind === "idle") {
			delete taskStateByIdRef.current[taskId];
		} else {
			taskStateByIdRef.current[taskId] = nextState;
		}
	}, []);

	const clearAutoReviewTimer = useCallback(
		(taskId: string) => {
			const state = getTaskState(taskId);
			if (isScheduledState(state)) {
				window.clearTimeout(state.timerId);
			}
			dispatchTaskEvent(taskId, { type: "cancel-schedule" });
		},
		[dispatchTaskEvent, getTaskState],
	);

	const clearAllAutoReviewState = useCallback(() => {
		for (const state of Object.values(taskStateByIdRef.current)) {
			if (isScheduledState(state)) {
				window.clearTimeout(state.timerId);
			}
		}
		taskStateByIdRef.current = {};
	}, []);

	const scheduleAutoReviewAction = useCallback(
		(taskId: string, action: ScheduledAutoReviewAction, execute: () => void) => {
			const state = getTaskState(taskId);
			if (isScheduledState(state)) {
				if (getScheduledAction(state) === action) {
					return;
				}
				window.clearTimeout(state.timerId);
			}
			const timerId = window.setTimeout(() => {
				execute();
			}, AUTO_REVIEW_ACTION_DELAY_MS);
			dispatchTaskEvent(taskId, { type: "schedule", action, timerId });
		},
		[dispatchTaskEvent, getTaskState],
	);

	useEffect(() => {
		return () => {
			clearAllAutoReviewState();
		};
	}, [clearAllAutoReviewState]);

	useEffect(() => {
		clearAllAutoReviewState();
	}, [clearAllAutoReviewState, resetKey]);

	const evaluateAutoReview = useCallback(
		(_trigger: { source: string; taskId?: string }) => {
			const columnByTaskId = new Map<string, BoardColumnId>();
			const reviewCardsForAutomation: BoardCard[] = [];
			for (const column of boardRef.current.columns) {
				for (const card of column.cards) {
					columnByTaskId.set(card.id, column.id);
					if (column.id === "review") {
						reviewCardsForAutomation.push(card);
					}
				}
			}

			// Reconcile: any tracked task that left the review column returns to idle.
			for (const taskId of Object.keys(taskStateByIdRef.current)) {
				if (columnByTaskId.get(taskId) !== "review") {
					clearAutoReviewTimer(taskId);
					dispatchTaskEvent(taskId, { type: "reset" });
				}
			}

			for (const reviewTask of reviewCardsForAutomation) {
				const autoReviewEnabled = isTaskAutoReviewEnabled(reviewTask);
				if (!autoReviewEnabled) {
					clearAutoReviewTimer(reviewTask.id);
					dispatchTaskEvent(reviewTask.id, { type: "reset" });
					continue;
				}

				const autoReviewMode = resolveTaskAutoReviewMode(reviewTask.autoReviewMode);
				const loadingState = taskGitActionLoadingByTaskId[reviewTask.id];
				const isGitActionInFlight =
					autoReviewMode === "commit"
						? loadingState?.commitSource !== null && loadingState?.commitSource !== undefined
						: autoReviewMode === "pr"
							? loadingState?.prSource !== null && loadingState?.prSource !== undefined
							: false;

				// Commit/PR automation mental model:
				// - A task is only "armed" for auto-done after we actually see working changes in review and trigger commit/pr.
				// - Review entries with zero changes (common during start-in-plan-mode planning loops) are intentionally ignored.
				// - Once armed, a later review state with zero changes is treated as commit/pr success, then we auto-move to done.
				const changedFiles = getTaskWorkspaceSnapshot(reviewTask.id)?.changedFiles;
				const taskState = getTaskState(reviewTask.id);
				const awaitingAction =
					taskState.kind === "awaiting-clean" || isScheduledMoveOrMoving(taskState) ? taskState.action : null;
				if (awaitingAction) {
					if (changedFiles === 0 && !isGitActionInFlight && taskState.kind !== "moving-to-done") {
						scheduleAutoReviewAction(reviewTask.id, "move_to_done_after_git_action", () => {
							const latestSelection = findCardSelection(boardRef.current, reviewTask.id);
							if (!latestSelection || latestSelection.column.id !== "review") {
								dispatchTaskEvent(reviewTask.id, { type: "cancel-schedule" });
								return;
							}
							if (!isTaskAutoReviewEnabled(latestSelection.card)) {
								dispatchTaskEvent(reviewTask.id, { type: "cancel-schedule" });
								return;
							}
							const latestMode = resolveTaskAutoReviewMode(latestSelection.card.autoReviewMode);
							if (latestMode !== autoReviewMode) {
								dispatchTaskEvent(reviewTask.id, { type: "cancel-schedule" });
								return;
							}
							dispatchTaskEvent(reviewTask.id, { type: "move-to-done-fired" });
							void requestMoveTaskToTrashRef
								.current(reviewTask.id, "review", {
									skipWorkingChangeWarning: true,
								})
								.finally(() => {
									dispatchTaskEvent(reviewTask.id, { type: "move-to-done-settled" });
								});
						});
					} else {
						clearAutoReviewTimer(reviewTask.id);
					}
					continue;
				}

				if ((changedFiles ?? 0) <= 0 || isGitActionInFlight) {
					clearAutoReviewTimer(reviewTask.id);
					continue;
				}

				const attemptKey = getAutoReviewAttemptKey(reviewTask, autoReviewMode);
				if (attemptKey && taskState.kind === "failed" && taskState.attemptKey === attemptKey) {
					clearAutoReviewTimer(reviewTask.id);
					continue;
				}

				scheduleAutoReviewAction(reviewTask.id, autoReviewMode, () => {
					const latestSelection = findCardSelection(boardRef.current, reviewTask.id);
					if (!latestSelection || latestSelection.column.id !== "review") {
						dispatchTaskEvent(reviewTask.id, { type: "cancel-schedule" });
						return;
					}
					if (!isTaskAutoReviewEnabled(latestSelection.card)) {
						dispatchTaskEvent(reviewTask.id, { type: "cancel-schedule" });
						return;
					}
					const latestMode = resolveTaskAutoReviewMode(latestSelection.card.autoReviewMode);
					if (latestMode !== autoReviewMode) {
						dispatchTaskEvent(reviewTask.id, { type: "cancel-schedule" });
						return;
					}
					const latestAttemptKey = getAutoReviewAttemptKey(latestSelection.card, latestMode);
					const latestTaskState = getTaskState(reviewTask.id);
					if (
						latestAttemptKey &&
						latestTaskState.kind === "failed" &&
						latestTaskState.attemptKey === latestAttemptKey
					) {
						dispatchTaskEvent(reviewTask.id, { type: "cancel-schedule" });
						return;
					}
					dispatchTaskEvent(reviewTask.id, { type: "git-action-fired" });
					void runAutoReviewGitActionRef.current(reviewTask.id, latestMode).then((triggered) => {
						if (!triggered) {
							dispatchTaskEvent(reviewTask.id, {
								type: "git-action-failed",
								action: latestMode,
								attemptKey: latestAttemptKey,
							});
						} else {
							dispatchTaskEvent(reviewTask.id, { type: "git-action-triggered" });
						}
					});
				});
			}
		},
		[clearAutoReviewTimer, dispatchTaskEvent, getTaskState, scheduleAutoReviewAction, taskGitActionLoadingByTaskId],
	);

	useEffect(() => {
		evaluateAutoReview({
			source: "board_or_loading_change",
		});
	}, [board, evaluateAutoReview, taskGitActionLoadingByTaskId]);

	useEffect(() => {
		return subscribeToAnyTaskMetadata((taskId) => {
			const selection = findCardSelection(boardRef.current, taskId);
			if (!selection || selection.column.id !== "review") {
				return;
			}
			evaluateAutoReview({
				source: "task_metadata_store",
				taskId,
			});
		});
	}, [evaluateAutoReview]);
}
