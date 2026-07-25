import { type FSWatcher, watch as fsWatch } from "node:fs";
import { join } from "node:path";

import type {
	RuntimeBoardData,
	RuntimeGitSyncSummary,
	RuntimeTaskWorkspaceMetadata,
	RuntimeVcsMode,
	RuntimeWorkspaceMetadata,
} from "../core/api-contract";
import { detectRepositoryKind } from "../state/workspace-state";
import { getGitSyncSummary, probeGitWorkspaceState } from "../workspace/git-sync";
import { readJjWorkspaceState } from "../workspace/jj-utils";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";

const WORKSPACE_METADATA_MIN_POLL_INTERVAL_MS = 1_000;
const WORKSPACE_METADATA_MAX_POLL_INTERVAL_MS = 10_000;
const WORKSPACE_METADATA_WATCH_DEBOUNCE_MS = 150;

interface TrackedTaskWorkspace {
	taskId: string;
	baseRef: string;
}

interface CachedHomeGitMetadata {
	summary: RuntimeGitSyncSummary | null;
	stateToken: string | null;
	stateVersion: number;
}

interface CachedTaskWorkspaceMetadata {
	data: RuntimeTaskWorkspaceMetadata;
	stateToken: string | null;
}

interface WorkspaceMetadataEntry {
	workspacePath: string;
	vcs: RuntimeVcsMode;
	trackedTasks: TrackedTaskWorkspace[];
	subscriberCount: number;
	pollTimer: NodeJS.Timeout | null;
	pollDelayMs: number;
	lastRefreshHadChanges: boolean;
	watchers: Map<string, FSWatcher>;
	watchRefreshTimer: NodeJS.Timeout | null;
	refreshPromise: Promise<RuntimeWorkspaceMetadata> | null;
	homeGit: CachedHomeGitMetadata;
	taskMetadataByTaskId: Map<string, CachedTaskWorkspaceMetadata>;
}

export interface CreateWorkspaceMetadataMonitorDependencies {
	onMetadataUpdated: (workspaceId: string, metadata: RuntimeWorkspaceMetadata) => void;
}

export interface WorkspaceMetadataMonitor {
	connectWorkspace: (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}) => Promise<RuntimeWorkspaceMetadata>;
	updateWorkspaceState: (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}) => Promise<RuntimeWorkspaceMetadata>;
	disconnectWorkspace: (workspaceId: string) => void;
	disposeWorkspace: (workspaceId: string) => void;
	close: () => void;
}

function collectTrackedTasks(board: RuntimeBoardData): TrackedTaskWorkspace[] {
	const tracked: TrackedTaskWorkspace[] = [];
	for (const column of board.columns) {
		// Backlog and trash cards do not need VCS metadata polling. Tracking only
		// active columns avoids unnecessary work, and trash paths are reconstructed
		// from task id on the web-ui side.
		if (column.id === "backlog" || column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			tracked.push({
				taskId: card.id,
				baseRef: card.baseRef,
			});
		}
	}
	return tracked;
}

function areGitSummariesEqual(a: RuntimeGitSyncSummary | null, b: RuntimeGitSyncSummary | null): boolean {
	if (a === b) {
		return true;
	}
	if (!a || !b) {
		return false;
	}
	return (
		a.currentBranch === b.currentBranch &&
		a.upstreamBranch === b.upstreamBranch &&
		a.changedFiles === b.changedFiles &&
		a.additions === b.additions &&
		a.deletions === b.deletions &&
		a.aheadCount === b.aheadCount &&
		a.behindCount === b.behindCount
	);
}

function areTaskMetadataEqual(a: RuntimeTaskWorkspaceMetadata, b: RuntimeTaskWorkspaceMetadata): boolean {
	return (
		a.taskId === b.taskId &&
		a.path === b.path &&
		a.exists === b.exists &&
		a.baseRef === b.baseRef &&
		a.branch === b.branch &&
		a.isDetached === b.isDetached &&
		a.headCommit === b.headCommit &&
		a.changedFiles === b.changedFiles &&
		a.additions === b.additions &&
		a.deletions === b.deletions &&
		a.stateVersion === b.stateVersion
	);
}

function areWorkspaceMetadataEqual(a: RuntimeWorkspaceMetadata, b: RuntimeWorkspaceMetadata): boolean {
	if (!areGitSummariesEqual(a.homeGitSummary, b.homeGitSummary)) {
		return false;
	}
	if (a.homeGitStateVersion !== b.homeGitStateVersion) {
		return false;
	}
	if (a.taskWorkspaces.length !== b.taskWorkspaces.length) {
		return false;
	}
	for (let index = 0; index < a.taskWorkspaces.length; index += 1) {
		const left = a.taskWorkspaces[index];
		const right = b.taskWorkspaces[index];
		if (!left || !right || !areTaskMetadataEqual(left, right)) {
			return false;
		}
	}
	return true;
}

function createEmptyWorkspaceMetadata(): RuntimeWorkspaceMetadata {
	return {
		homeGitSummary: null,
		homeGitStateVersion: 0,
		taskWorkspaces: [],
	};
}

function createWorkspaceEntry(workspacePath: string): WorkspaceMetadataEntry {
	return {
		workspacePath,
		vcs: detectRepositoryKind(workspacePath) ?? "git",
		trackedTasks: [],
		subscriberCount: 0,
		pollTimer: null,
		pollDelayMs: WORKSPACE_METADATA_MIN_POLL_INTERVAL_MS,
		lastRefreshHadChanges: false,
		watchers: new Map<string, FSWatcher>(),
		watchRefreshTimer: null,
		refreshPromise: null,
		homeGit: {
			summary: null,
			stateToken: null,
			stateVersion: 0,
		},
		taskMetadataByTaskId: new Map<string, CachedTaskWorkspaceMetadata>(),
	};
}

function buildWorkspaceMetadataSnapshot(entry: WorkspaceMetadataEntry): RuntimeWorkspaceMetadata {
	return {
		homeGitSummary: entry.homeGit.summary,
		homeGitStateVersion: entry.homeGit.stateVersion,
		taskWorkspaces: entry.trackedTasks
			.map((task) => entry.taskMetadataByTaskId.get(task.taskId)?.data ?? null)
			.filter((task): task is RuntimeTaskWorkspaceMetadata => task !== null),
	};
}

async function loadHomeGitMetadata(entry: WorkspaceMetadataEntry): Promise<CachedHomeGitMetadata> {
	try {
		const probe = await probeGitWorkspaceState(entry.workspacePath);
		if (entry.homeGit.stateToken === probe.stateToken) {
			return entry.homeGit;
		}
		const summary = await getGitSyncSummary(entry.workspacePath, { probe });
		return {
			summary,
			stateToken: probe.stateToken,
			stateVersion: Date.now(),
		};
	} catch {
		return entry.homeGit;
	}
}

async function loadTaskWorkspaceMetadata(
	workspacePath: string,
	task: TrackedTaskWorkspace,
	current: CachedTaskWorkspaceMetadata | null,
	vcs: RuntimeVcsMode,
): Promise<CachedTaskWorkspaceMetadata | null> {
	const pathInfo = await getTaskWorkspacePathInfo({
		cwd: workspacePath,
		taskId: task.taskId,
		baseRef: task.baseRef,
	});

	if (!pathInfo.exists) {
		if (
			current &&
			current.data.exists === false &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef
		) {
			return current;
		}
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: false,
				baseRef: pathInfo.baseRef,
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
				stateVersion: Date.now(),
			},
			stateToken: null,
		};
	}

	try {
		if (vcs === "jj") {
			const state = await readJjWorkspaceState(pathInfo.path);
			if (
				current &&
				current.stateToken === state.stateToken &&
				current.data.path === pathInfo.path &&
				current.data.baseRef === pathInfo.baseRef
			) {
				return current;
			}
			return {
				data: {
					taskId: task.taskId,
					path: pathInfo.path,
					exists: true,
					baseRef: pathInfo.baseRef,
					branch: null,
					isDetached: false,
					headCommit: state.commitId,
					changedFiles: state.changedFiles,
					additions: state.additions,
					deletions: state.deletions,
					stateVersion: Date.now(),
				},
				stateToken: state.stateToken,
			};
		}

		const probe = await probeGitWorkspaceState(pathInfo.path);
		if (
			current &&
			current.stateToken === probe.stateToken &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef
		) {
			return current;
		}
		const summary = await getGitSyncSummary(pathInfo.path, { probe });
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: true,
				baseRef: pathInfo.baseRef,
				branch: probe.currentBranch,
				isDetached: probe.headCommit !== null && probe.currentBranch === null,
				headCommit: probe.headCommit,
				changedFiles: summary.changedFiles,
				additions: summary.additions,
				deletions: summary.deletions,
				stateVersion: Date.now(),
			},
			stateToken: probe.stateToken,
		};
	} catch {
		if (current) {
			return current;
		}
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: true,
				baseRef: pathInfo.baseRef,
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
				stateVersion: Date.now(),
			},
			stateToken: null,
		};
	}
}

export function createWorkspaceMetadataMonitor(
	deps: CreateWorkspaceMetadataMonitorDependencies,
): WorkspaceMetadataMonitor {
	const workspaces = new Map<string, WorkspaceMetadataEntry>();

	const stopWorkspaceTimer = (entry: WorkspaceMetadataEntry) => {
		if (!entry.pollTimer) {
			return;
		}
		clearTimeout(entry.pollTimer);
		entry.pollTimer = null;
	};

	const stopWorkspaceWatchers = (entry: WorkspaceMetadataEntry) => {
		if (entry.watchRefreshTimer) {
			clearTimeout(entry.watchRefreshTimer);
			entry.watchRefreshTimer = null;
		}
		for (const watcher of entry.watchers.values()) {
			watcher.close();
		}
		entry.watchers.clear();
	};

	const refreshWorkspace = async (workspaceId: string): Promise<RuntimeWorkspaceMetadata> => {
		const entry = workspaces.get(workspaceId);
		if (!entry) {
			return createEmptyWorkspaceMetadata();
		}
		if (entry.refreshPromise) {
			return await entry.refreshPromise;
		}

		entry.refreshPromise = (async () => {
			const previousSnapshot = buildWorkspaceMetadataSnapshot(entry);
			if (entry.vcs === "git") {
				entry.homeGit = await loadHomeGitMetadata(entry);
			}

			const nextTaskEntries = await Promise.all(
				entry.trackedTasks.map(async (task) => {
					const current = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
					const next = await loadTaskWorkspaceMetadata(entry.workspacePath, task, current, entry.vcs);
					return next ? [task.taskId, next] : null;
				}),
			);

			entry.taskMetadataByTaskId = new Map(
				nextTaskEntries.filter(
					(candidate): candidate is [string, CachedTaskWorkspaceMetadata] => candidate !== null,
				),
			);

			const nextSnapshot = buildWorkspaceMetadataSnapshot(entry);
			entry.lastRefreshHadChanges = !areWorkspaceMetadataEqual(previousSnapshot, nextSnapshot);
			if (entry.lastRefreshHadChanges) {
				deps.onMetadataUpdated(workspaceId, nextSnapshot);
			}
			if (entry.subscriberCount > 0) {
				syncWatchers(workspaceId, entry);
			}
			return nextSnapshot;
		})().finally(() => {
			const current = workspaces.get(workspaceId);
			if (current) {
				current.refreshPromise = null;
			}
		});

		return await entry.refreshPromise;
	};

	const scheduleNextPoll = (workspaceId: string, entry: WorkspaceMetadataEntry) => {
		stopWorkspaceTimer(entry);
		const timer = setTimeout(() => {
			entry.pollTimer = null;
			void runPollCycle(workspaceId);
		}, entry.pollDelayMs);
		timer.unref();
		entry.pollTimer = timer;
	};

	const runPollCycle = async (workspaceId: string): Promise<void> => {
		const entry = workspaces.get(workspaceId);
		if (!entry || entry.subscriberCount === 0) {
			return;
		}
		await refreshWorkspace(workspaceId);
		const current = workspaces.get(workspaceId);
		if (!current || current.subscriberCount === 0) {
			return;
		}
		// Adaptive backoff: keep the 1s cadence while changes are being detected,
		// and back off exponentially (up to a cap) while the workspace is idle so
		// we do not spawn a git/jj subprocess every second for nothing.
		current.pollDelayMs = current.lastRefreshHadChanges
			? WORKSPACE_METADATA_MIN_POLL_INTERVAL_MS
			: Math.min(current.pollDelayMs * 2, WORKSPACE_METADATA_MAX_POLL_INTERVAL_MS);
		scheduleNextPoll(workspaceId, current);
	};

	const handleWatchEvent = (workspaceId: string) => {
		const entry = workspaces.get(workspaceId);
		if (!entry || entry.subscriberCount === 0 || entry.watchRefreshTimer) {
			return;
		}
		const timer = setTimeout(() => {
			entry.watchRefreshTimer = null;
			const current = workspaces.get(workspaceId);
			if (!current || current.subscriberCount === 0) {
				return;
			}
			// VCS activity observed: return to the fast cadence so follow-up
			// changes (including ones the watcher cannot see, like unstaged
			// working-tree edits) are detected within ~1s.
			current.pollDelayMs = WORKSPACE_METADATA_MIN_POLL_INTERVAL_MS;
			stopWorkspaceTimer(current);
			void runPollCycle(workspaceId);
		}, WORKSPACE_METADATA_WATCH_DEBOUNCE_MS);
		timer.unref();
		entry.watchRefreshTimer = timer;
	};

	function syncWatchers(workspaceId: string, entry: WorkspaceMetadataEntry): void {
		if (entry.subscriberCount === 0) {
			return;
		}
		const vcsDirName = entry.vcs === "jj" ? ".jj" : ".git";
		const desiredPaths = new Set<string>();
		desiredPaths.add(join(entry.workspacePath, vcsDirName));
		for (const cached of entry.taskMetadataByTaskId.values()) {
			if (cached.data.exists) {
				desiredPaths.add(join(cached.data.path, vcsDirName));
			}
		}
		for (const [watchedPath, watcher] of entry.watchers) {
			if (!desiredPaths.has(watchedPath)) {
				watcher.close();
				entry.watchers.delete(watchedPath);
			}
		}
		for (const watchedPath of desiredPaths) {
			if (entry.watchers.has(watchedPath)) {
				continue;
			}
			try {
				// Best effort: non-recursive watch of the VCS dir catches commits,
				// checkouts and staging. Anything it misses (e.g. unstaged edits) is
				// still covered by the backoff polling above.
				const watcher = fsWatch(watchedPath, { persistent: false }, () => {
					handleWatchEvent(workspaceId);
				});
				watcher.on("error", () => {
					watcher.close();
					entry.watchers.delete(watchedPath);
				});
				entry.watchers.set(watchedPath, watcher);
			} catch {
				// The VCS dir does not exist (yet) or cannot be watched; polling covers it.
			}
		}
	}

	const updateWorkspaceEntry = (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}): WorkspaceMetadataEntry => {
		const existing = workspaces.get(input.workspaceId) ?? createWorkspaceEntry(input.workspacePath);
		existing.workspacePath = input.workspacePath;
		existing.vcs = detectRepositoryKind(input.workspacePath) ?? existing.vcs;
		existing.trackedTasks = collectTrackedTasks(input.board);
		workspaces.set(input.workspaceId, existing);
		return existing;
	};

	return {
		connectWorkspace: async ({ workspaceId, workspacePath, board }) => {
			const entry = updateWorkspaceEntry({ workspaceId, workspacePath, board });
			entry.subscriberCount += 1;
			entry.pollDelayMs = WORKSPACE_METADATA_MIN_POLL_INTERVAL_MS;
			syncWatchers(workspaceId, entry);
			const snapshot = await refreshWorkspace(workspaceId);
			const current = workspaces.get(workspaceId);
			if (current && current.subscriberCount > 0) {
				scheduleNextPoll(workspaceId, current);
			}
			return snapshot;
		},
		updateWorkspaceState: async ({ workspaceId, workspacePath, board }) => {
			const entry = updateWorkspaceEntry({ workspaceId, workspacePath, board });
			if (entry.subscriberCount === 0) {
				return buildWorkspaceMetadataSnapshot(entry);
			}
			return await refreshWorkspace(workspaceId);
		},
		disconnectWorkspace: (workspaceId) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) {
				return;
			}
			entry.subscriberCount = Math.max(0, entry.subscriberCount - 1);
			if (entry.subscriberCount > 0) {
				return;
			}
			stopWorkspaceTimer(entry);
			stopWorkspaceWatchers(entry);
			workspaces.delete(workspaceId);
		},
		disposeWorkspace: (workspaceId) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) {
				return;
			}
			stopWorkspaceTimer(entry);
			stopWorkspaceWatchers(entry);
			workspaces.delete(workspaceId);
		},
		close: () => {
			for (const entry of workspaces.values()) {
				stopWorkspaceTimer(entry);
				stopWorkspaceWatchers(entry);
			}
			workspaces.clear();
		},
	};
}
