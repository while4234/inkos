import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderError } from "../llm/provider-error.js";
import { chatCompletion, createLLMClient } from "../llm/provider.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("native provider transport errors", () => {
  it("preserves HTTP headers and JSON error fields through chatCompletion", async () => {
    let receivedAuthorization = "";
    const server = createServer((request, response) => {
      receivedAuthorization = request.headers.authorization ?? "";
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "7",
        "x-request-id": "request_local_mock_789",
      });
      response.end(JSON.stringify({
        error: {
          code: "rate_limit_exceeded",
          type: "rate_limit_error",
          message: "mock upstream limit",
        },
      }));
    });
    servers.push(server);
    const baseUrl = await listenOnLoopback(server);
    const client = createLLMClient({
      provider: "openai",
      service: "custom",
      configSource: "studio",
      apiFormat: "chat",
      stream: false,
      baseUrl,
      apiKey: "mock-local-key",
      model: "mock-upstream-model",
      temperature: 0.7,
      thinkingBudget: 0,
    });

    const failure = await captureFailure(chatCompletion(
      client,
      "mock-upstream-model",
      [{ role: "user", content: "mock request" }],
      {
        retry: false,
        errorContext: {
          backendId: "backend-local",
          logicalModelId: "writer-default",
          upstreamModelId: "mock-upstream-model",
        },
      },
    ));

    expect(failure).toBeInstanceOf(ProviderError);
    const providerError = failure as ProviderError;
    expect(providerError.category).toBe("rate_limit");
    expect(providerError.status).toBe(429);
    expect(providerError.upstreamCode).toBe("rate_limit_exceeded");
    expect(providerError.upstreamType).toBe("rate_limit_error");
    expect(providerError.retryAfter?.delayMs).toBe(7_000);
    expect(providerError.requestId).toBe("request_local_mock_789");
    expect(providerError.backendId).toBe("backend-local");
    expect(providerError.logicalModelId).toBe("writer-default");
    expect(providerError.upstreamModelId).toBe("mock-upstream-model");
    expect(providerError.cause).toBeInstanceOf(Error);
    expect(receivedAuthorization).toBe("Bearer mock-local-key");
    expect(JSON.stringify(providerError)).not.toContain("mock-local-key");
  });
});

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock provider server did not expose a TCP address.");
  }
  return `http://127.0.0.1:${address.port}/v1`;
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected provider request to fail.");
}
