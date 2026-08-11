import { describe, expect, it } from "vitest";

import { isDurableAgentSessionEligible, RUNTIME_AGENT_CATALOG } from "../../../src/core/agent-catalog";
import { buildZmxWorkspaceSessionPrefix, prepareZmxAgentSession } from "../../../src/terminal/zmx-agent-session";

describe("prepareZmxAgentSession", () => {
	it("builds a deterministic workspace prefix for reconciliation", () => {
		expect(buildZmxWorkspaceSessionPrefix("Workspace One")).toBe("kanban.workspace-one.");
		expect(buildZmxWorkspaceSessionPrefix("  ")).toBeNull();
	});

	it("wraps an interactive agent in a deterministic durable holder", () => {
		const first = prepareZmxAgentSession({
			agentId: "codex",
			binary: "codex",
			args: ["--model", "gpt-5"],
			taskId: "task/with spaces",
			workspaceId: "workspace-one",
			zmxAvailable: true,
		});
		const second = prepareZmxAgentSession({
			agentId: "codex",
			binary: "codex",
			args: ["--model", "gpt-5"],
			taskId: "task/with spaces",
			workspaceId: "workspace-one",
			zmxAvailable: true,
		});

		expect(first).toEqual(second);
		expect(first?.binary).toBe("zmx");
		expect(first?.args.slice(0, 2)).toEqual(["attach", first?.sessionName]);
		expect(first?.args.slice(2)).toEqual(["codex", "--model", "gpt-5"]);
		expect(first?.sessionName).toMatch(/^kanban\.workspace-one\.codex\.task-with-spaces\.[a-f0-9]{12}$/);
	});

	// Pins the exact session-name format documented in docs/zmx-session-names.md.
	// External parsers (juja/zellij/bin/kanban-zmx-view) depend on it:
	// any change here is a breaking contract change, not a test update.
	it("generates the exact documented session-name format", () => {
		const launch = prepareZmxAgentSession({
			agentId: "codex",
			binary: "codex",
			args: [],
			taskId: "task/with spaces",
			workspaceId: "workspace-one",
			zmxAvailable: true,
		});

		// sha256("workspace-one\0task/with spaces")[:12] over the raw values.
		expect(launch?.sessionName).toBe("kanban.workspace-one.codex.task-with-spaces.8e64aaa3ecb1");
	});

	it("applies the documented safeSegment sanitization rules", () => {
		const launch = prepareZmxAgentSession({
			agentId: "kimi",
			binary: "kimi",
			args: [],
			taskId: "Task / With   CAPS..dots!",
			workspaceId: "WS",
			zmxAvailable: true,
		});

		// Lowercased; runs of [^a-z0-9._-] collapse to a single "-"; dots are kept;
		// leading/trailing "-" trimmed. Digest is over raw values: sha256("WS\0Task / With   CAPS..dots!")[:12].
		expect(launch?.sessionName).toMatch(/^kanban\.ws\.kimi\.task-with-caps\.\.dots\.[a-f0-9]{12}$/);
	});

	it("leaves unsupported or unavailable sessions on the existing PTY path", () => {
		expect(
			prepareZmxAgentSession({
				agentId: "gemini",
				binary: "gemini",
				args: [],
				taskId: "task-1",
				workspaceId: "workspace-one",
				zmxAvailable: true,
			}),
		).toBeNull();
		expect(
			prepareZmxAgentSession({
				agentId: "codex",
				binary: "codex",
				args: [],
				taskId: "task-1",
				workspaceId: "workspace-one",
				zmxAvailable: false,
			}),
		).toBeNull();
		expect(
			prepareZmxAgentSession({
				agentId: "codex",
				binary: "codex",
				args: [],
				taskId: "task-1",
				workspaceId: "  ",
				zmxAvailable: true,
			}),
		).toBeNull();
	});

	it("rejects agents whose catalog entry opts out of durable sessions", () => {
		for (const agentId of ["droid", "kiro"] as const) {
			expect(
				prepareZmxAgentSession({
					agentId,
					binary: agentId,
					args: [],
					taskId: "task-1",
					workspaceId: "workspace-one",
					zmxAvailable: true,
				}),
			).toBeNull();
		}
	});
});

describe("durable-session eligibility (RUNTIME_AGENT_CATALOG)", () => {
	it("records an explicit durableSession decision for every catalog entry", () => {
		for (const entry of RUNTIME_AGENT_CATALOG) {
			expect(typeof entry.durableSession).toBe("boolean");
		}
	});

	it("matches the recorded eligibility decisions", () => {
		const decisions = Object.fromEntries(RUNTIME_AGENT_CATALOG.map((entry) => [entry.id, entry.durableSession]));
		expect(decisions).toEqual({
			claude: true,
			codex: true,
			grok: true,
			kimi: true,
			opencode: false,
			droid: false,
			kiro: false,
			gemini: false,
		});
		expect(isDurableAgentSessionEligible("codex")).toBe(true);
		expect(isDurableAgentSessionEligible("droid")).toBe(false);
	});
});
