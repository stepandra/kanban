import type { RuntimeBoardData } from "../../src/core/api-contract";
import { createIndexedJsonImport } from "../../src/persistence/legacy-json-importer";
import {
	mapBoardToPostgresRecords,
	mapPostgresRecordsToBoard,
} from "../../src/persistence/postgres/postgres-board-mapping";
import { loadKanbanPostgresConfig } from "../../src/persistence/postgres/postgres-config";
import type { RuntimeIndexedJsonWorkspaceSnapshot } from "../../src/state/workspace-state";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-a",
						title: "Task A",
						prompt: "Implement A",
						startInPlanMode: true,
						autoReviewEnabled: true,
						autoReviewMode: "pr",
						agentId: "codex",
						clineSettings: {
							providerId: "openai",
							modelId: "gpt-5",
							reasoningEffort: "high",
						},
						images: [
							{
								id: "image-a",
								data: "data:image/png;base64,AA==",
								mimeType: "image/png",
								name: "reference.png",
							},
						],
						baseRef: "main",
						createdAt: 10,
						updatedAt: 20,
					},
				],
			},
			{
				id: "in_progress",
				title: "In Progress",
				cards: [
					{
						id: "task-b",
						title: "Task B",
						prompt: "Implement B",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 30,
						updatedAt: 40,
					},
				],
			},
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [
			{
				id: "dependency-a-b",
				fromTaskId: "task-a",
				toTaskId: "task-b",
				createdAt: 50,
			},
		],
	};
}

function createSnapshot(board = createBoard()): RuntimeIndexedJsonWorkspaceSnapshot {
	return {
		workspaceId: "workspace-a",
		repoPath: "/tmp/workspace-a",
		board,
		revision: 7,
		updatedAt: 60,
	};
}

describe("PostgreSQL board contract mapping", () => {
	it("round-trips ordered columns, cards, dependencies, and every existing card field", () => {
		const board = createBoard();
		const records = mapBoardToPostgresRecords("workspace-a", board);

		expect(records.columns.map((column) => [column.columnId, column.position])).toEqual([
			["backlog", 0],
			["in_progress", 1],
			["review", 2],
			["trash", 3],
		]);
		expect(records.cards.map((card) => [card.cardId, card.columnId, card.position])).toEqual([
			["task-a", "backlog", 0],
			["task-b", "in_progress", 0],
		]);
		expect(mapPostgresRecordsToBoard(records)).toEqual(board);
	});

	it("rejects duplicate IDs, missing card references, self-links, duplicate edges, and dependency cycles", () => {
		const duplicateCardBoard = createBoard();
		duplicateCardBoard.columns[1]?.cards.push({
			...duplicateCardBoard.columns[0]?.cards[0],
			id: "task-a",
			title: "Duplicate",
		});
		expect(() => mapBoardToPostgresRecords("workspace-a", duplicateCardBoard)).toThrow("Duplicate card ID");

		const missingCardBoard = createBoard();
		missingCardBoard.dependencies[0] = {
			id: "missing",
			fromTaskId: "task-a",
			toTaskId: "missing-task",
			createdAt: 50,
		};
		expect(() => mapBoardToPostgresRecords("workspace-a", missingCardBoard)).toThrow("existing Kanban cards");

		const selfLinkBoard = createBoard();
		selfLinkBoard.dependencies[0] = {
			id: "self",
			fromTaskId: "task-a",
			toTaskId: "task-a",
			createdAt: 50,
		};
		expect(() => mapBoardToPostgresRecords("workspace-a", selfLinkBoard)).toThrow("cannot link a card to itself");

		const duplicateEdgeBoard = createBoard();
		duplicateEdgeBoard.dependencies.push({
			id: "duplicate-edge",
			fromTaskId: "task-a",
			toTaskId: "task-b",
			createdAt: 51,
		});
		expect(() => mapBoardToPostgresRecords("workspace-a", duplicateEdgeBoard)).toThrow("Duplicate dependency edge");

		const cyclicBoard = createBoard();
		cyclicBoard.dependencies.push({
			id: "dependency-b-a",
			fromTaskId: "task-b",
			toTaskId: "task-a",
			createdAt: 51,
		});
		expect(() => mapBoardToPostgresRecords("workspace-a", cyclicBoard)).toThrow("acyclic graph");
	});

	it("rejects dependency timestamps that cannot round-trip through PostgreSQL", () => {
		for (const invalidTimestamp of [-1, Number.MAX_SAFE_INTEGER + 1]) {
			const board = createBoard();
			const dependency = board.dependencies[0];
			if (!dependency) {
				throw new Error("Missing fixture dependency.");
			}
			board.dependencies[0] = { ...dependency, createdAt: invalidTimestamp };
			expect(() => mapBoardToPostgresRecords("workspace-a", board)).toThrow(
				"dependency dependency-a-b createdAt must be a non-negative safe integer",
			);
		}
	});
});

describe("indexed JSON import validation", () => {
	it("creates a deterministic semantic checksum and binds it to the source revision", () => {
		const first = createIndexedJsonImport(createSnapshot());
		const reorderedSettings = createBoard();
		const firstCard = reorderedSettings.columns[0]?.cards[0];
		if (!firstCard) {
			throw new Error("Missing fixture card.");
		}
		firstCard.clineSettings = {
			reasoningEffort: "high",
			modelId: "gpt-5",
			providerId: "openai",
		};
		const second = createIndexedJsonImport(createSnapshot(reorderedSettings));

		expect(first.source).toEqual({
			kind: "indexed-json-v1",
			checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
			revision: 7,
		});
		expect(second.source.checksum).toBe(first.source.checksum);

		const advanced = createIndexedJsonImport({ ...createSnapshot(), revision: 8 });
		expect(advanced.source.checksum).not.toBe(first.source.checksum);
	});

	it("rejects invalid snapshot identity and revision before repository access", () => {
		expect(() => createIndexedJsonImport({ ...createSnapshot(), workspaceId: " " })).toThrow(
			"workspaceId cannot be empty",
		);
		expect(() => createIndexedJsonImport({ ...createSnapshot(), revision: -1 })).toThrow(
			"revision must be a non-negative safe integer",
		);
	});

	it("requires an explicit database URL and does not silently select PostgreSQL", () => {
		expect(() => loadKanbanPostgresConfig({})).toThrow("KANBAN_DATABASE_URL is required");
		expect(loadKanbanPostgresConfig({ KANBAN_DATABASE_URL: " postgres://example/kanban " })).toEqual({
			connectionString: "postgres://example/kanban",
		});
	});
});
