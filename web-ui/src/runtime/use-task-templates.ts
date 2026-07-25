// CRUD access to reusable task creation templates stored in the Kanban
// runtime config. Keeps tRPC persistence details out of the create dialog.
import { useCallback, useState } from "react";

import { fetchRuntimeConfig, saveRuntimeConfig } from "@/runtime/runtime-config-query";
import type { RuntimeConfigResponse, RuntimeTaskTemplate } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export type TaskTemplateInput = Omit<RuntimeTaskTemplate, "id">;

export interface UseTaskTemplatesResult {
	templates: RuntimeTaskTemplate[];
	isLoading: boolean;
	isSaving: boolean;
	saveTemplate: (input: TaskTemplateInput) => Promise<RuntimeTaskTemplate | null>;
	deleteTemplate: (templateId: string) => Promise<boolean>;
}

function createTaskTemplateId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useTaskTemplates(workspaceId: string | null, enabled: boolean): UseTaskTemplatesResult {
	const [isSaving, setIsSaving] = useState(false);
	const queryFn = useCallback(async () => await fetchRuntimeConfig(workspaceId), [workspaceId]);
	const configQuery = useTrpcQuery<RuntimeConfigResponse>({
		enabled,
		queryFn,
		retainDataOnError: true,
	});
	const setConfigData = configQuery.setData;
	const templates = configQuery.data?.taskTemplates ?? [];

	const persistTemplates = useCallback(
		async (taskTemplates: RuntimeTaskTemplate[]): Promise<RuntimeConfigResponse | null> => {
			setIsSaving(true);
			try {
				const saved = await saveRuntimeConfig(workspaceId, { taskTemplates });
				setConfigData(saved);
				return saved;
			} catch {
				return null;
			} finally {
				setIsSaving(false);
			}
		},
		[setConfigData, workspaceId],
	);

	const saveTemplate = useCallback(
		async (input: TaskTemplateInput): Promise<RuntimeTaskTemplate | null> => {
			const name = input.name.trim();
			if (!name || !input.prompt.trim()) {
				return null;
			}
			const template: RuntimeTaskTemplate = { ...input, id: createTaskTemplateId(), name };
			// Saving under an existing name replaces that template.
			const nextTemplates = [...templates.filter((existing) => existing.name !== name), template];
			const saved = await persistTemplates(nextTemplates);
			return saved ? template : null;
		},
		[persistTemplates, templates],
	);

	const deleteTemplate = useCallback(
		async (templateId: string): Promise<boolean> => {
			const nextTemplates = templates.filter((existing) => existing.id !== templateId);
			if (nextTemplates.length === templates.length) {
				return false;
			}
			return (await persistTemplates(nextTemplates)) !== null;
		},
		[persistTemplates, templates],
	);

	return {
		templates,
		isLoading: enabled ? configQuery.isLoading && configQuery.data === null : false,
		isSaving,
		saveTemplate,
		deleteTemplate,
	};
}
