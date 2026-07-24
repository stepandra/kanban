import { describe, expect, expectTypeOf, it } from "vitest";
import {
	createKanbanGenerationContext,
	createKanbanGenerationIdentity,
	createKanbanZmxIdentityInputs,
	formatKanbanZmxIdentity,
	type KanbanGenerationContext,
} from "../../src/domain/kanban-generation";
import {
	acceptKanbanGeneration,
	cancelKanbanGeneration,
	classifyKanbanGenerationReap,
	completeKanbanGenerationExecution,
	completeKanbanGenerationPromotion,
	createKanbanGenerationReady,
	type KanbanGenerationAccepted,
	type KanbanGenerationState,
	type KanbanPromotionAttemptStuck,
	markKanbanGenerationExecutionStuck,
	markKanbanGenerationPromotionStuck,
	reconnectKanbanGenerationExecution,
	rejectKanbanGeneration,
	selectKanbanGenerationPromotion,
	startKanbanGenerationExecution,
	startKanbanGenerationPromotion,
	submitKanbanGeneration,
} from "../../src/domain/kanban-generation-lifecycle";
import {
	advanceKanbanExecutionLeaseToken,
	advanceKanbanIntegrationLeaseToken,
	assertCurrentKanbanExecutionLeaseToken,
	assertCurrentKanbanIntegrationLeaseToken,
	createKanbanExecutionLeaseToken,
	createKanbanIntegrationLeaseToken,
} from "../../src/domain/kanban-leases";
import {
	createKanbanAcceptanceReceipt,
	createKanbanAcceptedRevision,
	createKanbanPromoterDerivedRevision,
	createKanbanPromotionReceipt,
	createKanbanSubmissionDispatchIntent,
	createKanbanSubmissionProvenance,
} from "../../src/domain/kanban-submission";

function createContext(): KanbanGenerationContext {
	const identity = createKanbanGenerationIdentity({
		workspaceId: "workspace-1",
		taskId: "b7438",
		generation: 2,
	});
	return createKanbanGenerationContext({
		identity,
		taskWorkspacePath: "/tmp/task-workspaces/b7438/kanban",
		zmxIdentity: createKanbanZmxIdentityInputs({
			generation: identity,
			agentId: "codex",
		}),
	});
}

function createSubmittedGeneration() {
	const context = createContext();
	const executionLease = createKanbanExecutionLeaseToken(context.identity, "execution-lease-1", "absurd-worker-1");
	const executing = startKanbanGenerationExecution(
		createKanbanGenerationReady(context),
		"absurd-attempt-1",
		executionLease,
	);
	const completed = completeKanbanGenerationExecution(executing, executionLease);
	return submitKanbanGeneration(
		completed,
		createKanbanSubmissionProvenance("submitted-sha", "refs/heads/kanban/b7438"),
	);
}

function createPromotionStuckAttempt(): KanbanPromotionAttemptStuck {
	const submitted = createSubmittedGeneration();
	const promoting = startKanbanGenerationPromotion(submitted, "promotion-attempt-1");
	return markKanbanGenerationPromotionStuck(promoting, "promoter disconnected");
}

function createAcceptedGeneration(): KanbanGenerationAccepted {
	const submitted = createSubmittedGeneration();
	const promoting = startKanbanGenerationPromotion(submitted, "promotion-attempt-1");
	const promoted = completeKanbanGenerationPromotion(
		promoting,
		"promotion-receipt-1",
		createKanbanPromoterDerivedRevision("promoter-sha", "refs/heads/kanban/b7438-promoted"),
	);
	const selected = selectKanbanGenerationPromotion(submitted, promoted);
	const acceptanceReceipt = createKanbanAcceptanceReceipt({
		receiptId: "acceptance-receipt-1",
		generation: selected.context.identity,
		promotionReceiptId: selected.promotionReceipt.receiptId,
		submission: selected.provenance,
		acceptedRevision: createKanbanAcceptedRevision("accepted-sha", "refs/heads/main"),
	});
	return acceptKanbanGeneration(selected, acceptanceReceipt);
}

describe("Kanban generation transition legality", () => {
	it("rejects transitions that skip execution, submission, or promotion receipts", () => {
		const ready = createKanbanGenerationReady(createContext());
		const provenance = createKanbanSubmissionProvenance("submitted-sha", "refs/heads/task");

		expect(() => submitKanbanGeneration(ready, provenance)).toThrow(
			'Illegal Kanban generation transition "submit" from "ready".',
		);

		const submitted = createSubmittedGeneration();
		const unmatchedAcceptance = createKanbanAcceptanceReceipt({
			receiptId: "acceptance-receipt-1",
			generation: submitted.context.identity,
			promotionReceiptId: "missing-promotion-receipt",
			submission: submitted.provenance,
			acceptedRevision: createKanbanAcceptedRevision("accepted-sha", "refs/heads/main"),
		});
		expect(() => acceptKanbanGeneration(submitted, unmatchedAcceptance)).toThrow(
			'Illegal Kanban generation transition "accept" from "submitted".',
		);
	});

	it("requires acceptance to reference the exact promotion receipt and submission", () => {
		const submitted = createSubmittedGeneration();
		const promoting = startKanbanGenerationPromotion(submitted, "promotion-attempt-1");
		const promoted = completeKanbanGenerationPromotion(
			promoting,
			"promotion-receipt-1",
			createKanbanPromoterDerivedRevision("promoter-sha", "refs/heads/promoted"),
		);
		const selected = selectKanbanGenerationPromotion(submitted, promoted);
		const wrongReceipt = createKanbanAcceptanceReceipt({
			receiptId: "acceptance-receipt-1",
			generation: selected.context.identity,
			promotionReceiptId: "promotion-receipt-2",
			submission: selected.provenance,
			acceptedRevision: createKanbanAcceptedRevision("accepted-sha", "refs/heads/main"),
		});

		expect(() => acceptKanbanGeneration(selected, wrongReceipt)).toThrow(
			"Kanban acceptance receipt does not match the promotion receipt.",
		);
	});

	it("does not permit a terminal generation to transition again", () => {
		const accepted = createAcceptedGeneration();
		expect(() => cancelKanbanGeneration(accepted, "late cancellation")).toThrow(
			'Illegal Kanban generation transition "cancel" from "accepted".',
		);
		expect(() => rejectKanbanGeneration(accepted, "late rejection")).toThrow(
			'Illegal Kanban generation transition "reject" from "accepted".',
		);
	});
});

describe("Kanban retry and reconnect identity", () => {
	it("reuses the generation workspace and deterministic zmx identity across retry", () => {
		const ready = createKanbanGenerationReady(createContext());
		const firstLease = createKanbanExecutionLeaseToken(ready.context.identity, "lease-1", "worker-1");
		const firstAttempt = startKanbanGenerationExecution(ready, "attempt-1", firstLease);
		const zmxIdentity = formatKanbanZmxIdentity(firstAttempt.context.zmxIdentity);
		const stuck = markKanbanGenerationExecutionStuck(firstAttempt, firstLease, "worker disappeared");
		const secondLease = advanceKanbanExecutionLeaseToken(firstLease, "lease-2", "worker-2");
		const secondAttempt = startKanbanGenerationExecution(stuck, "attempt-2", secondLease);

		expect(secondAttempt.context).toBe(firstAttempt.context);
		expect(secondAttempt.context.taskWorkspacePath).toBe(firstAttempt.context.taskWorkspacePath);
		expect(formatKanbanZmxIdentity(secondAttempt.context.zmxIdentity)).toBe(zmxIdentity);
		expect(secondAttempt.attempt.attemptId).not.toBe(firstAttempt.attempt.attemptId);
		expect(() => startKanbanGenerationExecution(stuck, "attempt-1", secondLease)).toThrow(
			"Execution retry requires a new Absurd attempt ID.",
		);
	});

	it("only reconnects the existing Absurd attempt with its current lease", () => {
		const ready = createKanbanGenerationReady(createContext());
		const lease = createKanbanExecutionLeaseToken(ready.context.identity, "lease-1", "worker-1");
		const executing = startKanbanGenerationExecution(ready, "attempt-1", lease);

		expect(reconnectKanbanGenerationExecution(executing, "attempt-1", lease)).toBe(executing);
		expect(() => reconnectKanbanGenerationExecution(executing, "attempt-2", lease)).toThrow(
			"Execution reconnect must target the existing Absurd attempt.",
		);
	});
});

describe("Kanban immutable submission and dispatch", () => {
	it("makes repeat submission idempotent and rejects provenance rewrites", () => {
		const submitted = createSubmittedGeneration();
		const sameProvenance = createKanbanSubmissionProvenance("submitted-sha", "refs/heads/kanban/b7438");
		const changedProvenance = createKanbanSubmissionProvenance("different-sha", "refs/heads/kanban/b7438");

		expect(submitKanbanGeneration(submitted, sameProvenance)).toBe(submitted);
		expect(() => submitKanbanGeneration(submitted, changedProvenance)).toThrow(
			"Kanban submission provenance is immutable for a generation.",
		);
		expect(Object.isFrozen(submitted.provenance)).toBe(true);
		expect(submitted).not.toHaveProperty("dispatchIntent");
	});

	it("derives exactly one stable dispatch intent identity per generation", () => {
		const context = createContext();
		const first = createKanbanSubmissionDispatchIntent(
			context.identity,
			createKanbanSubmissionProvenance("sha-1", "refs/heads/task"),
		);
		const replay = createKanbanSubmissionDispatchIntent(
			context.identity,
			createKanbanSubmissionProvenance("sha-1", "refs/heads/task"),
		);

		expect(replay.intentId).toBe(first.intentId);
		expect(first.intentId).toContain("kanban:submission-dispatch:kanban-generation:");
		expect(
			createKanbanSubmissionDispatchIntent(
				context.identity,
				createKanbanSubmissionProvenance("sha-2", "refs/heads/task"),
			).intentId,
		).not.toBe(first.intentId);
	});

	it("keeps promoter-derived and accepted revisions separate from submitted provenance", () => {
		const accepted = createAcceptedGeneration();

		expect(accepted.provenance).toEqual({
			submittedSha: "submitted-sha",
			remoteRef: "refs/heads/kanban/b7438",
		});
		expect(accepted.promotionReceipt.derivedRevision.sha).toBe("promoter-sha");
		expect(accepted.acceptanceReceipt.acceptedRevision.sha).toBe("accepted-sha");
	});
});

describe("Kanban lease fencing", () => {
	it("rejects stale generation execution and repository-workspace integration tokens", () => {
		const context = createContext();
		const executionOne = createKanbanExecutionLeaseToken(context.identity, "execution-1", "worker-1");
		const executionTwo = advanceKanbanExecutionLeaseToken(executionOne, "execution-2", "worker-2");
		const integrationOne = createKanbanIntegrationLeaseToken(
			context.identity.workspaceId,
			"integration-1",
			"fixer-1",
		);
		const integrationTwo = advanceKanbanIntegrationLeaseToken(integrationOne, "integration-2", "fixer-2");

		expect(executionTwo.fencingValue).toBe(2);
		expect(integrationTwo.fencingValue).toBe(2);
		expect(() => assertCurrentKanbanExecutionLeaseToken(executionTwo, executionOne)).toThrow(
			"Stale execution lease fencing value 1; current value is 2.",
		);
		expect(() => assertCurrentKanbanIntegrationLeaseToken(integrationTwo, integrationOne)).toThrow(
			"Stale integration lease fencing value 1; current value is 2.",
		);
		expect(() => assertCurrentKanbanExecutionLeaseToken(executionTwo, executionTwo)).not.toThrow();
		expect(() => assertCurrentKanbanIntegrationLeaseToken(integrationTwo, integrationTwo)).not.toThrow();
	});

	it("scopes one integration fence to the repository workspace rather than a generation", () => {
		const first = createKanbanIntegrationLeaseToken("workspace-1", "integration-1", "fixer-1");
		const otherWorkspace = createKanbanIntegrationLeaseToken("workspace-2", "integration-1", "fixer-1");

		expect(first).not.toHaveProperty("generation");
		expect(() => assertCurrentKanbanIntegrationLeaseToken(first, otherWorkspace)).toThrow(
			"Integration lease token belongs to a different Kanban repository workspace.",
		);
	});
});

describe("Kanban terminal and guarded reaper classification", () => {
	it("allows only process cleanup on stuck paths so retry retains the generation workspace", () => {
		const context = createContext();
		const executionLease = createKanbanExecutionLeaseToken(context.identity, "execution-1", "worker-1");
		const executing = startKanbanGenerationExecution(
			createKanbanGenerationReady(context),
			"attempt-1",
			executionLease,
		);
		const executionStuck = markKanbanGenerationExecutionStuck(executing, executionLease, "lost worker");
		const accepted = createAcceptedGeneration();
		const rejected = rejectKanbanGeneration(createSubmittedGeneration(), "review rejected");
		const cancelled = cancelKanbanGeneration(createKanbanGenerationReady(createContext()), "operator cancelled");
		const safe = { clean: true, conflicted: false, published: true };
		expectTypeOf(classifyKanbanGenerationReap).parameter(0).toEqualTypeOf<KanbanGenerationState>();

		expect(classifyKanbanGenerationReap(executionStuck, safe)).toEqual({
			kind: "process-only",
			path: "stuck",
			reason: "retry-reuses-generation-workspace",
		});
		expect(classifyKanbanGenerationReap(accepted, safe)).toEqual({ kind: "allowed", path: "terminal" });
		expect(classifyKanbanGenerationReap(rejected, safe)).toEqual({ kind: "allowed", path: "terminal" });
		expect(classifyKanbanGenerationReap(cancelled, safe)).toEqual({ kind: "allowed", path: "terminal" });
	});

	it("fails closed for dirty, conflicted, or unpublished workspaces", () => {
		const accepted = createAcceptedGeneration();

		expect(
			classifyKanbanGenerationReap(accepted, {
				clean: false,
				conflicted: true,
				published: false,
			}),
		).toEqual({
			kind: "blocked",
			path: "terminal",
			reasons: ["dirty", "conflicted", "unpublished"],
		});
		expect(
			classifyKanbanGenerationReap(createKanbanGenerationReady(createContext()), {
				clean: true,
				conflicted: false,
				published: true,
			}),
		).toEqual({ kind: "not-candidate", reason: "generation-active" });
		expect(
			classifyKanbanGenerationReap(accepted, {
				clean: "unknown",
				conflicted: "unknown",
				published: "unknown",
			}),
		).toEqual({
			kind: "blocked",
			path: "terminal",
			reasons: ["unknown"],
		});
	});
});

describe("Kanban cancellation and rejection semantics", () => {
	it("cancels only before submission and rejects only states carrying submission provenance", () => {
		const ready = createKanbanGenerationReady(createContext());
		const submitted = createSubmittedGeneration();

		expect(cancelKanbanGeneration(ready, "operator cancelled").kind).toBe("cancelled");
		expect(() => rejectKanbanGeneration(ready, "not reviewable")).toThrow(
			'Illegal Kanban generation transition "reject" from "ready".',
		);
		expect(rejectKanbanGeneration(submitted, "review rejected").artifacts.kind).toBe("submitted");
		expect(() => cancelKanbanGeneration(submitted, "too late to cancel")).toThrow(
			'Illegal Kanban generation transition "cancel" from "submitted".',
		);
	});

	it("requires a new Promoter attempt ID when retrying a stuck promotion", () => {
		const stuck = createPromotionStuckAttempt();

		expect(() => startKanbanGenerationPromotion(stuck, stuck.attempt.attemptId)).toThrow(
			"Promotion retry requires a new Promoter attempt ID.",
		);
		expect(startKanbanGenerationPromotion(stuck, "promotion-attempt-2").attempt.attemptId).toBe(
			"promotion-attempt-2",
		);
	});

	it("represents independent Promoter attempts concurrently without advancing the generation", () => {
		const submitted = createSubmittedGeneration();
		const first = startKanbanGenerationPromotion(submitted, "promotion-attempt-1");
		const second = startKanbanGenerationPromotion(submitted, "promotion-attempt-2");
		const firstStuck = markKanbanGenerationPromotionStuck(first, "repair needed");
		const secondCompleted = completeKanbanGenerationPromotion(
			second,
			"promotion-receipt-2",
			createKanbanPromoterDerivedRevision("promoter-sha-2", "refs/heads/promoted-2"),
		);

		expect(submitted.kind).toBe("submitted");
		expect(firstStuck.attempt.attemptId).toBe("promotion-attempt-1");
		expect(secondCompleted.attempt.attemptId).toBe("promotion-attempt-2");
		expect(firstStuck).not.toHaveProperty("context");
		expect(secondCompleted).not.toHaveProperty("context");
		expect(firstStuck).not.toHaveProperty("lease");
		expect(secondCompleted).not.toHaveProperty("lease");
		expect(selectKanbanGenerationPromotion(submitted, secondCompleted).promotionReceipt.receiptId).toBe(
			"promotion-receipt-2",
		);
	});

	it("rejects a completed attempt whose receipt has mismatched persisted bindings", () => {
		const submitted = createSubmittedGeneration();
		const running = startKanbanGenerationPromotion(submitted, "promotion-attempt-1");
		const completed = completeKanbanGenerationPromotion(
			running,
			"promotion-receipt-1",
			createKanbanPromoterDerivedRevision("promoter-sha", "refs/heads/promoted"),
		);
		const foreignGeneration = createKanbanGenerationIdentity({
			workspaceId: submitted.context.identity.workspaceId,
			taskId: "other-task",
			generation: 1,
		});

		expect(() =>
			selectKanbanGenerationPromotion(submitted, {
				...completed,
				promotionReceipt: createKanbanPromotionReceipt({
					...completed.promotionReceipt,
					generation: foreignGeneration,
				}),
			}),
		).toThrow("Promotion receipt belongs to a different Kanban generation.");
		expect(() =>
			selectKanbanGenerationPromotion(submitted, {
				...completed,
				promotionReceipt: createKanbanPromotionReceipt({
					...completed.promotionReceipt,
					submission: createKanbanSubmissionProvenance("other-sha", "refs/heads/other"),
				}),
			}),
		).toThrow("Kanban submission provenance is immutable for a generation.");
		expect(() =>
			selectKanbanGenerationPromotion(submitted, {
				...completed,
				promotionReceipt: createKanbanPromotionReceipt({
					...completed.promotionReceipt,
					promotionAttemptId: "promotion-attempt-2",
				}),
			}),
		).toThrow("Promotion receipt belongs to a different Promoter attempt.");
	});
});
