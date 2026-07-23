import { randomUUID } from "node:crypto";
import type { ProviderErrorCategory } from "./provider-error.js";

export const ROUTING_EVENT_TYPES = [
  "attempt_started",
  "local_retry",
  "backend_switched",
  "succeeded",
  "failed",
  "exhausted",
] as const;

export type RoutingEventType = typeof ROUTING_EVENT_TYPES[number];
export type RoutingEventPhase = "selection" | "request" | "retry" | "complete";

export interface RoutingEvent {
  readonly eventId: string;
  readonly requestId: string;
  readonly type: RoutingEventType;
  readonly timestamp: string;
  readonly logicalModelId: string;
  readonly phase: RoutingEventPhase;
  readonly backendId?: string;
  readonly upstreamModelId?: string;
  readonly fromBackendId?: string;
  readonly toBackendId?: string;
  readonly reason?: ProviderErrorCategory | "candidate_unavailable";
  readonly retryCount: number;
  readonly visibleOutput: boolean;
}

export type RoutingEventObserver = (event: RoutingEvent) => void | Promise<void>;

export class RoutingEventEmitter {
  private sequence = 0;

  public constructor(
    public readonly logicalModelId: string,
    private readonly observer?: RoutingEventObserver,
    private readonly now: () => number = Date.now,
    public readonly requestId = randomUUID(),
  ) {}

  public async emit(
    event: Omit<RoutingEvent, "eventId" | "requestId" | "timestamp" | "logicalModelId">,
  ): Promise<void> {
    if (!this.observer) return;
    const sequence = ++this.sequence;
    const routedEvent: RoutingEvent = {
      eventId: `${this.requestId}:${sequence}`,
      requestId: this.requestId,
      timestamp: new Date(this.now()).toISOString(),
      logicalModelId: this.logicalModelId,
      ...event,
    };
    try {
      await this.observer(routedEvent);
    } catch {
      // Observability must not change request success or failover behavior.
    }
  }
}
