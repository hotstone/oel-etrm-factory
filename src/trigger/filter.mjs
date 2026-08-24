// Pure webhook-filter logic, extracted for unit testing.
export const AGENT_READY_LABEL = "73c75ba5-3ef4-4517-aaaf-573fdd3cc41b";
export const AGENT_IN_PROGRESS_LABEL = "46bd9a14-51e1-4434-a097-2fa43cdf1cac";

/**
 * Fire only on the transition to agent-ready, never while a run is in flight.
 * Returns { fire: boolean, reason: string }.
 */
export function shouldFire(payload) {
  if (payload.type !== "Issue" || !["create", "update"].includes(payload.action)) {
    return { fire: false, reason: "not an issue create/update" };
  }
  const labels = payload.data?.labelIds ?? [];
  const previous = payload.updatedFrom?.labelIds; // present only when labels changed

  const hasReady = labels.includes(AGENT_READY_LABEL);
  const hadReady = Array.isArray(previous) && previous.includes(AGENT_READY_LABEL);
  const inProgress = labels.includes(AGENT_IN_PROGRESS_LABEL);
  const readyAdded =
    hasReady && (payload.action === "create" || (Array.isArray(previous) && !hadReady));

  if (!readyAdded) return { fire: false, reason: "no agent-ready transition" };
  if (inProgress) return { fire: false, reason: "agent-in-progress set" };
  return { fire: true, reason: "agent-ready added" };
}
