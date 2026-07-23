import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, KeyRound, Loader2, Network, Plus, RefreshCw, Trash2 } from "lucide-react";
import { fetchJson } from "../hooks/use-api";
import { tr } from "../lib/app-language";
import type {
  BackendHealthDTO,
  BackendInstanceDTO,
  CredentialStatusDTO,
  LogicalModelRouteDTO,
  RoutingActivityEventDTO,
  StudioPromptFamily,
} from "../shared/contracts";
import { apiKeyEditIntent, healthRecoveryText } from "./model-routing-state";

interface Nav {
  readonly toServices: () => void;
  readonly toProjectSettings: () => void;
}

interface RoutingView {
  readonly revision: string;
  readonly backends: ReadonlyArray<BackendInstanceDTO>;
  readonly credentials: ReadonlyArray<CredentialStatusDTO>;
  readonly routes: ReadonlyArray<LogicalModelRouteDTO>;
  readonly health: ReadonlyArray<BackendHealthDTO>;
  readonly activity: ReadonlyArray<RoutingActivityEventDTO>;
  readonly overrides: Readonly<Record<string, unknown>>;
}

const fieldClass = "w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm";

export function ModelRoutingPage({ nav }: { nav: Nav }) {
  const [view, setView] = useState<RoutingView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [backendId, setBackendId] = useState("");
  const [backendName, setBackendName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [routeId, setRouteId] = useState("");
  const [routeName, setRouteName] = useState("");
  const [upstreamModel, setUpstreamModel] = useState("");
  const [promptFamily, setPromptFamily] = useState<StudioPromptFamily>("none");
  const [selectedBackends, setSelectedBackends] = useState<string[]>([]);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [agentName, setAgentName] = useState("");
  const [agentRouteId, setAgentRouteId] = useState("");

  const reload = useCallback(async () => {
    setError("");
    try {
      const [backendPayload, authPayload, routePayload, healthPayload, overridePayload] = await Promise.all([
        fetchJson<{ revision: string; backends: BackendInstanceDTO[] }>("/model-backends"),
        fetchJson<{ credentials: CredentialStatusDTO[] }>("/model-auth"),
        fetchJson<{ revision: string; routes: LogicalModelRouteDTO[] }>("/model-routes"),
        fetchJson<{ backends: BackendHealthDTO[]; recentActivity: RoutingActivityEventDTO[] }>("/model-health"),
        fetchJson<{ overrides: Record<string, unknown> }>("/project/model-overrides"),
      ]);
      setView({
        revision: routePayload.revision,
        backends: backendPayload.backends,
        credentials: authPayload.credentials,
        routes: routePayload.routes,
        health: healthPayload.backends,
        activity: healthPayload.recentActivity,
        overrides: overridePayload.overrides,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr("读取模型路由失败", "Failed to load model routing"));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const run = async (name: string, operation: () => Promise<void>) => {
    setBusy(name);
    setError("");
    try {
      await operation();
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr("操作失败", "Operation failed"));
    } finally {
      setBusy("");
    }
  };

  const healthByBackend = useMemo(
    () => new Map((view?.health ?? []).map((health) => [health.backendId, health])),
    [view?.health],
  );

  if (!view) {
    return <div role="status" className="flex items-center gap-2 text-sm"><Loader2 className="animate-spin" size={16} />{error || tr("加载中", "Loading")}</div>;
  }

  const createBackend = () => run("create-backend", async () => {
    const id = backendId.trim();
    const credentialId = `credential-${id}`;
    await fetchJson("/model-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: view.revision,
        credential: { id: credentialId, kind: "api_key", label: `${backendName.trim()} API Key`, scope: "project" },
        backend: {
          id,
          displayName: backendName.trim(),
          service: `custom:${id}`,
          provider: "custom",
          baseUrl: baseUrl.trim(),
          credentialRef: { id: credentialId, kind: "api_key" },
          enabled: true,
          transport: { apiFormat: "chat", stream: true },
        },
        apiKey: apiKey.trim(),
      }),
    });
    setBackendId("");
    setBackendName("");
    setBaseUrl("");
    setApiKey("");
  });

  const createRoute = () => run("create-route", async () => {
    await fetchJson("/model-routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: view.revision,
        route: {
          id: routeId.trim(),
          displayName: routeName.trim(),
          promptFamily,
          enabled: true,
          candidates: selectedBackends.map((candidate) => ({
            backendId: candidate,
            upstreamModelId: upstreamModel.trim(),
          })),
        },
      }),
    });
    setRouteId("");
    setRouteName("");
    setUpstreamModel("");
    setSelectedBackends([]);
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl">{tr("模型连续性", "Model continuity")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{tr("凭证只显示状态和掩码；路由按候选顺序切换。", "Credentials expose only status and masks; routes fail over in candidate order.")}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={nav.toServices} className="rounded-lg border px-3 py-2 text-sm">{tr("服务商", "Providers")}</button>
          <button onClick={nav.toProjectSettings} className="rounded-lg border px-3 py-2 text-sm">{tr("Agent 覆盖", "Agent overrides")}</button>
          <button onClick={() => void reload()} aria-label={tr("刷新", "Refresh")} className="rounded-lg border p-2"><RefreshCw size={16} /></button>
        </div>
      </div>

      {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}

      <section className="space-y-3 rounded-xl border border-border/50 p-4">
        <h2 className="flex items-center gap-2 font-medium"><Plus size={16} />{tr("新增 API Key 后端", "Add API Key backend")}</h2>
        <div className="grid gap-2 md:grid-cols-4">
          <label className="text-xs">{tr("稳定 ID", "Stable ID")}<input aria-label="Backend ID" value={backendId} onChange={(e) => setBackendId(e.target.value)} className={fieldClass} /></label>
          <label className="text-xs">{tr("显示名称", "Display name")}<input aria-label="Backend name" value={backendName} onChange={(e) => setBackendName(e.target.value)} className={fieldClass} /></label>
          <label className="text-xs">Endpoint<input aria-label="Backend endpoint" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={fieldClass} /></label>
          <label className="text-xs">API Key<input aria-label="Backend API Key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className={fieldClass} /></label>
        </div>
        <button disabled={busy !== "" || !backendId.trim() || !backendName.trim() || !baseUrl.trim() || !apiKey.trim()} onClick={createBackend} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{tr("创建后端", "Create backend")}</button>
      </section>

      <section className="space-y-3 rounded-xl border border-border/50 p-4">
        <h2 className="flex items-center gap-2 font-medium"><KeyRound size={16} />{tr("后端与健康", "Backends and health")}</h2>
        {view.backends.map((backend) => {
          const health = healthByBackend.get(backend.id);
          const draft = keyDrafts[backend.credential.id] ?? "";
          return (
            <article key={backend.id} className="rounded-lg border border-border/40 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium">{backend.displayName} <span className="font-mono text-xs text-muted-foreground">{backend.id}</span></div>
                  <div title={backend.baseUrl} className="max-w-2xl truncate font-mono text-xs text-muted-foreground">{backend.baseUrl}</div>
                  <div className="mt-1 text-xs">{health?.status ?? "unknown"} · {healthRecoveryText(health?.status ?? "unknown")}</div>
                  <div className="text-xs text-muted-foreground">{backend.credential.configured ? backend.credential.maskedHint : tr("未配置凭证", "Credential not configured")}</div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => void navigator.clipboard?.writeText(backend.baseUrl)}
                    className="rounded border px-2 py-1 text-xs"
                  >{tr("复制 URL", "Copy URL")}</button>
                  <button onClick={() => run(`probe-${backend.id}`, () => fetchJson(`/model-health/${encodeURIComponent(backend.id)}/probe`, { method: "POST" }).then(() => undefined))} className="rounded border px-2 py-1 text-xs">Probe</button>
                  <button onClick={() => run(`reset-${backend.id}`, () => fetchJson(`/model-health/${encodeURIComponent(backend.id)}/reset`, { method: "POST" }).then(() => undefined))} className="rounded border px-2 py-1 text-xs">Reset</button>
                  <button
                    onClick={() => run(`toggle-${backend.id}`, () => fetchJson(`/model-backends/${encodeURIComponent(backend.id)}`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        revision: view.revision,
                        backend: {
                          id: backend.id,
                          displayName: backend.displayName,
                          service: backend.service,
                          provider: backend.provider,
                          baseUrl: backend.baseUrl,
                          credentialRef: { id: backend.credential.id, kind: backend.credential.kind },
                          enabled: !backend.enabled,
                          transport: backend.transport,
                        },
                      }),
                    }).then(() => undefined))}
                    className="rounded border px-2 py-1 text-xs"
                  >{backend.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}</button>
                  <button
                    aria-label={`Delete backend ${backend.id}`}
                    onClick={() => {
                      if (!window.confirm(tr(`删除后端 ${backend.displayName}？`, `Delete backend ${backend.displayName}?`))) return;
                      void run(`delete-backend-${backend.id}`, () => fetchJson(`/model-backends/${encodeURIComponent(backend.id)}`, {
                        method: "DELETE",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ revision: view.revision }),
                      }).then(() => undefined));
                    }}
                    className="rounded border border-destructive/40 p-1 text-destructive"
                  ><Trash2 size={14} /></button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <input aria-label={`Replace key for ${backend.id}`} type="password" autoComplete="new-password" value={draft} onChange={(e) => setKeyDrafts((value) => ({ ...value, [backend.credential.id]: e.target.value }))} placeholder={tr("留空保持不变", "Leave blank to keep")} className={`${fieldClass} max-w-sm`} />
                <button
                  disabled={!draft.trim()}
                  onClick={() => run(`key-${backend.id}`, async () => {
                    const intent = apiKeyEditIntent(draft, backend.credential.configured, false);
                    if (intent.action !== "replace" || !intent.apiKey) return;
                    await fetchJson(`/model-auth/${encodeURIComponent(backend.credential.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: intent.apiKey }) });
                    setKeyDrafts((value) => ({ ...value, [backend.credential.id]: "" }));
                  })}
                  className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                >{tr("替换", "Replace")}</button>
                <button
                  onClick={() => {
                    if (!window.confirm(tr(
                      `清除 ${backend.displayName} 的 API Key？`,
                      `Clear the API Key for ${backend.displayName}?`,
                    ))) return;
                    void run(`clear-${backend.id}`, async () => {
                      await fetchJson(`/model-auth/${encodeURIComponent(backend.credential.id)}`, {
                        method: "DELETE",
                      });
                      setKeyDrafts((value) => ({ ...value, [backend.credential.id]: "" }));
                    });
                  }}
                  className="rounded border border-destructive/40 px-2 py-1 text-xs text-destructive"
                >{tr("清除", "Clear")}</button>
              </div>
            </article>
          );
        })}
      </section>

      <section className="space-y-3 rounded-xl border border-border/50 p-4">
        <h2 className="flex items-center gap-2 font-medium"><Network size={16} />{tr("逻辑模型路由", "Logical model routes")}</h2>
        <div className="grid gap-2 md:grid-cols-4">
          <input aria-label="Route ID" value={routeId} onChange={(e) => setRouteId(e.target.value)} placeholder="route-writing" className={fieldClass} />
          <input aria-label="Route name" value={routeName} onChange={(e) => setRouteName(e.target.value)} placeholder={tr("显示名称", "Display name")} className={fieldClass} />
          <input aria-label="Upstream model" value={upstreamModel} onChange={(e) => setUpstreamModel(e.target.value)} placeholder="upstream model" className={fieldClass} />
          <select aria-label="Prompt family" value={promptFamily} onChange={(e) => setPromptFamily(e.target.value as StudioPromptFamily)} className={fieldClass}>
            {["gpt", "grok", "deepseek", "none"].map((family) => <option key={family}>{family}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          {view.backends.map((backend) => (
            <label key={backend.id} className="flex items-center gap-1 rounded border px-2 py-1 text-xs">
              <input type="checkbox" checked={selectedBackends.includes(backend.id)} onChange={(e) => setSelectedBackends((items) => e.target.checked ? [...items, backend.id] : items.filter((id) => id !== backend.id))} />
              {backend.displayName}
            </label>
          ))}
        </div>
        <button disabled={busy !== "" || !routeId.trim() || !routeName.trim() || !upstreamModel.trim() || selectedBackends.length === 0} onClick={createRoute} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{tr("创建路由", "Create route")}</button>
        {view.routes.map((route) => (
          <article key={route.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/40 p-3">
            <div>
              <div className="font-medium">{route.displayName} {route.isDefault && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">default</span>}</div>
              <div className="text-xs text-muted-foreground">{route.promptFamily}</div>
              <ol className="mt-1 space-y-1">
                {route.candidates.map((candidate, index) => (
                  <li key={`${candidate.backendId}:${candidate.upstreamModelId}`} className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                    <span>{index + 1}. {candidate.backendId}:{candidate.upstreamModelId}</span>
                    <button
                      aria-label={`Move ${candidate.backendId} up`}
                      disabled={index === 0}
                      onClick={() => run(`move-${route.id}-${index}-up`, async () => {
                        const candidates = [...route.candidates];
                        [candidates[index - 1], candidates[index]] = [candidates[index]!, candidates[index - 1]!];
                        await fetchJson(`/model-routes/${encodeURIComponent(route.id)}`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            revision: view.revision,
                            route: {
                              id: route.id,
                              displayName: route.displayName,
                              promptFamily: route.promptFamily,
                              enabled: route.enabled,
                              candidates,
                            },
                          }),
                        });
                      })}
                      className="rounded border px-1 disabled:opacity-30"
                    >↑</button>
                    <button
                      aria-label={`Move ${candidate.backendId} down`}
                      disabled={index === route.candidates.length - 1}
                      onClick={() => run(`move-${route.id}-${index}-down`, async () => {
                        const candidates = [...route.candidates];
                        [candidates[index], candidates[index + 1]] = [candidates[index + 1]!, candidates[index]!];
                        await fetchJson(`/model-routes/${encodeURIComponent(route.id)}`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            revision: view.revision,
                            route: {
                              id: route.id,
                              displayName: route.displayName,
                              promptFamily: route.promptFamily,
                              enabled: route.enabled,
                              candidates,
                            },
                          }),
                        });
                      })}
                      className="rounded border px-1 disabled:opacity-30"
                    >↓</button>
                  </li>
                ))}
              </ol>
            </div>
            <div className="flex gap-2">
              {!route.isDefault && <button onClick={() => run(`default-${route.id}`, () => fetchJson(`/model-routes/${encodeURIComponent(route.id)}/default`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: view.revision }) }).then(() => undefined))} className="rounded border px-2 py-1 text-xs">{tr("设为默认", "Set default")}</button>}
              {!route.isDefault && <button aria-label={`Delete ${route.id}`} onClick={() => {
                if (!window.confirm(tr(`删除路由 ${route.displayName}？`, `Delete route ${route.displayName}?`))) return;
                void run(`delete-${route.id}`, () => fetchJson(`/model-routes/${encodeURIComponent(route.id)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: view.revision }) }).then(() => undefined));
              }} className="rounded border border-destructive/40 p-1 text-destructive"><Trash2 size={14} /></button>}
            </div>
          </article>
        ))}
      </section>

      <section className="space-y-3 rounded-xl border border-border/50 p-4">
        <h2 className="font-medium">{tr("Agent 路由覆盖", "Agent route override")}</h2>
        <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
          <label className="text-xs">{tr("Agent 名称", "Agent name")}<input aria-label="Agent name" value={agentName} onChange={(event) => setAgentName(event.target.value)} className={fieldClass} /></label>
          <label className="text-xs">{tr("逻辑路由", "Logical route")}
            <select aria-label="Agent route" value={agentRouteId} onChange={(event) => setAgentRouteId(event.target.value)} className={fieldClass}>
              <option value="">{tr("选择路由", "Select route")}</option>
              {view.routes.map((route) => <option key={route.id} value={route.id}>{route.displayName} ({route.id})</option>)}
            </select>
          </label>
          <button
            disabled={!agentName.trim() || !agentRouteId}
            onClick={() => run("agent-route", () => fetchJson("/project/model-overrides", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                overrides: {
                  ...view.overrides,
                  [agentName.trim()]: { routeId: agentRouteId },
                },
              }),
            }).then(() => undefined))}
            className="self-end rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >{tr("保存覆盖", "Save override")}</button>
        </div>
        <pre className="max-h-32 overflow-auto rounded bg-secondary/30 p-2 text-xs">{JSON.stringify(view.overrides, null, 2)}</pre>
      </section>

      <section className="space-y-2 rounded-xl border border-border/50 p-4">
        <h2 className="flex items-center gap-2 font-medium"><Activity size={16} />{tr("最近路由活动", "Recent routing activity")}</h2>
        {view.activity.length === 0 && <p className="text-sm text-muted-foreground">{tr("暂无生产路由事件；Studio Agent 路径将在 PR-08 接入。", "No production routing events yet; Studio Agent routing arrives in PR-08.")}</p>}
        {view.activity.slice(-20).reverse().map((event) => (
          <div key={event.eventId} className="text-xs text-muted-foreground">
            {event.logicalModelDisplayName} · {event.type} · {event.fromBackendId ? `${event.fromBackendId} → ${event.toBackendId}` : event.backendId} · {event.reason ?? event.phase}
          </div>
        ))}
      </section>
    </div>
  );
}
