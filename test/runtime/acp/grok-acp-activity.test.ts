import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { toRuntimeAcpActivity } from "../../../src/acp/grok-acp-activity";

describe("Grok ACP activity projection", () => {
	it("projects message, tool, and plan updates into bounded runtime activity", () => {
		const message = toRuntimeAcpActivity(
			{
				sessionId: "session-1",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "Implemented the auth handshake." },
				},
			} satisfies SessionNotification,
			1,
			10,
		);
		const tool = toRuntimeAcpActivity(
			{
				sessionId: "session-1",
				update: {
					sessionUpdate: "tool_call",
					toolCallId: "tool-1",
					title: "Run tests",
					kind: "execute",
					status: "in_progress",
					rawInput: { authFile: "auth.json", apiKey: "xai-secret-key" },
					rawOutput: "xai-secret-response",
				},
			} satisfies SessionNotification,
			2,
			20,
		);
		const plan = toRuntimeAcpActivity(
			{
				sessionId: "session-1",
				update: {
					sessionUpdate: "plan",
					entries: [{ content: "Verify the vertical slice", priority: "high", status: "in_progress" }],
				},
			} satisfies SessionNotification,
			3,
			30,
		);

		expect(message).toMatchObject({ sequence: 1, timestamp: 10, kind: "message" });
		expect(tool).toMatchObject({
			sequence: 2,
			kind: "tool",
			text: "Run tests",
			toolKind: "execute",
			toolStatus: "in_progress",
		});
		expect(JSON.stringify(tool)).not.toContain("auth.json");
		expect(JSON.stringify(tool)).not.toContain("xai-secret");
		expect(plan).toMatchObject({
			sequence: 3,
			kind: "plan",
			text: "Verify the vertical slice",
		});
	});

	it("caps plan replay entries at the persisted schema bound", () => {
		const plan = toRuntimeAcpActivity(
			{
				sessionId: "session-1",
				update: {
					sessionUpdate: "plan",
					entries: Array.from({ length: 120 }, (_, index) => ({
						content: `Step ${index + 1}`,
						priority: "medium" as const,
						status: "pending" as const,
					})),
				},
			} satisfies SessionNotification,
			1,
			10,
		);

		expect(plan?.plan).toHaveLength(100);
	});
});
