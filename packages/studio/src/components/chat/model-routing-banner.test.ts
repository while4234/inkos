import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolExecutionSteps } from "./ToolExecutionSteps";

describe("production routing switch banner", () => {
  it("shows the logical model, A to B switch, safe reason, and phase", () => {
    const html = renderToStaticMarkup(React.createElement(ToolExecutionSteps, {
      executions: [{
        id: "task-1",
        tool: "write_next",
        label: "Write next",
        status: "processing",
        startedAt: Date.now(),
        routingSummary: {
          logicalModelId: "route-ab",
          logicalModelDisplayName: "Writer A/B",
          activeBackendId: "backend-b",
          retryCount: 1,
          lastEventAt: "2026-07-24T00:00:00.000Z",
          switches: [{
            eventId: "request-1:3",
            requestId: "request-1",
            type: "backend_switched",
            timestamp: "2026-07-24T00:00:00.000Z",
            logicalModelId: "route-ab",
            logicalModelDisplayName: "Writer A/B",
            phase: "retry",
            fromBackendId: "backend-a",
            toBackendId: "backend-b",
            reason: "quota",
            retryCount: 1,
            context: { taskId: "task-1" },
          }],
        },
      }],
    }));
    expect(html).toContain("Writer A/B");
    expect(html).toContain("backend-a");
    expect(html).toContain("backend-b");
    expect(html).toContain("quota");
    expect(html).toContain("retry");
  });
});
