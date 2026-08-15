import type { PlanEntry, SessionNotification, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";

import type { RuntimeAcpActivityItem } from "../core/api-contract";

const MAX_ACTIVITY_TEXT_CHARS = 16_384;
const MAX_PLAN_ENTRIES = 100;

function truncate(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function toolActivity(input: ToolCall | ToolCallUpdate, sequence: number, timestamp: number): RuntimeAcpActivityItem {
	return {
		sequence,
		timestamp,
		kind: "tool",
		text: truncate(input.title?.trim() || input.name?.trim() || input.toolCallId, MAX_ACTIVITY_TEXT_CHARS),
		toolCallId: input.toolCallId,
		toolKind: input.kind ?? null,
		toolStatus: input.status ?? null,
	};
}

function planActivity(entries: PlanEntry[], sequence: number, timestamp: number): RuntimeAcpActivityItem {
	const active = entries.find((entry) => entry.status === "in_progress");
	const pending = entries.find((entry) => entry.status === "pending");
	return {
		sequence,
		timestamp,
		kind: "plan",
		text: truncate(active?.content ?? pending?.content ?? "Plan updated", MAX_ACTIVITY_TEXT_CHARS),
		plan: entries.slice(0, MAX_PLAN_ENTRIES).map((entry) => ({
			content: truncate(entry.content, MAX_ACTIVITY_TEXT_CHARS),
			priority: entry.priority,
			status: entry.status,
		})),
	};
}

export function toRuntimeAcpActivity(
	notification: SessionNotification,
	sequence: number,
	timestamp = Date.now(),
): RuntimeAcpActivityItem | null {
	const update = notification.update;
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
		case "agent_thought_chunk":
			if (update.content.type !== "text" || !update.content.text) {
				return null;
			}
			return {
				sequence,
				timestamp,
				kind: update.sessionUpdate === "agent_message_chunk" ? "message" : "thought",
				text: truncate(update.content.text, MAX_ACTIVITY_TEXT_CHARS),
			};
		case "tool_call":
		case "tool_call_update":
			return toolActivity(update, sequence, timestamp);
		case "plan":
			return planActivity(update.entries, sequence, timestamp);
		case "plan_update":
			if (update.plan.type === "items") {
				return planActivity(update.plan.entries, sequence, timestamp);
			}
			return {
				sequence,
				timestamp,
				kind: "plan",
				text: truncate(
					update.plan.type === "markdown" ? update.plan.content : update.plan.uri,
					MAX_ACTIVITY_TEXT_CHARS,
				),
				plan: [],
			};
		case "plan_removed":
			return {
				sequence,
				timestamp,
				kind: "plan",
				text: "Plan removed",
				plan: [],
			};
		case "user_message_chunk":
		case "available_commands_update":
		case "current_mode_update":
		case "config_option_update":
		case "session_info_update":
		case "usage_update":
			return null;
	}
}
