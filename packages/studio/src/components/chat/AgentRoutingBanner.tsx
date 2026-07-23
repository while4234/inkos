import { AlertTriangle, GitBranch } from "lucide-react";
import type { AgentRoutingSummary } from "@actalk/inkos-core";
import type { StudioRoutingSummary } from "../../shared/contracts";
import { tr } from "../../lib/app-language";
import { RoutingTraceDetails } from "./RoutingTraceDetails";

export interface AgentRoutingBannerProps {
  readonly summary?: StudioRoutingSummary;
  readonly result?: AgentRoutingSummary;
  readonly interruption?: string;
}

export function AgentRoutingBanner({
  summary,
  result,
  interruption,
}: AgentRoutingBannerProps) {
  const interrupted = summary?.terminalState === "interrupted"
    || result?.terminalState === "interrupted"
    || Boolean(interruption);
  if (interrupted) {
    const attempted = result
      ? [...new Map(result.attempts.map((attempt) => [
          `${attempt.backendId}\0${attempt.upstreamModelId}`,
          `${attempt.backendId} / ${attempt.upstreamModelId}`,
        ])).values()]
      : summary?.activeBackendId
        ? [`${summary.activeBackendId}${summary.activeModelId ? ` / ${summary.activeModelId}` : ""}`]
        : [];
    return (
      <div
        className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200"
        role="status"
      >
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>
          <span className="font-medium">
            {summary?.logicalModelDisplayName ?? result?.logicalModelId ?? summary?.logicalModelId}
          </span>
          {": "}
          {interruption ?? tr(
            "模型流在已产生内容后中断；为避免重复文本或工具调用，本次未自动切换后端。",
            "The model stream was interrupted after output; no backend switch was attempted to avoid replaying text or tool calls.",
          )}
          {attempted.length > 0 ? (
            <span className="mt-1 block">
              {tr("已尝试", "Attempted")}: {attempted.join(", ")}
            </span>
          ) : null}
          <RoutingTraceDetails trace={summary?.trace ?? result?.trace} />
        </span>
      </div>
    );
  }

  const liveSwitch = summary?.switches.at(-1);
  const persistedSwitch = result?.switches.at(-1);
  const fromBackendId = liveSwitch?.fromBackendId ?? persistedSwitch?.fromBackendId;
  const toBackendId = liveSwitch?.toBackendId ?? persistedSwitch?.toBackendId;
  if (!fromBackendId || !toBackendId) return null;

  return (
    <div
      className="mb-2 flex items-center gap-2 rounded-lg border border-sky-500/25 bg-sky-500/8 px-3 py-2 text-xs text-sky-800 dark:text-sky-200"
      role="status"
    >
      <GitBranch size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">
          {summary?.logicalModelDisplayName ?? result?.logicalModelId ?? summary?.logicalModelId}
        </span>
        {" · "}
        {tr("输出前已切换后端", "Switched backend before output")}
        {liveSwitch?.phase ? ` [${liveSwitch.phase}]` : ""}:{" "}
        <code>{fromBackendId}</code> → <code>{toBackendId}</code>
        {liveSwitch?.reason || persistedSwitch?.reason
          ? ` (${liveSwitch?.reason ?? persistedSwitch?.reason})`
          : ""}
        <RoutingTraceDetails trace={summary?.trace ?? result?.trace} />
      </span>
    </div>
  );
}
