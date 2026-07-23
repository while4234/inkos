import type {
  ModelRoutingConfig,
  RoutingEvent,
} from "@actalk/inkos-core";
import { buildRoutingTrace } from "@actalk/inkos-core";
import type {
  RoutingActivityContextDTO,
  RoutingActivityEventDTO,
  StudioRoutingSummary,
} from "../../shared/contracts.js";
import {
  mergeRoutingActivity,
  reduceRoutingSummary,
} from "../../shared/routing-summary.js";
import { routingActivityEventDTO } from "./model-dto.js";

const MAX_RECENT_EVENTS = 100;

export class StudioRoutingActivity {
  private recentEvents: RoutingActivityEventDTO[] = [];
  private summaries = new Map<string, StudioRoutingSummary>();
  private requestEvents = new Map<string, RoutingEvent[]>();

  public record(
    event: RoutingEvent,
    routing: ModelRoutingConfig,
    context?: RoutingActivityContextDTO,
  ): RoutingActivityEventDTO {
    const route = routing.routes.find((candidate) => candidate.id === event.logicalModelId);
    const tracedEvent: RoutingEvent = context
      ? {
          ...event,
          context: {
            ...event.context,
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
            ...(context.taskId ? { taskId: context.taskId } : {}),
            ...(context.taskId ? { operationId: context.taskId } : {}),
            ...(context.bookId ? { bookId: context.bookId } : {}),
            ...(context.chapter ? { chapter: context.chapter } : {}),
            ...(context.agent ? { agent: context.agent } : {}),
          },
        }
      : event;
    const requestEvents = [
      ...(this.requestEvents.get(event.requestId) ?? []),
      tracedEvent,
    ].slice(-400);
    this.requestEvents.set(event.requestId, requestEvents);
    if (this.requestEvents.size > 100) {
      this.requestEvents.delete(this.requestEvents.keys().next().value!);
    }
    const trace = buildRoutingTrace(requestEvents, {
      logicalModelDisplayName: route?.displayName,
    });
    const dto = {
      ...routingActivityEventDTO(event, routing, context),
      ...(trace ? { trace } : {}),
    };
    this.recentEvents = mergeRoutingActivity(
      this.recentEvents,
      [dto],
      MAX_RECENT_EVENTS,
    );
    if (context?.taskId) {
      this.summaries.set(context.taskId, reduceRoutingSummary(
        this.summaries.get(context.taskId),
        dto,
      ));
    }
    return dto;
  }

  public recent(): ReadonlyArray<RoutingActivityEventDTO> {
    return this.recentEvents;
  }

  public summary(taskId: string): StudioRoutingSummary | undefined {
    return this.summaries.get(taskId);
  }

  public clear(taskId: string): void {
    this.summaries.delete(taskId);
  }
}
