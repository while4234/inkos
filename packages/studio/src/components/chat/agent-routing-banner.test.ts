import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentRoutingBanner } from "./AgentRoutingBanner";

describe("AgentRoutingBanner", () => {
  it("distinguishes a safe pre-output switch from a post-output interruption", () => {
    const switched = renderToStaticMarkup(React.createElement(AgentRoutingBanner, {
      summary: {
        logicalModelId: "agent-default",
        logicalModelDisplayName: "Studio Agent",
        activeBackendId: "backend-b",
        retryCount: 0,
        switches: [{
          eventId: "request:2",
          requestId: "request",
          type: "backend_switched",
          timestamp: "2026-07-24T00:00:00.000Z",
          logicalModelId: "agent-default",
          logicalModelDisplayName: "Studio Agent",
          phase: "retry",
          fromBackendId: "backend-a",
          toBackendId: "backend-b",
          reason: "quota",
          retryCount: 0,
          visibleOutput: false,
        }],
        lastEventAt: "2026-07-24T00:00:00.000Z",
      },
    }));
    expect(switched).toContain("输出前已切换后端");
    expect(switched).toContain("backend-a");
    expect(switched).toContain("backend-b");
    expect(switched).toContain("Studio Agent");
    expect(switched).toContain("retry");
    expect(switched).toContain("quota");

    const interrupted = renderToStaticMarkup(React.createElement(AgentRoutingBanner, {
      summary: {
        logicalModelId: "agent-default",
        logicalModelDisplayName: "Studio Agent",
        activeBackendId: "backend-b",
        retryCount: 0,
        switches: [],
        lastEventAt: "2026-07-24T00:00:00.000Z",
        terminalState: "interrupted",
      },
      result: {
        logicalModelId: "agent-default",
        attempts: [{
          backendId: "backend-b",
          upstreamModelId: "gpt-route",
          attemptNumber: 1,
          reason: "network",
          visibleOutput: true,
        }],
        switches: [],
        actualBackendId: "backend-b",
        actualModelId: "gpt-route",
        promptFamily: "gpt",
        promptRevision: 1,
        retryCount: 0,
        terminalState: "interrupted",
      },
    }));
    expect(interrupted).toContain("中断");
    expect(interrupted).toContain("未自动切换");
    expect(interrupted).toContain("backend-b");
    expect(interrupted).toContain("gpt-route");
    expect(interrupted).not.toMatch(/authorization|bearer|api.?key|system prompt/i);
  });

  it("renders per-backend unknown usage and cost without a fake zero price", () => {
    const html = renderToStaticMarkup(React.createElement(AgentRoutingBanner, {
      summary: {
        logicalModelId: "agent-default",
        logicalModelDisplayName: "Studio Agent",
        activeBackendId: "backend-b",
        retryCount: 0,
        switches: [{
          eventId: "request:2",
          requestId: "request",
          type: "backend_switched",
          timestamp: "2026-07-24T00:00:00.000Z",
          logicalModelId: "agent-default",
          logicalModelDisplayName: "Studio Agent",
          phase: "selection",
          fromBackendId: "backend-a",
          toBackendId: "backend-b",
          reason: "quota",
          retryCount: 0,
        }],
        lastEventAt: "2026-07-24T00:00:00.000Z",
        trace: {
          version: 1,
          requestId: "request",
          operationId: "request",
          logicalModelId: "agent-default",
          logicalModelDisplayName: "Studio Agent",
          prompt: null,
          context: {},
          attempts: [],
          switches: [],
          backends: [{
            backendId: "backend-a",
            attemptCount: 1,
            localRetryCount: 0,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
            cost: {
              status: "unknown",
              amount: null,
              currency: null,
              priceSource: null,
              priceRevision: null,
            },
          }],
          visibleOutput: false,
          finalBackendId: "backend-b",
          finalModelId: "model-b",
          finalStatus: "succeeded",
        },
      },
    }));
    expect(html).toContain("backend-a");
    expect(html).toContain("unknown");
    expect(html).not.toContain("$0.00");
  });
});
