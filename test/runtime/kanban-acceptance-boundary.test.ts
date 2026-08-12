import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
	type RuntimeBoardData,
	type RuntimeTaskAcceptanceEvidence,
	type RuntimeTaskReviewSubmission,
	runtimeBoardCardSchema,
} from "../../src/core/api-contract";
import {
	acceptReadOnlyTask,
	discardTask,
	moveTaskToColumn,
	submitTaskReview,
} from "../../src/core/task-board-mutations";

function submitReview(board: RuntimeBoardData, taskId: string, submission: RuntimeTaskReviewSubmission, now?: number) {
	return submitTaskReview(
		board,
		taskId,
		submission,
		{ reportDigest: createHash("sha256").update(submission.reportMarkdown).digest("hex") },
		now,
	);
}

function createReviewBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: "Verify publication",
						prompt: "Verify publication",
						startInPlanMode: false,
						baseRef: "main",
						execution: { attemptId: "attempt-1", generation: 1, queuedAt: 10 },
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

const acceptanceEvidence: RuntimeTaskAcceptanceEvidence = {
	kind: "verified_remote_revision",
	taskId: "task-1",
	generation: 1,
	executionAttemptId: "attempt-1",
	acceptedRevision: {
		sha: "0123456789abcdef0123456789abcdef01234567",
		remoteRef: "refs/heads/kanban/task-1-review",
	},
	verifiedAt: 2,
};

function createReadOnlySubmission(overrides: Partial<RuntimeTaskReviewSubmission> = {}): RuntimeTaskReviewSubmission {
	const reportMarkdown = "# Audit result\n\nNo repository changes were required.\n";
	return {
		taskId: "task-1",
		generation: 1,
		executionAttemptId: "attempt-1",
		deliverableKind: "read_only_report",
		reportMarkdown,
		reportDigest: createHash("sha256").update(reportMarkdown).digest("hex"),
		submittedAt: 20,
		workspace: {
			taskId: "task-1",
			path: "/tmp/task-1",
			vcs: "git",
			baseRef: "main",
		},
		receipt: {
			vcs: "git",
			clean: true,
			headCommit: "0123456789abcdef0123456789abcdef01234567",
			baseCommit: "0123456789abcdef0123456789abcdef01234567",
			hasConflicts: false,
			hasUntracked: false,
			divergent: false,
			stateDigest: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
		},
		...overrides,
	};
}

describe("Kanban acceptance boundary", () => {
	it("keeps legacy cards schema-compatible while excluding them from no-change acceptance", () => {
		const legacy = runtimeBoardCardSchema.parse({
			id: "legacy-task",
			title: "Legacy task",
			prompt: "Legacy task",
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
		});
		expect(legacy.deliverableKind).toBeUndefined();
		expect(legacy.submission).toBeUndefined();

		const board = createReviewBoard();
		const task = board.columns.find((column) => column.id === "review")?.cards[0];
		if (!task) throw new Error("Expected legacy Review task.");
		task.origin = { kind: "amp_architect", threadId: "T-architect-1" };
		const submission = createReadOnlySubmission();
		task.submission = submission;
		expect(() =>
			acceptReadOnlyTask(board, "task-1", {
				kind: "verified_no_change_report",
				taskId: "task-1",
				generation: 1,
				executionAttemptId: "attempt-1",
				reportDigest: submission.reportDigest,
				receipt: submission.receipt,
				architectThreadId: "T-architect-1",
				verifiedAt: 30,
			}),
		).toThrow("not an explicit read-only report deliverable");
	});

	it("stores one immutable generation- and attempt-fenced read-only submission", () => {
		const board = createReviewBoard();
		const task = board.columns.find((column) => column.id === "review")?.cards[0];
		if (!task) {
			throw new Error("Expected review task.");
		}
		task.deliverableKind = "read_only_report";
		const submission = createReadOnlySubmission();

		const attached = submitReview(board, "task-1", submission, 21);
		expect(attached.task?.submission).toEqual(submission);
		expect(attached.fromColumnId).toBe("review");
		expect(attached.moved).toBe(false);
		expect(submitReview(attached.board, "task-1", submission, 22).board).toBe(attached.board);

		expect(() =>
			submitReview(attached.board, "task-1", {
				...submission,
				submittedAt: 23,
			}),
		).toThrow("immutable");
		expect(() => submitReview(board, "task-1", createReadOnlySubmission({ generation: 2 }))).toThrow("generation");
		expect(() =>
			submitReview(board, "task-1", createReadOnlySubmission({ executionAttemptId: "attempt-stale" })),
		).toThrow("attempt");
		expect(() => submitReview(board, "task-1", createReadOnlySubmission({ reportDigest: "0".repeat(64) }))).toThrow(
			"digest",
		);
		expect(() =>
			submitReview(
				board,
				"task-1",
				createReadOnlySubmission({
					receipt: { ...createReadOnlySubmission().receipt, clean: false },
				}),
			),
		).toThrow("verified-clean");
	});

	it("allows a legacy Review task without execution telemetry to attach its first report", () => {
		const board = createReviewBoard();
		const task = board.columns.find((column) => column.id === "review")?.cards[0];
		if (!task) throw new Error("Expected review task.");
		task.deliverableKind = "read_only_report";
		delete task.execution;

		const result = submitReview(board, "task-1", createReadOnlySubmission({ executionAttemptId: null }));

		expect(result.task?.submission?.executionAttemptId).toBeNull();
	});

	it("accepts a verified no-change report through the dedicated transition and satisfies dependants", () => {
		const board = createReviewBoard();
		const task = board.columns.find((column) => column.id === "review")?.cards[0];
		if (!task) {
			throw new Error("Expected review task.");
		}
		task.deliverableKind = "read_only_report";
		task.origin = { kind: "amp_architect", threadId: "T-architect-1" };
		board.columns
			.find((column) => column.id === "backlog")
			?.cards.push({
				id: "dependent",
				title: "Dependent",
				prompt: "Dependent",
				startInPlanMode: false,
				baseRef: "main",
				createdAt: 1,
				updatedAt: 1,
			});
		board.dependencies.push({
			id: "dependency-1",
			fromTaskId: "dependent",
			toTaskId: "task-1",
			createdAt: 1,
		});
		const submitted = submitReview(board, "task-1", createReadOnlySubmission(), 21);
		const submission = submitted.task?.submission;
		if (!submission) {
			throw new Error("Expected durable submission.");
		}

		const accepted = acceptReadOnlyTask(
			submitted.board,
			"task-1",
			{
				kind: "verified_no_change_report",
				taskId: "task-1",
				generation: 1,
				executionAttemptId: "attempt-1",
				reportDigest: submission.reportDigest,
				receipt: submission.receipt,
				architectThreadId: "T-architect-1",
				verifiedAt: 30,
			},
			30,
		);

		expect(accepted.moved).toBe(true);
		expect(accepted.fromColumnId).toBe("review");
		expect(accepted.task?.acceptanceEvidence).toMatchObject({
			kind: "verified_no_change_report",
			reportDigest: submission.reportDigest,
		});
		expect(accepted.board.dependencies).toEqual([]);
		expect(moveTaskToColumn(accepted.board, "dependent", "in_progress").moved).toBe(true);
	});

	it("rejects an ordinary Review to Done move", () => {
		const moved = moveTaskToColumn(createReviewBoard(), "task-1", "trash", 2);
		expect(moved.moved).toBe(false);
		expect(moved.fromColumnId).toBe("review");
		expect(moved.board.columns.find((column) => column.id === "review")?.cards).toHaveLength(1);
	});

	it("keeps an explicit read-only report in Review when ordinary discard is attempted", () => {
		const board = createReviewBoard();
		const task = board.columns.find((column) => column.id === "review")?.cards[0];
		if (!task) throw new Error("Expected review task.");
		task.deliverableKind = "read_only_report";

		const discarded = discardTask(board, "task-1", 2);

		expect(discarded.moved).toBe(false);
		expect(discarded.fromColumnId).toBe("review");
	});

	it("rejects an ordinary Review to Done move even when stale acceptance evidence exists", () => {
		const board = createReviewBoard();
		const reviewTask = board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected the review task to exist.");
		}
		reviewTask.acceptanceEvidence = acceptanceEvidence;

		const moved = moveTaskToColumn(board, "task-1", "trash", 3);

		expect(moved.moved).toBe(false);
		expect(moved.board.columns.find((column) => column.id === "review")?.cards[0]?.acceptanceEvidence).toEqual(
			acceptanceEvidence,
		);
	});

	it("migrates legacy acceptance evidence to the task generation when loading a card", () => {
		const parsed = runtimeBoardCardSchema.parse({
			id: "legacy-accepted",
			title: "Legacy accepted task",
			prompt: "Legacy accepted task",
			startInPlanMode: false,
			generation: 3,
			acceptanceEvidence: {
				kind: "verified_remote_revision",
				acceptedRevision: acceptanceEvidence.acceptedRevision,
				verifiedAt: 2,
			},
			baseRef: "main",
			createdAt: 1,
			updatedAt: 2,
		});

		expect(parsed.acceptanceEvidence).toMatchObject({ taskId: "legacy-accepted", generation: 3 });
	});

	it("clears historical acceptance evidence when a Done task is reopened", () => {
		const board = createReviewBoard();
		const task = board.columns.find((column) => column.id === "review")?.cards[0];
		if (!task) {
			throw new Error("Expected review task.");
		}
		task.acceptanceEvidence = acceptanceEvidence;
		task.submission = createReadOnlySubmission();
		const accepted = discardTask(board, "task-1");

		const reopened = moveTaskToColumn(accepted.board, "task-1", "review", 3);

		expect(reopened.moved).toBe(true);
		expect(
			reopened.board.columns.find((column) => column.id === "review")?.cards[0]?.acceptanceEvidence,
		).toBeUndefined();
		expect(reopened.board.columns.find((column) => column.id === "review")?.cards[0]?.submission).toBeUndefined();
	});
});
