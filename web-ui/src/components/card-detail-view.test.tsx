import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CardDetailView } from "@/components/card-detail-view";
import type { RuntimeTaskExecutionProjection } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import type { BoardCard, BoardColumn, CardSelection } from "@/types";

const mockUseRuntimeWorkspaceChanges = vi.fn();
const { mockAgentTerminalPanel, mockDiffViewerPanel } = vi.hoisted(() => ({
	mockAgentTerminalPanel: vi.fn((_props: { panelBackgroundColor?: string; terminalBackgroundColor?: string }) => null),
	mockDiffViewerPanel: vi.fn((..._args: unknown[]) => null),
}));

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: () => {},
}));

vi.mock("@/hooks/use-is-mobile", () => ({
	useIsMobile: () => false,
}));

vi.mock("@/components/detail-panels/agent-terminal-panel", () => ({
	AgentTerminalPanel: mockAgentTerminalPanel,
}));

vi.mock("@/components/detail-panels/column-context-panel", () => ({
	ColumnContextPanel: () => <div data-testid="column-context-panel" />,
}));

vi.mock("@/components/detail-panels/diff-viewer-panel", () => ({
	DiffViewerPanel: (props: unknown) => {
		mockDiffViewerPanel(props);
		return <div data-testid="diff-viewer-panel" />;
	},
}));

vi.mock("@/components/detail-panels/file-tree-panel", () => ({
	FileTreePanel: () => <div data-testid="file-tree-panel" />,
}));

vi.mock("@/resize/resizable-bottom-pane", () => ({
	ResizableBottomPane: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/runtime/use-runtime-workspace-changes", () => ({
	useRuntimeWorkspaceChanges: (...args: unknown[]) => mockUseRuntimeWorkspaceChanges(...args),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceStateVersionValue: () => 0,
	useTaskWorkspaceSnapshotValue: () => null,
}));

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutResetEffect: () => {},
}));

function createCard(id: string): BoardCard {
	return {
		id,
		title: `Task ${id}`,
		prompt: `Task ${id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createSelection(): CardSelection {
	const card = createCard("task-1");
	const columns: BoardColumn[] = [
		{
			id: "backlog",
			title: "Backlog",
			cards: [card],
		},
		{
			id: "in_progress",
			title: "In Progress",
			cards: [],
		},
		{
			id: "review",
			title: "Review",
			cards: [],
		},
		{
			id: "trash",
			title: "Done",
			cards: [],
		},
	];
	return {
		card,
		column: columns[0]!,
		allColumns: columns,
	};
}

function createReviewSelection(withSubmission = true): CardSelection {
	const selection = createSelection();
	selection.column.cards = [];
	selection.column = selection.allColumns.find((column) => column.id === "review")!;
	selection.column.cards = [selection.card];
	selection.card.deliverableKind = "read_only_report";
	selection.card.origin = { kind: "amp_architect", threadId: "T-architect-1" };
	selection.card.execution = { attemptId: "attempt-1", generation: 1, queuedAt: 2 };
	if (withSubmission) {
		selection.card.submission = {
			taskId: selection.card.id,
			generation: 1,
			executionAttemptId: "attempt-1",
			deliverableKind: "read_only_report",
			reportMarkdown: "# Audit result\n\nNo changes were required.",
			reportDigest: "a".repeat(64),
			submittedAt: 1_700_000_000_000,
			workspace: {
				taskId: selection.card.id,
				path: "/tmp/task-1",
				vcs: "jj",
				baseRef: "main",
			},
			receipt: {
				vcs: "jj",
				clean: true,
				changeId: "change-id",
				commitId: "1".repeat(40),
				parentCommitIds: ["2".repeat(40)],
				baseCommit: "2".repeat(40),
				hasConflicts: false,
				divergent: false,
				stateDigest: "b".repeat(64),
			},
		};
	}
	return selection;
}

function createChangeReviewSelection(): CardSelection {
	const selection = createSelection();
	selection.column.cards = [];
	selection.column = selection.allColumns.find((column) => column.id === "review")!;
	selection.column.cards = [selection.card];
	selection.card.deliverableKind = "change";
	return selection;
}

type MockedDiffViewerProps = {
	onAddToTerminal?: (formatted: string) => void;
	onSendToTerminal?: (formatted: string) => void;
};

function getLastMockFirstArg<T>(mockFn: { mock: { calls: unknown[][] } }): T {
	const lastCall = mockFn.mock.calls.at(-1);
	expect(lastCall).toBeDefined();
	return lastCall?.[0] as T;
}

function requireResizeSeparator(container: HTMLElement): HTMLElement {
	const separator = container.querySelector('[aria-label="Resize agent and diff panels"]');
	if (!(separator instanceof HTMLElement)) {
		throw new Error("Expected a resize separator.");
	}
	return separator;
}

function requireAgentPanel(container: HTMLElement): HTMLElement {
	const separator = requireResizeSeparator(container);
	const panel = separator.previousElementSibling;
	if (!(panel instanceof HTMLElement)) {
		throw new Error("Expected an agent panel element.");
	}
	return panel;
}

function requireDetailDiffSeparator(container: HTMLElement): HTMLElement {
	const separator = container.querySelector('[aria-label="Resize detail diff panels"]');
	if (!(separator instanceof HTMLElement)) {
		throw new Error("Expected a detail diff resize separator.");
	}
	return separator;
}

function requireDetailDiffFileTreePanel(container: HTMLElement): HTMLElement {
	const separator = requireDetailDiffSeparator(container);
	const panel = separator.nextElementSibling;
	if (!(panel instanceof HTMLElement)) {
		throw new Error("Expected a detail diff file tree panel element.");
	}
	return panel;
}

describe("CardDetailView", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		window.localStorage.clear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockAgentTerminalPanel.mockClear();
		mockDiffViewerPanel.mockClear();
		mockUseRuntimeWorkspaceChanges.mockReturnValue({
			changes: {
				files: [
					{
						path: "src/example.ts",
						status: "modified",
						additions: 1,
						deletions: 0,
						oldText: "before\n",
						newText: "after\n",
					},
				],
			},
			isRuntimeAvailable: true,
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		mockUseRuntimeWorkspaceChanges.mockReset();
		mockAgentTerminalPanel.mockClear();
		mockDiffViewerPanel.mockClear();
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("collapses the expanded diff on Escape without closing the detail view", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const expandButton = container.querySelector('button[aria-label="Expand split diff view"]');
		expect(expandButton).toBeInstanceOf(HTMLButtonElement);
		if (!(expandButton instanceof HTMLButtonElement)) {
			throw new Error("Expected an expand diff button.");
		}

		await act(async () => {
			expandButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			expandButton.click();
		});

		const toolbarButtons = Array.from(container.querySelectorAll("button"));
		expect(toolbarButtons[0]?.getAttribute("aria-label")).toBe("Collapse expanded diff view");
		expect(toolbarButtons[1]?.textContent?.trim()).toBe("All Changes");
		expect(toolbarButtons[2]?.textContent?.trim()).toBe("Last Turn");
		expect(container.querySelector('button[aria-label="Expand split diff view"]')).toBeNull();

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(container.querySelector('button[aria-label="Collapse expanded diff view"]')).toBeNull();
		expect(container.querySelector('button[aria-label="Expand split diff view"]')).toBeInstanceOf(HTMLButtonElement);
	});

	it("clears stale diff content when switching from all changes to last turn", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const lastTurnButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Last Turn",
		);
		expect(lastTurnButton).toBeInstanceOf(HTMLButtonElement);
		if (!(lastTurnButton instanceof HTMLButtonElement)) {
			throw new Error("Expected a Last Turn button.");
		}

		await act(async () => {
			lastTurnButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			lastTurnButton.click();
		});

		const lastCall = mockUseRuntimeWorkspaceChanges.mock.calls.at(-1);
		expect(lastCall?.[3]).toBe("last_turn");
		expect(lastCall?.[7]).toBe(true);
	});

	it("keeps the active diff mode visually highlighted", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const getDiffModeButton = (label: string): HTMLButtonElement => {
			const button = Array.from(container.querySelectorAll("button")).find(
				(candidate) => candidate.textContent?.trim() === label,
			);
			if (!(button instanceof HTMLButtonElement)) {
				throw new Error(`Expected a ${label} button.`);
			}
			return button;
		};

		const allChangesButton = getDiffModeButton("All Changes");
		const lastTurnButton = getDiffModeButton("Last Turn");

		expect(allChangesButton.getAttribute("aria-pressed")).toBe("true");
		expect(allChangesButton.getAttribute("style")).toContain(
			"background-color: color-mix(in srgb, var(--color-surface-3) 80%, var(--color-text-primary))",
		);
		expect(lastTurnButton.getAttribute("aria-pressed")).toBe("false");
		expect(lastTurnButton.style.backgroundColor).toBe("");

		await act(async () => {
			lastTurnButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			lastTurnButton.click();
		});

		expect(getDiffModeButton("All Changes").getAttribute("aria-pressed")).toBe("false");
		expect(getDiffModeButton("All Changes").style.backgroundColor).toBe("");
		expect(getDiffModeButton("Last Turn").getAttribute("aria-pressed")).toBe("true");
		expect(getDiffModeButton("Last Turn").getAttribute("style")).toContain(
			"background-color: color-mix(in srgb, var(--color-surface-3) 80%, var(--color-text-primary))",
		);
	});

	it("closes git history before handling other Escape behavior", async () => {
		const onCloseGitHistory = vi.fn();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					gitHistoryPanel={<div data-testid="git-history-panel">Git history</div>}
					onCloseGitHistory={onCloseGitHistory}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const input = document.createElement("input");
		container.appendChild(input);
		input.focus();

		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(onCloseGitHistory).toHaveBeenCalledTimes(1);
	});

	it("uses surface-primary colors for the detail terminal panel", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const lastCall = mockAgentTerminalPanel.mock.calls.at(-1);
		expect(lastCall?.[0]).toMatchObject({
			panelBackgroundColor: "var(--color-surface-0)",
			terminalBackgroundColor: TERMINAL_THEME_COLORS.surfacePrimary,
		});
	});

	it("routes Add diff comments to the review comments handler", async () => {
		const onAddReviewComments = vi.fn();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					onAddReviewComments={onAddReviewComments}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const diffProps = getLastMockFirstArg<MockedDiffViewerProps>(mockDiffViewerPanel);
		expect(diffProps.onAddToTerminal).toBeTypeOf("function");

		await act(async () => {
			diffProps.onAddToTerminal?.("src/example.ts:4 | value\n> Add tests");
		});

		expect(onAddReviewComments).toHaveBeenCalledWith("task-1", "src/example.ts:4 | value\n> Add tests");
	});

	it("routes Send diff comments to the send review comments handler", async () => {
		const onSendReviewComments = vi.fn();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					onSendReviewComments={onSendReviewComments}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const diffProps = getLastMockFirstArg<MockedDiffViewerProps>(mockDiffViewerPanel);
		expect(diffProps.onSendToTerminal).toBeTypeOf("function");

		await act(async () => {
			diffProps.onSendToTerminal?.("src/example.ts:8 | done\n> Ship this");
			await Promise.resolve();
		});

		expect(onSendReviewComments).toHaveBeenCalledWith("task-1", "src/example.ts:8 | done\n> Ship this");
	});

	it("loads the saved agent-to-diff panel ratio from local storage", async () => {
		window.localStorage.setItem(LocalStorageKey.DetailAgentPanelRatio, "0.62");

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(requireAgentPanel(container).style.width).toBe("62%");
	});

	it("persists the resized agent-to-diff panel ratio globally", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const separator = requireResizeSeparator(container);
		const dragHandle = separator.firstElementChild;
		expect(dragHandle).toBeInstanceOf(HTMLDivElement);
		if (!(dragHandle instanceof HTMLDivElement)) {
			throw new Error("Expected a draggable resize handle.");
		}

		await act(async () => {
			dragHandle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 160 }));
		});
		await act(async () => {
			window.dispatchEvent(new MouseEvent("mousemove", { clientX: 320 }));
			window.dispatchEvent(new MouseEvent("mouseup", { clientX: 320 }));
		});

		const savedRatioRaw = window.localStorage.getItem(LocalStorageKey.DetailAgentPanelRatio);
		expect(savedRatioRaw).not.toBeNull();
		const savedRatio = Number(savedRatioRaw);
		expect(savedRatio).toBeGreaterThan(0.4);
		expect(savedRatio).toBeLessThanOrEqual(0.75);
		expect(requireAgentPanel(container).style.width).not.toBe("40%");
	});

	it("keeps the saved divider position after leaving and reopening task detail", async () => {
		const renderDetail = async (): Promise<void> => {
			await act(async () => {
				root.render(
					<CardDetailView
						selection={createSelection()}
						currentProjectId="workspace-1"
						sessionSummary={null}
						taskSessions={{}}
						onSessionSummary={() => {}}
						onCardSelect={() => {}}
						onTaskDragEnd={() => {}}
						onMoveToTrash={() => {}}
						bottomTerminalOpen={false}
						bottomTerminalTaskId={null}
						bottomTerminalSummary={null}
						onBottomTerminalClose={() => {}}
					/>,
				);
			});
		};

		await renderDetail();

		const separator = requireResizeSeparator(container);
		const dragHandle = separator.firstElementChild;
		expect(dragHandle).toBeInstanceOf(HTMLDivElement);
		if (!(dragHandle instanceof HTMLDivElement)) {
			throw new Error("Expected a draggable resize handle.");
		}

		await act(async () => {
			dragHandle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 200 }));
			window.dispatchEvent(new MouseEvent("mouseup", { clientX: 420 }));
		});

		const expectedRatio = window.localStorage.getItem(LocalStorageKey.DetailAgentPanelRatio);
		expect(expectedRatio).not.toBeNull();

		await act(async () => {
			root.unmount();
			root = createRoot(container);
		});

		await renderDetail();

		const restoredWidth = requireAgentPanel(container).style.width;
		const restoredRatio = Number.parseFloat(restoredWidth) / 100;
		expect(restoredRatio).toBeCloseTo(Number(expectedRatio), 2);
	});

	it("uses separate file-tree ratios for collapsed and expanded diff layouts", async () => {
		window.localStorage.setItem(LocalStorageKey.DetailDiffFileTreePanelRatio, "0.42");
		window.localStorage.setItem(LocalStorageKey.DetailExpandedDiffFileTreePanelRatio, "0.18");

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(requireDetailDiffFileTreePanel(container).style.flex).toBe("0 0 42%");

		const expandButton = container.querySelector('button[aria-label="Expand split diff view"]');
		expect(expandButton).toBeInstanceOf(HTMLButtonElement);
		if (!(expandButton instanceof HTMLButtonElement)) {
			throw new Error("Expected an expand diff button.");
		}

		await act(async () => {
			expandButton.click();
		});

		expect(requireDetailDiffFileTreePanel(container).style.flex).toBe("0 0 18%");
	});

	it("shows the Amp Architect reference and a supported continuation command", async () => {
		const selection = createSelection();
		selection.card.origin = {
			kind: "amp_architect",
			threadId: "T-019fb3aa-000b-752a-a88e-337592dae657",
		};

		await act(async () => {
			root.render(
				<CardDetailView
					selection={selection}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.textContent).toContain("Origin · Amp Architect");
		expect(container.textContent).toContain("amp threads continue T-019fb3aa-000b-752a-a88e-337592dae657");
		expect(container.querySelector('button[title^="amp threads continue T-"]')).toBeInstanceOf(HTMLButtonElement);
	});

	it("renders a durable report as the primary Review content even when execution is unknown", async () => {
		const unknownExecution: RuntimeTaskExecutionProjection = {
			attemptId: "attempt-1",
			generation: 1,
			queuedAt: 2,
			status: "unknown",
			runId: null,
			currentAttempt: null,
			maxAttempts: null,
			createdAt: null,
			updatedAt: null,
		};
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createReviewSelection()}
					currentProjectId="workspace-1"
					workspaceVcs="jj"
					sessionSummary={{
						taskId: "task-1",
						state: "idle",
						agentId: "codex",
						workspacePath: "/tmp/task-1",
						pid: null,
						startedAt: 1,
						updatedAt: 2,
						lastOutputAt: 2,
						reviewReason: "exit",
						exitCode: 0,
						lastHookAt: null,
						latestHookActivity: null,
					}}
					executionProjection={unknownExecution}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.textContent).toContain("Audit result");
		expect(container.textContent).toContain("Ready for review");
		expect(container.textContent).toContain("No-change receipt verified");
		expect(container.textContent).toContain("Acceptance unavailable — remains in Review");
		expect(container.textContent).not.toContain("Accept read-only report");
		expect(container.textContent).not.toContain("unknown");
		expect(mockAgentTerminalPanel).not.toHaveBeenCalled();
		expect(document.body.textContent).not.toContain("Accept read-only report?");
	}, 20_000);

	it("keeps a change task without a durable submission ready for normal Review", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createChangeReviewSelection()}
					currentProjectId="workspace-1"
					workspaceVcs="jj"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.textContent).toContain("Ready for review");
		expect(container.textContent).toContain("Remote proof required");
		expect(container.textContent).toContain("Change ready for review");
		expect(container.textContent).toContain("Inspect the workspace changes and verify the remote revision");
		expect(container.textContent).not.toContain("Submission required");
		expect(container.textContent).not.toContain("Durable submission missing — resubmit required");
		expect(container.textContent).not.toContain("Accept read-only report");
		expect(mockAgentTerminalPanel).not.toHaveBeenCalled();
		expect(mockDiffViewerPanel).toHaveBeenCalled();
	});

	it("fails closed for an explicit read-only Review card without a durable submission", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createReviewSelection(false)}
					currentProjectId="workspace-1"
					workspaceVcs="git"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.textContent).toContain("Durable submission missing — resubmit required");
		expect(container.textContent).toContain("Submission required");
		expect(mockAgentTerminalPanel).not.toHaveBeenCalled();
	});

	it("shows JJ changes and the verified no-change empty state without disabling the panel", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createReviewSelection()}
					currentProjectId="workspace-1"
					workspaceVcs="jj"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});
		expect(container.textContent).not.toContain("Git diff is unavailable");
		const lastTurnButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Last Turn",
		);
		expect(lastTurnButton?.disabled).toBe(true);

		mockUseRuntimeWorkspaceChanges.mockReturnValue({
			changes: { vcs: "jj", files: [], stateKey: "c".repeat(64), conflicts: [], error: null },
			isRuntimeAvailable: true,
		});
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createReviewSelection()}
					currentProjectId="workspace-1"
					workspaceVcs="jj"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});
		expect(container.textContent).toContain("Verified no-change submission");
	}, 20_000);
});
