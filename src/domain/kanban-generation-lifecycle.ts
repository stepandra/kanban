import {
	isSameKanbanGeneration,
	type KanbanGenerationContext,
	type KanbanGenerationIdentity,
} from "./kanban-generation.js";
import { assertCurrentKanbanExecutionLeaseToken, type KanbanExecutionLeaseToken } from "./kanban-leases.js";
import {
	assertKanbanAcceptanceMatchesPromotion,
	assertSameKanbanSubmission,
	createKanbanPromotionReceipt,
	createKanbanSubmissionProvenance,
	type KanbanAcceptanceReceipt,
	type KanbanPromoterDerivedRevision,
	type KanbanPromotionReceipt,
	type KanbanSubmissionProvenance,
} from "./kanban-submission.js";

export interface KanbanExecutionAttemptReference {
	readonly attemptId: string;
	readonly owner: "absurd";
}

export interface KanbanPromotionAttemptReference {
	readonly attemptId: string;
	readonly executor: "amp-promoter-orb";
}

interface KanbanGenerationStateBase {
	readonly context: KanbanGenerationContext;
}

export interface KanbanGenerationReady extends KanbanGenerationStateBase {
	readonly kind: "ready";
}

export interface KanbanGenerationExecuting extends KanbanGenerationStateBase {
	readonly kind: "executing";
	readonly attempt: KanbanExecutionAttemptReference;
	readonly lease: KanbanExecutionLeaseToken;
}

export interface KanbanGenerationExecutionStuck extends KanbanGenerationStateBase {
	readonly kind: "execution-stuck";
	readonly attempt: KanbanExecutionAttemptReference;
	readonly lastLease: KanbanExecutionLeaseToken;
	readonly reason: string;
}

export interface KanbanGenerationAwaitingSubmission extends KanbanGenerationStateBase {
	readonly kind: "awaiting-submission";
	readonly completedAttempt: KanbanExecutionAttemptReference;
}

export interface KanbanGenerationSubmitted extends KanbanGenerationStateBase {
	readonly kind: "submitted";
	readonly provenance: KanbanSubmissionProvenance;
}

interface KanbanPromotionAttemptStateBase {
	readonly generation: KanbanGenerationIdentity;
	readonly provenance: KanbanSubmissionProvenance;
	readonly attempt: KanbanPromotionAttemptReference;
}

export interface KanbanPromotionAttemptRunning extends KanbanPromotionAttemptStateBase {
	readonly kind: "promotion-running";
}

export interface KanbanPromotionAttemptStuck extends KanbanPromotionAttemptStateBase {
	readonly kind: "promotion-stuck";
	readonly reason: string;
}

export interface KanbanPromotionAttemptCompleted extends KanbanPromotionAttemptStateBase {
	readonly kind: "promotion-completed";
	readonly promotionReceipt: KanbanPromotionReceipt;
}

export type KanbanPromotionAttemptState =
	| KanbanPromotionAttemptRunning
	| KanbanPromotionAttemptStuck
	| KanbanPromotionAttemptCompleted;

export interface KanbanGenerationPromoted extends KanbanGenerationStateBase {
	readonly kind: "promoted";
	readonly provenance: KanbanSubmissionProvenance;
	readonly promotionReceipt: KanbanPromotionReceipt;
}

export interface KanbanGenerationAccepted extends KanbanGenerationStateBase {
	readonly kind: "accepted";
	readonly provenance: KanbanSubmissionProvenance;
	readonly promotionReceipt: KanbanPromotionReceipt;
	readonly acceptanceReceipt: KanbanAcceptanceReceipt;
}

export type KanbanGenerationArtifactHistory =
	| { readonly kind: "none" }
	| {
			readonly kind: "submitted";
			readonly provenance: KanbanSubmissionProvenance;
	  }
	| {
			readonly kind: "promoted";
			readonly provenance: KanbanSubmissionProvenance;
			readonly promotionReceipt: KanbanPromotionReceipt;
	  };

export interface KanbanGenerationRejected extends KanbanGenerationStateBase {
	readonly kind: "rejected";
	readonly reason: string;
	readonly artifacts: KanbanGenerationArtifactHistory;
}

export interface KanbanGenerationCancelled extends KanbanGenerationStateBase {
	readonly kind: "cancelled";
	readonly reason: string;
	readonly artifacts: KanbanGenerationArtifactHistory;
}

export type KanbanGenerationState =
	| KanbanGenerationReady
	| KanbanGenerationExecuting
	| KanbanGenerationExecutionStuck
	| KanbanGenerationAwaitingSubmission
	| KanbanGenerationSubmitted
	| KanbanGenerationPromoted
	| KanbanGenerationAccepted
	| KanbanGenerationRejected
	| KanbanGenerationCancelled;

export type KanbanGenerationTerminalState =
	| KanbanGenerationAccepted
	| KanbanGenerationRejected
	| KanbanGenerationCancelled;

export type KanbanStuckState = KanbanGenerationExecutionStuck | KanbanPromotionAttemptStuck;

export type KanbanGenerationReapDecision =
	| { readonly kind: "not-candidate"; readonly reason: "generation-active" }
	| {
			readonly kind: "process-only";
			readonly path: "stuck";
			readonly reason: "retry-reuses-generation-workspace";
	  }
	| {
			readonly kind: "blocked";
			readonly path: "terminal";
			readonly reasons: readonly ("dirty" | "conflicted" | "unpublished" | "unknown")[];
	  }
	| { readonly kind: "allowed"; readonly path: "terminal" };

export type KanbanWorkspaceReapFact = boolean | "unknown";

export interface KanbanWorkspaceReapFacts {
	readonly clean: KanbanWorkspaceReapFact;
	readonly conflicted: KanbanWorkspaceReapFact;
	readonly published: KanbanWorkspaceReapFact;
}

export class KanbanGenerationTransitionError extends Error {
	constructor(state: KanbanGenerationState["kind"] | KanbanPromotionAttemptState["kind"], transition: string) {
		super(`Illegal Kanban generation transition "${transition}" from "${state}".`);
		this.name = "KanbanGenerationTransitionError";
	}
}

function requireNonEmpty(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new Error(`${field} cannot be empty.`);
	}
	return normalized;
}

function assertLeaseGeneration(generation: KanbanGenerationIdentity, leaseGeneration: KanbanGenerationIdentity): void {
	if (!isSameKanbanGeneration(generation, leaseGeneration)) {
		throw new Error("Lease token belongs to a different Kanban generation.");
	}
}

function createExecutionAttempt(attemptId: string): KanbanExecutionAttemptReference {
	return Object.freeze({
		attemptId: requireNonEmpty(attemptId, "attemptId"),
		owner: "absurd",
	});
}

function createPromotionAttempt(attemptId: string): KanbanPromotionAttemptReference {
	return Object.freeze({
		attemptId: requireNonEmpty(attemptId, "attemptId"),
		executor: "amp-promoter-orb",
	});
}

export function createKanbanGenerationReady(context: KanbanGenerationContext): KanbanGenerationReady {
	return Object.freeze({ kind: "ready", context });
}

export function startKanbanGenerationExecution(
	state: KanbanGenerationState,
	attemptId: string,
	lease: KanbanExecutionLeaseToken,
): KanbanGenerationExecuting {
	if (state.kind !== "ready" && state.kind !== "execution-stuck") {
		throw new KanbanGenerationTransitionError(state.kind, "start-execution");
	}
	assertLeaseGeneration(state.context.identity, lease.generation);
	if (state.kind === "execution-stuck") {
		if (state.attempt.attemptId === attemptId.trim()) {
			throw new Error("Execution retry requires a new Absurd attempt ID.");
		}
		if (lease.fencingValue <= state.lastLease.fencingValue) {
			throw new Error("Execution retry requires a monotonically increasing fencing value.");
		}
	}
	return Object.freeze({
		kind: "executing",
		context: state.context,
		attempt: createExecutionAttempt(attemptId),
		lease,
	});
}

export function reconnectKanbanGenerationExecution(
	state: KanbanGenerationState,
	attemptId: string,
	lease: KanbanExecutionLeaseToken,
): KanbanGenerationExecuting {
	if (state.kind !== "executing") {
		throw new KanbanGenerationTransitionError(state.kind, "reconnect-execution");
	}
	if (state.attempt.attemptId !== attemptId) {
		throw new Error("Execution reconnect must target the existing Absurd attempt.");
	}
	assertCurrentKanbanExecutionLeaseToken(state.lease, lease);
	return state;
}

export function completeKanbanGenerationExecution(
	state: KanbanGenerationState,
	lease: KanbanExecutionLeaseToken,
): KanbanGenerationAwaitingSubmission {
	if (state.kind !== "executing") {
		throw new KanbanGenerationTransitionError(state.kind, "complete-execution");
	}
	assertCurrentKanbanExecutionLeaseToken(state.lease, lease);
	return Object.freeze({
		kind: "awaiting-submission",
		context: state.context,
		completedAttempt: state.attempt,
	});
}

export function markKanbanGenerationExecutionStuck(
	state: KanbanGenerationState,
	lease: KanbanExecutionLeaseToken,
	reason: string,
): KanbanGenerationExecutionStuck {
	if (state.kind !== "executing") {
		throw new KanbanGenerationTransitionError(state.kind, "mark-execution-stuck");
	}
	assertCurrentKanbanExecutionLeaseToken(state.lease, lease);
	return Object.freeze({
		kind: "execution-stuck",
		context: state.context,
		attempt: state.attempt,
		lastLease: state.lease,
		reason: requireNonEmpty(reason, "reason"),
	});
}

export function submitKanbanGeneration(
	state: KanbanGenerationState,
	provenance: KanbanSubmissionProvenance,
): KanbanGenerationSubmitted {
	if (state.kind === "submitted") {
		assertSameKanbanSubmission(state.provenance, provenance);
		return state;
	}
	if (state.kind !== "awaiting-submission") {
		throw new KanbanGenerationTransitionError(state.kind, "submit");
	}
	const immutableProvenance = createKanbanSubmissionProvenance(provenance.submittedSha, provenance.remoteRef);
	return Object.freeze({
		kind: "submitted",
		context: state.context,
		provenance: immutableProvenance,
	});
}

export function startKanbanGenerationPromotion(
	state: KanbanGenerationSubmitted | KanbanPromotionAttemptStuck,
	attemptId: string,
): KanbanPromotionAttemptRunning {
	if (state.kind === "promotion-stuck" && state.attempt.attemptId === attemptId.trim()) {
		throw new Error("Promotion retry requires a new Promoter attempt ID.");
	}
	return Object.freeze({
		kind: "promotion-running",
		generation: state.kind === "submitted" ? state.context.identity : state.generation,
		provenance: state.provenance,
		attempt: createPromotionAttempt(attemptId),
	});
}

export function markKanbanGenerationPromotionStuck(
	state: KanbanPromotionAttemptState,
	reason: string,
): KanbanPromotionAttemptStuck {
	if (state.kind !== "promotion-running") {
		throw new KanbanGenerationTransitionError(state.kind, "mark-promotion-stuck");
	}
	return Object.freeze({
		kind: "promotion-stuck",
		generation: state.generation,
		provenance: state.provenance,
		attempt: state.attempt,
		reason: requireNonEmpty(reason, "reason"),
	});
}

export function completeKanbanGenerationPromotion(
	state: KanbanPromotionAttemptState,
	receiptId: string,
	derivedRevision: KanbanPromoterDerivedRevision,
): KanbanPromotionAttemptCompleted {
	if (state.kind !== "promotion-running") {
		throw new KanbanGenerationTransitionError(state.kind, "complete-promotion");
	}
	const promotionReceipt = createKanbanPromotionReceipt({
		receiptId,
		generation: state.generation,
		promotionAttemptId: state.attempt.attemptId,
		submission: state.provenance,
		derivedRevision,
	});
	return Object.freeze({
		kind: "promotion-completed",
		generation: state.generation,
		provenance: state.provenance,
		attempt: state.attempt,
		promotionReceipt,
	});
}

export function selectKanbanGenerationPromotion(
	state: KanbanGenerationState,
	attempt: KanbanPromotionAttemptCompleted,
): KanbanGenerationPromoted {
	if (state.kind !== "submitted") {
		throw new KanbanGenerationTransitionError(state.kind, "select-promotion");
	}
	if (!isSameKanbanGeneration(state.context.identity, attempt.generation)) {
		throw new Error("Promotion receipt belongs to a different Kanban generation.");
	}
	assertSameKanbanSubmission(state.provenance, attempt.provenance);
	if (!isSameKanbanGeneration(attempt.generation, attempt.promotionReceipt.generation)) {
		throw new Error("Promotion receipt belongs to a different Kanban generation.");
	}
	assertSameKanbanSubmission(attempt.provenance, attempt.promotionReceipt.submission);
	if (attempt.attempt.attemptId !== attempt.promotionReceipt.promotionAttemptId) {
		throw new Error("Promotion receipt belongs to a different Promoter attempt.");
	}
	return Object.freeze({
		kind: "promoted",
		context: state.context,
		provenance: state.provenance,
		promotionReceipt: attempt.promotionReceipt,
	});
}

export function acceptKanbanGeneration(
	state: KanbanGenerationState,
	acceptanceReceipt: KanbanAcceptanceReceipt,
): KanbanGenerationAccepted {
	if (state.kind !== "promoted") {
		throw new KanbanGenerationTransitionError(state.kind, "accept");
	}
	assertKanbanAcceptanceMatchesPromotion(state.promotionReceipt, acceptanceReceipt);
	return Object.freeze({
		kind: "accepted",
		context: state.context,
		provenance: state.provenance,
		promotionReceipt: state.promotionReceipt,
		acceptanceReceipt,
	});
}

function getArtifactHistory(state: KanbanGenerationState): KanbanGenerationArtifactHistory {
	switch (state.kind) {
		case "submitted":
			return {
				kind: "submitted",
				provenance: state.provenance,
			};
		case "promoted":
			return {
				kind: "promoted",
				provenance: state.provenance,
				promotionReceipt: state.promotionReceipt,
			};
		default:
			return { kind: "none" };
	}
}

export function rejectKanbanGeneration(state: KanbanGenerationState, reason: string): KanbanGenerationRejected {
	if (state.kind !== "submitted" && state.kind !== "promoted") {
		throw new KanbanGenerationTransitionError(state.kind, "reject");
	}
	return Object.freeze({
		kind: "rejected",
		context: state.context,
		reason: requireNonEmpty(reason, "reason"),
		artifacts: getArtifactHistory(state),
	});
}

export function cancelKanbanGeneration(state: KanbanGenerationState, reason: string): KanbanGenerationCancelled {
	if (
		state.kind !== "ready" &&
		state.kind !== "executing" &&
		state.kind !== "execution-stuck" &&
		state.kind !== "awaiting-submission"
	) {
		throw new KanbanGenerationTransitionError(state.kind, "cancel");
	}
	return Object.freeze({
		kind: "cancelled",
		context: state.context,
		reason: requireNonEmpty(reason, "reason"),
		artifacts: getArtifactHistory(state),
	});
}

export function isKanbanGenerationTerminal(state: KanbanGenerationState): state is KanbanGenerationTerminalState {
	return state.kind === "accepted" || state.kind === "rejected" || state.kind === "cancelled";
}

export function isKanbanLifecycleStuck(
	state: KanbanGenerationState | KanbanPromotionAttemptState,
): state is KanbanStuckState {
	return state.kind === "execution-stuck" || state.kind === "promotion-stuck";
}

export function classifyKanbanGenerationReap(
	state: KanbanGenerationState,
	facts: KanbanWorkspaceReapFacts,
): KanbanGenerationReapDecision {
	if (state.kind === "execution-stuck") {
		return { kind: "process-only", path: "stuck", reason: "retry-reuses-generation-workspace" };
	}
	if (!isKanbanGenerationTerminal(state)) {
		return { kind: "not-candidate", reason: "generation-active" };
	}
	const reasons: ("dirty" | "conflicted" | "unpublished" | "unknown")[] = [];
	if (facts.clean === false) {
		reasons.push("dirty");
	} else if (facts.clean === "unknown") {
		reasons.push("unknown");
	}
	if (facts.conflicted === true) {
		reasons.push("conflicted");
	} else if (facts.conflicted === "unknown" && !reasons.includes("unknown")) {
		reasons.push("unknown");
	}
	if (facts.published === false) {
		reasons.push("unpublished");
	} else if (facts.published === "unknown" && !reasons.includes("unknown")) {
		reasons.push("unknown");
	}
	return reasons.length > 0 ? { kind: "blocked", path: "terminal", reasons } : { kind: "allowed", path: "terminal" };
}
