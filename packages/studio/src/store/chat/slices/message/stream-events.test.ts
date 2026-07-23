import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";
import {
  MAX_TOOL_LOGS,
  applyStreamTextDeltas,
  appendBoundedToolLogs,
  applyRoutingEventToAgentMessages,
  applyRoutingEventToTaskMessages,
  createLatestEventThrottle,
  createStreamTextDeltaBatcher,
  routingEventTarget,
} from "./stream-events";

describe("stream event performance helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies queued text deltas in their original order", () => {
    const parts = applyStreamTextDeltas(
      [{ type: "thinking", content: "why", streaming: true }],
      [
        { kind: "thinking", text: " it matters" },
        { kind: "text", text: "Answer " },
        { kind: "text", text: "body." },
      ],
    );

    expect(parts).toEqual([
      { type: "thinking", content: "why it matters", streaming: true },
      { type: "text", content: "Answer body." },
    ]);
  });

  it("batches many text deltas into one scheduled flush", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batcher = createStreamTextDeltaBatcher(flush, 50);

    for (let i = 0; i < 100; i += 1) {
      batcher.enqueue({ kind: "text", text: "x" });
    }

    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(49);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0]).toHaveLength(100);
  });

  it("flushes queued text immediately before structural stream events", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batcher = createStreamTextDeltaBatcher(flush, 50);

    batcher.enqueue({ kind: "text", text: "before tool" });
    batcher.flush();
    vi.advanceTimersByTime(50);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([{ kind: "text", text: "before tool" }]);
  });

  it("throttles frequent progress events and publishes the latest one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const publish = vi.fn();
    const throttle = createLatestEventThrottle<string>(publish, 1000);

    throttle.enqueue("first");
    throttle.enqueue("second");
    throttle.enqueue("third");

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith("first");

    vi.advanceTimersByTime(999);
    expect(publish).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith("third");
  });

  it("keeps only recent tool logs", () => {
    const existing = Array.from({ length: MAX_TOOL_LOGS + 20 }, (_, i) => `old-${i}`);
    const logs = appendBoundedToolLogs(existing, ["latest"]);

    expect(logs).toHaveLength(MAX_TOOL_LOGS);
    expect(logs[0]).toBe("old-21");
    expect(logs.at(-1)).toBe("latest");
  });

  it("applies ordered routing attempt, retry, switch, and exhausted events to a task card", () => {
    const taskId = "task-1";
    let messages: Message[] = [{
      role: "assistant" as const,
      content: "",
      timestamp: 1,
      parts: [{
        type: "tool" as const,
        execution: {
          id: taskId,
          tool: "write_next",
          label: "Write next",
          status: "processing" as const,
          startedAt: 1,
        },
      }],
    }];
    const base = {
      requestId: "request-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      logicalModelId: "route-ab",
      logicalModelDisplayName: "Writer",
      phase: "request" as const,
      retryCount: 0,
      context: { sessionId: "session-1", taskId },
    };
    for (const event of [
      { ...base, eventId: "request-1:1", type: "attempt_started" as const, backendId: "backend-a" },
      { ...base, eventId: "request-1:2", type: "local_retry" as const, phase: "retry" as const, backendId: "backend-a", retryCount: 1 },
      { ...base, eventId: "request-1:3", type: "backend_switched" as const, phase: "retry" as const, fromBackendId: "backend-a", toBackendId: "backend-b", reason: "quota", retryCount: 1 },
      { ...base, eventId: "request-1:3", type: "backend_switched" as const, phase: "retry" as const, fromBackendId: "backend-a", toBackendId: "backend-b", reason: "quota", retryCount: 1 },
      { ...base, eventId: "request-1:4", type: "exhausted" as const, phase: "complete" as const, backendId: "backend-b", retryCount: 2 },
    ]) {
      messages = applyRoutingEventToTaskMessages(messages, taskId, event) as Message[];
    }
    const part = messages[0]?.parts?.[0];
    expect(part?.type).toBe("tool");
    const execution = part?.type === "tool" ? part.execution : undefined;
    expect(execution?.routingSummary).toMatchObject({
      logicalModelDisplayName: "Writer",
      activeBackendId: "backend-b",
      retryCount: 1,
    });
    expect(execution?.routingSummary?.switches).toHaveLength(1);
  });

  it("deduplicates replayed Agent routing events and marks post-output failure as interrupted", () => {
    let messages: Message[] = [{
      role: "assistant",
      content: "previous",
      timestamp: 1,
      parts: [{ type: "text", content: "previous" }],
    }, {
      role: "assistant",
      content: "partial",
      timestamp: 2,
      parts: [{ type: "text", content: "partial" }],
    }];
    const base = {
      requestId: "agent-request-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      logicalModelId: "agent-default",
      logicalModelDisplayName: "Studio Agent",
      phase: "request" as const,
      retryCount: 0,
      context: { sessionId: "session-1" },
    };
    const switchEvent = {
      ...base,
      eventId: "agent-request-1:1",
      type: "backend_switched" as const,
      phase: "retry" as const,
      fromBackendId: "backend-a",
      toBackendId: "backend-b",
      reason: "quota",
    };
    messages = applyRoutingEventToAgentMessages(messages, 2, switchEvent) as Message[];
    expect(applyRoutingEventToAgentMessages(messages, 2, switchEvent)).toBeNull();
    messages = applyRoutingEventToAgentMessages(messages, 2, {
      ...base,
      eventId: "agent-request-1:2",
      type: "failed",
      backendId: "backend-b",
      reason: "network",
      visibleOutput: true,
    }) as Message[];

    expect(messages[0]?.routingSummary).toBeUndefined();
    expect(messages[1]?.routingSummary).toMatchObject({
      activeBackendId: "backend-b",
      terminalState: "interrupted",
    });
    expect(messages[1]?.routingSummary?.switches).toHaveLength(1);
    expect(messages[1]?.routingInterruption).toContain("中断");
  });

  it("creates the current assistant shell for pre-output routing without mutating the previous turn", () => {
    const previous: Message = {
      role: "assistant",
      content: "previous answer",
      timestamp: 10,
    };
    const messages = applyRoutingEventToAgentMessages([previous], 20, {
      eventId: "pre-output:1",
      requestId: "pre-output",
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
      context: { sessionId: "session-1" },
    }) as Message[];

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(previous);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      timestamp: 20,
      routingSummary: {
        activeBackendId: "backend-b",
      },
    });
  });

  it("routes only explicit surface-Agent events to the chat turn", () => {
    const base = {
      eventId: "request:1",
      requestId: "request",
      type: "attempt_started" as const,
      timestamp: "2026-07-24T00:00:00.000Z",
      logicalModelId: "route",
      logicalModelDisplayName: "Route",
      phase: "request" as const,
      retryCount: 0,
    };
    expect(routingEventTarget({ ...base, context: { sessionId: "s", scope: "agent" } }))
      .toEqual({ kind: "agent" });
    expect(routingEventTarget({ ...base, context: { sessionId: "s", taskId: "task-1" } }))
      .toEqual({ kind: "task", taskId: "task-1" });
    expect(routingEventTarget({ ...base, context: { sessionId: "s" } }))
      .toEqual({ kind: "ignore" });
  });
});
