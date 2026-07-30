import {
	type BeforeCapture,
	DragDropContext,
	type DragStart,
	type DropResult,
	type FluidDragActions,
	type Sensor,
	type SensorAPI,
	type SnapDragActions,
} from "@hello-pangea/dnd";
import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { ListChecks, SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BoardBulkActionBar } from "@/components/board-bulk-action-bar";
import { BoardColumn } from "@/components/board-column";
import { BoardFilterControls } from "@/components/board-filter-controls";
import { BoardOperationalSummary } from "@/components/board-operational-summary";
import { DependencyOverlay } from "@/components/dependencies/dependency-overlay";
import { useDependencyLinking } from "@/components/dependencies/use-dependency-linking";
import { Button } from "@/components/ui/button";
import { useBoardFilter } from "@/hooks/use-board-filter";
import { useBoardSelection } from "@/hooks/use-board-selection";
import { useBoardSpatialNavigation } from "@/hooks/use-board-spatial-navigation";
import type { RuntimeTaskExecutionProjection, RuntimeTaskSessionSummary, RuntimeVcsMode } from "@/runtime/types";
import { canCreateTaskDependency } from "@/state/board-state";
import { findCardColumnId, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import type { BoardCard, BoardColumnId, BoardData, BoardDependency } from "@/types";

const BOARD_COLUMN_ORDER: BoardColumnId[] = ["backlog", "in_progress", "review", "trash"];

export type RequestProgrammaticCardMove = (move: ProgrammaticCardMoveInFlight) => boolean;

function isRectVerticallyVisibleWithinContainer(rect: DOMRect, containerRect: DOMRect): boolean {
	return rect.top >= containerRect.top && rect.bottom <= containerRect.bottom;
}

export function KanbanBoard({
	data,
	taskSessions,
	executionProjections = {},
	onCardSelect,
	onCreateTask,
	onStartTask,
	onStartAllTasks,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	onSaveTaskTitle,
	onCommitTask,
	onOpenPrTask,
	onCancelAutomaticTaskAction,
	onMoveToTrashTask,
	onRestoreFromTrashTask,
	commitTaskLoadingById,
	openPrTaskLoadingById,
	moveToTrashLoadingById,
	dependencies,
	onCreateDependency,
	onDeleteDependency,
	onDragEnd,
	onRequestProgrammaticCardMoveReady,
	workspacePath,
	workspaceVcs,
	onOpenTracksView,
	onOpenRepositoryView,
	onMoveTasksToColumn,
	isInteractionActive = true,
}: {
	data: BoardData;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	executionProjections?: Record<string, RuntimeTaskExecutionProjection>;
	onCardSelect: (taskId: string) => void;
	onCreateTask: () => void;
	onStartTask?: (taskId: string) => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCard) => void;
	onSaveTaskTitle?: (taskId: string, title: string) => void;
	onCommitTask?: (taskId: string) => void;
	onOpenPrTask?: (taskId: string) => void;
	onCancelAutomaticTaskAction?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	commitTaskLoadingById?: Record<string, boolean>;
	openPrTaskLoadingById?: Record<string, boolean>;
	moveToTrashLoadingById?: Record<string, boolean>;
	dependencies: BoardDependency[];
	onCreateDependency?: (fromTaskId: string, toTaskId: string) => void;
	onDeleteDependency?: (dependencyId: string) => void;
	onDragEnd: (result: DropResult) => void;
	onRequestProgrammaticCardMoveReady?: (requestMove: RequestProgrammaticCardMove | null) => void;
	workspacePath?: string | null;
	workspaceVcs?: RuntimeVcsMode | null;
	onOpenTracksView?: () => void;
	onOpenRepositoryView?: () => void;
	onMoveTasksToColumn?: (taskIds: string[], toColumnId: BoardColumnId) => void;
	isInteractionActive?: boolean;
}): React.ReactElement {
	const dragOccurredRef = useRef(false);
	const boardRef = useRef<HTMLElement>(null);
	const sensorApiRef = useRef<SensorAPI | null>(null);
	const latestDataRef = useRef<BoardData>(data);
	const programmaticCardMoveInFlightRef = useRef<ProgrammaticCardMoveInFlight | null>(null);
	const [activeDragTaskId, setActiveDragTaskId] = useState<string | null>(null);
	const [attentionOnly, setAttentionOnly] = useState(false);
	const [reviewOnly, setReviewOnly] = useState(false);

	const [activeDragSourceColumnId, setActiveDragSourceColumnId] = useState<BoardColumnId | null>(null);
	const [programmaticCardMoveInFlight, setProgrammaticCardMoveInFlight] =
		useState<ProgrammaticCardMoveInFlight | null>(null);
	// Read from latestDataRef so the callback identity stays stable across stream
	// ticks; unstable identities here would defeat the memoized BoardCards.
	const canLinkTasks = useCallback(
		(fromTaskId: string, toTaskId: string) => canCreateTaskDependency(latestDataRef.current, fromTaskId, toTaskId),
		[],
	);
	const dependencyLinking = useDependencyLinking({
		canLinkTasks,
		onCreateDependency,
	});

	useEffect(() => {
		latestDataRef.current = data;
	}, [data]);

	const programmaticSensor: Sensor = useCallback((api: SensorAPI) => {
		sensorApiRef.current = api;
	}, []);

	const getElementClientCenter = useCallback((element: HTMLElement): { x: number; y: number } => {
		const rect = element.getBoundingClientRect();
		return {
			x: rect.left + rect.width / 2,
			y: rect.top + rect.height / 2,
		};
	}, []);

	const canAnimateProgrammaticTopInsertion = useCallback((taskId: string, targetColumnId: BoardColumnId): boolean => {
		const boardElement = boardRef.current;
		if (!boardElement) {
			return false;
		}
		const sourceCardElement = boardElement.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
		const sourceColumnId = findCardColumnId(latestDataRef.current.columns, taskId);
		const sourceColumnElement = sourceColumnId
			? boardElement.querySelector<HTMLElement>(`section[data-column-id="${sourceColumnId}"]`)
			: null;
		const sourceCardsElement = sourceColumnElement?.querySelector<HTMLElement>(".kb-column-cards");
		const targetColumnElement = boardElement.querySelector<HTMLElement>(`[data-column-id="${targetColumnId}"]`);
		const targetCardsElement = targetColumnElement?.querySelector<HTMLElement>(".kb-column-cards");
		if (!sourceCardElement || !sourceCardsElement || !targetCardsElement) {
			return false;
		}

		const sourceCardRect = sourceCardElement.getBoundingClientRect();
		const sourceCardsRect = sourceCardsElement.getBoundingClientRect();
		if (!isRectVerticallyVisibleWithinContainer(sourceCardRect, sourceCardsRect)) {
			return false;
		}

		if (targetCardsElement.scrollTop > 1) {
			return false;
		}

		const firstTargetCardElement = targetCardsElement.querySelector<HTMLElement>("[data-task-id]");
		if (firstTargetCardElement) {
			const firstTargetCardRect = firstTargetCardElement.getBoundingClientRect();
			return isRectVerticallyVisibleWithinContainer(firstTargetCardRect, targetCardsElement.getBoundingClientRect());
		}

		return true;
	}, []);

	const getProgrammaticTopTargetClientSelection = useCallback(
		(taskId: string, targetColumnId: BoardColumnId): { x: number; y: number } | null => {
			const boardElement = boardRef.current;
			if (!boardElement) {
				return null;
			}
			const sourceCardElement = boardElement.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
			const targetColumnElement = boardElement.querySelector<HTMLElement>(`[data-column-id="${targetColumnId}"]`);
			const targetCardsElement = targetColumnElement?.querySelector<HTMLElement>(".kb-column-cards");
			if (!sourceCardElement || !targetCardsElement) {
				return null;
			}

			const sourceCardRect = sourceCardElement.getBoundingClientRect();
			const firstTargetCardElement = targetCardsElement.querySelector<HTMLElement>("[data-task-id]");
			if (firstTargetCardElement) {
				const targetRect = firstTargetCardElement.getBoundingClientRect();
				const desiredCenterY = targetRect.top + sourceCardRect.height / 2;
				const maxTopInsertCenterY = targetRect.top + targetRect.height / 2 - 1;
				return {
					x: targetRect.left + sourceCardRect.width / 2,
					y: Math.min(desiredCenterY, maxTopInsertCenterY),
				};
			}
			const targetRect = targetCardsElement.getBoundingClientRect();
			const targetCardsStyle = window.getComputedStyle(targetCardsElement);
			const paddingTop = Number.parseFloat(targetCardsStyle.paddingTop) || 0;
			const paddingLeft = Number.parseFloat(targetCardsStyle.paddingLeft) || 0;
			return {
				x: targetRect.left + paddingLeft + sourceCardRect.width / 2,
				y: targetRect.top + paddingTop + sourceCardRect.height / 2,
			};
		},
		[],
	);

	const clearProgrammaticCardMoveInFlight = useCallback((taskId?: string) => {
		if (taskId && programmaticCardMoveInFlightRef.current?.taskId !== taskId) {
			return;
		}
		programmaticCardMoveInFlightRef.current = null;
		setProgrammaticCardMoveInFlight(null);
	}, []);

	const requestProgrammaticCardMove = useCallback<RequestProgrammaticCardMove>(
		(move) => {
			const { taskId, toColumnId: targetColumnId } = move;
			const board = latestDataRef.current;
			const sourceColumnId = findCardColumnId(board.columns, taskId);
			if (!sourceColumnId || sourceColumnId !== move.fromColumnId || sourceColumnId === targetColumnId) {
				return false;
			}

			const sensorApi = sensorApiRef.current;
			if (!sensorApi) {
				return false;
			}

			const sourceOrderIndex = BOARD_COLUMN_ORDER.indexOf(sourceColumnId);
			const targetOrderIndex = BOARD_COLUMN_ORDER.indexOf(targetColumnId);
			if (sourceOrderIndex < 0 || targetOrderIndex < 0) {
				return false;
			}
			if (move.insertAtTop && !canAnimateProgrammaticTopInsertion(taskId, targetColumnId)) {
				return false;
			}

			const horizontalSteps = targetOrderIndex - sourceOrderIndex;
			programmaticCardMoveInFlightRef.current = move;
			setProgrammaticCardMoveInFlight(move);
			const preDrag = sensorApi.tryGetLock(taskId);
			if (!preDrag) {
				clearProgrammaticCardMoveInFlight(taskId);
				return false;
			}

			const sourceCardElement = boardRef.current?.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`) ?? null;
			const topTargetClientSelection = move.insertAtTop
				? getProgrammaticTopTargetClientSelection(taskId, targetColumnId)
				: null;
			if (sourceCardElement && topTargetClientSelection) {
				let dragActions: FluidDragActions;
				try {
					dragActions = preDrag.fluidLift(getElementClientCenter(sourceCardElement));
				} catch {
					clearProgrammaticCardMoveInFlight(taskId);
					if (preDrag.isActive()) {
						preDrag.abort();
					}
					return false;
				}

				const startClientSelection = getElementClientCenter(sourceCardElement);
				const startTime = performance.now();
				const deltaX = topTargetClientSelection.x - startClientSelection.x;
				const deltaY = topTargetClientSelection.y - startClientSelection.y;
				const travelDistance = Math.hypot(deltaX, deltaY);
				const durationMs = Math.min(224, Math.max(133, 102 + travelDistance * 0.126)) * 0.5;
				const easeInOutCubic = (value: number) => (value < 0.5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2);
				const animate = (frameTime: number) => {
					if (!dragActions.isActive()) {
						return;
					}
					try {
						const progress = Math.min((frameTime - startTime) / durationMs, 1);
						const easedProgress = easeInOutCubic(progress);
						dragActions.move({
							x: startClientSelection.x + deltaX * easedProgress,
							y: startClientSelection.y + deltaY * easedProgress,
						});
						if (progress >= 1) {
							dragActions.drop();
							return;
						}
						window.requestAnimationFrame(animate);
					} catch {
						clearProgrammaticCardMoveInFlight(taskId);
						if (dragActions.isActive()) {
							dragActions.cancel();
						}
					}
				};

				window.requestAnimationFrame(animate);
				return true;
			}

			let dragActions: SnapDragActions;
			try {
				dragActions = preDrag.snapLift();
			} catch {
				clearProgrammaticCardMoveInFlight(taskId);
				if (preDrag.isActive()) {
					preDrag.abort();
				}
				return false;
			}

			const moveOneStep = horizontalSteps > 0 ? dragActions.moveRight : dragActions.moveLeft;
			const moveSteps: Array<() => void> = [];
			for (let step = 0; step < Math.abs(horizontalSteps); step += 1) {
				moveSteps.push(moveOneStep);
			}

			const performStep = (stepIndex: number) => {
				if (!dragActions.isActive()) {
					return;
				}
				try {
					if (stepIndex >= moveSteps.length) {
						dragActions.drop();
						return;
					}
					moveSteps[stepIndex]?.();
					window.setTimeout(() => {
						performStep(stepIndex + 1);
					}, 90);
				} catch {
					clearProgrammaticCardMoveInFlight(taskId);
					if (dragActions.isActive()) {
						dragActions.cancel();
					}
				}
			};

			window.requestAnimationFrame(() => {
				window.requestAnimationFrame(() => {
					performStep(0);
				});
			});
			return true;
		},
		[
			canAnimateProgrammaticTopInsertion,
			clearProgrammaticCardMoveInFlight,
			getElementClientCenter,
			getProgrammaticTopTargetClientSelection,
		],
	);

	useEffect(() => {
		onRequestProgrammaticCardMoveReady?.(requestProgrammaticCardMove);
		return () => {
			onRequestProgrammaticCardMoveReady?.(null);
		};
	}, [onRequestProgrammaticCardMoveReady, requestProgrammaticCardMove]);

	const handleBeforeCapture = useCallback(
		(start: BeforeCapture) => {
			setActiveDragTaskId(start.draggableId);
			setActiveDragSourceColumnId(findCardColumnId(data.columns, start.draggableId));
		},
		[data],
	);

	const handleDragStart = useCallback((_start: DragStart) => {
		dragOccurredRef.current = true;
	}, []);

	const handleDragEnd = useCallback(
		(result: DropResult) => {
			setActiveDragTaskId(null);
			setActiveDragSourceColumnId(null);
			clearProgrammaticCardMoveInFlight(result.draggableId);
			requestAnimationFrame(() => {
				dragOccurredRef.current = false;
			});
			onDragEnd(result);
		},
		[clearProgrammaticCardMoveInFlight, onDragEnd],
	);

	// Dependency links should reroute as soon as motion starts, not only after drop.
	// Treat the active card as already belonging to its destination/effective column
	// so the edge transition can animate alongside the move.
	const activeTaskEffectiveColumnId =
		programmaticCardMoveInFlight?.toColumnId ??
		(activeDragTaskId !== null && activeDragSourceColumnId === "backlog" ? "in_progress" : null);

	const boardFilter = useBoardFilter();
	const selection = useBoardSelection(data);

	const visibleColumns = useMemo(() => {
		if (!boardFilter.isFilterActive && !attentionOnly && !reviewOnly) {
			return data.columns;
		}
		return data.columns.map((column) => ({
			...column,
			cards: column.cards.filter((card) => {
				if (reviewOnly && column.id !== "review") {
					return false;
				}
				if (!boardFilter.isCardVisible(card, taskSessions[card.id])) {
					return false;
				}
				if (!attentionOnly) {
					return true;
				}
				const sessionState = taskSessions[card.id]?.state;
				const execution = executionProjections[card.id];
				return Boolean(
					card.removedAgentId ||
						sessionState === "failed" ||
						sessionState === "interrupted" ||
						(execution &&
							(execution.generation !== (card.generation ?? 1) ||
								execution.status === "failed" ||
								execution.status === "cancelled" ||
								execution.status === "unknown")),
				);
			}),
		}));
	}, [attentionOnly, boardFilter, data.columns, executionProjections, reviewOnly, taskSessions]);

	const visibleCardCount = useMemo(
		() => visibleColumns.reduce((count, column) => count + column.cards.length, 0),
		[visibleColumns],
	);

	const agentFilterOptions = useMemo(() => {
		const labelByAgentId = new Map<string, string>();
		let hasDefaultAgent = false;
		for (const column of data.columns) {
			for (const card of column.cards) {
				if (!card.agentId) {
					hasDefaultAgent = true;
					continue;
				}
				if (!labelByAgentId.has(card.agentId)) {
					labelByAgentId.set(
						card.agentId,
						card.agentId === "amp"
							? "Amp Orb"
							: (getRuntimeAgentCatalogEntry(card.agentId)?.label ?? card.agentId),
					);
				}
			}
		}
		const options = [...labelByAgentId.entries()].map(([value, label]) => ({ value, label }));
		if (hasDefaultAgent) {
			options.unshift({ value: "", label: "Default agent" });
		}
		return options;
	}, [data.columns]);

	const selectedColumnCounts = useMemo(() => {
		const selectedIds = selection.selectedTaskIdSet;
		const counts = { backlog: 0, trash: 0, other: 0 };
		for (const column of data.columns) {
			for (const card of column.cards) {
				if (!selectedIds.has(card.id)) {
					continue;
				}
				if (column.id === "backlog") {
					counts.backlog += 1;
				} else if (column.id === "trash") {
					counts.trash += 1;
				} else {
					counts.other += 1;
				}
			}
		}
		return counts;
	}, [data.columns, selection.selectedTaskIdSet]);

	const handleCardSelect = useCallback(
		(card: BoardCard) => {
			if (!dragOccurredRef.current) {
				onCardSelect(card.id);
			}
		},
		[onCardSelect],
	);

	const handleActivateCard = useCallback(
		(card: BoardCard, columnId: BoardColumnId) => {
			if (columnId === "trash") {
				return;
			}
			if (columnId === "backlog") {
				onEditTask?.(card);
				return;
			}
			handleCardSelect(card);
		},
		[handleCardSelect, onEditTask],
	);

	const { focusedTaskId } = useBoardSpatialNavigation({
		columns: visibleColumns,
		enabled: isInteractionActive,
		hasSelection: selection.selectedTaskIds.length > 0,
		onClearSelection: selection.clearSelection,
		onActivateCard: handleActivateCard,
	});

	const handleBulkMoveToColumn = useCallback(
		(toColumnId: BoardColumnId) => {
			const taskIds = selection.selectedTaskIds;
			if (taskIds.length === 0) {
				return;
			}
			onMoveTasksToColumn?.(taskIds, toColumnId);
			selection.clearSelection();
		},
		[onMoveTasksToColumn, selection],
	);

	return (
		<DragDropContext
			onBeforeCapture={handleBeforeCapture}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
			sensors={[programmaticSensor]}
		>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<div className="flex items-center gap-2 px-2 pt-2">
					<BoardOperationalSummary
						data={data}
						taskSessions={taskSessions}
						executionProjections={executionProjections}
						workspaceVcs={workspaceVcs}
						onOpenTracksView={onOpenTracksView}
						onOpenRepositoryView={onOpenRepositoryView}
						onShowReview={() => {
							setReviewOnly((current) => !current);
							setAttentionOnly(false);
						}}
						onShowAttention={() => {
							setAttentionOnly((current) => !current);
							setReviewOnly(false);
						}}
						attentionActive={attentionOnly}
					/>
					<div className="ml-auto flex min-w-0 items-center gap-2">
						<BoardFilterControls
							query={boardFilter.query}
							onQueryChange={boardFilter.setQuery}
							agentId={boardFilter.agentId}
							onAgentIdChange={boardFilter.setAgentId}
							sessionState={boardFilter.sessionState}
							onSessionStateChange={boardFilter.setSessionState}
							agentOptions={agentFilterOptions}
							isBoardActive={isInteractionActive}
						/>
						{selection.selectedTaskIds.length > 0 ? (
							<BoardBulkActionBar
								selectedCount={selection.selectedTaskIds.length}
								canStart={selectedColumnCounts.backlog > 0}
								canMoveToReview={selectedColumnCounts.trash > 0}
								canMoveToTrash={selectedColumnCounts.backlog + selectedColumnCounts.other > 0}
								onMoveToColumn={handleBulkMoveToColumn}
								onClearSelection={selection.clearSelection}
							/>
						) : (
							<Button
								size="sm"
								variant={selection.isSelectionMode ? "default" : "ghost"}
								icon={<ListChecks size={14} />}
								aria-pressed={selection.isSelectionMode}
								onClick={() => selection.setIsSelectionMode(!selection.isSelectionMode)}
							>
								{selection.isSelectionMode ? "Done" : "Select"}
							</Button>
						)}
					</div>
				</div>
				<div className="relative flex min-h-0 min-w-0 flex-1">
					<section
						ref={boardRef}
						className="kb-board kb-dependency-surface"
						data-programmatic-card-move={programmaticCardMoveInFlight ? "true" : undefined}
					>
						{visibleColumns.map((column) => (
							<BoardColumn
								key={column.id}
								column={column}
								taskSessions={taskSessions}
								executionProjections={executionProjections}
								onCreateTask={column.id === "backlog" ? onCreateTask : undefined}
								onStartTask={column.id === "backlog" ? onStartTask : undefined}
								onStartAllTasks={column.id === "backlog" ? onStartAllTasks : undefined}
								onClearTrash={column.id === "trash" ? onClearTrash : undefined}
								editingTaskId={column.id === "backlog" ? editingTaskId : null}
								inlineTaskEditor={column.id === "backlog" ? inlineTaskEditor : undefined}
								onEditTask={column.id === "backlog" ? onEditTask : undefined}
								onSaveTitle={column.id !== "trash" ? onSaveTaskTitle : undefined}
								onCommitTask={column.id === "review" ? onCommitTask : undefined}
								onOpenPrTask={column.id === "review" ? onOpenPrTask : undefined}
								onCancelAutomaticTaskAction={onCancelAutomaticTaskAction}
								onMoveToTrashTask={column.id === "review" ? onMoveToTrashTask : undefined}
								onRestoreFromTrashTask={column.id === "trash" ? onRestoreFromTrashTask : undefined}
								commitTaskLoadingById={column.id === "review" ? commitTaskLoadingById : undefined}
								openPrTaskLoadingById={column.id === "review" ? openPrTaskLoadingById : undefined}
								moveToTrashLoadingById={column.id === "review" ? moveToTrashLoadingById : undefined}
								activeDragTaskId={activeDragTaskId}
								activeDragSourceColumnId={activeDragSourceColumnId}
								programmaticCardMoveInFlight={programmaticCardMoveInFlight}
								onDependencyPointerDown={dependencyLinking.onDependencyPointerDown}
								onDependencyPointerEnter={dependencyLinking.onDependencyPointerEnter}
								dependencySourceTaskId={dependencyLinking.draft?.sourceTaskId ?? null}
								dependencyTargetTaskId={dependencyLinking.draft?.targetTaskId ?? null}
								isDependencyLinking={dependencyLinking.draft !== null}
								workspacePath={workspacePath}
								selectedTaskIds={selection.selectedTaskIdSet}
								keyboardFocusedTaskId={focusedTaskId}
								isSelectionMode={selection.isSelectionMode}
								onToggleCardSelected={selection.toggleTaskSelected}
								onCardClick={handleCardSelect}
							/>
						))}
						<DependencyOverlay
							containerRef={boardRef}
							dependencies={dependencies}
							draft={dependencyLinking.draft}
							activeTaskId={activeDragTaskId ?? programmaticCardMoveInFlight?.taskId ?? null}
							activeTaskEffectiveColumnId={activeTaskEffectiveColumnId}
							isMotionActive={activeDragTaskId !== null || programmaticCardMoveInFlight !== null}
							onDeleteDependency={onDeleteDependency}
						/>
					</section>
					{boardFilter.isFilterActive && visibleCardCount === 0 ? (
						<div className="absolute inset-0 flex items-center justify-center">
							<div className="flex flex-col items-center gap-3 text-text-tertiary">
								<SearchX size={32} strokeWidth={1} />
								<p className="m-0 text-sm text-text-secondary">No tasks match the current filters.</p>
								<Button size="sm" variant="default" onClick={boardFilter.clearFilter}>
									Clear filters
								</Button>
							</div>
						</div>
					) : null}
				</div>
			</div>
		</DragDropContext>
	);
}
