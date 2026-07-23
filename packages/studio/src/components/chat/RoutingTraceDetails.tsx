import type { RoutingTrace } from "@actalk/inkos-core";
import { tr } from "../../lib/app-language";

export function RoutingTraceDetails({ trace }: { readonly trace?: RoutingTrace }) {
  if (!trace) return null;
  return (
    <div className="mt-2 space-y-1 rounded-md border border-border/40 bg-background/50 p-2 text-[11px]">
      <div>
        <span className="font-medium">{tr("实际模型", "Actual model")}</span>:{" "}
        <code>{trace.finalBackendId ?? "unknown"} / {trace.finalModelId ?? "unknown"}</code>
        {" · "}
        {tr("状态", "status")}: {trace.finalStatus}
        {" · "}
        {tr("重试", "retries")}: {trace.backends.reduce(
          (total, backend) => total + backend.localRetryCount,
          0,
        )}
      </div>
      {trace.switches.length > 0 ? (
        <div>
          <span className="font-medium">{tr("切换", "Switches")}</span>:{" "}
          {trace.switches.map((item) =>
            `${item.fromBackendId} → ${item.toBackendId} (${item.reason})`
          ).join(" · ")}
        </div>
      ) : null}
      {trace.backends.map((backend) => (
        <div key={backend.backendId}>
          <code>{backend.backendId}</code>:{" "}
          {tr("输入", "in")} {formatTokens(backend.inputTokens)},{" "}
          {tr("输出", "out")} {formatTokens(backend.outputTokens)},{" "}
          {tr("缓存", "cache")} {formatTokens(backend.cacheReadTokens)},{" "}
          {tr("推理", "reasoning")} {formatTokens(backend.reasoningTokens)},{" "}
          {tr("成本", "cost")} {formatCost(backend.cost)}
        </div>
      ))}
    </div>
  );
}

function formatTokens(value: number | null): string {
  return value === null ? "unknown" : value.toLocaleString();
}

function formatCost(cost: RoutingTrace["backends"][number]["cost"]): string {
  if (cost.status === "unknown" || cost.amount === null || !cost.currency) return "unknown";
  const amount = cost.amount === 0
    ? "0"
    : cost.amount < 0.000001
      ? cost.amount.toExponential(3)
      : cost.amount.toFixed(6);
  return `${cost.currency} ${amount}`;
}
