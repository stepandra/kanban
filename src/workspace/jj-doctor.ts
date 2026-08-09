import { z } from "zod";

import type { RuntimeBoardColumnId, RuntimeBoardData } from "../core/api-contract";
import { detectRepositoryKind, loadWorkspaceBoardById, loadWorkspaceContext } from "../state/workspace-state";
import { runJj } from "./jj-utils";
import { getTaskWorkspacePathInfo } from "./task-worktree";

const PREFIX = "kanban-";
const WORKSPACE_TEMPLATE =
	'name ++ "\\t" ++ target.change_id() ++ "\\t" ++ target.commit_id() ++ "\\t" ++ target.empty() ++ "\\t" ++ target.conflict() ++ "\\t" ++ target.divergent() ++ "\\t" ++ target.hidden() ++ "\\n"';
const HEAD_TEMPLATE = 'change_id ++ "\\t" ++ commit_id ++ "\\t" ++ empty ++ "\\t" ++ description.first_line() ++ "\\n"';
const STALENESS_GAP =
	"Per-workspace staleness cannot be proven from repository-level jj reads without entering individual workspaces.";

export const jjWorkspaceKindSchema = z.enum(["default", "kanban-task", "foreign"]);
export type JjWorkspaceKind = z.infer<typeof jjWorkspaceKindSchema>;
export const jjWorkspaceClassificationSchema = z.enum([
	"default",
	"active",
	"completed",
	"stale-empty",
	"orphaned",
	"unowned",
	"unknown",
]);
export type JjWorkspaceClassification = z.infer<typeof jjWorkspaceClassificationSchema>;
export const jjDoctorIssueKindSchema = z.enum([
	"missing-path",
	"conflicted",
	"divergent",
	"stale-empty",
	"hidden-workspace",
]);
export const jjWorkspaceHealthSchema = z.object({
	name: z.string(),
	kind: jjWorkspaceKindSchema,
	taskId: z.string().nullable(),
	changeId: z.string(),
	commitId: z.string(),
	empty: z.boolean(),
	conflicted: z.boolean(),
	divergent: z.boolean(),
	hidden: z.boolean(),
	expectedPath: z.string().nullable(),
	pathExists: z.boolean().nullable(),
	onBoard: z.boolean(),
	boardColumn: z.string().nullable(),
	classification: jjWorkspaceClassificationSchema,
});
export type JjWorkspaceHealth = z.infer<typeof jjWorkspaceHealthSchema>;
export const jjHeadHealthSchema = z.object({
	changeId: z.string(),
	commitId: z.string(),
	empty: z.boolean(),
	description: z.string(),
	ownedByWorkspace: z.string().nullable(),
});
export type JjHeadHealth = z.infer<typeof jjHeadHealthSchema>;
export const jjDoctorIssueSchema = z.object({
	kind: jjDoctorIssueKindSchema,
	workspace: z.string().nullable(),
	taskId: z.string().nullable(),
	detail: z.string(),
});
export type JjDoctorIssue = z.infer<typeof jjDoctorIssueSchema>;
export const jjDoctorReportSchema = z.object({
	ok: z.boolean(),
	reason: z.string().nullable(),
	repoPath: z.string(),
	vcs: z.literal("jj").nullable(),
	jjVersion: z.string().nullable(),
	boardConnected: z.boolean(),
	healthy: z.boolean(),
	workspaces: z.array(jjWorkspaceHealthSchema),
	heads: z.array(jjHeadHealthSchema),
	issues: z.array(jjDoctorIssueSchema),
	gaps: z.array(z.string()),
});
export type JjDoctorReport = z.infer<typeof jjDoctorReportSchema>;

interface WorkspaceRow {
	name: string;
	changeId: string;
	commitId: string;
	empty: boolean;
	conflicted: boolean;
	divergent: boolean;
	hidden: boolean;
}

interface HeadRow {
	changeId: string;
	commitId: string;
	empty: boolean;
	description: string;
}

function parseBoolean(value: string): boolean | null {
	const trimmed = value.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	return null;
}

function parseWorkspaces(output: string, gaps: string[]): { rows: WorkspaceRow[]; incomplete: boolean } {
	const rows: WorkspaceRow[] = [];
	let incomplete = false;
	for (const line of output.split("\n").filter(Boolean)) {
		const fields = line.split("\t");
		if (fields.length !== 7) {
			incomplete = true;
			gaps.push(`Skipped an unparseable jj workspace list row: ${JSON.stringify(line)}.`);
			continue;
		}
		const [name, changeId, commitId, empty, conflicted, divergent, hidden] = fields;
		if (
			!name ||
			!changeId ||
			!commitId ||
			empty === undefined ||
			conflicted === undefined ||
			divergent === undefined ||
			hidden === undefined
		) {
			incomplete = true;
			gaps.push(`Skipped an incomplete jj workspace list row: ${JSON.stringify(line)}.`);
			continue;
		}
		const parsedEmpty = parseBoolean(empty);
		const parsedConflicted = parseBoolean(conflicted);
		const parsedDivergent = parseBoolean(divergent);
		const parsedHidden = parseBoolean(hidden);
		const booleanFields = [
			["empty", empty, parsedEmpty],
			["conflicted", conflicted, parsedConflicted],
			["divergent", divergent, parsedDivergent],
			["hidden", hidden, parsedHidden],
		] as const;
		if (parsedEmpty === null || parsedConflicted === null || parsedDivergent === null || parsedHidden === null) {
			const invalidBooleans = booleanFields.filter(([, , value]) => value === null);
			incomplete = true;
			gaps.push(
				`Skipped a jj workspace list row with invalid boolean ${invalidBooleans
					.map(([field, value]) => `${field}=${JSON.stringify(value)}`)
					.join(", ")}: ${JSON.stringify(line)}.`,
			);
			continue;
		}
		rows.push({
			name,
			changeId,
			commitId,
			empty: parsedEmpty,
			conflicted: parsedConflicted,
			divergent: parsedDivergent,
			hidden: parsedHidden,
		});
	}
	return { rows, incomplete };
}

function parseHeads(output: string, gaps: string[]): { rows: HeadRow[]; incomplete: boolean } {
	const rows: HeadRow[] = [];
	let incomplete = false;
	for (const line of output.split("\n").filter(Boolean)) {
		const [changeId, commitId, empty, ...description] = line.split("\t");
		if (!changeId || !commitId || empty === undefined) {
			incomplete = true;
			gaps.push(`Skipped an incomplete jj visible-head row: ${JSON.stringify(line)}.`);
			continue;
		}
		const parsedEmpty = parseBoolean(empty);
		if (parsedEmpty === null) {
			incomplete = true;
			gaps.push(
				`Skipped a jj visible-head row with invalid boolean empty=${JSON.stringify(empty)}: ${JSON.stringify(line)}.`,
			);
			continue;
		}
		rows.push({ changeId, commitId, empty: parsedEmpty, description: description.join("\t") });
	}
	return { rows, incomplete };
}

function kindFor(name: string): JjWorkspaceKind {
	return name === "default"
		? "default"
		: name.startsWith(PREFIX) && name.length > PREFIX.length
			? "kanban-task"
			: "foreign";
}

function boardTask(
	board: RuntimeBoardData | null,
	taskId: string | null,
): { column: RuntimeBoardColumnId; baseRef: string } | null {
	if (!board || !taskId) return null;
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) return { column: column.id, baseRef: card.baseRef };
	}
	return null;
}

function classification(input: {
	kind: JjWorkspaceKind;
	column: RuntimeBoardColumnId | null;
	pathExists: boolean | null;
	empty: boolean;
}): JjWorkspaceClassification {
	if (input.kind === "default") return "default";
	if (input.kind === "foreign") return "unowned";
	if (input.pathExists === null) return "unknown";
	if (!input.pathExists) return "orphaned";
	if (input.column) return input.column === "trash" ? "completed" : "active";
	return input.empty ? "stale-empty" : "orphaned";
}

async function contextFor(cwd: string): Promise<{ repoPath: string; board: RuntimeBoardData | null } | null> {
	try {
		const context = await loadWorkspaceContext(cwd, { autoCreateIfMissing: false });
		if (context.vcs !== "jj") return null;
		return { repoPath: context.repoPath, board: await loadWorkspaceBoardById(context.workspaceId).catch(() => null) };
	} catch {
		if (detectRepositoryKind(cwd) !== "jj") return null;
		const root = await runJj(cwd, ["--ignore-working-copy", "root"]);
		return { repoPath: root.ok && root.stdout ? root.stdout : cwd, board: null };
	}
}

async function version(repoPath: string): Promise<string | null> {
	const result = await runJj(repoPath, ["--version"]);
	return result.ok && result.stdout ? result.stdout : null;
}

function failed(repoPath: string, reason: string, vcs: "jj" | null = null, gaps: string[] = []): JjDoctorReport {
	return {
		ok: false,
		reason,
		repoPath,
		vcs,
		jjVersion: null,
		boardConnected: false,
		healthy: false,
		workspaces: [],
		heads: [],
		issues: [],
		gaps,
	};
}

export async function inspectJjRepositoryHealth(options: { cwd: string }): Promise<JjDoctorReport> {
	const cwd = options.cwd.trim();
	if (!cwd) return failed(cwd, "A repository path is required for the jj health inventory.");
	const context = await contextFor(cwd);
	if (!context) return failed(cwd, "No jj repository detected. `kanban jj doctor` only inspects jj repositories.");

	const { repoPath, board } = context;
	const gaps = [STALENESS_GAP];
	if (!board) gaps.push("Board reconciliation skipped: this project is not added to Kanban.");
	const listed = await runJj(repoPath, ["--ignore-working-copy", "workspace", "list", "-T", WORKSPACE_TEMPLATE]);
	if (!listed.ok) {
		const report = failed(repoPath, listed.stderr || "Could not read jj workspaces.", "jj", gaps);
		report.jjVersion = await version(repoPath);
		return report;
	}
	const parsedWorkspaces = parseWorkspaces(listed.stdout, gaps);
	const workspaces: JjWorkspaceHealth[] = [];
	for (const row of parsedWorkspaces.rows) {
		const kind = kindFor(row.name);
		const taskId = kind === "kanban-task" ? row.name.slice(PREFIX.length) : null;
		const task = boardTask(board, taskId);
		let expectedPath: string | null = kind === "default" ? repoPath : null;
		let pathExists: boolean | null = kind === "default" ? true : null;
		if (kind === "kanban-task" && taskId) {
			try {
				const info = await getTaskWorkspacePathInfo({ cwd: repoPath, taskId, baseRef: task?.baseRef ?? "@" });
				expectedPath = info.path;
				pathExists = info.exists;
			} catch (error) {
				gaps.push(
					`Could not resolve the expected path for "${row.name}": ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		workspaces.push({
			...row,
			kind,
			taskId,
			expectedPath,
			pathExists,
			onBoard: task !== null,
			boardColumn: task?.column ?? null,
			classification: classification({ kind, column: task?.column ?? null, pathExists, empty: row.empty }),
		});
	}

	const owners = new Map(workspaces.map((workspace) => [workspace.commitId, workspace.name]));
	const headsResult = await runJj(repoPath, [
		"--ignore-working-copy",
		"log",
		"-r",
		"heads(all())",
		"--no-graph",
		"-T",
		HEAD_TEMPLATE,
	]);
	let headIncomplete = false;
	const heads: JjHeadHealth[] = [];
	if (!headsResult.ok) {
		headIncomplete = true;
		gaps.push(`Could not read visible heads: ${headsResult.stderr || "jj log failed."}`);
	} else {
		const parsed = parseHeads(headsResult.stdout, gaps);
		headIncomplete = parsed.incomplete;
		for (const row of parsed.rows) heads.push({ ...row, ownedByWorkspace: owners.get(row.commitId) ?? null });
	}

	const issues: JjDoctorIssue[] = [];
	for (const workspace of workspaces) {
		const base = { workspace: workspace.name, taskId: workspace.taskId };
		if (workspace.kind === "kanban-task" && workspace.pathExists === false)
			issues.push({
				...base,
				kind: "missing-path",
				detail: `Registered path ${workspace.expectedPath ?? "(unknown)"} is missing.`,
			});
		if (workspace.conflicted)
			issues.push({
				...base,
				kind: "conflicted",
				detail: `Working-copy commit ${workspace.commitId} contains conflicts.`,
			});
		if (workspace.divergent)
			issues.push({ ...base, kind: "divergent", detail: `Change ${workspace.changeId} is divergent.` });
		if (workspace.hidden)
			issues.push({
				...base,
				kind: "hidden-workspace",
				detail: `Working-copy commit ${workspace.commitId} is hidden.`,
			});
		if (workspace.classification === "stale-empty")
			issues.push({
				...base,
				kind: "stale-empty",
				detail: `"${workspace.name}" is empty with no owning board task.`,
			});
	}

	return {
		ok: true,
		reason: null,
		repoPath,
		vcs: "jj",
		jjVersion: await version(repoPath),
		boardConnected: board !== null,
		healthy: issues.length === 0 && !parsedWorkspaces.incomplete && !headIncomplete,
		workspaces,
		heads,
		issues,
		gaps,
	};
}
