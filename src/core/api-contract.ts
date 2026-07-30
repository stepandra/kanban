import { z } from "zod";
import { resolveTaskTitle } from "./task-title.js";

export const runtimeWorkspaceFileStatusSchema = z.enum([
	"modified",
	"added",
	"deleted",
	"renamed",
	"copied",
	"untracked",
	"unknown",
]);
export type RuntimeWorkspaceFileStatus = z.infer<typeof runtimeWorkspaceFileStatusSchema>;

export const runtimeWorkspaceFileChangeSchema = z.object({
	path: z.string(),
	previousPath: z.string().optional(),
	status: runtimeWorkspaceFileStatusSchema,
	additions: z.number(),
	deletions: z.number(),
	oldText: z.string().nullable(),
	newText: z.string().nullable(),
});
export type RuntimeWorkspaceFileChange = z.infer<typeof runtimeWorkspaceFileChangeSchema>;

export const runtimeWorkspaceChangesRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
	mode: z.enum(["working_copy", "last_turn"]).optional(),
});
export type RuntimeWorkspaceChangesRequest = z.infer<typeof runtimeWorkspaceChangesRequestSchema>;

export const runtimeWorkspaceChangesModeSchema = z.enum(["working_copy", "last_turn"]);
export type RuntimeWorkspaceChangesMode = z.infer<typeof runtimeWorkspaceChangesModeSchema>;

export const runtimeWorkspaceChangesResponseSchema = z.object({
	repoRoot: z.string(),
	generatedAt: z.number(),
	files: z.array(runtimeWorkspaceFileChangeSchema),
});
export type RuntimeWorkspaceChangesResponse = z.infer<typeof runtimeWorkspaceChangesResponseSchema>;

export const runtimeWorkspaceFileSearchRequestSchema = z.object({
	query: z.string(),
	limit: z.number().int().positive().optional(),
});
export type RuntimeWorkspaceFileSearchRequest = z.infer<typeof runtimeWorkspaceFileSearchRequestSchema>;

export const runtimeWorkspaceFileSearchMatchSchema = z.object({
	path: z.string(),
	name: z.string(),
	changed: z.boolean(),
});
export type RuntimeWorkspaceFileSearchMatch = z.infer<typeof runtimeWorkspaceFileSearchMatchSchema>;

export const runtimeWorkspaceFileSearchResponseSchema = z.object({
	query: z.string(),
	files: z.array(runtimeWorkspaceFileSearchMatchSchema),
});
export type RuntimeWorkspaceFileSearchResponse = z.infer<typeof runtimeWorkspaceFileSearchResponseSchema>;

export const runtimeAgentIdSchema = z.enum([
	"amp",
	"claude",
	"codex",
	"grok",
	"kimi",
	"gemini",
	"opencode",
	"droid",
	"kiro",
]);
export type RuntimeAgentId = z.infer<typeof runtimeAgentIdSchema>;

const runtimeRemovedAgentIdSchema = z.literal("cline");
const runtimePersistedBoardAgentIdSchema = z.union([runtimeAgentIdSchema, runtimeRemovedAgentIdSchema]);

const runtimeBoardColumnIdEnum = z.enum(["backlog", "in_progress", "review", "trash"]);
export const runtimeBoardColumnIdSchema = z.preprocess(
	(val) => (val === "done" ? "trash" : val),
	runtimeBoardColumnIdEnum,
);
export type RuntimeBoardColumnId = z.infer<typeof runtimeBoardColumnIdEnum>;

const runtimeTaskAutoReviewModeEnum = z.enum(["commit", "pr"]);
export const runtimeTaskAutoReviewModeSchema = z.preprocess(
	(val) => (val === "move_to_trash" || val === "move_to_done" ? "commit" : val),
	runtimeTaskAutoReviewModeEnum,
);
export type RuntimeTaskAutoReviewMode = z.infer<typeof runtimeTaskAutoReviewModeEnum>;

export const runtimeTaskImageSchema = z.object({
	id: z.string(),
	data: z.string(),
	mimeType: z.string(),
	name: z.string().optional(),
});
export type RuntimeTaskImage = z.infer<typeof runtimeTaskImageSchema>;

export const runtimeAmpThreadIdSchema = z.string().regex(/^T-[A-Za-z0-9][A-Za-z0-9-]*$/u);
export const runtimeTaskOriginSchema = z.object({
	kind: z.literal("amp_architect"),
	threadId: runtimeAmpThreadIdSchema,
});
export type RuntimeTaskOrigin = z.infer<typeof runtimeTaskOriginSchema>;

export const runtimeTaskExecutionAttemptReferenceSchema = z.object({
	attemptId: z.string().min(1),
	generation: z.number().int().positive(),
	queuedAt: z.number(),
});
export type RuntimeTaskExecutionAttemptReference = z.infer<typeof runtimeTaskExecutionAttemptReferenceSchema>;

export const runtimeTrackIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);
export type RuntimeTrackId = z.infer<typeof runtimeTrackIdSchema>;

export const runtimeMilestoneIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);
export type RuntimeMilestoneId = z.infer<typeof runtimeMilestoneIdSchema>;

export const runtimeTrackSchema = z.object({
	id: runtimeTrackIdSchema,
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().min(1).max(1_000).optional(),
	order: z.number().int().nonnegative(),
	archivedAt: z.number().int().nonnegative().optional(),
});
export type RuntimeTrack = z.infer<typeof runtimeTrackSchema>;

export const runtimeMilestoneStateSchema = z.enum(["planned", "active", "accepted", "archived"]);
export type RuntimeMilestoneState = z.infer<typeof runtimeMilestoneStateSchema>;

export const runtimeMilestoneSchema = z.object({
	id: runtimeMilestoneIdSchema,
	trackId: runtimeTrackIdSchema,
	title: z.string().trim().min(1).max(160),
	definitionOfDone: z.string().trim().min(1).max(2_000).optional(),
	state: runtimeMilestoneStateSchema,
	order: z.number().int().nonnegative(),
	scopeRevision: z.number().int().nonnegative(),
});
export type RuntimeMilestone = z.infer<typeof runtimeMilestoneSchema>;

export const runtimeTaskPlanningContextSchema = z.object({
	trackId: runtimeTrackIdSchema,
	milestoneId: runtimeMilestoneIdSchema,
	weight: z.number().positive().max(100).optional(),
});
export type RuntimeTaskPlanningContext = z.infer<typeof runtimeTaskPlanningContextSchema>;

export const runtimeTaskAcceptanceEvidenceSchema = z.object({
	kind: z.literal("verified_remote_revision"),
	acceptedRevision: z.object({
		sha: z.string().regex(/^[0-9a-f]{40,64}$/u),
		remoteRef: z.string().regex(/^refs\/heads\/kanban\/[A-Za-z0-9._/-]+$/u),
	}),
	verifiedAt: z.number().int().nonnegative(),
});
export type RuntimeTaskAcceptanceEvidence = z.infer<typeof runtimeTaskAcceptanceEvidenceSchema>;

export const runtimeBoardCardSchema = z
	.object({
		id: z.string(),
		title: z.string().optional(),
		prompt: z.string(),
		startInPlanMode: z.boolean(),
		autoReviewEnabled: z.boolean().optional(),
		autoReviewMode: runtimeTaskAutoReviewModeSchema.optional(),
		images: z.array(runtimeTaskImageSchema).optional(),
		agentId: runtimePersistedBoardAgentIdSchema.optional(),
		removedAgentId: runtimeRemovedAgentIdSchema.optional(),
		priority: z.number().optional(),
		generation: z.number().int().positive().optional(),
		origin: runtimeTaskOriginSchema.optional(),
		execution: runtimeTaskExecutionAttemptReferenceSchema.optional(),
		planning: runtimeTaskPlanningContextSchema.optional(),
		acceptanceEvidence: runtimeTaskAcceptanceEvidenceSchema.optional(),
		baseRef: z.string(),
		createdAt: z.number(),
		updatedAt: z.number(),
	})
	.transform(({ agentId, removedAgentId, ...card }) => {
		const migratedRemovedAgentId: "cline" | undefined =
			agentId === "cline" || removedAgentId === "cline" ? "cline" : undefined;
		return {
			...card,
			...(agentId && agentId !== "cline" ? { agentId } : {}),
			...(migratedRemovedAgentId ? { removedAgentId: migratedRemovedAgentId } : {}),
			title: resolveTaskTitle(card.title, card.prompt),
		};
	});
export type RuntimeBoardCard = z.infer<typeof runtimeBoardCardSchema>;

export const runtimeBoardColumnSchema = z.object({
	id: runtimeBoardColumnIdSchema,
	title: z.string(),
	cards: z.array(runtimeBoardCardSchema),
});
export type RuntimeBoardColumn = z.infer<typeof runtimeBoardColumnSchema>;

export const runtimeBoardDependencySchema = z.object({
	id: z.string(),
	fromTaskId: z.string(),
	toTaskId: z.string(),
	createdAt: z.number(),
});
export type RuntimeBoardDependency = z.infer<typeof runtimeBoardDependencySchema>;

export const runtimeBoardDataSchema = z
	.object({
		columns: z.array(runtimeBoardColumnSchema),
		dependencies: z.array(runtimeBoardDependencySchema).default([]),
		tracks: z.array(runtimeTrackSchema).optional(),
		milestones: z.array(runtimeMilestoneSchema).optional(),
	})
	.superRefine((board, ctx) => {
		const tracks = board.tracks ?? [];
		const milestones = board.milestones ?? [];
		const trackIds = new Set<string>();
		for (const [index, track] of tracks.entries()) {
			if (trackIds.has(track.id)) {
				ctx.addIssue({
					code: "custom",
					path: ["tracks", index, "id"],
					message: `Duplicate track id: ${track.id}`,
				});
			}
			trackIds.add(track.id);
		}
		const milestonesById = new Map<string, RuntimeMilestone>();
		const activeTrackIds = new Set<string>();
		for (const [index, milestone] of milestones.entries()) {
			if (!trackIds.has(milestone.trackId)) {
				ctx.addIssue({
					code: "custom",
					path: ["milestones", index, "trackId"],
					message: `Milestone ${milestone.id} references unknown track ${milestone.trackId}`,
				});
			}
			if (milestonesById.has(milestone.id)) {
				ctx.addIssue({
					code: "custom",
					path: ["milestones", index, "id"],
					message: `Duplicate milestone id: ${milestone.id}`,
				});
			}
			milestonesById.set(milestone.id, milestone);
			if (milestone.state === "active") {
				if (activeTrackIds.has(milestone.trackId)) {
					ctx.addIssue({
						code: "custom",
						path: ["milestones", index, "state"],
						message: `Track ${milestone.trackId} cannot have more than one active milestone`,
					});
				}
				activeTrackIds.add(milestone.trackId);
			}
		}
		for (const [columnIndex, column] of board.columns.entries()) {
			for (const [cardIndex, card] of column.cards.entries()) {
				if (!card.planning) continue;
				const milestone = milestonesById.get(card.planning.milestoneId);
				if (!trackIds.has(card.planning.trackId)) {
					ctx.addIssue({
						code: "custom",
						path: ["columns", columnIndex, "cards", cardIndex, "planning", "trackId"],
						message: `Task ${card.id} references unknown track ${card.planning.trackId}`,
					});
				}
				if (!milestone || milestone.trackId !== card.planning.trackId) {
					ctx.addIssue({
						code: "custom",
						path: ["columns", columnIndex, "cards", cardIndex, "planning", "milestoneId"],
						message: `Task ${card.id} references a milestone outside its track`,
					});
				}
			}
		}
	});
export type RuntimeBoardData = z.infer<typeof runtimeBoardDataSchema>;

export const runtimeTrackTaskStatusSchema = z.enum(["backlog", "in_progress", "review", "accepted"]);
export type RuntimeTrackTaskStatus = z.infer<typeof runtimeTrackTaskStatusSchema>;

export const runtimeTrackTaskCountsSchema = z.object({
	backlog: z.number().int().nonnegative(),
	inProgress: z.number().int().nonnegative(),
	review: z.number().int().nonnegative(),
	accepted: z.number().int().nonnegative(),
});
export type RuntimeTrackTaskCounts = z.infer<typeof runtimeTrackTaskCountsSchema>;

export const runtimeTrackProgressSchema = z.object({
	acceptedWeight: z.number().nonnegative(),
	totalWeight: z.number().nonnegative(),
	percent: z.number().min(0).max(100).nullable(),
	basis: z.enum(["weighted", "count", "scope_unset"]),
});
export type RuntimeTrackProgress = z.infer<typeof runtimeTrackProgressSchema>;

export const runtimeTrackTaskRefSchema = z.object({
	taskId: z.string(),
	title: z.string(),
	status: runtimeTrackTaskStatusSchema,
	weight: z.number().positive(),
	blockedByCount: z.number().int().nonnegative(),
});
export type RuntimeTrackTaskRef = z.infer<typeof runtimeTrackTaskRefSchema>;

export const runtimeMilestoneProjectionSchema = z.object({
	milestoneId: runtimeMilestoneIdSchema,
	title: z.string(),
	definitionOfDone: z.string().optional(),
	state: runtimeMilestoneStateSchema,
	order: z.number().int().nonnegative(),
	scopeRevision: z.number().int().nonnegative(),
	counts: runtimeTrackTaskCountsSchema,
	progress: runtimeTrackProgressSchema,
	tasks: z.array(runtimeTrackTaskRefSchema),
});
export type RuntimeMilestoneProjection = z.infer<typeof runtimeMilestoneProjectionSchema>;

export const runtimeTrackProjectionSchema = z.object({
	trackId: runtimeTrackIdSchema,
	name: z.string(),
	description: z.string().optional(),
	order: z.number().int().nonnegative(),
	archived: z.boolean(),
	activeMilestoneId: runtimeMilestoneIdSchema.nullable(),
	counts: runtimeTrackTaskCountsSchema,
	progress: runtimeTrackProgressSchema,
	milestones: z.array(runtimeMilestoneProjectionSchema),
});
export type RuntimeTrackProjection = z.infer<typeof runtimeTrackProjectionSchema>;

export const runtimeCrossTrackDependencySchema = z.object({
	dependentTaskId: z.string(),
	prerequisiteTaskId: z.string(),
	dependentTrackId: runtimeTrackIdSchema,
	prerequisiteTrackId: runtimeTrackIdSchema,
});
export type RuntimeCrossTrackDependency = z.infer<typeof runtimeCrossTrackDependencySchema>;

export const runtimeUnassignedTrackProjectionSchema = z.object({
	counts: runtimeTrackTaskCountsSchema,
	tasks: z.array(runtimeTrackTaskRefSchema),
});
export type RuntimeUnassignedTrackProjection = z.infer<typeof runtimeUnassignedTrackProjectionSchema>;

export const runtimeTracksProjectionSchema = z.object({
	schema: z.literal("kanban-tracks-projection/v1"),
	projectRef: z.string().trim().min(1),
	revision: z.number().int().nonnegative(),
	generatedAt: z.number().int().nonnegative(),
	tracks: z.array(runtimeTrackProjectionSchema),
	unassigned: runtimeUnassignedTrackProjectionSchema,
	crossTrackDependencies: z.array(runtimeCrossTrackDependencySchema),
});
export type RuntimeTracksProjection = z.infer<typeof runtimeTracksProjectionSchema>;

export const runtimeGitRepositoryInfoSchema = z.object({
	currentBranch: z.string().nullable(),
	defaultBranch: z.string().nullable(),
	branches: z.array(z.string()),
});
export type RuntimeGitRepositoryInfo = z.infer<typeof runtimeGitRepositoryInfoSchema>;

export const runtimeVcsModeSchema = z.enum(["git", "jj"]);
export type RuntimeVcsMode = z.infer<typeof runtimeVcsModeSchema>;

export const runtimeGitSyncActionSchema = z.enum(["fetch", "pull", "push"]);
export type RuntimeGitSyncAction = z.infer<typeof runtimeGitSyncActionSchema>;

export const runtimeGitSyncSummarySchema = z.object({
	currentBranch: z.string().nullable(),
	upstreamBranch: z.string().nullable(),
	changedFiles: z.number(),
	additions: z.number(),
	deletions: z.number(),
	aheadCount: z.number(),
	behindCount: z.number(),
});
export type RuntimeGitSyncSummary = z.infer<typeof runtimeGitSyncSummarySchema>;

export const runtimeGitSummaryResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeGitSyncSummarySchema,
	error: z.string().optional(),
});
export type RuntimeGitSummaryResponse = z.infer<typeof runtimeGitSummaryResponseSchema>;

export const runtimeGitSyncResponseSchema = z.object({
	ok: z.boolean(),
	action: runtimeGitSyncActionSchema,
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitSyncResponse = z.infer<typeof runtimeGitSyncResponseSchema>;

export const runtimeGitCheckoutRequestSchema = z.object({
	branch: z.string(),
});
export type RuntimeGitCheckoutRequest = z.infer<typeof runtimeGitCheckoutRequestSchema>;

export const runtimeGitCheckoutResponseSchema = z.object({
	ok: z.boolean(),
	branch: z.string(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitCheckoutResponse = z.infer<typeof runtimeGitCheckoutResponseSchema>;

export const runtimeGitDiscardResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitDiscardResponse = z.infer<typeof runtimeGitDiscardResponseSchema>;

export const runtimeTaskSessionStateSchema = z.enum(["idle", "running", "awaiting_review", "failed", "interrupted"]);
export type RuntimeTaskSessionState = z.infer<typeof runtimeTaskSessionStateSchema>;

export const runtimeTaskSessionModeSchema = z.enum(["act", "plan"]);
export type RuntimeTaskSessionMode = z.infer<typeof runtimeTaskSessionModeSchema>;

export const runtimeTaskSessionReviewReasonSchema = z
	.enum(["attention", "exit", "error", "interrupted", "hook"])
	.nullable();
export type RuntimeTaskSessionReviewReason = z.infer<typeof runtimeTaskSessionReviewReasonSchema>;

export const runtimeTaskHookActivitySchema = z.object({
	activityText: z.string().nullable().default(null),
	toolName: z.string().nullable().default(null),
	toolInputSummary: z.string().nullable().default(null),
	finalMessage: z.string().nullable().default(null),
	hookEventName: z.string().nullable().default(null),
	notificationType: z.string().nullable().default(null),
	source: z.string().nullable().default(null),
});
export type RuntimeTaskHookActivity = z.infer<typeof runtimeTaskHookActivitySchema>;

export const runtimeTaskTurnCheckpointSchema = z.object({
	turn: z.number().int().positive(),
	ref: z.string(),
	commit: z.string(),
	createdAt: z.number(),
});
export type RuntimeTaskTurnCheckpoint = z.infer<typeof runtimeTaskTurnCheckpointSchema>;

export const runtimeTaskSessionSummarySchema = z.object({
	taskId: z.string(),
	state: runtimeTaskSessionStateSchema,
	mode: runtimeTaskSessionModeSchema.nullable().optional(),
	agentId: runtimeAgentIdSchema.nullable(),
	workspacePath: z.string().nullable(),
	pid: z.number().nullable(),
	startedAt: z.number().nullable(),
	updatedAt: z.number(),
	lastOutputAt: z.number().nullable(),
	reviewReason: runtimeTaskSessionReviewReasonSchema,
	exitCode: z.number().nullable(),
	lastHookAt: z.number().nullable().default(null),
	latestHookActivity: runtimeTaskHookActivitySchema.nullable().default(null),
	// Name of the durable zmx session backing this task session, when the agent
	// was launched under zmx (see src/terminal/zmx-agent-session.ts). Persisted
	// so a restarted runtime can reattach instead of losing track of the live
	// session. Optional so older persisted state remains valid.
	durableSessionName: z.string().nullable().optional(),
	warningMessage: z.string().nullable().optional(),
	latestTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
	previousTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
});
export type RuntimeTaskSessionSummary = z.infer<typeof runtimeTaskSessionSummarySchema>;

export const runtimeWorkspaceStateResponseSchema = z.object({
	repoPath: z.string(),
	statePath: z.string(),
	vcs: runtimeVcsModeSchema,
	git: runtimeGitRepositoryInfoSchema,
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	revision: z.number(),
});
export type RuntimeWorkspaceStateResponse = z.infer<typeof runtimeWorkspaceStateResponseSchema>;

export const runtimeWorkspaceStateSaveRequestSchema = z.object({
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	expectedRevision: z.number().int().nonnegative().optional(),
});
export type RuntimeWorkspaceStateSaveRequest = z.infer<typeof runtimeWorkspaceStateSaveRequestSchema>;

export const runtimeWorkspaceStateConflictResponseSchema = z.object({
	error: z.string(),
	currentRevision: z.number(),
});
export type RuntimeWorkspaceStateConflictResponse = z.infer<typeof runtimeWorkspaceStateConflictResponseSchema>;

export const runtimeWorkspaceStateNotifyResponseSchema = z.object({
	ok: z.boolean(),
});
export type RuntimeWorkspaceStateNotifyResponse = z.infer<typeof runtimeWorkspaceStateNotifyResponseSchema>;

export const runtimeProjectTaskCountsSchema = z.object({
	backlog: z.number(),
	in_progress: z.number(),
	review: z.number(),
	trash: z.number(),
});
export type RuntimeProjectTaskCounts = z.infer<typeof runtimeProjectTaskCountsSchema>;

export const runtimeProjectSummarySchema = z.object({
	id: z.string(),
	path: z.string(),
	name: z.string(),
	taskCounts: runtimeProjectTaskCountsSchema,
});
export type RuntimeProjectSummary = z.infer<typeof runtimeProjectSummarySchema>;

export const runtimeTaskWorkspaceMetadataSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	exists: z.boolean(),
	baseRef: z.string(),
	branch: z.string().nullable(),
	isDetached: z.boolean(),
	headCommit: z.string().nullable(),
	changeId: z.string().nullable(),
	changedFiles: z.number().nullable(),
	additions: z.number().nullable(),
	deletions: z.number().nullable(),
	stateVersion: z.number().int().nonnegative(),
});
export type RuntimeTaskWorkspaceMetadata = z.infer<typeof runtimeTaskWorkspaceMetadataSchema>;

export const runtimeWorkspaceMetadataSchema = z.object({
	homeGitSummary: runtimeGitSyncSummarySchema.nullable(),
	homeGitStateVersion: z.number().int().nonnegative(),
	taskWorkspaces: z.array(runtimeTaskWorkspaceMetadataSchema),
});
export type RuntimeWorkspaceMetadata = z.infer<typeof runtimeWorkspaceMetadataSchema>;

export const runtimeStateStreamSnapshotMessageSchema = z.object({
	type: z.literal("snapshot"),
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
	workspaceState: runtimeWorkspaceStateResponseSchema.nullable(),
	workspaceMetadata: runtimeWorkspaceMetadataSchema.nullable(),
});
export type RuntimeStateStreamSnapshotMessage = z.infer<typeof runtimeStateStreamSnapshotMessageSchema>;

export const runtimeStateStreamWorkspaceStateMessageSchema = z.object({
	type: z.literal("workspace_state_updated"),
	workspaceId: z.string(),
	workspaceState: runtimeWorkspaceStateResponseSchema,
});
export type RuntimeStateStreamWorkspaceStateMessage = z.infer<typeof runtimeStateStreamWorkspaceStateMessageSchema>;

export const runtimeStateStreamTaskSessionsMessageSchema = z.object({
	type: z.literal("task_sessions_updated"),
	workspaceId: z.string(),
	summaries: z.array(runtimeTaskSessionSummarySchema),
});
export type RuntimeStateStreamTaskSessionsMessage = z.infer<typeof runtimeStateStreamTaskSessionsMessageSchema>;

export const runtimeStateStreamProjectsMessageSchema = z.object({
	type: z.literal("projects_updated"),
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
});
export type RuntimeStateStreamProjectsMessage = z.infer<typeof runtimeStateStreamProjectsMessageSchema>;

export const runtimeStateStreamWorkspaceMetadataMessageSchema = z.object({
	type: z.literal("workspace_metadata_updated"),
	workspaceId: z.string(),
	workspaceMetadata: runtimeWorkspaceMetadataSchema,
});
export type RuntimeStateStreamWorkspaceMetadataMessage = z.infer<
	typeof runtimeStateStreamWorkspaceMetadataMessageSchema
>;

export const runtimeStateStreamTaskReadyForReviewMessageSchema = z.object({
	type: z.literal("task_ready_for_review"),
	workspaceId: z.string(),
	taskId: z.string(),
	triggeredAt: z.number(),
});
export type RuntimeStateStreamTaskReadyForReviewMessage = z.infer<
	typeof runtimeStateStreamTaskReadyForReviewMessageSchema
>;

export const runtimeStateStreamErrorMessageSchema = z.object({
	type: z.literal("error"),
	message: z.string(),
});
export type RuntimeStateStreamErrorMessage = z.infer<typeof runtimeStateStreamErrorMessageSchema>;

export const runtimeStateStreamMessageSchema = z.discriminatedUnion("type", [
	runtimeStateStreamSnapshotMessageSchema,
	runtimeStateStreamWorkspaceStateMessageSchema,
	runtimeStateStreamTaskSessionsMessageSchema,
	runtimeStateStreamProjectsMessageSchema,
	runtimeStateStreamWorkspaceMetadataMessageSchema,
	runtimeStateStreamTaskReadyForReviewMessageSchema,
	runtimeStateStreamErrorMessageSchema,
]);
export type RuntimeStateStreamMessage = z.infer<typeof runtimeStateStreamMessageSchema>;

export const runtimeProjectsResponseSchema = z.object({
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
});
export type RuntimeProjectsResponse = z.infer<typeof runtimeProjectsResponseSchema>;

export const runtimeProjectAddRequestSchema = z
	.object({
		path: z.string().optional(),
		gitUrl: z.string().optional(),
		initializeGit: z.boolean().optional(),
	})
	.refine((data) => data.path || data.gitUrl, { message: "Either path or gitUrl is required" });
export type RuntimeProjectAddRequest = z.infer<typeof runtimeProjectAddRequestSchema>;

export const runtimeProjectAddResponseSchema = z.object({
	ok: z.boolean(),
	project: runtimeProjectSummarySchema.nullable(),
	requiresGitInitialization: z.boolean().optional(),
	error: z.string().optional(),
});
export type RuntimeProjectAddResponse = z.infer<typeof runtimeProjectAddResponseSchema>;

export const runtimeProjectDirectoryPickerResponseSchema = z.object({
	ok: z.boolean(),
	path: z.string().nullable(),
	error: z.string().optional(),
});
export type RuntimeProjectDirectoryPickerResponse = z.infer<typeof runtimeProjectDirectoryPickerResponseSchema>;

export const runtimeDirectoryListEntrySchema = z.object({
	name: z.string(),
	path: z.string(),
	isGitRepository: z.boolean(),
});
export type RuntimeDirectoryListEntry = z.infer<typeof runtimeDirectoryListEntrySchema>;

export const runtimeDirectoryListRequestSchema = z.object({
	path: z.string().optional(),
});
export type RuntimeDirectoryListRequest = z.infer<typeof runtimeDirectoryListRequestSchema>;

export const runtimeDirectoryListResponseSchema = z.object({
	ok: z.boolean(),
	currentPath: z.string(),
	parentPath: z.string().nullable(),
	rootPath: z.string(),
	entries: z.array(runtimeDirectoryListEntrySchema),
	error: z.string().optional(),
});
export type RuntimeDirectoryListResponse = z.infer<typeof runtimeDirectoryListResponseSchema>;

export const runtimeProjectRemoveRequestSchema = z.object({
	projectId: z.string(),
});
export type RuntimeProjectRemoveRequest = z.infer<typeof runtimeProjectRemoveRequestSchema>;

export const runtimeProjectRemoveResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeProjectRemoveResponse = z.infer<typeof runtimeProjectRemoveResponseSchema>;

export const runtimeWorktreeEnsureRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
});
export type RuntimeWorktreeEnsureRequest = z.infer<typeof runtimeWorktreeEnsureRequestSchema>;

export const runtimeWorktreeEnsureResponseSchema = z.union([
	z.object({
		ok: z.literal(true),
		path: z.string(),
		baseRef: z.string(),
		baseCommit: z.string(),
		warning: z.string().optional(),
		error: z.string().optional(),
	}),
	z.object({
		ok: z.literal(false),
		path: z.null(),
		baseRef: z.string(),
		baseCommit: z.null(),
		error: z.string().optional(),
	}),
]);
export type RuntimeWorktreeEnsureResponse = z.infer<typeof runtimeWorktreeEnsureResponseSchema>;

export const runtimeWorktreeDeleteRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeWorktreeDeleteRequest = z.infer<typeof runtimeWorktreeDeleteRequestSchema>;

export const runtimeWorktreeDeleteResponseSchema = z.object({
	ok: z.boolean(),
	removed: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeWorktreeDeleteResponse = z.infer<typeof runtimeWorktreeDeleteResponseSchema>;

export const runtimeTaskWorkspaceInfoRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
});
export type RuntimeTaskWorkspaceInfoRequest = z.infer<typeof runtimeTaskWorkspaceInfoRequestSchema>;

export const runtimeTaskWorkspaceInfoResponseSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	exists: z.boolean(),
	baseRef: z.string(),
	branch: z.string().nullable(),
	isDetached: z.boolean(),
	headCommit: z.string().nullable(),
});
export type RuntimeTaskWorkspaceInfoResponse = z.infer<typeof runtimeTaskWorkspaceInfoResponseSchema>;

export const runtimeProjectShortcutSchema = z.object({
	label: z.string(),
	command: z.string(),
	icon: z.string().optional(),
});
export type RuntimeProjectShortcut = z.infer<typeof runtimeProjectShortcutSchema>;

export const runtimeTaskTemplateSchema = z.object({
	id: z.string(),
	name: z.string(),
	prompt: z.string(),
	agentId: runtimeAgentIdSchema.optional(),
	baseRef: z.string().optional(),
	autoReviewEnabled: z.boolean().optional(),
	autoReviewMode: runtimeTaskAutoReviewModeSchema.optional(),
});
export type RuntimeTaskTemplate = z.infer<typeof runtimeTaskTemplateSchema>;

export const runtimeCommandRunRequestSchema = z.object({
	command: z.string(),
});
export type RuntimeCommandRunRequest = z.infer<typeof runtimeCommandRunRequestSchema>;

export const runtimeCommandRunResponseSchema = z.object({
	exitCode: z.number(),
	stdout: z.string(),
	stderr: z.string(),
	combinedOutput: z.string(),
	durationMs: z.number(),
});
export type RuntimeCommandRunResponse = z.infer<typeof runtimeCommandRunResponseSchema>;

export const runtimeOpenFileRequestSchema = z.object({
	filePath: z.string(),
});
export type RuntimeOpenFileRequest = z.infer<typeof runtimeOpenFileRequestSchema>;

export const runtimeOpenFileResponseSchema = z.object({
	ok: z.boolean(),
});
export type RuntimeOpenFileResponse = z.infer<typeof runtimeOpenFileResponseSchema>;

export const runtimeDebugResetAllStateResponseSchema = z.object({
	ok: z.boolean(),
	clearedPaths: z.array(z.string()),
});
export type RuntimeDebugResetAllStateResponse = z.infer<typeof runtimeDebugResetAllStateResponseSchema>;

export const runtimeUpdateStatusResponseSchema = z.object({
	currentVersion: z.string(),
	latestVersion: z.string().nullable(),
	updateAvailable: z.boolean(),
	updateTiming: z.enum(["startup", "shutdown"]).nullable(),
	installCommand: z.string().nullable(),
});
export type RuntimeUpdateStatusResponse = z.infer<typeof runtimeUpdateStatusResponseSchema>;

export const runtimeRunUpdateResponseSchema = z.object({
	status: z.enum([
		"updated",
		"already_up_to_date",
		"cache_refreshed",
		"unsupported_installation",
		"check_failed",
		"update_failed",
	]),
	currentVersion: z.string(),
	latestVersion: z.string().nullable(),
	message: z.string(),
});
export type RuntimeRunUpdateResponse = z.infer<typeof runtimeRunUpdateResponseSchema>;

export const runtimeAgentDefinitionSchema = z.object({
	id: runtimeAgentIdSchema,
	label: z.string(),
	binary: z.string(),
	command: z.string(),
	defaultArgs: z.array(z.string()),
	installed: z.boolean(),
	configured: z.boolean(),
});
export type RuntimeAgentDefinition = z.infer<typeof runtimeAgentDefinitionSchema>;

export const runtimeConfigResponseSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema,
	selectedShortcutLabel: z.string().nullable(),
	agentAutonomousModeEnabled: z.boolean(),
	debugModeEnabled: z.boolean().optional(),
	effectiveCommand: z.string().nullable(),
	globalConfigPath: z.string(),
	projectConfigPath: z.string().nullable(),
	readyForReviewNotificationsEnabled: z.boolean(),
	detectedCommands: z.array(z.string()),
	agents: z.array(runtimeAgentDefinitionSchema),
	shortcuts: z.array(runtimeProjectShortcutSchema),
	commitPromptTemplate: z.string(),
	openPrPromptTemplate: z.string(),
	commitPromptTemplateDefault: z.string(),
	openPrPromptTemplateDefault: z.string(),
	taskTemplates: z.array(runtimeTaskTemplateSchema),
});
export type RuntimeConfigResponse = z.infer<typeof runtimeConfigResponseSchema>;

export const runtimeConfigSaveRequestSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema.optional(),
	selectedShortcutLabel: z.string().nullable().optional(),
	agentAutonomousModeEnabled: z.boolean().optional(),
	shortcuts: z.array(runtimeProjectShortcutSchema).optional(),
	readyForReviewNotificationsEnabled: z.boolean().optional(),
	commitPromptTemplate: z.string().optional(),
	openPrPromptTemplate: z.string().optional(),
	taskTemplates: z.array(runtimeTaskTemplateSchema).optional(),
});
export type RuntimeConfigSaveRequest = z.infer<typeof runtimeConfigSaveRequestSchema>;

export const runtimeTaskSessionStartRequestSchema = z.object({
	taskId: z.string(),
	prompt: z.string(),
	/** Display title from the Kanban task card. */
	taskTitle: z.string().optional(),
	images: z.array(runtimeTaskImageSchema).optional(),
	startInPlanMode: z.boolean().optional(),
	mode: runtimeTaskSessionModeSchema.optional(),
	resumeFromTrash: z.boolean().optional(),
	baseRef: z.string(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
	agentId: runtimeAgentIdSchema.optional(),
});
export type RuntimeTaskSessionStartRequest = z.infer<typeof runtimeTaskSessionStartRequestSchema>;

export const runtimeTaskSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionStartResponse = z.infer<typeof runtimeTaskSessionStartResponseSchema>;

export const runtimeTaskExecutionEnqueueRequestSchema = z.object({
	taskId: z.string(),
	resumeFromTrash: z.boolean().optional(),
});
export type RuntimeTaskExecutionEnqueueRequest = z.infer<typeof runtimeTaskExecutionEnqueueRequestSchema>;

export const runtimeTaskExecutionEnqueueResponseSchema = z.object({
	ok: z.boolean(),
	state: z.literal("queued").nullable(),
	task: z
		.object({
			id: z.string(),
			generation: z.number().int().positive(),
		})
		.nullable(),
	attempt: runtimeTaskExecutionAttemptReferenceSchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskExecutionEnqueueResponse = z.infer<typeof runtimeTaskExecutionEnqueueResponseSchema>;

export const runtimeTaskExecutionProjectionStatusSchema = z.enum([
	"pending",
	"running",
	"sleeping",
	"completed",
	"failed",
	"cancelled",
	"unknown",
]);
export type RuntimeTaskExecutionProjectionStatus = z.infer<typeof runtimeTaskExecutionProjectionStatusSchema>;

export const runtimeTaskExecutionProjectionRequestSchema = z.object({
	attempts: z.array(runtimeTaskExecutionAttemptReferenceSchema).max(100),
});
export type RuntimeTaskExecutionProjectionRequest = z.infer<typeof runtimeTaskExecutionProjectionRequestSchema>;

export const runtimeTaskExecutionProjectionSchema = runtimeTaskExecutionAttemptReferenceSchema.extend({
	status: runtimeTaskExecutionProjectionStatusSchema,
	runId: z.string().nullable(),
	currentAttempt: z.number().int().positive().nullable(),
	maxAttempts: z.number().int().positive().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskExecutionProjection = z.infer<typeof runtimeTaskExecutionProjectionSchema>;

export const runtimeTaskExecutionProjectionResponseSchema = z.object({
	generatedAt: z.number(),
	attempts: z.array(runtimeTaskExecutionProjectionSchema),
});
export type RuntimeTaskExecutionProjectionResponse = z.infer<typeof runtimeTaskExecutionProjectionResponseSchema>;

export const runtimeSystemReadinessCheckSchema = z.object({
	id: z.enum(["absurd_queue", "absurd_worker", "jujutsu", "amp_architect", "worker_commands"]),
	label: z.string(),
	status: z.enum(["ready", "stopped", "unavailable", "degraded"]),
	detail: z.string(),
});
export type RuntimeSystemReadinessCheck = z.infer<typeof runtimeSystemReadinessCheckSchema>;

export const runtimeSystemReadinessResponseSchema = z.object({
	generatedAt: z.number(),
	checks: z.array(runtimeSystemReadinessCheckSchema),
});
export type RuntimeSystemReadinessResponse = z.infer<typeof runtimeSystemReadinessResponseSchema>;

export const runtimeTaskSessionStopRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskSessionStopRequest = z.infer<typeof runtimeTaskSessionStopRequestSchema>;

export const runtimeTaskSessionStopResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionStopResponse = z.infer<typeof runtimeTaskSessionStopResponseSchema>;

export const runtimeTaskSessionInputRequestSchema = z.object({
	taskId: z.string(),
	text: z.string(),
	appendNewline: z.boolean().optional(),
});
export type RuntimeTaskSessionInputRequest = z.infer<typeof runtimeTaskSessionInputRequestSchema>;

export const runtimeTaskSessionInputResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionInputResponse = z.infer<typeof runtimeTaskSessionInputResponseSchema>;

export const runtimeShellSessionStartRequestSchema = z.object({
	taskId: z.string(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
	workspaceTaskId: z.string().optional(),
	baseRef: z.string(),
});
export type RuntimeShellSessionStartRequest = z.infer<typeof runtimeShellSessionStartRequestSchema>;

export const runtimeShellSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	shellBinary: z.string().nullable().optional(),
	error: z.string().optional(),
});
export type RuntimeShellSessionStartResponse = z.infer<typeof runtimeShellSessionStartResponseSchema>;

export const runtimeTerminalWsResizeMessageSchema = z.object({
	type: z.literal("resize"),
	cols: z.number().int().positive(),
	rows: z.number().int().positive(),
	pixelWidth: z.number().int().positive().optional(),
	pixelHeight: z.number().int().positive().optional(),
});
export type RuntimeTerminalWsResizeMessage = z.infer<typeof runtimeTerminalWsResizeMessageSchema>;

export const runtimeTerminalWsStopMessageSchema = z.object({
	type: z.literal("stop"),
});
export type RuntimeTerminalWsStopMessage = z.infer<typeof runtimeTerminalWsStopMessageSchema>;

export const runtimeTerminalWsOutputAckMessageSchema = z.object({
	type: z.literal("output_ack"),
	bytes: z.number().int().nonnegative(),
});
export type RuntimeTerminalWsOutputAckMessage = z.infer<typeof runtimeTerminalWsOutputAckMessageSchema>;

export const runtimeTerminalWsRestoreCompleteMessageSchema = z.object({
	type: z.literal("restore_complete"),
});
export type RuntimeTerminalWsRestoreCompleteMessage = z.infer<typeof runtimeTerminalWsRestoreCompleteMessageSchema>;

export const runtimeTerminalWsClientMessageSchema = z.discriminatedUnion("type", [
	runtimeTerminalWsResizeMessageSchema,
	runtimeTerminalWsStopMessageSchema,
	runtimeTerminalWsOutputAckMessageSchema,
	runtimeTerminalWsRestoreCompleteMessageSchema,
]);
export type RuntimeTerminalWsClientMessage = z.infer<typeof runtimeTerminalWsClientMessageSchema>;

export const runtimeTerminalWsStateMessageSchema = z.object({
	type: z.literal("state"),
	summary: runtimeTaskSessionSummarySchema,
});
export type RuntimeTerminalWsStateMessage = z.infer<typeof runtimeTerminalWsStateMessageSchema>;

export const runtimeTerminalWsErrorMessageSchema = z.object({
	type: z.literal("error"),
	message: z.string(),
});
export type RuntimeTerminalWsErrorMessage = z.infer<typeof runtimeTerminalWsErrorMessageSchema>;

export const runtimeTerminalWsExitMessageSchema = z.object({
	type: z.literal("exit"),
	code: z.number().nullable(),
});
export type RuntimeTerminalWsExitMessage = z.infer<typeof runtimeTerminalWsExitMessageSchema>;

export const runtimeTerminalWsRestoreMessageSchema = z.object({
	type: z.literal("restore"),
	snapshot: z.string(),
	cols: z.number().int().positive().nullable().optional(),
	rows: z.number().int().positive().nullable().optional(),
});
export type RuntimeTerminalWsRestoreMessage = z.infer<typeof runtimeTerminalWsRestoreMessageSchema>;

export const runtimeTerminalWsServerMessageSchema = z.discriminatedUnion("type", [
	runtimeTerminalWsStateMessageSchema,
	runtimeTerminalWsErrorMessageSchema,
	runtimeTerminalWsExitMessageSchema,
	runtimeTerminalWsRestoreMessageSchema,
]);
export type RuntimeTerminalWsServerMessage = z.infer<typeof runtimeTerminalWsServerMessageSchema>;

export const runtimeGitCommitSchema = z.object({
	hash: z.string(),
	shortHash: z.string(),
	authorName: z.string(),
	authorEmail: z.string(),
	date: z.string(),
	message: z.string(),
	parentHashes: z.array(z.string()),
	relation: z.enum(["selected", "upstream", "shared"]).optional(),
});
export type RuntimeGitCommit = z.infer<typeof runtimeGitCommitSchema>;

export const runtimeGitRefSchema = z.object({
	name: z.string(),
	type: z.enum(["branch", "remote", "detached"]),
	hash: z.string(),
	isHead: z.boolean(),
	upstreamName: z.string().optional(),
	ahead: z.number().optional(),
	behind: z.number().optional(),
});
export type RuntimeGitRef = z.infer<typeof runtimeGitRefSchema>;

export const runtimeGitLogRequestSchema = z.object({
	ref: z.string().nullable().optional(),
	refs: z.array(z.string()).optional(),
	maxCount: z.number().int().positive().optional(),
	skip: z.number().int().nonnegative().optional(),
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitLogRequest = z.infer<typeof runtimeGitLogRequestSchema>;

export const runtimeGitLogResponseSchema = z.object({
	ok: z.boolean(),
	commits: z.array(runtimeGitCommitSchema),
	totalCount: z.number(),
	error: z.string().optional(),
});
export type RuntimeGitLogResponse = z.infer<typeof runtimeGitLogResponseSchema>;

export const runtimeJjGraphRequestSchema = z.object({
	maxCount: z.number().int().positive().max(200).optional(),
});
export type RuntimeJjGraphRequest = z.infer<typeof runtimeJjGraphRequestSchema>;

export const runtimeJjGraphNodeSchema = z.object({
	kind: z.literal("node"),
	graphPrefix: z.string(),
	changeId: z.string(),
	commitId: z.string(),
	parentCommitIds: z.array(z.string()),
	description: z.string(),
	bookmarks: z.array(z.string()),
	workspaces: z.array(z.string()),
	currentWorkingCopy: z.boolean(),
	empty: z.boolean(),
	conflict: z.boolean(),
});
export type RuntimeJjGraphNode = z.infer<typeof runtimeJjGraphNodeSchema>;

export const runtimeJjGraphEdgeSchema = z.object({
	kind: z.literal("edge"),
	graphPrefix: z.string(),
});
export type RuntimeJjGraphEdge = z.infer<typeof runtimeJjGraphEdgeSchema>;

export const runtimeJjGraphRowSchema = z.discriminatedUnion("kind", [
	runtimeJjGraphNodeSchema,
	runtimeJjGraphEdgeSchema,
]);
export type RuntimeJjGraphRow = z.infer<typeof runtimeJjGraphRowSchema>;

export const runtimeJjGraphResponseSchema = z.object({
	ok: z.boolean(),
	rows: z.array(runtimeJjGraphRowSchema),
	changeCount: z.number().int().nonnegative(),
	truncated: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeJjGraphResponse = z.infer<typeof runtimeJjGraphResponseSchema>;

export const runtimeGitCommitDiffFileSchema = z.object({
	path: z.string(),
	previousPath: z.string().optional(),
	status: z.enum(["modified", "added", "deleted", "renamed"]),
	additions: z.number(),
	deletions: z.number(),
	patch: z.string(),
});
export type RuntimeGitCommitDiffFile = z.infer<typeof runtimeGitCommitDiffFileSchema>;

export const runtimeGitCommitDiffRequestSchema = z.object({
	commitHash: z.string(),
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitCommitDiffRequest = z.infer<typeof runtimeGitCommitDiffRequestSchema>;

export const runtimeGitCommitDiffResponseSchema = z.object({
	ok: z.boolean(),
	commitHash: z.string(),
	files: z.array(runtimeGitCommitDiffFileSchema),
	error: z.string().optional(),
});
export type RuntimeGitCommitDiffResponse = z.infer<typeof runtimeGitCommitDiffResponseSchema>;

export const runtimeGitRefsResponseSchema = z.object({
	ok: z.boolean(),
	refs: z.array(runtimeGitRefSchema),
	error: z.string().optional(),
});
export type RuntimeGitRefsResponse = z.infer<typeof runtimeGitRefsResponseSchema>;

export const runtimeHookEventSchema = z.enum(["to_review", "to_in_progress", "activity"]);
export type RuntimeHookEvent = z.infer<typeof runtimeHookEventSchema>;

export const runtimeHookIngestRequestSchema = z.object({
	taskId: z.string(),
	workspaceId: z.string(),
	event: runtimeHookEventSchema,
	metadata: runtimeTaskHookActivitySchema.partial().optional(),
});
export type RuntimeHookIngestRequest = z.infer<typeof runtimeHookIngestRequestSchema>;

export const runtimeHookIngestResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeHookIngestResponse = z.infer<typeof runtimeHookIngestResponseSchema>;
