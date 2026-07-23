import type {
  ModelRoutingConfig,
  RoutingEvent,
} from "@actalk/inkos-core";
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

  public record(
    event: RoutingEvent,
    routing: ModelRoutingConfig,
    context?: RoutingActivityContextDTO,
  ): RoutingActivityEventDTO {
    const dto = routingActivityEventDTO(event, routing, context);
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
