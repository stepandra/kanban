// Minimal ambient stand-in for the `@ampcode/plugin` SDK types. The Amp plugin
// (`amp/kanban.ts`) is a self-contained single file installed via
// `amp plugins add <raw-url>` and typed by Amp's own runtime, so the SDK is not
// an npm dependency of this repo. Only the surface used by `amp/kanban.ts` is
// declared, mirroring https://ampcode.com/manual/plugin-api; extend it when the
// plugin adopts new APIs, and delete it if the SDK is ever added as a real
// dependency.
declare module "@ampcode/plugin" {
	export type ThreadID = `T-${string}`;
	export type ThreadMessageID = number | string;

	export interface ThreadTextBlock {
		type: "text";
		text: string;
	}

	export interface ThreadThinkingBlock {
		type: "thinking";
		thinking: string;
	}

	export interface ThreadToolUseBlock {
		type: "tool_use";
		id: string;
		name: string;
		input: Record<string, unknown>;
	}

	export interface ThreadAssistantMessage {
		role: "assistant";
		id: ThreadMessageID;
		content: (ThreadTextBlock | ThreadThinkingBlock | ThreadToolUseBlock)[];
	}

	export interface UserMessage {
		type: "user-message";
		content: string;
	}

	export interface PluginThread {
		id: ThreadID;
		appendUserMessage(message: UserMessage): Promise<void>;
		waitForResponse(options?: { timeoutMs?: number }): Promise<ThreadAssistantMessage>;
	}

	export type AgentThread = PluginThread;

	export interface CreateAgentThreadOptions {
		parentThreadID?: ThreadID;
		show?: boolean;
		executor?: "local" | "orb" | { type: "runner"; id: string };
	}

	export interface Agent {
		createThread(options?: CreateAgentThreadOptions): Promise<AgentThread>;
	}

	export type BuiltinAgentMode = "low" | "medium" | "high" | "ultra" | "smart" | "deep" | "rush";

	export interface PluginLogger {
		log: (...args: unknown[]) => void;
	}

	export interface URI {
		toString(): string;
	}

	export interface PluginSystem {
		readonly workspaceRoot: URI | null;
	}

	export interface AgentStartEvent {
		thread: { id: ThreadID };
		message: string;
		id: ThreadMessageID;
	}

	export interface AgentStartResult {
		message?: { content: string; display?: boolean };
	}

	export interface PluginToolContext {
		thread: PluginThread;
	}

	export interface PluginToolDefinition {
		name: string;
		description: string;
		inputSchema: Record<string, unknown>;
		execute(input: Record<string, unknown>, ctx: PluginToolContext): Promise<string>;
	}

	export interface PluginInputOptions {
		title?: string;
		helpText?: string;
		initialValue?: string;
		submitButtonText?: string;
	}

	export interface PluginCommandContext {
		ui: { input(options: PluginInputOptions): Promise<string | undefined> };
		thread?: PluginThread;
	}

	export interface PluginCommandOptions {
		title: string;
		category?: string;
		description?: string;
	}

	export interface PluginAPI {
		logger: PluginLogger;
		system: PluginSystem;
		helpers: { filePathFromURI(uri: URI): string };
		getBuiltinAgent(mode: BuiltinAgentMode): Agent;
		on(event: "agent.start", handler: (event: AgentStartEvent) => AgentStartResult | Promise<AgentStartResult>): void;
		registerTool(definition: PluginToolDefinition): void;
		registerCommand(
			id: string,
			options: PluginCommandOptions,
			handler: (ctx: PluginCommandContext) => void | Promise<void>,
		): void;
	}
}
