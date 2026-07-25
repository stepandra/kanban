import { describe, expect, it } from "vitest";

import { matchesBoardFilter } from "@/hooks/use-board-filter";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard } from "@/types";

function createCard(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "task-1",
		title: "Fix login bug",
		prompt: "Fix the login bug in the auth flow",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createSessionSummary(state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state,
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe("matchesBoardFilter", () => {
	it("matches everything when no filter is set", () => {
		expect(matchesBoardFilter(createCard(), undefined, { query: "", agentId: null, sessionState: null })).toBe(true);
	});

	it("matches query against title and prompt case-insensitively", () => {
		const card = createCard();
		expect(matchesBoardFilter(card, undefined, { query: "LOGIN", agentId: null, sessionState: null })).toBe(true);
		expect(matchesBoardFilter(card, undefined, { query: "auth flow", agentId: null, sessionState: null })).toBe(true);
		expect(matchesBoardFilter(card, undefined, { query: "payments", agentId: null, sessionState: null })).toBe(false);
	});

	it("matches query against prompt-only content", () => {
		const card = createCard({ title: "", prompt: "Refactor the billing module" });
		expect(matchesBoardFilter(card, undefined, { query: "billing", agentId: null, sessionState: null })).toBe(true);
	});

	it("filters by agent id, treating a missing agent as the default agent", () => {
		const defaultCard = createCard({ agentId: undefined });
		const claudeCard = createCard({ agentId: "claude" as BoardCard["agentId"] });
		expect(matchesBoardFilter(defaultCard, undefined, { query: "", agentId: "", sessionState: null })).toBe(true);
		expect(matchesBoardFilter(claudeCard, undefined, { query: "", agentId: "", sessionState: null })).toBe(false);
		expect(matchesBoardFilter(claudeCard, undefined, { query: "", agentId: "claude", sessionState: null })).toBe(
			true,
		);
		expect(matchesBoardFilter(defaultCard, undefined, { query: "", agentId: "claude", sessionState: null })).toBe(
			false,
		);
	});

	it("filters by session state, treating a missing session as idle", () => {
		const card = createCard();
		expect(matchesBoardFilter(card, undefined, { query: "", agentId: null, sessionState: "idle" })).toBe(true);
		expect(matchesBoardFilter(card, undefined, { query: "", agentId: null, sessionState: "running" })).toBe(false);
		expect(
			matchesBoardFilter(card, createSessionSummary("running"), {
				query: "",
				agentId: null,
				sessionState: "running",
			}),
		).toBe(true);
		expect(
			matchesBoardFilter(card, createSessionSummary("awaiting_review"), {
				query: "",
				agentId: null,
				sessionState: "awaiting_review",
			}),
		).toBe(true);
	});

	it("combines query, agent, and session state filters", () => {
		const card = createCard({ agentId: "claude" as BoardCard["agentId"] });
		const summary = createSessionSummary("running");
		expect(matchesBoardFilter(card, summary, { query: "login", agentId: "claude", sessionState: "running" })).toBe(
			true,
		);
		expect(matchesBoardFilter(card, summary, { query: "login", agentId: "claude", sessionState: "failed" })).toBe(
			false,
		);
		expect(matchesBoardFilter(card, summary, { query: "nope", agentId: "claude", sessionState: "running" })).toBe(
			false,
		);
	});
});
