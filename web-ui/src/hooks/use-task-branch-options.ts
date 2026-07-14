import { useMemo } from "react";

import type { RuntimeGitRepositoryInfo, RuntimeVcsMode } from "@/runtime/types";

interface TaskBranchOption {
	value: string;
	label: string;
}

interface UseTaskBranchOptionsInput {
	workspaceGit: RuntimeGitRepositoryInfo | null;
	workspaceVcs: RuntimeVcsMode | null;
}

interface UseTaskBranchOptionsResult {
	createTaskBranchOptions: TaskBranchOption[];
	defaultTaskBranchRef: string;
}

export function useTaskBranchOptions({
	workspaceGit,
	workspaceVcs,
}: UseTaskBranchOptionsInput): UseTaskBranchOptionsResult {
	const createTaskBranchOptions = useMemo(() => {
		if (workspaceVcs === "jj") {
			return [{ value: "@", label: "@ (current change)" }];
		}
		if (!workspaceGit) {
			return [] as TaskBranchOption[];
		}

		const options: TaskBranchOption[] = [];
		const seen = new Set<string>();
		const append = (value: string | null, labelSuffix?: string) => {
			if (!value || seen.has(value)) {
				return;
			}
			seen.add(value);
			options.push({
				value,
				label: labelSuffix ? `${value} ${labelSuffix}` : value,
			});
		};

		append(workspaceGit.currentBranch, "(current)");
		const mainCandidate = workspaceGit.branches.includes("main") ? "main" : workspaceGit.defaultBranch;
		append(mainCandidate, mainCandidate && mainCandidate !== workspaceGit.currentBranch ? "(default)" : undefined);
		for (const branch of workspaceGit.branches) {
			append(branch);
		}
		append(workspaceGit.defaultBranch, workspaceGit.defaultBranch ? "(default)" : undefined);

		return options;
	}, [workspaceGit, workspaceVcs]);

	const defaultTaskBranchRef = useMemo(() => {
		if (workspaceVcs === "jj") {
			return "@";
		}
		if (!workspaceGit) {
			return "";
		}
		return workspaceGit.currentBranch ?? workspaceGit.defaultBranch ?? createTaskBranchOptions[0]?.value ?? "";
	}, [createTaskBranchOptions, workspaceGit, workspaceVcs]);

	return {
		createTaskBranchOptions,
		defaultTaskBranchRef,
	};
}
