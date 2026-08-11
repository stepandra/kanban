import type { RuntimeAgentId } from "./api-contract";

export interface RuntimeAgentCatalogEntry {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	baseArgs: string[];
	autonomousArgs: string[];
	installUrl: string;
	/**
	 * Whether interactive sessions for this agent may be wrapped in a durable
	 * zmx session (see src/terminal/zmx-agent-session.ts). This is the single
	 * source of truth for durable-session eligibility; an explicit decision
	 * must be recorded for every launch-supported agent.
	 */
	durableSession: boolean;
}

export const RUNTIME_AGENT_CATALOG: RuntimeAgentCatalogEntry[] = [
	{
		id: "grok",
		label: "Grok Build",
		binary: "grok",
		baseArgs: ["--no-alt-screen", "--no-auto-update"],
		autonomousArgs: ["--always-approve"],
		installUrl: "https://grok.com/",
		durableSession: true,
	},
	{
		id: "kimi",
		label: "Kimi Code",
		binary: "kimi",
		baseArgs: [],
		autonomousArgs: ["--yolo"],
		installUrl: "https://moonshotai.github.io/kimi-code/",
		durableSession: true,
	},
	{
		id: "claude",
		label: "Claude Code",
		binary: "claude",
		baseArgs: [],
		autonomousArgs: ["--permission-mode", "auto"],
		installUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
		durableSession: true,
	},
	{
		id: "codex",
		label: "OpenAI Codex",
		binary: "codex",
		baseArgs: [],
		autonomousArgs: ["--dangerously-bypass-approvals-and-sandbox"],
		installUrl: "https://github.com/openai/codex",
		durableSession: true,
	},
	{
		id: "opencode",
		label: "OpenCode",
		binary: "opencode",
		baseArgs: [],
		autonomousArgs: [],
		installUrl: "https://github.com/sst/opencode",
		durableSession: false,
	},
	{
		id: "droid",
		label: "Factory Droid",
		binary: "droid",
		baseArgs: [],
		autonomousArgs: ["--auto", "high"],
		installUrl: "https://docs.factory.ai/cli/getting-started/quickstart",
		// Not durable: durable-session wrapping not yet validated for Droid.
		durableSession: false,
	},
	{
		id: "kiro",
		label: "Kiro",
		binary: "kiro-cli",
		baseArgs: ["chat"],
		autonomousArgs: ["--trust-all-tools"],
		installUrl: "https://kiro.dev",
		// Not durable: durable-session wrapping not yet validated for Kiro.
		durableSession: false,
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		binary: "gemini",
		baseArgs: [],
		autonomousArgs: ["--yolo"],
		installUrl: "https://github.com/google-gemini/gemini-cli",
		durableSession: false,
	},
];

// Catalog entries outside this set exist only to read persisted agent IDs.
// They must not become executable merely because their binary is installed.
export const RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS: readonly RuntimeAgentId[] = ["grok", "kimi", "claude", "codex"];

const RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET = new Set<RuntimeAgentId>(RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS);

export function isRuntimeAgentLaunchSupported(agentId: RuntimeAgentId): boolean {
	return RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET.has(agentId);
}

export function getRuntimeLaunchSupportedAgentCatalog(): RuntimeAgentCatalogEntry[] {
	return RUNTIME_AGENT_CATALOG.filter((entry) => isRuntimeAgentLaunchSupported(entry.id));
}

export function getRuntimeAgentCatalogEntry(agentId: RuntimeAgentId): RuntimeAgentCatalogEntry | null {
	return RUNTIME_AGENT_CATALOG.find((entry) => entry.id === agentId) ?? null;
}

export function isDurableAgentSessionEligible(agentId: RuntimeAgentId): boolean {
	return getRuntimeAgentCatalogEntry(agentId)?.durableSession === true;
}
