import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, KeyRound, Loader2, Network, Plus, RefreshCw, Trash2 } from "lucide-react";
import { fetchJson } from "../hooks/use-api";
import { tr } from "../lib/app-language";
import type {
  BackendHealthDTO,
  BackendInstanceDTO,
  CodexDiscoveryCandidateDTO,
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
  readonly codexCandidates: ReadonlyArray<CodexDiscoveryCandidateDTO>;
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
  const [promptFamily, setPromptFamily] = useState<StudioPromptFamily>("gpt");
  const [selectedBackends, setSelectedBackends] = useState<string[]>([]);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [agentName, setAgentName] = useState("");
  const [agentRouteId, setAgentRouteId] = useState("");
  const [codexCredentialId, setCodexCredentialId] = useState("credential-codex");
  const [codexLabel, setCodexLabel] = useState("Codex CLI");
  const [codexBackendId, setCodexBackendId] = useState("backend-codex");
  const [codexBackendName, setCodexBackendName] = useState("Codex");
  const [codexCredentialForBackend, setCodexCredentialForBackend] = useState("");

  const reload = useCallback(async () => {
    setError("");
    try {
      const [backendPayload, authPayload, routePayload, healthPayload, overridePayload, discoveryPayload] = await Promise.all([
        fetchJson<{ revision: string; backends: BackendInstanceDTO[] }>("/model-backends"),
        fetchJson<{ credentials: CredentialStatusDTO[] }>("/model-auth"),
        fetchJson<{ revision: string; routes: LogicalModelRouteDTO[] }>("/model-routes"),
        fetchJson<{ backends: BackendHealthDTO[]; recentActivity: RoutingActivityEventDTO[] }>("/model-health"),
        fetchJson<{ overrides: Record<string, unknown> }>("/project/model-overrides"),
        fetchJson<{ candidates: CodexDiscoveryCandidateDTO[] }>("/model-auth/codex/discovery"),
      ]);
      setView({
        revision: routePayload.revision,
        backends: backendPayload.backends,
        credentials: authPayload.credentials,
        routes: routePayload.routes,
        health: healthPayload.backends,
        activity: healthPayload.recentActivity,
        overrides: overridePayload.overrides,
        codexCandidates: discoveryPayload.candidates,
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

  const importCodexCandidate = (candidateId: string) =>
    run("import-codex", async () => {
      await fetchJson("/model-auth/codex/import-discovered", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: view.revision,
          credentialId: codexCredentialId.trim(),
          label: codexLabel.trim(),
          candidateId,
          mode: "copy",
        }),
      });
    });

  const importCodexFile = (file: File) =>
    run("upload-codex", async () => {
      const existing = view.credentials.some(
        (credential) => credential.id === codexCredentialId.trim() && credential.kind === "codex",
      );
      await fetchJson(existing
        ? `/model-auth/codex/${encodeURIComponent(codexCredentialId.trim())}`
        : "/model-auth/codex/import", {
        method: existing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: view.revision,
          credentialId: codexCredentialId.trim(),
          label: codexLabel.trim(),
          fileName: file.name,
          content: await file.text(),
        }),
      });
    });

  const createCodexBackend = () =>
    run("create-codex-backend", async () => {
      await fetchJson("/model-backends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: view.revision,
          existingCredential: true,
          backend: {
            id: codexBackendId.trim(),
            displayName: codexBackendName.trim(),
            service: "codex",
            provider: "openai",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            credentialRef: {
              id: codexCredentialForBackend,
              kind: "codex",
            },
            enabled: true,
            transport: { apiFormat: "responses", stream: true },
          },
        }),
      });
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
        <h2 className="flex items-center gap-2 font-medium"><KeyRound size={16} />{tr("使用 Codex 登录凭证", "Use Codex login credentials")}</h2>
        <p className="text-sm text-muted-foreground">
          {tr(
            "导入并使用已有 Codex CLI 登录凭证；这不是在 InkOS 中进行浏览器 OAuth 登录。默认复制到 InkOS 用户级凭证目录，外部 auth.json 不会被修改或删除。",
            "Import and use an existing Codex CLI login credential. This is not browser OAuth inside InkOS. The default imports a copy into the user-level InkOS credential directory; the external auth.json is never modified or deleted.",
          )}
        </p>
        <div className="grid gap-2 md:grid-cols-3">
          <label className="text-xs">{tr("凭证 ID", "Credential ID")}<input aria-label="Codex credential ID" value={codexCredentialId} onChange={(event) => setCodexCredentialId(event.target.value)} className={fieldClass} /></label>
          <label className="text-xs">{tr("显示名称", "Display name")}<input aria-label="Codex credential label" value={codexLabel} onChange={(event) => setCodexLabel(event.target.value)} className={fieldClass} /></label>
          <label className="text-xs">{tr("上传 auth.json（导入或重新导入）", "Upload auth.json (import or re-import)")}
            <input
              aria-label="Upload Codex auth JSON"
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importCodexFile(file);
                event.currentTarget.value = "";
              }}
              className={fieldClass}
            />
          </label>
        </div>
        <div className="space-y-2">
          {view.codexCandidates.map((candidate) => (
            <div key={candidate.candidateId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/40 p-2 text-xs">
              <span>
                {candidate.sources.join(" → ")} · {candidate.safeFileName} · {candidate.state}
                {candidate.accountHint ? ` · ${candidate.accountHint}` : ""}
                {candidate.expiresAt ? ` · ${candidate.expiresAt}` : ""}
              </span>
              <button
                disabled={candidate.state !== "available" || !codexCredentialId.trim() || !codexLabel.trim()}
                onClick={() => void importCodexCandidate(candidate.candidateId)}
                className="rounded border px-2 py-1 disabled:opacity-40"
              >{tr("导入副本", "Import copy")}</button>
            </div>
          ))}
        </div>
        <div className="space-y-2">
          {view.credentials.filter((credential) => credential.kind === "codex").map((credential) => (
            <div key={credential.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/40 p-2 text-xs">
              <span>
                {credential.label} · {credential.codex?.accountHint ?? tr("账号未知", "Account unknown")} ·
                {" "}{credential.codex?.expiresAt ?? tr("过期时间未知", "Expiry unknown")} ·
                {" "}{credential.codex?.needsReimport ? tr("需要重新导入", "Re-import required") : tr("可用", "Available")} ·
                {" "}refresh: {credential.codex?.lastRefresh ?? "never"}
              </span>
              <button
                onClick={() => {
                  if (!window.confirm(tr(
                    `删除 InkOS 对 ${credential.label} 的本地引用？外部 auth.json 不会被删除。`,
                    `Delete InkOS's local reference to ${credential.label}? The external auth.json will not be deleted.`,
                  ))) return;
                  void run(`delete-codex-${credential.id}`, () =>
                    fetchJson(`/model-auth/codex/${encodeURIComponent(credential.id)}`, {
                      method: "DELETE",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ revision: view.revision }),
                    }).then(() => undefined));
                }}
                className="rounded border border-destructive/40 px-2 py-1 text-destructive"
              >{tr("删除 InkOS 引用", "Delete InkOS reference")}</button>
            </div>
          ))}
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          <input aria-label="Codex backend ID" value={codexBackendId} onChange={(event) => setCodexBackendId(event.target.value)} className={fieldClass} />
          <input aria-label="Codex backend name" value={codexBackendName} onChange={(event) => setCodexBackendName(event.target.value)} className={fieldClass} />
          <select aria-label="Codex backend credential" value={codexCredentialForBackend} onChange={(event) => setCodexCredentialForBackend(event.target.value)} className={fieldClass}>
            <option value="">{tr("选择 Codex 凭证", "Select Codex credential")}</option>
            {view.credentials.filter((credential) => credential.kind === "codex" && credential.configured).map((credential) => (
              <option key={credential.id} value={credential.id}>{credential.label}</option>
            ))}
          </select>
        </div>
        <button
          disabled={!codexBackendId.trim() || !codexBackendName.trim() || !codexCredentialForBackend}
          onClick={() => void createCodexBackend()}
          className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >{tr("创建 Codex Responses 后端", "Create Codex Responses backend")}</button>
      </section>

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
                  <div className="text-xs text-muted-foreground">
                    {backend.credential.kind === "codex"
                      ? `${backend.credential.codex?.accountHint ?? tr("账号未知", "Account unknown")} · ${backend.credential.codex?.expiresAt ?? tr("过期时间未知", "Expiry unknown")}`
                      : backend.credential.configured
                        ? backend.credential.maskedHint
                        : tr("未配置凭证", "Credential not configured")}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => void navigator.clipboard?.writeText(backend.baseUrl)}
                    className="rounded border px-2 py-1 text-xs"
                  >{tr("复制 URL", "Copy URL")}</button>
                  {backend.credential.kind === "api_key" && <button onClick={() => run(`probe-${backend.id}`, () => fetchJson(`/model-health/${encodeURIComponent(backend.id)}/probe`, { method: "POST" }).then(() => undefined))} className="rounded border px-2 py-1 text-xs">Probe</button>}
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
              {backend.credential.kind === "api_key" && <div className="mt-3 flex flex-wrap gap-2">
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
              </div>}
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
