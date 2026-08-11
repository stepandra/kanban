import type { DropResult } from "@hello-pangea/dnd";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { useLinkedBacklogTaskActions } from "@/hooks/use-linked-backlog-task-actions";
import { useProgrammaticCardMoves } from "@/hooks/use-programmatic-card-moves";
import type { UseTaskSessionsResult } from "@/hooks/use-task-sessions";
import type { RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import { applyDragResult, findCardSelection, getTaskColumnId, moveTaskToColumn } from "@/state/board-state";
import { setTaskWorkspaceInfo } from "@/stores/workspace-metadata-store";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import {
	getBrowserNotificationPermission,
	hasPromptedForBrowserNotificationPermission,
	requestBrowserNotificationPermission,
} from "@/utils/notification-permission";

interface SelectedBoardCard {
	card: BoardCard;
	column: {
		id: BoardColumnId;
	};
}

interface PendingProgrammaticStartMoveCompletion {
	resolve: (started: boolean) => void;
	timeoutId: number;
}

interface UseBoardInteractionsInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	selectedCard: SelectedBoardCard | null;
	selectedTaskId: string | null;
	currentProjectId: string | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	setIsGitHistoryOpen: Dispatch<SetStateAction<boolean>>;
	stopTaskSession: UseTaskSessionsResult["stopTaskSession"];
	ensureTaskWorkspace: UseTaskSessionsResult["ensureTaskWorkspace"];
	startTaskSession: UseTaskSessionsResult["startTaskSession"];
	fetchTaskWorkspaceInfo: (task: BoardCard) => Promise<RuntimeTaskWorkspaceInfoResponse | null>;
	sendTaskSessionInput: (
		taskId: string,
		input: string,
		options?: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
	readyForReviewNotificationsEnabled: boolean;
}

export interface UseBoardInteractionsResult {
	handleProgrammaticCardMoveReady: ReturnType<typeof useProgrammaticCardMoves>["handleProgrammaticCardMoveReady"];
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	handleCreateDependency: (fromTaskId: string, toTaskId: string) => void;
	handleDeleteDependency: (dependencyId: string) => void;
	handleDragEnd: (result: DropResult, options?: { selectDroppedTask?: boolean }) => void;
	handleStartTask: (taskId: string) => void;
	handleStartAllBacklogTasks: (taskIds?: string[]) => void;
	handleDetailTaskDragEnd: (result: DropResult) => void;
	handleCardSelect: (taskId: string) => void;
	handleMoveToTrash: () => void;
	handleMoveReviewCardToTrash: (taskId: string) => void;
	handleMoveTasksToColumn: (taskIds: string[], toColumnId: BoardColumnId) => void;
	handleRestoreTaskFromTrash: (taskId: string) => void;
	handleAddReviewComments: (taskId: string, text: string) => Promise<void>;
	handleSendReviewComments: (taskId: string, text: string) => Promise<void>;
	moveToTrashLoadingById: Record<string, boolean>;
}

export function useBoardInteractions({
	board,
	setBoard,
	selectedCard,
	selectedTaskId,
	currentProjectId,
	setSelectedTaskId,
	setIsGitHistoryOpen,
	stopTaskSession,
	ensureTaskWorkspace,
	startTaskSession,
	fetchTaskWorkspaceInfo,
	sendTaskSessionInput,
	readyForReviewNotificationsEnabled,
}: UseBoardInteractionsInput): UseBoardInteractionsResult {
	const notificationPermissionPromptInFlightRef = useRef(false);
	const moveToTrashLoadingByIdRef = useRef<Record<string, true>>({});
	const resumeTaskFromTrashInFlightRef = useRef(new Set<string>());
	const pendingProgrammaticStartMoveCompletionByTaskIdRef = useRef<
		Record<string, PendingProgrammaticStartMoveCompletion>
	>({});
	const [moveToTrashLoadingById, setMoveToTrashLoadingById] = useState<Record<string, boolean>>({});
	const {
		handleProgrammaticCardMoveReady,
		setRequestMoveTaskToTrashHandler,
		tryProgrammaticCardMove,
		consumeProgrammaticCardMove,
		resolvePendingProgrammaticTrashMove,
		waitForProgrammaticCardMoveAvailability,
		resetProgrammaticCardMoves,
		requestMoveTaskToTrashWithAnimation,
	} = useProgrammaticCardMoves();

	const resolvePendingProgrammaticStartMove = useCallback((taskId: string, started: boolean) => {
		const pending = pendingProgrammaticStartMoveCompletionByTaskIdRef.current[taskId];
		if (!pending) {
			return;
		}
		window.clearTimeout(pending.timeoutId);
		delete pendingProgrammaticStartMoveCompletionByTaskIdRef.current[taskId];
		pending.resolve(started);
	}, []);

	const getPrimaryBoardTaskElement = useCallback((taskId: string): HTMLElement | null => {
		const boardElement = document.querySelector<HTMLElement>(".kb-board");
		if (!boardElement) {
			return null;
		}
		for (const element of boardElement.querySelectorAll<HTMLElement>("[data-task-id]")) {
			if (element.dataset.taskId === taskId) {
				return element;
			}
		}
		return null;
	}, []);

	const waitForBacklogCardHeightToSettle = useCallback(
		async (taskId: string): Promise<void> => {
			if (!getPrimaryBoardTaskElement(taskId)) {
				return;
			}

			await new Promise<void>((resolve) => {
				let previousHeight = 0;
				let stableFrameCount = 0;
				let framesRemaining = 8;

				const measure = () => {
					const cardElement = getPrimaryBoardTaskElement(taskId);
					const nextHeight = cardElement?.getBoundingClientRect().height ?? 0;
					if (nextHeight > 0 && previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) {
						stableFrameCount += 1;
					} else {
						stableFrameCount = 0;
					}
					previousHeight = nextHeight;

					if (stableFrameCount >= 1 || framesRemaining <= 0) {
						resolve();
						return;
					}

					framesRemaining -= 1;
					window.requestAnimationFrame(measure);
				};

				window.requestAnimationFrame(measure);
			});
		},
		[getPrimaryBoardTaskElement],
	);

	const setTaskMoveToTrashLoading = useCallback((taskId: string, isLoading: boolean) => {
		if (isLoading) {
			moveToTrashLoadingByIdRef.current[taskId] = true;
			setMoveToTrashLoadingById((current) => {
				if (current[taskId]) {
					return current;
				}
				return {
					...current,
					[taskId]: true,
				};
			});
			return;
		}

		delete moveToTrashLoadingByIdRef.current[taskId];
		setMoveToTrashLoadingById((current) => {
			if (!current[taskId]) {
				return current;
			}
			const next = { ...current };
			delete next[taskId];
			return next;
		});
	}, []);

	const handleAddReviewComments = useCallback(
		async (taskId: string, text: string) => {
			const typed = await sendTaskSessionInput(taskId, text, { appendNewline: false, mode: "paste" });
			if (!typed.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: typed.message ?? "Could not add review comments to the task session.",
					timeout: 7000,
				});
			}
		},
		[sendTaskSessionInput],
	);

	const handleSendReviewComments = useCallback(
		async (taskId: string, text: string) => {
			const typed = await sendTaskSessionInput(taskId, text, { appendNewline: false, mode: "paste" });
			if (!typed.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: typed.message ?? "Could not send review comments to the task session.",
					timeout: 7000,
				});
				return;
			}
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 200);
			});
			const submitted = await sendTaskSessionInput(taskId, "\r", { appendNewline: false });
			if (!submitted.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: submitted.message ?? "Could not submit review comments to the task session.",
					timeout: 7000,
				});
			}
		},
		[sendTaskSessionInput],
	);

	const maybeRequestNotificationPermissionForTaskStart = useCallback(() => {
		const shouldPromptForNotificationPermission =
			readyForReviewNotificationsEnabled &&
			getBrowserNotificationPermission() === "default" &&
			!hasPromptedForBrowserNotificationPermission() &&
			!notificationPermissionPromptInFlightRef.current;
		if (!shouldPromptForNotificationPermission) {
			return;
		}
		notificationPermissionPromptInFlightRef.current = true;
		void requestBrowserNotificationPermission().finally(() => {
			notificationPermissionPromptInFlightRef.current = false;
		});
	}, [readyForReviewNotificationsEnabled]);

	const kickoffTaskInProgress = useCallback(
		async (
			task: BoardCard,
			taskId: string,
			fromColumnId: BoardColumnId,
			options?: { optimisticMove?: boolean },
		): Promise<boolean> => {
			const optimisticMove = options?.optimisticMove ?? true;
			const ensured = await ensureTaskWorkspace(task);
			if (!ensured.ok) {
				notifyError(ensured.message ?? "Could not set up task workspace.");
				if (optimisticMove) {
					setBoard((currentBoard) => {
						const currentColumnId = getTaskColumnId(currentBoard, taskId);
						if (currentColumnId !== "in_progress") {
							return currentBoard;
						}
						const reverted = moveTaskToColumn(currentBoard, taskId, fromColumnId);
						return reverted.moved ? reverted.board : currentBoard;
					});
				}
				return false;
			}
			if (ensured.response?.warning) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: ensured.response.warning,
					timeout: 7000,
				});
			}
			if (selectedTaskId === taskId) {
				if (ensured.response) {
					setTaskWorkspaceInfo({
						taskId,
						path: ensured.response.path,
						exists: true,
						baseRef: ensured.response.baseRef,
						branch: null,
						isDetached: true,
						headCommit: ensured.response.baseCommit,
					});
				}
				const infoAfterEnsure = await fetchTaskWorkspaceInfo(task);
				if (infoAfterEnsure) {
					setTaskWorkspaceInfo(infoAfterEnsure);
				}
			}
			const started = await startTaskSession(task);
			if (!started.ok) {
				notifyError(started.message ?? "Could not start task session.");
				if (optimisticMove) {
					setBoard((currentBoard) => {
						const currentColumnId = getTaskColumnId(currentBoard, taskId);
						if (currentColumnId !== "in_progress") {
							return currentBoard;
						}
						const reverted = moveTaskToColumn(currentBoard, taskId, fromColumnId);
						return reverted.moved ? reverted.board : currentBoard;
					});
				}
				return false;
			}
			if (!optimisticMove) {
				setBoard((currentBoard) => {
					const currentColumnId = getTaskColumnId(currentBoard, taskId);
					if (currentColumnId !== fromColumnId) {
						return currentBoard;
					}
					const moved = moveTaskToColumn(currentBoard, taskId, "in_progress", { insertAtTop: true });
					return moved.moved ? moved.board : currentBoard;
				});
			}
			return true;
		},
		[ensureTaskWorkspace, fetchTaskWorkspaceInfo, selectedTaskId, setBoard, startTaskSession],
	);

	const startBacklogTaskImmediately = useCallback(
		async (task: BoardCard): Promise<boolean> => {
			const selection = findCardSelection(board, task.id);
			if (!selection || selection.column.id !== "backlog") {
				return false;
			}

			setBoard((currentBoard) => {
				const currentSelection = findCardSelection(currentBoard, task.id);
				if (!currentSelection || currentSelection.column.id !== "backlog") {
					return currentBoard;
				}
				const moved = moveTaskToColumn(currentBoard, task.id, "in_progress", { insertAtTop: true });
				return moved.moved ? moved.board : currentBoard;
			});

			return kickoffTaskInProgress(task, task.id, "backlog", {
				optimisticMove: true,
			});
		},
		[board, kickoffTaskInProgress, setBoard],
	);

	const startBacklogTaskWithAnimation = useCallback(
		async (task: BoardCard): Promise<boolean> => {
			if (selectedCard) {
				return startBacklogTaskImmediately(task);
			}

			await waitForBacklogCardHeightToSettle(task.id);

			const programmaticMoveAttempt = tryProgrammaticCardMove(task.id, "backlog", "in_progress");
			if (programmaticMoveAttempt === "blocked") {
				await waitForProgrammaticCardMoveAvailability();
				return startBacklogTaskWithAnimation(task);
			}
			if (programmaticMoveAttempt === "unavailable") {
				return kickoffTaskInProgress(task, task.id, "backlog", {
					optimisticMove: false,
				});
			}

			let resolveCompletion: ((started: boolean) => void) | null = null;
			const completionPromise = new Promise<boolean>((resolve) => {
				resolveCompletion = resolve;
			});
			const timeoutId = window.setTimeout(() => {
				resolvePendingProgrammaticStartMove(task.id, false);
			}, 5000);
			pendingProgrammaticStartMoveCompletionByTaskIdRef.current[task.id] = {
				resolve: (started) => {
					resolveCompletion?.(started);
					resolveCompletion = null;
				},
				timeoutId,
			};
			return completionPromise;
		},
		[
			kickoffTaskInProgress,
			resolvePendingProgrammaticStartMove,
			selectedCard,
			startBacklogTaskImmediately,
			tryProgrammaticCardMove,
			waitForBacklogCardHeightToSettle,
			waitForProgrammaticCardMoveAvailability,
		],
	);

	const { confirmMoveTaskToTrash, handleCreateDependency, handleDeleteDependency, requestMoveTaskToTrash } =
		useLinkedBacklogTaskActions({
			board,
			setBoard,
			setSelectedTaskId,
			stopTaskSession,
		});

	useEffect(() => {
		setRequestMoveTaskToTrashHandler(requestMoveTaskToTrash);
	}, [requestMoveTaskToTrash, setRequestMoveTaskToTrashHandler]);

	const resumeTaskFromTrash = useCallback(
		async (task: BoardCard, taskId: string): Promise<void> => {
			if (resumeTaskFromTrashInFlightRef.current.has(taskId)) {
				return;
			}
			resumeTaskFromTrashInFlightRef.current.add(taskId);
			try {
				const ensured = await ensureTaskWorkspace(task);
				if (!ensured.ok) {
					notifyError(ensured.message ?? "Could not set up task workspace.");
					return;
				}
				if (ensured.response?.warning) {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: ensured.response.warning,
						timeout: 7000,
					});
				}
				const resumed = await startTaskSession(task, { resumeFromTrash: true });
				if (!resumed.ok) {
					notifyError(resumed.message ?? "Could not resume task session.");
					return;
				}

				setBoard((currentBoard) => {
					const currentColumnId = getTaskColumnId(currentBoard, taskId);
					let resumedBoard = currentBoard;
					if (currentColumnId === "trash") {
						const moved = moveTaskToColumn(currentBoard, taskId, "review", {
							insertAtTop: true,
						});
						if (!moved.moved) {
							return currentBoard;
						}
						resumedBoard = moved.board;
					} else if (currentColumnId !== "review") {
						return currentBoard;
					}
					return resumedBoard;
				});
			} finally {
				resumeTaskFromTrashInFlightRef.current.delete(taskId);
			}
		},
		[ensureTaskWorkspace, setBoard, startTaskSession],
	);

	const handleDragEnd = useCallback(
		(result: DropResult, options?: { selectDroppedTask?: boolean }) => {
			if (options?.selectDroppedTask && result.type.startsWith("CARD") && result.destination) {
				setSelectedTaskId(result.draggableId);
			}
			const { behavior: programmaticMoveBehavior, programmaticCardMoveInFlight } = consumeProgrammaticCardMove(
				result.draggableId,
			);

			const applied = applyDragResult(board, result, { programmaticCardMoveInFlight });

			const moveEvent = applied.moveEvent;
			if (!moveEvent) {
				resolvePendingProgrammaticStartMove(result.draggableId, false);
				setBoard(applied.board);
				return;
			}

			if (moveEvent.toColumnId === "trash") {
				setBoard(applied.board);
				if (programmaticMoveBehavior?.skipTrashWorkflow) {
					resolvePendingProgrammaticTrashMove(moveEvent.taskId);
					return;
				}
				const requestPromise = requestMoveTaskToTrash(moveEvent.taskId, moveEvent.fromColumnId, {
					optimisticMoveApplied: true,
					skipWorkingChangeWarning: programmaticMoveBehavior?.skipWorkingChangeWarning,
				});
				void requestPromise.finally(() => {
					resolvePendingProgrammaticTrashMove(moveEvent.taskId);
				});
				return;
			}

			if (moveEvent.fromColumnId === "trash" && moveEvent.toColumnId === "review") {
				const sourceSelection = findCardSelection(board, moveEvent.taskId);
				if (!sourceSelection || sourceSelection.column.id !== "trash") {
					return;
				}
				void resumeTaskFromTrash(sourceSelection.card, moveEvent.taskId);
				return;
			}

			setBoard(applied.board);

			if (
				moveEvent.toColumnId === "in_progress" &&
				moveEvent.fromColumnId === "backlog" &&
				!programmaticMoveBehavior?.skipKickoff
			) {
				maybeRequestNotificationPermissionForTaskStart();
				const movedSelection = findCardSelection(applied.board, moveEvent.taskId);
				if (movedSelection) {
					void kickoffTaskInProgress(movedSelection.card, moveEvent.taskId, moveEvent.fromColumnId)
						.then((started) => {
							resolvePendingProgrammaticStartMove(moveEvent.taskId, started);
						})
						.catch(() => {
							resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
						});
					return;
				}
				resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
				return;
			}
			resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
		},
		[
			board,
			consumeProgrammaticCardMove,
			kickoffTaskInProgress,
			maybeRequestNotificationPermissionForTaskStart,
			requestMoveTaskToTrash,
			resumeTaskFromTrash,
			resolvePendingProgrammaticStartMove,
			resolvePendingProgrammaticTrashMove,
			setBoard,
			setSelectedTaskId,
		],
	);

	const handleStartTask = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "backlog") {
				return;
			}
			maybeRequestNotificationPermissionForTaskStart();
			void startBacklogTaskWithAnimation(selection.card);
		},
		[board, maybeRequestNotificationPermissionForTaskStart, startBacklogTaskWithAnimation],
	);

	const handleStartAllBacklogTasks = useCallback(
		(taskIds?: string[]) => {
			const requestedTaskIds =
				taskIds ?? board.columns.find((column) => column.id === "backlog")?.cards.map((card) => card.id) ?? [];
			if (requestedTaskIds.length === 0) {
				return;
			}

			let nextBoard = board;
			const pendingStarts: BoardCard[] = [];
			const startedTaskIds = new Set<string>();

			for (const taskId of requestedTaskIds) {
				if (!taskId || startedTaskIds.has(taskId)) {
					continue;
				}
				const selection = findCardSelection(nextBoard, taskId);
				if (!selection || selection.column.id !== "backlog") {
					continue;
				}
				const moved = moveTaskToColumn(nextBoard, taskId, "in_progress", { insertAtTop: true });
				if (!moved.moved) {
					continue;
				}
				nextBoard = moved.board;
				const movedSelection = findCardSelection(nextBoard, taskId);
				if (!movedSelection) {
					continue;
				}
				pendingStarts.push(movedSelection.card);
				startedTaskIds.add(taskId);
			}

			if (pendingStarts.length === 0) {
				return;
			}

			setBoard(nextBoard);
			maybeRequestNotificationPermissionForTaskStart();
			for (const task of pendingStarts) {
				void kickoffTaskInProgress(task, task.id, "backlog");
			}
		},
		[board, kickoffTaskInProgress, maybeRequestNotificationPermissionForTaskStart, setBoard],
	);

	const handleDetailTaskDragEnd = useCallback(
		(result: DropResult) => {
			handleDragEnd(result);
		},
		[handleDragEnd],
	);

	const handleCardSelect = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id === "trash") {
				return;
			}
			setSelectedTaskId(taskId);
			setIsGitHistoryOpen(false);
		},
		[board, setIsGitHistoryOpen, setSelectedTaskId],
	);

	const handleMoveToTrash = useCallback(() => {
		if (!selectedCard) {
			return;
		}
		if (moveToTrashLoadingByIdRef.current[selectedCard.card.id]) {
			return;
		}
		setTaskMoveToTrashLoading(selectedCard.card.id, true);
		void requestMoveTaskToTrashWithAnimation(selectedCard.card.id, selectedCard.column.id).finally(() => {
			setTaskMoveToTrashLoading(selectedCard.card.id, false);
		});
	}, [requestMoveTaskToTrashWithAnimation, selectedCard, setTaskMoveToTrashLoading]);

	const handleMoveReviewCardToTrash = useCallback(
		(taskId: string) => {
			if (moveToTrashLoadingByIdRef.current[taskId]) {
				return;
			}
			setTaskMoveToTrashLoading(taskId, true);
			void requestMoveTaskToTrashWithAnimation(taskId, "review").finally(() => {
				setTaskMoveToTrashLoading(taskId, false);
			});
		},
		[requestMoveTaskToTrashWithAnimation, setTaskMoveToTrashLoading],
	);

	const handleRestoreTaskFromTrash = useCallback(
		(taskId: string) => {
			if (resumeTaskFromTrashInFlightRef.current.has(taskId)) {
				return;
			}
			const programmaticMoveAttempt = tryProgrammaticCardMove(taskId, "trash", "review");
			if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
				return;
			}

			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "trash") {
				return;
			}

			void resumeTaskFromTrash(selection.card, taskId);
		},
		[board, resumeTaskFromTrash, tryProgrammaticCardMove],
	);

	const handleMoveTasksToTrash = useCallback(
		(taskIds: string[]) => {
			for (const taskId of taskIds) {
				const selection = findCardSelection(board, taskId);
				if (!selection || selection.column.id === "trash") {
					continue;
				}
				void confirmMoveTaskToTrash(selection.card);
			}
		},
		[board, confirmMoveTaskToTrash],
	);

	const handleMoveTasksToColumn = useCallback(
		(taskIds: string[], toColumnId: BoardColumnId) => {
			if (toColumnId === "in_progress") {
				handleStartAllBacklogTasks(taskIds);
				return;
			}
			if (toColumnId === "review") {
				for (const taskId of taskIds) {
					handleRestoreTaskFromTrash(taskId);
				}
				return;
			}
			if (toColumnId === "trash") {
				handleMoveTasksToTrash(taskIds);
			}
		},
		[handleMoveTasksToTrash, handleRestoreTaskFromTrash, handleStartAllBacklogTasks],
	);

	const resetBoardInteractionsState = useCallback(() => {
		moveToTrashLoadingByIdRef.current = {};
		resumeTaskFromTrashInFlightRef.current.clear();
		setMoveToTrashLoadingById({});
		for (const taskId of Object.keys(pendingProgrammaticStartMoveCompletionByTaskIdRef.current)) {
			resolvePendingProgrammaticStartMove(taskId, false);
		}
		resetProgrammaticCardMoves();
	}, [resetProgrammaticCardMoves, resolvePendingProgrammaticStartMove]);

	useEffect(() => {
		resetBoardInteractionsState();
	}, [currentProjectId, resetBoardInteractionsState]);

	return {
		handleProgrammaticCardMoveReady,
		confirmMoveTaskToTrash,
		handleCreateDependency,
		handleDeleteDependency,
		handleDragEnd,
		handleStartTask,
		handleStartAllBacklogTasks,
		handleDetailTaskDragEnd,
		handleCardSelect,
		handleMoveToTrash,
		handleMoveReviewCardToTrash,
		handleMoveTasksToColumn,
		handleRestoreTaskFromTrash,
		handleAddReviewComments,
		handleSendReviewComments,
		moveToTrashLoadingById,
	};
}
