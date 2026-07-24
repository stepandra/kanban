import {
	createKanbanGenerationIdentity,
	formatKanbanGenerationIdentity,
	isSameKanbanGeneration,
	type KanbanGenerationIdentity,
} from "./kanban-generation.js";

export interface KanbanSubmissionProvenance {
	readonly submittedSha: string;
	readonly remoteRef: string;
}

export interface KanbanSubmissionDispatchIntent {
	readonly kind: "submission-dispatch";
	readonly intentId: string;
	readonly generation: KanbanGenerationIdentity;
	readonly provenance: KanbanSubmissionProvenance;
}

export interface KanbanPromoterDerivedRevision {
	readonly sha: string;
	readonly remoteRef: string;
}

export interface KanbanAcceptedRevision {
	readonly sha: string;
	readonly remoteRef: string;
}

export interface KanbanPromotionReceipt {
	readonly receiptId: string;
	readonly generation: KanbanGenerationIdentity;
	readonly promotionAttemptId: string;
	readonly submission: KanbanSubmissionProvenance;
	readonly derivedRevision: KanbanPromoterDerivedRevision;
}

export interface KanbanAcceptanceReceipt {
	readonly receiptId: string;
	readonly generation: KanbanGenerationIdentity;
	readonly promotionReceiptId: string;
	readonly submission: KanbanSubmissionProvenance;
	readonly acceptedRevision: KanbanAcceptedRevision;
}

function requireNonEmpty(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new Error(`${field} cannot be empty.`);
	}
	return normalized;
}

export function createKanbanSubmissionProvenance(submittedSha: string, remoteRef: string): KanbanSubmissionProvenance {
	return Object.freeze({
		submittedSha: requireNonEmpty(submittedSha, "submittedSha"),
		remoteRef: requireNonEmpty(remoteRef, "remoteRef"),
	});
}

export function isSameKanbanSubmission(left: KanbanSubmissionProvenance, right: KanbanSubmissionProvenance): boolean {
	return left.submittedSha === right.submittedSha && left.remoteRef === right.remoteRef;
}

export function assertSameKanbanSubmission(
	current: KanbanSubmissionProvenance,
	presented: KanbanSubmissionProvenance,
): void {
	if (!isSameKanbanSubmission(current, presented)) {
		throw new Error("Kanban submission provenance is immutable for a generation.");
	}
}

export function createKanbanSubmissionDispatchIntent(
	generation: KanbanGenerationIdentity,
	provenance: KanbanSubmissionProvenance,
): KanbanSubmissionDispatchIntent {
	const immutableGeneration = createKanbanGenerationIdentity(generation);
	const immutableProvenance = createKanbanSubmissionProvenance(provenance.submittedSha, provenance.remoteRef);
	return Object.freeze({
		kind: "submission-dispatch",
		intentId: [
			"kanban:submission-dispatch",
			formatKanbanGenerationIdentity(immutableGeneration),
			encodeURIComponent(immutableProvenance.submittedSha),
			encodeURIComponent(immutableProvenance.remoteRef),
		].join(":"),
		generation: immutableGeneration,
		provenance: immutableProvenance,
	});
}

export function createKanbanPromoterDerivedRevision(sha: string, remoteRef: string): KanbanPromoterDerivedRevision {
	return Object.freeze({
		sha: requireNonEmpty(sha, "sha"),
		remoteRef: requireNonEmpty(remoteRef, "remoteRef"),
	});
}

export function createKanbanAcceptedRevision(sha: string, remoteRef: string): KanbanAcceptedRevision {
	return Object.freeze({
		sha: requireNonEmpty(sha, "sha"),
		remoteRef: requireNonEmpty(remoteRef, "remoteRef"),
	});
}

export function createKanbanPromotionReceipt(input: KanbanPromotionReceipt): KanbanPromotionReceipt {
	return Object.freeze({
		receiptId: requireNonEmpty(input.receiptId, "receiptId"),
		generation: createKanbanGenerationIdentity(input.generation),
		promotionAttemptId: requireNonEmpty(input.promotionAttemptId, "promotionAttemptId"),
		submission: createKanbanSubmissionProvenance(input.submission.submittedSha, input.submission.remoteRef),
		derivedRevision: createKanbanPromoterDerivedRevision(input.derivedRevision.sha, input.derivedRevision.remoteRef),
	});
}

export function createKanbanAcceptanceReceipt(input: KanbanAcceptanceReceipt): KanbanAcceptanceReceipt {
	return Object.freeze({
		receiptId: requireNonEmpty(input.receiptId, "receiptId"),
		generation: createKanbanGenerationIdentity(input.generation),
		promotionReceiptId: requireNonEmpty(input.promotionReceiptId, "promotionReceiptId"),
		submission: createKanbanSubmissionProvenance(input.submission.submittedSha, input.submission.remoteRef),
		acceptedRevision: createKanbanAcceptedRevision(input.acceptedRevision.sha, input.acceptedRevision.remoteRef),
	});
}

export function assertKanbanAcceptanceMatchesPromotion(
	promotion: KanbanPromotionReceipt,
	acceptance: KanbanAcceptanceReceipt,
): void {
	if (
		!isSameKanbanGeneration(promotion.generation, acceptance.generation) ||
		promotion.receiptId !== acceptance.promotionReceiptId
	) {
		throw new Error("Kanban acceptance receipt does not match the promotion receipt.");
	}
	assertSameKanbanSubmission(promotion.submission, acceptance.submission);
}
