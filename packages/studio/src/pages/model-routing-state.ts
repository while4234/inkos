import type {
  BackendHealthStatusDTO,
} from "../shared/contracts";
import { tr } from "../lib/app-language";
export { mergeRoutingActivity } from "../shared/routing-summary";

export type ApiKeyEditIntent =
  | { readonly action: "keep" }
  | { readonly action: "replace"; readonly apiKey: string }
  | { readonly action: "clear" };

export function apiKeyEditIntent(
  draft: string,
  configured: boolean,
  clearRequested: boolean,
): ApiKeyEditIntent {
  if (clearRequested) return { action: "clear" };
  const apiKey = draft.trim();
  if (apiKey) return { action: "replace", apiKey };
  return configured ? { action: "keep" } : { action: "replace", apiKey: "" };
}

export function healthRecoveryText(status: BackendHealthStatusDTO): string {
  switch (status) {
    case "temporary_cooldown":
      return tr("等待冷却结束，或手工 reset/probe", "Wait for cooldown, or reset/probe manually");
    case "quota_exhausted":
      return tr(
        "补充额度后手工 probe；不会自动短时恢复",
        "Restore quota, then probe manually; this does not auto-recover after a short delay",
      );
    case "auth_required":
      return tr(
        "替换凭证后手工 probe；不会自动短时恢复",
        "Replace the credential, then probe manually; this does not auto-recover after a short delay",
      );
    case "disabled":
      return tr("启用后端后再 probe", "Enable the backend before probing");
    case "healthy":
      return tr("可用", "Available");
    case "unknown":
      return tr("尚未探测", "Not probed yet");
  }
}
