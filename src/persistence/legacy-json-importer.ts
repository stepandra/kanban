import { createHash } from "node:crypto";

import { runtimeBoardDataSchema } from "../core/api-contract";
import { loadIndexedJsonWorkspaceSnapshot, type RuntimeIndexedJsonWorkspaceSnapshot } from "../state/workspace-state";
import type {
	KanbanBoardRepository,
	KanbanLegacyWorkspaceImport,
	KanbanLegacyWorkspaceImportResult,
} from "./board-repository";

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalize(entry));
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonicalize(entry)]),
		);
	}
	return value;
}

function requireSafeNonNegativeInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative safe integer.`);
	}
	return value;
}

function requireNonEmpty(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new Error(`${field} cannot be empty.`);
	}
	return normalized;
}

export function createIndexedJsonImport(snapshot: RuntimeIndexedJsonWorkspaceSnapshot): KanbanLegacyWorkspaceImport {
	const workspaceId = requireNonEmpty(snapshot.workspaceId, "workspaceId");
	const repoPath = requireNonEmpty(snapshot.repoPath, "repoPath");
	const revision = requireSafeNonNegativeInteger(snapshot.revision, "revision");
	const updatedAt = requireSafeNonNegativeInteger(snapshot.updatedAt, "updatedAt");
	const board = runtimeBoardDataSchema.parse(snapshot.board);
	const canonicalSource = JSON.stringify(
		canonicalize({
			version: 1,
			workspaceId,
			repoPath,
			revision,
			updatedAt,
			board,
		}),
	);
	const checksum = createHash("sha256").update(canonicalSource).digest("hex");

	return {
		workspace: {
			workspaceId,
			repoPath,
			revision,
			updatedAt,
			board,
		},
		source: {
			kind: "indexed-json-v1",
			checksum,
			revision,
		},
	};
}

export async function importIndexedJsonWorkspace(
	cwd: string,
	repository: KanbanBoardRepository,
): Promise<KanbanLegacyWorkspaceImportResult> {
	const snapshot = await loadIndexedJsonWorkspaceSnapshot(cwd);
	return await repository.importLegacyWorkspace(createIndexedJsonImport(snapshot));
}
