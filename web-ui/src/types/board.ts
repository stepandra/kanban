import type {
	RuntimeAgentId,
	RuntimeBoardColumnId,
	RuntimeMilestone,
	RuntimeTaskAcceptanceEvidence,
	RuntimeTaskExecutionAttemptReference,
	RuntimeTaskImage,
	RuntimeTaskOrigin,
	RuntimeTaskPlanningContext,
	RuntimeTrack,
} from "@/runtime/types";

export type BoardColumnId = RuntimeBoardColumnId;

export type TaskImage = RuntimeTaskImage;

export interface BoardCard {
	id: string;
	title: string;
	prompt: string;
	startInPlanMode: boolean;
	images?: TaskImage[];
	agentId?: RuntimeAgentId;
	removedAgentId?: "cline";
	generation?: number;
	origin?: RuntimeTaskOrigin;
	execution?: RuntimeTaskExecutionAttemptReference;
	planning?: RuntimeTaskPlanningContext;
	acceptanceEvidence?: RuntimeTaskAcceptanceEvidence;
	baseRef: string;
	createdAt: number;
	updatedAt: number;
}

export interface BoardColumn {
	id: BoardColumnId;
	title: string;
	cards: BoardCard[];
}

export interface BoardDependency {
	id: string;
	fromTaskId: string;
	toTaskId: string;
	createdAt: number;
}

export interface BoardData {
	columns: BoardColumn[];
	dependencies: BoardDependency[];
	tracks?: RuntimeTrack[];
	milestones?: RuntimeMilestone[];
}

export interface ReviewTaskWorkspaceSnapshot {
	taskId: string;
	path: string;
	exists: boolean;
	branch: string | null;
	isDetached: boolean;
	headCommit: string | null;
	changeId: string | null;
	changedFiles: number | null;
	additions: number | null;
	deletions: number | null;
}

export interface CardSelection {
	card: BoardCard;
	column: BoardColumn;
	allColumns: BoardColumn[];
}
