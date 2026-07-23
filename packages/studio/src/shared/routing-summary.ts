import type {
  RoutingActivityEventDTO,
  StudioRoutingSummary,
} from "./contracts.js";

const MAX_TASK_SWITCHES = 20;
const MAX_SUMMARY_EVENT_IDS = 200;

export function mergeRoutingActivity(
  current: ReadonlyArray<RoutingActivityEventDTO>,
  incoming: ReadonlyArray<RoutingActivityEventDTO>,
  limit = 100,
): RoutingActivityEventDTO[] {
  const byId = new Map(current.map((event) => [event.eventId, event]));
  incoming.forEach((event) => byId.set(event.eventId, event));
  return [...byId.values()]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId))
    .slice(-limit);
}

export function reduceRoutingSummary(
  current: StudioRoutingSummary | undefined,
  event: RoutingActivityEventDTO,
): StudioRoutingSummary {
  const recentEventIds = current?.recentEventIds ?? [];
  if (recentEventIds.includes(event.eventId)) return current!;

  const switches = event.type === "backend_switched"
    ? mergeRoutingActivity(current?.switches ?? [], [event], MAX_TASK_SWITCHES)
    : current?.switches ?? [];
  return {
    logicalModelId: event.logicalModelId,
    logicalModelDisplayName: event.logicalModelDisplayName,
    activeBackendId: event.toBackendId ?? event.backendId ?? current?.activeBackendId ?? null,
    activeModelId: event.upstreamModelId ?? current?.activeModelId ?? null,
    retryCount: (current?.retryCount ?? 0) + (event.type === "local_retry" ? 1 : 0),
    switches,
    recentEventIds: [...recentEventIds, event.eventId].slice(-MAX_SUMMARY_EVENT_IDS),
    lastEventAt: event.timestamp,
    terminalState: event.type === "failed"
      ? event.visibleOutput ? "interrupted" : "failed"
      : event.type === "succeeded" || event.type === "exhausted"
        ? event.type
        : current?.terminalState,
  };
}
