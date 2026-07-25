export interface KanbanGenerationIdentity {
	readonly workspaceId: string;
	readonly taskId: string;
	readonly generation: number;
}

export interface KanbanZmxIdentityInputs {
	readonly generation: KanbanGenerationIdentity;
	readonly agentId: string;
}

export interface KanbanGenerationContext {
	readonly identity: KanbanGenerationIdentity;
	readonly taskWorkspacePath: string;
	readonly zmxIdentity: KanbanZmxIdentityInputs;
}

function requireNonEmpty(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new Error(`${field} cannot be empty.`);
	}
	return normalized;
}

export function createKanbanGenerationIdentity(input: KanbanGenerationIdentity): KanbanGenerationIdentity {
	if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
		throw new Error("generation must be a positive safe integer.");
	}
	return Object.freeze({
		workspaceId: requireNonEmpty(input.workspaceId, "workspaceId"),
		taskId: requireNonEmpty(input.taskId, "taskId"),
		generation: input.generation,
	});
}

export function isSameKanbanGeneration(left: KanbanGenerationIdentity, right: KanbanGenerationIdentity): boolean {
	return (
		left.workspaceId === right.workspaceId && left.taskId === right.taskId && left.generation === right.generation
	);
}

export function formatKanbanGenerationIdentity(identity: KanbanGenerationIdentity): string {
	return [
		"kanban-generation",
		encodeURIComponent(identity.workspaceId),
		encodeURIComponent(identity.taskId),
		identity.generation.toString(10),
	].join(":");
}

export function createKanbanZmxIdentityInputs(input: KanbanZmxIdentityInputs): KanbanZmxIdentityInputs {
	return Object.freeze({
		generation: createKanbanGenerationIdentity(input.generation),
		agentId: requireNonEmpty(input.agentId, "agentId"),
	});
}

export function formatKanbanZmxIdentity(inputs: KanbanZmxIdentityInputs): string {
	return [formatKanbanGenerationIdentity(inputs.generation), encodeURIComponent(inputs.agentId)].join(":");
}

export function createKanbanGenerationContext(input: KanbanGenerationContext): KanbanGenerationContext {
	const identity = createKanbanGenerationIdentity(input.identity);
	const zmxIdentity = createKanbanZmxIdentityInputs(input.zmxIdentity);
	if (!isSameKanbanGeneration(identity, zmxIdentity.generation)) {
		throw new Error("zmx identity must belong to the same Kanban generation.");
	}
	return Object.freeze({
		identity,
		taskWorkspacePath: requireNonEmpty(input.taskWorkspacePath, "taskWorkspacePath"),
		zmxIdentity,
	});
}
