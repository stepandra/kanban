import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfigResponse, RuntimeTaskTemplate } from "@/runtime/types";
import { type UseTaskTemplatesResult, useTaskTemplates } from "@/runtime/use-task-templates";

const { fetchRuntimeConfigMock, saveRuntimeConfigMock } = vi.hoisted(() => ({
	fetchRuntimeConfigMock: vi.fn(),
	saveRuntimeConfigMock: vi.fn(),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchRuntimeConfig: fetchRuntimeConfigMock,
	saveRuntimeConfig: saveRuntimeConfigMock,
}));

function createRuntimeConfigResponse(taskTemplates: RuntimeConfigResponse["taskTemplates"]): RuntimeConfigResponse {
	return {
		selectedAgentId: "codex",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		effectiveCommand: "codex",
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project/.cline/kanban/config.json",
		readyForReviewNotificationsEnabled: true,
		detectedCommands: ["codex"],
		agents: [],
		shortcuts: [],
		taskTemplates,
	};
}

type HookSnapshot = UseTaskTemplatesResult;

function HookHarness({
	workspaceId,
	onSnapshot,
}: {
	workspaceId: string | null;
	onSnapshot: (snapshot: HookSnapshot) => void;
}): null {
	const snapshot = useTaskTemplates(workspaceId, true);

	useEffect(() => {
		onSnapshot(snapshot);
	}, [onSnapshot, snapshot]);

	return null;
}

describe("useTaskTemplates", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let snapshots: HookSnapshot[];

	const latestSnapshot = (): HookSnapshot => {
		const snapshot = snapshots.at(-1);
		if (!snapshot) {
			throw new Error("Expected a task templates snapshot.");
		}
		return snapshot;
	};

	const renderHarness = async (workspaceId: string | null): Promise<void> => {
		await act(async () => {
			root.render(
				<HookHarness
					workspaceId={workspaceId}
					onSnapshot={(snapshot) => {
						snapshots = [...snapshots, snapshot];
					}}
				/>,
			);
			await Promise.resolve();
		});
	};

	beforeEach(() => {
		fetchRuntimeConfigMock.mockReset();
		saveRuntimeConfigMock.mockReset();
		snapshots = [];
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("loads templates from the runtime config", async () => {
		fetchRuntimeConfigMock.mockResolvedValue(
			createRuntimeConfigResponse([{ id: "tpl-1", name: "Bug fix", prompt: "Fix it" }]),
		);
		await renderHarness("project-a");

		expect(fetchRuntimeConfigMock).toHaveBeenCalledWith("project-a");
		expect(latestSnapshot().templates).toEqual([{ id: "tpl-1", name: "Bug fix", prompt: "Fix it" }]);
		expect(latestSnapshot().isLoading).toBe(false);
	});

	it("saves a new template and persists the updated list", async () => {
		const initialConfig = createRuntimeConfigResponse([{ id: "tpl-1", name: "Bug fix", prompt: "Fix it" }]);
		fetchRuntimeConfigMock.mockResolvedValue(initialConfig);
		saveRuntimeConfigMock.mockImplementation(async (_workspaceId, input: { taskTemplates?: unknown[] }) =>
			createRuntimeConfigResponse((input.taskTemplates ?? []) as RuntimeConfigResponse["taskTemplates"]),
		);
		await renderHarness("project-a");

		const result: { saved: RuntimeTaskTemplate | null } = { saved: null };
		await act(async () => {
			result.saved = await latestSnapshot().saveTemplate({
				name: "Docs",
				prompt: "Write docs",
				baseRef: "main",
			});
		});
		const saved = result.saved;

		expect(saved).not.toBeNull();
		expect(saved?.name).toBe("Docs");
		expect(saved?.id).toBeTruthy();
		expect(saveRuntimeConfigMock).toHaveBeenCalledWith("project-a", {
			taskTemplates: [
				{ id: "tpl-1", name: "Bug fix", prompt: "Fix it" },
				{
					id: saved?.id,
					name: "Docs",
					prompt: "Write docs",
					baseRef: "main",
				},
			],
		});
		expect(latestSnapshot().templates).toHaveLength(2);
	});

	it("replaces an existing template when saving under the same name", async () => {
		fetchRuntimeConfigMock.mockResolvedValue(
			createRuntimeConfigResponse([{ id: "tpl-1", name: "Bug fix", prompt: "Old prompt" }]),
		);
		saveRuntimeConfigMock.mockImplementation(async (_workspaceId, input: { taskTemplates?: unknown[] }) =>
			createRuntimeConfigResponse((input.taskTemplates ?? []) as RuntimeConfigResponse["taskTemplates"]),
		);
		await renderHarness(null);

		await act(async () => {
			await latestSnapshot().saveTemplate({ name: "Bug fix", prompt: "New prompt" });
		});

		const persisted = saveRuntimeConfigMock.mock.calls.at(-1)?.[1] as {
			taskTemplates: Array<{ id: string; name: string; prompt: string }>;
		};
		expect(persisted.taskTemplates).toHaveLength(1);
		expect(persisted.taskTemplates[0]?.name).toBe("Bug fix");
		expect(persisted.taskTemplates[0]?.prompt).toBe("New prompt");
	});

	it("rejects saving a template without a name or prompt", async () => {
		fetchRuntimeConfigMock.mockResolvedValue(createRuntimeConfigResponse([]));
		await renderHarness(null);

		let result: Awaited<ReturnType<HookSnapshot["saveTemplate"]>> = null;
		await act(async () => {
			result = await latestSnapshot().saveTemplate({ name: "  ", prompt: "Something" });
		});
		expect(result).toBeNull();
		await act(async () => {
			result = await latestSnapshot().saveTemplate({ name: "Name", prompt: "   " });
		});
		expect(result).toBeNull();
		expect(saveRuntimeConfigMock).not.toHaveBeenCalled();
	});

	it("deletes a template and persists the remaining list", async () => {
		fetchRuntimeConfigMock.mockResolvedValue(
			createRuntimeConfigResponse([
				{ id: "tpl-1", name: "Bug fix", prompt: "Fix it" },
				{ id: "tpl-2", name: "Docs", prompt: "Write docs" },
			]),
		);
		saveRuntimeConfigMock.mockImplementation(async (_workspaceId, input: { taskTemplates?: unknown[] }) =>
			createRuntimeConfigResponse((input.taskTemplates ?? []) as RuntimeConfigResponse["taskTemplates"]),
		);
		await renderHarness("project-a");

		let deleted = false;
		await act(async () => {
			deleted = await latestSnapshot().deleteTemplate("tpl-1");
		});

		expect(deleted).toBe(true);
		expect(saveRuntimeConfigMock).toHaveBeenCalledWith("project-a", {
			taskTemplates: [{ id: "tpl-2", name: "Docs", prompt: "Write docs" }],
		});
		expect(latestSnapshot().templates).toEqual([{ id: "tpl-2", name: "Docs", prompt: "Write docs" }]);
	});

	it("does not persist when deleting an unknown template", async () => {
		fetchRuntimeConfigMock.mockResolvedValue(
			createRuntimeConfigResponse([{ id: "tpl-1", name: "Bug fix", prompt: "Fix it" }]),
		);
		await renderHarness(null);

		let deleted = true;
		await act(async () => {
			deleted = await latestSnapshot().deleteTemplate("tpl-unknown");
		});

		expect(deleted).toBe(false);
		expect(saveRuntimeConfigMock).not.toHaveBeenCalled();
	});
});
