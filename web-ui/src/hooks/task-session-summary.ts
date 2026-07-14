import type { RuntimeTaskSessionSummary } from "@/runtime/types";

// State can arrive from an action response and the runtime stream out of order.
export function selectNewestTaskSessionSummary(
	left: RuntimeTaskSessionSummary | null,
	right: RuntimeTaskSessionSummary | null,
): RuntimeTaskSessionSummary | null {
	if (!left) {
		return right;
	}
	if (!right) {
		return left;
	}
	return left.updatedAt >= right.updatedAt ? left : right;
}
