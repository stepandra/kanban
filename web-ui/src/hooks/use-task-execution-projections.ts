import { useCallback, useMemo } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskExecutionProjection, RuntimeTaskExecutionProjectionResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import type { BoardData } from "@/types";
import { useInterval } from "@/utils/react-use";

interface UseTaskExecutionProjectionsInput {
	board: BoardData;
	currentProjectId: string | null;
}

export function useTaskExecutionProjections({
	board,
	currentProjectId,
}: UseTaskExecutionProjectionsInput): Record<string, RuntimeTaskExecutionProjection> {
	const attemptByTaskId = useMemo(
		() =>
			Object.fromEntries(
				board.columns.flatMap((column) =>
					column.cards.flatMap((card) => (card.execution ? [[card.id, card.execution] as const] : [])),
				),
			),
		[board.columns],
	);
	const attempts = useMemo(() => Object.values(attemptByTaskId), [attemptByTaskId]);
	const queryFn = useCallback(async (): Promise<RuntimeTaskExecutionProjectionResponse> => {
		if (!currentProjectId) {
			return { generatedAt: Date.now(), attempts: [] };
		}
		return await getRuntimeTrpcClient(currentProjectId).runtime.getTaskExecutionProjections.query({ attempts });
	}, [attempts, currentProjectId]);
	const query = useTrpcQuery({
		enabled: Boolean(currentProjectId && attempts.length > 0),
		queryFn,
		retainDataOnError: true,
	});
	useInterval(
		() => {
			void query.refetch();
		},
		currentProjectId && attempts.length > 0 ? 5_000 : null,
	);
	return useMemo(() => {
		const taskIdByAttemptId = new Map(
			Object.entries(attemptByTaskId).map(([taskId, attempt]) => [attempt.attemptId, taskId]),
		);
		return Object.fromEntries(
			(query.data?.attempts ?? []).flatMap((projection) => {
				const taskId = taskIdByAttemptId.get(projection.attemptId);
				return taskId ? [[taskId, projection] as const] : [];
			}),
		);
	}, [attemptByTaskId, query.data?.attempts]);
}
