import { describe, expect, it } from "vitest";
import { setAppLanguage } from "../lib/app-language";
import type { RoutingActivityEventDTO } from "../shared/contracts";
import {
  apiKeyEditIntent,
  healthRecoveryText,
  mergeRoutingActivity,
} from "./model-routing-state";

function event(eventId: string, timestamp: string): RoutingActivityEventDTO {
  return {
    eventId,
    requestId: "request-1",
    type: "backend_switched",
    timestamp,
    logicalModelId: "route-ab",
    logicalModelDisplayName: "Writer",
    phase: "retry",
    fromBackendId: "backend-a",
    toBackendId: "backend-b",
    reason: "quota",
    retryCount: 1,
  };
}

describe("model routing UI state", () => {
  it("treats blank edits as keep and clear as an explicit separate action", () => {
    expect(apiKeyEditIntent("   ", true, false)).toEqual({ action: "keep" });
    expect(apiKeyEditIntent(" replacement ", true, false)).toEqual({
      action: "replace",
      apiKey: "replacement",
    });
    expect(apiKeyEditIntent("", true, true)).toEqual({ action: "clear" });
  });

  it("does not promise automatic recovery for quota or authentication", () => {
    setAppLanguage("zh");
    expect(healthRecoveryText("quota_exhausted")).toContain("不会自动短时恢复");
    expect(healthRecoveryText("auth_required")).toContain("不会自动短时恢复");
    expect(healthRecoveryText("temporary_cooldown")).toContain("冷却");
    setAppLanguage("en");
    expect(healthRecoveryText("quota_exhausted")).toContain("does not auto-recover");
    expect(healthRecoveryText("auth_required")).toContain("Replace the credential");
    setAppLanguage("zh");
  });

  it("deduplicates reconnect replay and preserves event order", () => {
    expect(mergeRoutingActivity(
      [event("request-1:2", "2026-07-24T00:00:02.000Z")],
      [
        event("request-1:2", "2026-07-24T00:00:02.000Z"),
        event("request-1:1", "2026-07-24T00:00:01.000Z"),
      ],
    ).map((item) => item.eventId)).toEqual(["request-1:1", "request-1:2"]);
  });
});
