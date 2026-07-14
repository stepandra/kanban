import type { RuntimeTaskAutoReviewMode, RuntimeTaskWorkspaceInfoResponse, RuntimeVcsMode } from "@/runtime/types";

export type TaskGitAction = Extract<RuntimeTaskAutoReviewMode, "commit" | "pr">;

interface TaskGitPromptVariable {
	key: string;
	token: string;
	description: string;
}

export const TASK_GIT_BASE_REF_PROMPT_VARIABLE: TaskGitPromptVariable = {
	key: "base_ref",
	token: "{{base_ref}}",
	description: "the branch this task worktree was created from",
};

export interface TaskGitPromptTemplates {
	commitPromptTemplate?: string | null;
	openPrPromptTemplate?: string | null;
	commitPromptTemplateDefault?: string | null;
	openPrPromptTemplateDefault?: string | null;
}

interface BuildTaskGitActionPromptInput {
	action: TaskGitAction;
	workspaceInfo: RuntimeTaskWorkspaceInfoResponse;
	templates?: TaskGitPromptTemplates | null;
	vcs?: RuntimeVcsMode;
}

function buildJjActionPrompt(action: TaskGitAction, workspaceInfo: RuntimeTaskWorkspaceInfoResponse): string {
	if (action === "commit") {
		return `You are in a Jujutsu task workspace. Finish the task by recording the current working-copy change with jj.

- Use jj, not git, for version-control operations.
- Do not create a bookmark for a local commit-only action.
- Do not abandon, squash, rebase, or otherwise rewrite unrelated changes.

Steps:
1. Inspect the task change with \`jj status\` and \`jj diff\`.
2. Run \`jj commit -m "<concise task summary>"\`.
3. Verify \`jj diff --summary\` is empty. The completed task change is now \`@-\` and \`@\` is the new empty working-copy change.
4. Report the completed change ID, commit ID, and description from \`jj log -r @-\`.`;
	}

	const bookmarkName = `kanban/${workspaceInfo.taskId}`;
	return `You are in a Jujutsu task workspace. Finish the task, publish its completed change, and open a pull request.

- Use jj, not git, for version-control operations.
- Keep the bookmark at the publish boundary; the task did not need one while it was local.
- The task was created from revision \`${workspaceInfo.baseRef}\`. A GitHub PR base must be a branch name, not a jj revset such as \`@\` or \`trunk()\`.
- Do not abandon, squash, rebase, or otherwise rewrite unrelated changes.

Steps:
1. Inspect the task change with \`jj status\` and \`jj diff\`.
2. Run \`jj commit -m "<concise task summary>"\`. The completed task change is now \`@-\`.
3. Create or advance the task bookmark with \`jj bookmark set "${bookmarkName}" -r @-\`.
4. Publish only that bookmark with \`jj git push --bookmark "${bookmarkName}"\`.
5. Determine the GitHub base branch. Use the branch corresponding to the task's base revision when unambiguous; otherwise use the repository default from \`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name\`.
6. If a pull request already exists for head \`${bookmarkName}\` and that base, return its URL. Otherwise create it with \`gh pr create --head "${bookmarkName}" --base "<base-branch>"\` and an appropriate title and body.
7. Verify \`jj diff --summary\` is empty and report the PR URL, base branch, bookmark, completed change ID, and commit ID. If publishing or PR creation failed, report the exact failure instead of claiming success.`;
}

function resolveTemplate(action: TaskGitAction, templates?: TaskGitPromptTemplates | null): string {
	if (action === "commit") {
		const template = templates?.commitPromptTemplate?.trim();
		if (template) {
			return template;
		}
		const defaultTemplate = templates?.commitPromptTemplateDefault?.trim();
		if (defaultTemplate) {
			return defaultTemplate;
		}
		return "Handle this commit action using the provided git context.";
	}
	const template = templates?.openPrPromptTemplate?.trim();
	if (template) {
		return template;
	}
	const defaultTemplate = templates?.openPrPromptTemplateDefault?.trim();
	if (defaultTemplate) {
		return defaultTemplate;
	}
	return "Handle this pull request action using the provided git context.";
}

function interpolateTemplate(template: string, variables: Record<string, string>): string {
	let result = template;
	for (const [key, value] of Object.entries(variables)) {
		result = result.replaceAll(`{{${key}}}`, value);
	}
	return result;
}

export function buildTaskGitActionPrompt(input: BuildTaskGitActionPromptInput): string {
	if (input.vcs === "jj") {
		return buildJjActionPrompt(input.action, input.workspaceInfo);
	}
	const variables: Record<string, string> = {
		[TASK_GIT_BASE_REF_PROMPT_VARIABLE.key]: input.workspaceInfo.baseRef,
	};
	const template = resolveTemplate(input.action, input.templates);
	return interpolateTemplate(template, variables);
}
