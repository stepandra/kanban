import { useCallback, useMemo, useState } from "react";

import type { RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard } from "@/types";

export interface BoardFilterValue {
	query: string;
	agentId: string | null;
	sessionState: RuntimeTaskSessionState | null;
}

export function matchesBoardFilter(
	card: BoardCard,
	sessionSummary: RuntimeTaskSessionSummary | undefined,
	filter: BoardFilterValue,
): boolean {
	const query = filter.query.trim().toLowerCase();
	if (query) {
		const haystack = `${card.title}\n${card.prompt}`.toLowerCase();
		if (!haystack.includes(query)) {
			return false;
		}
	}
	if (filter.agentId !== null && (card.agentId ?? "") !== filter.agentId) {
		return false;
	}
	if (filter.sessionState !== null && (sessionSummary?.state ?? "idle") !== filter.sessionState) {
		return false;
	}
	return true;
}

export interface UseBoardFilterResult {
	query: string;
	setQuery: (query: string) => void;
	agentId: string | null;
	setAgentId: (agentId: string | null) => void;
	sessionState: RuntimeTaskSessionState | null;
	setSessionState: (sessionState: RuntimeTaskSessionState | null) => void;
	isFilterActive: boolean;
	clearFilter: () => void;
	isCardVisible: (card: BoardCard, sessionSummary: RuntimeTaskSessionSummary | undefined) => boolean;
}

export function useBoardFilter(): UseBoardFilterResult {
	const [query, setQuery] = useState("");
	const [agentId, setAgentId] = useState<string | null>(null);
	const [sessionState, setSessionState] = useState<RuntimeTaskSessionState | null>(null);

	const isFilterActive = query.trim() !== "" || agentId !== null || sessionState !== null;

	const clearFilter = useCallback(() => {
		setQuery("");
		setAgentId(null);
		setSessionState(null);
	}, []);

	const isCardVisible = useCallback(
		(card: BoardCard, sessionSummary: RuntimeTaskSessionSummary | undefined) =>
			matchesBoardFilter(card, sessionSummary, { query, agentId, sessionState }),
		[agentId, query, sessionState],
	);

	return useMemo(
		() => ({
			query,
			setQuery,
			agentId,
			setAgentId,
			sessionState,
			setSessionState,
			isFilterActive,
			clearFilter,
			isCardVisible,
		}),
		[agentId, clearFilter, isCardVisible, isFilterActive, query, sessionState],
	);
}
