// Older Kanban versions persisted synthetic sidebar sessions under this prefix.
// Keep recognizing them so runtime cleanup never treats them as task cards.
const HOME_AGENT_SESSION_NAMESPACE = "__home_agent__";
const HOME_AGENT_SESSION_PREFIX = `${HOME_AGENT_SESSION_NAMESPACE}:`;

export function isHomeAgentSessionId(sessionId: string): boolean {
	return sessionId.startsWith(HOME_AGENT_SESSION_PREFIX);
}
