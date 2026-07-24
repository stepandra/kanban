import type { RuntimeBoardData } from "../core/api-contract";

export interface KanbanBoardWorkspace {
	workspaceId: string;
	repoPath: string;
	revision: number;
	updatedAt: number;
	board: RuntimeBoardData;
}

export interface KanbanBoardWorkspaceSave {
	workspaceId: string;
	expectedRevision: number;
	board: RuntimeBoardData;
	updatedAt: number;
}

export interface KanbanLegacyImportSource {
	kind: "indexed-json-v1";
	checksum: string;
	revision: number;
}

export interface KanbanLegacyWorkspaceImport {
	workspace: KanbanBoardWorkspace;
	source: KanbanLegacyImportSource;
}

export interface KanbanImportReceipt {
	workspaceId: string;
	source: KanbanLegacyImportSource;
	importedAt: number;
	cardCount: number;
	dependencyCount: number;
}

export type KanbanLegacyWorkspaceImportResult =
	| {
			status: "imported";
			receipt: KanbanImportReceipt;
	  }
	| {
			status: "already-imported";
			receipt: KanbanImportReceipt;
	  };

export interface KanbanBoardRepository {
	loadWorkspace(workspaceId: string): Promise<KanbanBoardWorkspace | null>;
	saveWorkspace(input: KanbanBoardWorkspaceSave): Promise<KanbanBoardWorkspace>;
	importLegacyWorkspace(input: KanbanLegacyWorkspaceImport): Promise<KanbanLegacyWorkspaceImportResult>;
}
