import {
	createKanbanGenerationIdentity,
	isSameKanbanGeneration,
	type KanbanGenerationIdentity,
} from "./kanban-generation.js";

interface KanbanLeaseTokenFields {
	readonly leaseId: string;
	readonly holderId: string;
	readonly fencingValue: number;
}

export interface KanbanExecutionLeaseToken extends KanbanLeaseTokenFields {
	readonly kind: "execution";
	readonly generation: KanbanGenerationIdentity;
}

export interface KanbanIntegrationLeaseToken extends KanbanLeaseTokenFields {
	readonly kind: "integration";
	readonly workspaceId: string;
}

function requireNonEmpty(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new Error(`${field} cannot be empty.`);
	}
	return normalized;
}

function validateFencingValue(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error("fencingValue must be a positive safe integer.");
	}
	return value;
}

function createLeaseFields(leaseId: string, holderId: string, fencingValue: number): KanbanLeaseTokenFields {
	return {
		leaseId: requireNonEmpty(leaseId, "leaseId"),
		holderId: requireNonEmpty(holderId, "holderId"),
		fencingValue: validateFencingValue(fencingValue),
	};
}

export function createKanbanExecutionLeaseToken(
	generation: KanbanGenerationIdentity,
	leaseId: string,
	holderId: string,
): KanbanExecutionLeaseToken {
	return Object.freeze({
		kind: "execution",
		generation: createKanbanGenerationIdentity(generation),
		...createLeaseFields(leaseId, holderId, 1),
	});
}

export function advanceKanbanExecutionLeaseToken(
	previous: KanbanExecutionLeaseToken,
	leaseId: string,
	holderId: string,
): KanbanExecutionLeaseToken {
	return Object.freeze({
		kind: "execution",
		generation: previous.generation,
		...createLeaseFields(leaseId, holderId, previous.fencingValue + 1),
	});
}

export function createKanbanIntegrationLeaseToken(
	workspaceId: string,
	leaseId: string,
	holderId: string,
): KanbanIntegrationLeaseToken {
	return Object.freeze({
		kind: "integration",
		workspaceId: requireNonEmpty(workspaceId, "workspaceId"),
		...createLeaseFields(leaseId, holderId, 1),
	});
}

export function advanceKanbanIntegrationLeaseToken(
	previous: KanbanIntegrationLeaseToken,
	leaseId: string,
	holderId: string,
): KanbanIntegrationLeaseToken {
	return Object.freeze({
		kind: "integration",
		workspaceId: previous.workspaceId,
		...createLeaseFields(leaseId, holderId, previous.fencingValue + 1),
	});
}

function assertCurrentLeaseToken(
	current: KanbanLeaseTokenFields,
	presented: KanbanLeaseTokenFields,
	kind: "execution" | "integration",
): void {
	if (presented.fencingValue < current.fencingValue) {
		throw new Error(
			`Stale ${kind} lease fencing value ${presented.fencingValue}; current value is ${current.fencingValue}.`,
		);
	}
	if (
		presented.fencingValue !== current.fencingValue ||
		presented.leaseId !== current.leaseId ||
		presented.holderId !== current.holderId
	) {
		throw new Error(`Presented ${kind} lease token is not the current lease.`);
	}
}

export function assertCurrentKanbanExecutionLeaseToken(
	current: KanbanExecutionLeaseToken,
	presented: KanbanExecutionLeaseToken,
): void {
	if (!isSameKanbanGeneration(current.generation, presented.generation)) {
		throw new Error("Execution lease token belongs to a different Kanban generation.");
	}
	assertCurrentLeaseToken(current, presented, "execution");
}

export function assertCurrentKanbanIntegrationLeaseToken(
	current: KanbanIntegrationLeaseToken,
	presented: KanbanIntegrationLeaseToken,
): void {
	if (current.workspaceId !== presented.workspaceId) {
		throw new Error("Integration lease token belongs to a different Kanban repository workspace.");
	}
	assertCurrentLeaseToken(current, presented, "integration");
}
