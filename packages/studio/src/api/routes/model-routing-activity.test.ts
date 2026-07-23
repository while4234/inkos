import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResilientChatRuntime,
  CredentialResolver,
  classifyProviderError,
  type ModelRoutingConfig,
} from "@actalk/inkos-core";
import { afterEach, describe, expect, it } from "vitest";
import { StudioRoutingActivity } from "./model-routing-activity.js";

describe("Studio production routing observer", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("preserves Core event order and exposes a safe A to B task summary", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-studio-routing-observer-"));
    const routing: ModelRoutingConfig = {
      version: 1,
      credentials: [
        { id: "credential-a", kind: "api_key", label: "A", scope: "project" },
        { id: "credential-b", kind: "api_key", label: "B", scope: "project" },
      ],
      backends: [
        {
          id: "backend-a",
          displayName: "Backend A",
          service: "custom:a",
          provider: "custom",
          baseUrl: "http://127.0.0.1:41001/v1",
          credentialRef: { id: "credential-a", kind: "api_key" },
          enabled: true,
          transport: { apiFormat: "chat", stream: true },
        },
        {
          id: "backend-b",
          displayName: "Backend B",
          service: "custom:b",
          provider: "custom",
          baseUrl: "http://127.0.0.1:41002/v1",
          credentialRef: { id: "credential-b", kind: "api_key" },
          enabled: true,
          transport: { apiFormat: "chat", stream: true },
        },
      ],
      routes: [{
        id: "route-ab",
        displayName: "Writer A/B",
        promptFamily: "none",
        enabled: true,
        candidates: [
          { backendId: "backend-a", upstreamModelId: "fixture-model" },
          { backendId: "backend-b", upstreamModelId: "fixture-model" },
        ],
      }],
      defaultRouteId: "route-ab",
    };
    const activity = new StudioRoutingActivity();
    const calls: string[] = [];
    const runtime = new ResilientChatRuntime({
      routing,
      projectRoot: root,
      baseConfig: {
        provider: "custom",
        service: "custom:a",
        configSource: "studio",
        baseUrl: "http://127.0.0.1:41001/v1",
        apiKey: "",
        model: "fixture-model",
        temperature: 0.7,
        thinkingBudget: 0,
        apiFormat: "chat",
        stream: true,
        routing,
      },
      credentials: new CredentialResolver([{
        kind: "api_key",
        resolve: async (ref) => ({
          kind: "api_key" as const,
          ref,
          apiKey: ref.id === "credential-a" ? "fixture-a" : "fixture-b",
        }),
      }]),
      invoke: async (client) => {
        calls.push(client._routingBackendId!);
        if (client._routingBackendId === "backend-a") {
          throw classifyProviderError({ status: 402 });
        }
        return {
          content: "recovered",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      observer: (event) => {
        activity.record(event, routing, {
          sessionId: "session-1",
          taskId: "task-1",
          bookId: "book-1",
        });
      },
    });

    await expect(runtime.complete("route-ab", [{ role: "user", content: "write" }]))
      .resolves.toMatchObject({ content: "recovered" });
    expect(calls).toEqual(["backend-a", "backend-b"]);
    expect(activity.recent().map((event) => event.type)).toEqual([
      "attempt_started",
      "failed",
      "backend_switched",
      "attempt_started",
      "succeeded",
    ]);
    expect(activity.summary("task-1")).toMatchObject({
      logicalModelDisplayName: "Writer A/B",
      activeBackendId: "backend-b",
      retryCount: 0,
    });
    const serialized = JSON.stringify(activity.recent());
    expect(serialized).not.toContain("fixture-a");
    expect(serialized).not.toContain("fixture-b");
    expect(serialized).not.toContain("Authorization");
  });
});
