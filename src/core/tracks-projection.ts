import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeMilestone,
	RuntimeMilestoneProjection,
	RuntimeTrackProgress,
	RuntimeTracksProjection,
	RuntimeTrackTaskCounts,
	RuntimeTrackTaskRef,
} from "./api-contract";

interface BuildTracksProjectionInput {
	projectRef: string;
	revision: number;
	generatedAt?: number;
	board: RuntimeBoardData;
}

interface LocatedTask {
	card: RuntimeBoardCard;
	columnId: RuntimeBoardColumnId;
}

function createEmptyCounts(): RuntimeTrackTaskCounts {
	return { backlog: 0, inProgress: 0, review: 0, accepted: 0, discarded: 0 };
}

function incrementCount(counts: RuntimeTrackTaskCounts, task: LocatedTask): void {
	switch (task.columnId) {
		case "backlog":
			counts.backlog += 1;
			break;
		case "in_progress":
			counts.inProgress += 1;
			break;
		case "review":
			counts.review += 1;
			break;
		case "trash":
			if (task.card.acceptanceEvidence) {
				counts.accepted += 1;
			} else {
				counts.discarded += 1;
			}
			break;
	}
}

function toProjectionStatus(task: LocatedTask): RuntimeTrackTaskRef["status"] {
	if (task.columnId !== "trash") {
		return task.columnId;
	}
	return task.card.acceptanceEvidence ? "accepted" : "discarded";
}

function collectLocatedTasks(board: RuntimeBoardData): LocatedTask[] {
	return board.columns.flatMap((column) =>
		column.cards.map((card) => ({
			card,
			columnId: column.id,
		})),
	);
}

function buildTaskRef(task: LocatedTask, blockedByCount: number): RuntimeTrackTaskRef {
	return {
		taskId: task.card.id,
		title: task.card.title,
		status: toProjectionStatus(task),
		weight: task.card.planning?.weight ?? 1,
		blockedByCount,
	};
}

function buildProgress(tasks: LocatedTask[]): RuntimeTrackProgress {
	if (tasks.length === 0) {
		return { acceptedWeight: 0, totalWeight: 0, percent: null, basis: "scope_unset" };
	}
	const hasExplicitWeights = tasks.some((task) => task.card.planning?.weight !== undefined);
	const totalWeight = tasks.reduce((total, task) => total + (task.card.planning?.weight ?? 1), 0);
	const acceptedWeight = tasks.reduce(
		(total, task) =>
			total + (task.columnId === "trash" && task.card.acceptanceEvidence ? (task.card.planning?.weight ?? 1) : 0),
		0,
	);
	return {
		acceptedWeight,
		totalWeight,
		percent: Math.round((acceptedWeight / totalWeight) * 100),
		basis: hasExplicitWeights ? "weighted" : "count",
	};
}

function buildCounts(tasks: LocatedTask[]): RuntimeTrackTaskCounts {
	const counts = createEmptyCounts();
	for (const task of tasks) incrementCount(counts, task);
	return counts;
}

function buildBlockedByCount(board: RuntimeBoardData): Map<string, number> {
	const counts = new Map<string, number>();
	for (const dependency of board.dependencies) {
		counts.set(dependency.fromTaskId, (counts.get(dependency.fromTaskId) ?? 0) + 1);
	}
	return counts;
}

function sortLocatedTasks(tasks: LocatedTask[]): LocatedTask[] {
	return [...tasks].sort(
		(left, right) => left.card.createdAt - right.card.createdAt || left.card.id.localeCompare(right.card.id),
	);
}

function buildMilestoneProjection(
	milestone: RuntimeMilestone,
	tasks: LocatedTask[],
	blockedByCount: Map<string, number>,
): RuntimeMilestoneProjection {
	const orderedTasks = sortLocatedTasks(tasks);
	return {
		milestoneId: milestone.id,
		title: milestone.title,
		...(milestone.definitionOfDone ? { definitionOfDone: milestone.definitionOfDone } : {}),
		state: milestone.state,
		order: milestone.order,
		scopeRevision: milestone.scopeRevision,
		counts: buildCounts(orderedTasks),
		progress: buildProgress(orderedTasks),
		tasks: orderedTasks.map((task) => buildTaskRef(task, blockedByCount.get(task.card.id) ?? 0)),
	};
}

export function buildTracksProjection(input: BuildTracksProjectionInput): RuntimeTracksProjection {
	const locatedTasks = collectLocatedTasks(input.board);
	const locatedTaskById = new Map(locatedTasks.map((task) => [task.card.id, task]));
	const blockedByCount = buildBlockedByCount(input.board);
	const tracks = [...(input.board.tracks ?? [])]
		.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
		.map((track) => {
			const milestones = (input.board.milestones ?? [])
				.filter((milestone) => milestone.trackId === track.id)
				.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
				.map((milestone) =>
					buildMilestoneProjection(
						milestone,
						locatedTasks.filter((task) => task.card.planning?.milestoneId === milestone.id),
						blockedByCount,
					),
				);
			const activeMilestone = milestones.find((milestone) => milestone.state === "active") ?? null;
			const activeTasks = activeMilestone
				? locatedTasks.filter((task) => task.card.planning?.milestoneId === activeMilestone.milestoneId)
				: [];
			return {
				trackId: track.id,
				name: track.name,
				...(track.description ? { description: track.description } : {}),
				order: track.order,
				archived: track.archivedAt !== undefined,
				activeMilestoneId: activeMilestone?.milestoneId ?? null,
				counts: buildCounts(activeTasks),
				progress: buildProgress(activeTasks),
				milestones,
			};
		});

	const assignedTaskIds = new Set(
		locatedTasks.filter((task) => task.card.planning !== undefined).map((task) => task.card.id),
	);
	const unassignedTasks = sortLocatedTasks(locatedTasks.filter((task) => !assignedTaskIds.has(task.card.id)));
	const crossTrackDependencies = input.board.dependencies.flatMap((dependency) => {
		const dependentTrackId = locatedTaskById.get(dependency.fromTaskId)?.card.planning?.trackId;
		const prerequisiteTrackId = locatedTaskById.get(dependency.toTaskId)?.card.planning?.trackId;
		if (!dependentTrackId || !prerequisiteTrackId || dependentTrackId === prerequisiteTrackId) {
			return [];
		}
		return [
			{
				dependentTaskId: dependency.fromTaskId,
				prerequisiteTaskId: dependency.toTaskId,
				dependentTrackId,
				prerequisiteTrackId,
			},
		];
	});

	return {
		schema: "kanban-tracks-projection/v1",
		projectRef: input.projectRef,
		revision: input.revision,
		generatedAt: input.generatedAt ?? Date.now(),
		tracks,
		unassigned: {
			counts: buildCounts(unassignedTasks),
			tasks: unassignedTasks.map((task) => buildTaskRef(task, blockedByCount.get(task.card.id) ?? 0)),
		},
		crossTrackDependencies,
	};
}
