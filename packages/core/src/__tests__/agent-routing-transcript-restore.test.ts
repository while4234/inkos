import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendTranscriptEvent } from "../interaction/session-transcript.js";
import { deriveBookSessionFromTranscript } from "../interaction/session-transcript-restore.js";
import type { MessageEvent } from "../interaction/session-transcript-schema.js";

describe("Agent routing transcript restore", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-route-restore-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("attaches only the safe route result to the committed assistant turn", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "route-request",
      seq: 1,
      timestamp: 1,
      input: "hello",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "route-request",
      uuid: "assistant-1",
      parentUuid: null,
      seq: 2,
      role: "assistant",
      timestamp: 2,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-route",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        timestamp: 2,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "routing_summary",
      version: 1,
      sessionId: "s1",
      requestId: "route-request",
      seq: 3,
      timestamp: 3,
      logicalModelId: "agent-default",
      attempts: [{
        backendId: "backend-a",
        upstreamModelId: "gpt-route",
        attemptNumber: 1,
        reason: "network",
        visibleOutput: true,
      }],
      switches: [],
      actualBackendId: "backend-a",
      actualModelId: "gpt-route",
      promptFamily: "gpt",
      promptRevision: 2,
      retryCount: 0,
      terminalState: "interrupted",
      trace: {
        version: 1,
        requestId: "route-request",
        operationId: "route-request",
        logicalModelId: "agent-default",
        logicalModelDisplayName: null,
        prompt: null,
        context: { sessionId: "s1" },
        attempts: [],
        switches: [],
        backends: [],
        visibleOutput: true,
        finalBackendId: "backend-a",
        finalModelId: "gpt-route",
        finalStatus: "interrupted",
      },
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_failed",
      version: 1,
      sessionId: "s1",
      requestId: "route-request",
      seq: 4,
      timestamp: 4,
      error: "The provider stream was interrupted after output.",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "thinking-request",
      seq: 5,
      timestamp: 5,
      input: "think",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "thinking-request",
      uuid: "assistant-thinking",
      parentUuid: null,
      seq: 6,
      role: "assistant",
      timestamp: 6,
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "forwarded reasoning", thinkingSignature: "sig" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-route",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        timestamp: 6,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "routing_summary",
      version: 1,
      sessionId: "s1",
      requestId: "thinking-request",
      seq: 7,
      timestamp: 7,
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
      promptRevision: 2,
      retryCount: 0,
      terminalState: "interrupted",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_failed",
      version: 1,
      sessionId: "s1",
      requestId: "thinking-request",
      seq: 8,
      timestamp: 8,
      error: "The provider stream was interrupted after output.",
    });

    const session = await deriveBookSessionFromTranscript(projectRoot, "s1");
    const routingResult = session?.messages[0]?.routingResult;
    expect(routingResult).toMatchObject({
      logicalModelId: "agent-default",
      actualBackendId: "backend-a",
      actualModelId: "gpt-route",
      terminalState: "interrupted",
      trace: {
        version: 1,
        requestId: "route-request",
        finalStatus: "interrupted",
      },
    });
    expect(JSON.stringify(routingResult)).not.toMatch(/authorization|bearer|api.?key|system prompt/i);
    expect(session?.messages[1]).toMatchObject({
      role: "assistant",
      content: "",
      thinking: "forwarded reasoning",
      routingResult: {
        actualBackendId: "backend-b",
        terminalState: "interrupted",
      },
    });
  });
});
