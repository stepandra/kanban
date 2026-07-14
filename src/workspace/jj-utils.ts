import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const JJ_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface JjCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export interface JjWorkspaceState {
	changeId: string;
	commitId: string;
	changedFiles: number;
	additions: number;
	deletions: number;
	stateToken: string;
}

export async function runJj(cwd: string, args: string[]): Promise<JjCommandResult> {
	try {
		const { stdout, stderr } = await execFileAsync("jj", ["--no-pager", "--color=never", "-R", cwd, ...args], {
			encoding: "utf8",
			maxBuffer: JJ_MAX_BUFFER_BYTES,
		});
		return {
			ok: true,
			stdout: String(stdout ?? "").trim(),
			stderr: String(stderr ?? "").trim(),
		};
	} catch (error) {
		const candidate = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
		return {
			ok: false,
			stdout: String(candidate.stdout ?? "").trim(),
			stderr: String(candidate.stderr ?? candidate.message ?? "").trim(),
		};
	}
}

function parseDiffStatCount(output: string, kind: "file" | "insertion" | "deletion"): number {
	const suffix = kind === "file" ? "files? changed" : `${kind}s?\\([+-]\\)`;
	const match = output.match(new RegExp(`(\\d+) ${suffix}`));
	return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}

export async function readJjWorkspaceState(cwd: string): Promise<JjWorkspaceState> {
	const stat = await runJj(cwd, ["diff", "--stat"]);
	if (!stat.ok) {
		throw new Error(stat.stderr || "Could not read jj working-copy statistics.");
	}
	const identity = await runJj(cwd, ["log", "--no-graph", "-r", "@", "-T", 'change_id ++ "\\n" ++ commit_id']);
	if (!identity.ok) {
		throw new Error(identity.stderr || "Could not read jj working-copy identity.");
	}
	const [changeId = "", commitId = ""] = identity.stdout.split("\n");
	if (!changeId || !commitId) {
		throw new Error("jj returned an incomplete working-copy identity.");
	}

	return {
		changeId,
		commitId,
		changedFiles: parseDiffStatCount(stat.stdout, "file"),
		additions: parseDiffStatCount(stat.stdout, "insertion"),
		deletions: parseDiffStatCount(stat.stdout, "deletion"),
		stateToken: JSON.stringify([changeId, commitId, stat.stdout]),
	};
}
