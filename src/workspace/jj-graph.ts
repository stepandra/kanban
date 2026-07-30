import {
	type RuntimeJjGraphNode,
	type RuntimeJjGraphResponse,
	type RuntimeJjGraphRow,
	runtimeJjGraphNodeSchema,
} from "../core/api-contract";
import { runJj } from "./jj-utils";

const DEFAULT_JJ_GRAPH_CHANGE_COUNT = 80;
const JJ_GRAPH_NODE_MARKER = "KANBAN_JJ_NODE\t";

const JJ_GRAPH_TEMPLATE =
	'"KANBAN_JJ_NODE\\t{"' +
	' ++ "\\"changeId\\":" ++ json(change_id)' +
	' ++ ",\\"commitId\\":" ++ json(commit_id)' +
	' ++ ",\\"parentCommitIds\\":" ++ json(parents.map(|p| p.commit_id()))' +
	' ++ ",\\"description\\":" ++ description.first_line().escape_json()' +
	' ++ ",\\"bookmarks\\":" ++ json(local_bookmarks.map(|b| b.name()))' +
	' ++ ",\\"workspaces\\":" ++ json(working_copies.map(|w| w.name()))' +
	' ++ ",\\"currentWorkingCopy\\":" ++ if(current_working_copy, "true", "false")' +
	' ++ ",\\"empty\\":" ++ if(empty, "true", "false")' +
	' ++ ",\\"conflict\\":" ++ if(conflict, "true", "false")' +
	' ++ "}\\n"';

function parseNodeLine(line: string): RuntimeJjGraphNode | null {
	const markerIndex = line.indexOf(JJ_GRAPH_NODE_MARKER);
	if (markerIndex < 0) {
		return null;
	}
	const payload = line.slice(markerIndex + JJ_GRAPH_NODE_MARKER.length);
	try {
		const parsed = runtimeJjGraphNodeSchema.safeParse({
			kind: "node",
			graphPrefix: line.slice(0, markerIndex),
			...(JSON.parse(payload) as object),
		});
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function parseJjGraphOutput(output: string): RuntimeJjGraphRow[] {
	const rows: RuntimeJjGraphRow[] = [];
	for (const line of output.split("\n")) {
		if (!line) {
			continue;
		}
		const node = parseNodeLine(line);
		if (node) {
			rows.push(node);
			continue;
		}
		rows.push({
			kind: "edge",
			graphPrefix: line,
		});
	}
	return rows;
}

export async function getJjGraph(options: { cwd: string; maxCount?: number }): Promise<RuntimeJjGraphResponse> {
	const maxCount = options.maxCount ?? DEFAULT_JJ_GRAPH_CHANGE_COUNT;
	const result = await runJj(options.cwd, ["log", "-r", "all()", "-n", String(maxCount), "-T", JJ_GRAPH_TEMPLATE]);
	if (!result.ok) {
		return {
			ok: false,
			rows: [],
			changeCount: 0,
			truncated: false,
			error: result.stderr || "Could not read the jj change graph.",
		};
	}

	const rows = parseJjGraphOutput(result.stdout);
	const changeCount = rows.filter((row) => row.kind === "node").length;
	return {
		ok: true,
		rows,
		changeCount,
		truncated: changeCount >= maxCount,
	};
}
