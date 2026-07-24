import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  FileKey2,
  Loader2,
  LogIn,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { fetchJson } from "../hooks/use-api";
import { tr } from "../lib/app-language";
import type {
  BackendInstanceDTO,
  CodexDiscoveryCandidateDTO,
  CredentialStatusDTO,
  GrokOAuthConfigurationStatusDTO,
  GrokOAuthLoginStartDTO,
  LogicalModelRouteDTO,
} from "../shared/contracts";

interface CredentialServiceDetailPageProps {
  readonly kind: "codex" | "grok_oauth";
  readonly nav: { readonly toServices: () => void };
}

interface ViewState {
  readonly revision: string;
  readonly credentials: CredentialStatusDTO[];
  readonly backends: BackendInstanceDTO[];
  readonly routes: LogicalModelRouteDTO[];
  readonly codexCandidates: CodexDiscoveryCandidateDTO[];
  readonly grokConfig: GrokOAuthConfigurationStatusDTO;
}

interface ModelOption {
  readonly id: string;
  readonly name: string;
}

const fieldClass = "w-full rounded-xl border border-border/60 bg-background px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-primary/50";

export function CredentialServiceDetailPage({
  kind,
  nav,
}: CredentialServiceDetailPageProps) {
  const isCodex = kind === "codex";
  const service = isCodex ? "codex" : "xai";
  const title = isCodex ? "Codex" : "xAI (Grok)";
  const defaultCredentialId = isCodex ? "credential-codex" : "credential-grok";
  const defaultBackendId = isCodex ? "backend-codex" : "backend-grok";
  const [view, setView] = useState<ViewState | null>(null);
  const [credentialId, setCredentialId] = useState(defaultCredentialId);
  const [credentialLabel, setCredentialLabel] = useState(title);
  const [backendId, setBackendId] = useState(defaultBackendId);
  const [backendName, setBackendName] = useState(title);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [includeInFailover, setIncludeInFailover] = useState(true);
  const [verifiedFingerprint, setVerifiedFingerprint] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [grokLogin, setGrokLogin] = useState<GrokOAuthLoginStartDTO | null>(null);
  const [grokCallback, setGrokCallback] = useState("");
  const [grokIssuer, setGrokIssuer] = useState("");
  const [grokClientId, setGrokClientId] = useState("");
  const [grokRedirectUri, setGrokRedirectUri] = useState("");

  const reload = useCallback(async () => {
    const [backendPayload, authPayload, routePayload, discoveryPayload, grokConfig] = await Promise.all([
      fetchJson<{ revision: string; backends: BackendInstanceDTO[] }>("/model-backends"),
      fetchJson<{ credentials: CredentialStatusDTO[] }>("/model-auth"),
      fetchJson<{ revision: string; routes: LogicalModelRouteDTO[] }>("/model-routes"),
      fetchJson<{ candidates: CodexDiscoveryCandidateDTO[] }>("/model-auth/codex/discovery"),
      fetchJson<GrokOAuthConfigurationStatusDTO>("/model-auth/grok/config"),
    ]);
    const next: ViewState = {
      revision: routePayload.revision,
      credentials: authPayload.credentials,
      backends: backendPayload.backends,
      routes: routePayload.routes,
      codexCandidates: discoveryPayload.candidates,
      grokConfig,
    };
    setView(next);
    if (!isCodex) {
      setGrokIssuer((current) => current || grokConfig.issuer || "");
      setGrokRedirectUri((current) => current || grokConfig.redirectUri
        || `http://127.0.0.1:${window.location.port}/api/v1/model-auth/grok/callback`);
    }
    const existingBackend = backendPayload.backends.find((item) =>
      item.service === service && item.credential.kind === kind);
    if (existingBackend) {
      setBackendId(existingBackend.id);
      setBackendName(existingBackend.displayName);
      setCredentialId(existingBackend.credential.id);
      setEnabled(existingBackend.enabled);
      const route = routePayload.routes.find((item) =>
        item.candidates.some((candidate) => candidate.backendId === existingBackend.id));
      const candidate = route?.candidates.find((item) => item.backendId === existingBackend.id);
      if (candidate) setModel(candidate.upstreamModelId);
      setIncludeInFailover(Boolean(route));
    } else {
      const firstCredential = authPayload.credentials.find((item) => item.kind === kind);
      if (firstCredential) setCredentialId(firstCredential.id);
    }
  }, [isCodex, kind, service]);

  useEffect(() => {
    void reload().catch((reason) => {
      setError(reason instanceof Error ? reason.message : "Failed to load provider");
    });
  }, [reload]);

  useEffect(() => {
    setVerifiedFingerprint("");
  }, [credentialId, model]);

  useEffect(() => {
    if (!grokLogin) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await fetchJson<{
          readonly status: "pending" | "missing" | "expired" | "completed" | "failed";
          readonly message?: string;
        }>(`/model-auth/grok/login/${encodeURIComponent(grokLogin.sessionId)}`, {
          signal: controller.signal,
        });
        if (result.status === "completed") {
          setGrokLogin(null);
          setMessage(tr("Grok 账号已连接", "Grok account connected"));
          await reload();
          return;
        }
        if (result.status !== "pending") {
          setGrokLogin(null);
          setError(result.message ?? tr("Grok 登录未完成", "Grok login did not complete"));
          return;
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Failed to check Grok login");
        }
      }
      timer = setTimeout(() => void poll(), 1_000);
    };
    timer = setTimeout(() => void poll(), 750);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [grokLogin, reload]);

  const credentials = useMemo(
    () => (view?.credentials ?? []).filter((item) => item.kind === kind),
    [kind, view?.credentials],
  );
  const existingBackend = view?.backends.find((item) =>
    item.service === service && item.credential.kind === kind);
  const selectedCredential = credentials.find((item) => item.id === credentialId);
  const tested = verifiedFingerprint === `${credentialId}\0${model}`;
  const grokConfigReady = Boolean(view?.grokConfig.configured)
    || Boolean(grokIssuer.trim() && grokClientId.trim() && grokRedirectUri.trim());

  const run = async (name: string, operation: () => Promise<void>) => {
    setBusy(name);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr("操作失败", "Operation failed"));
    } finally {
      setBusy("");
    }
  };

  const importCodexFile = (file: File) => run("import", async () => {
    const exists = credentials.some((item) => item.id === credentialId);
    await fetchJson(
      exists
        ? `/model-auth/codex/${encodeURIComponent(credentialId)}`
        : "/model-auth/codex/import",
      {
        method: exists ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: view?.revision,
          credentialId: credentialId.trim(),
          label: credentialLabel.trim(),
          fileName: file.name,
          content: await file.text(),
        }),
      },
    );
    setMessage(tr("auth.json 已安全导入", "auth.json imported securely"));
    await reload();
  });

  const importCodexCandidate = (candidateId: string) => run("import", async () => {
    await fetchJson("/model-auth/codex/import-discovered", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: view?.revision,
        credentialId: credentialId.trim(),
        label: credentialLabel.trim(),
        candidateId,
        mode: "copy",
      }),
    });
    setMessage(tr("Codex 登录凭证已导入", "Codex login credential imported"));
    await reload();
  });

  const startGrokLogin = () => run("login", async () => {
    const login = await fetchJson<GrokOAuthLoginStartDTO>("/model-auth/grok/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: view?.revision,
        credentialId: credentialId.trim(),
        label: credentialLabel.trim(),
        ...(!view?.grokConfig.configured ? {
          oauthConfig: {
            issuer: grokIssuer.trim(),
            clientId: grokClientId.trim(),
            redirectUri: grokRedirectUri.trim(),
          },
        } : {}),
      }),
    });
    window.open(login.authorizationUrl, "_blank", "noopener,noreferrer");
    setGrokLogin({ ...login, authorizationUrl: "" });
  });

  const completeGrokLogin = () => run("login", async () => {
    if (!grokLogin) return;
    await fetchJson(`/model-auth/grok/login/${encodeURIComponent(grokLogin.sessionId)}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback: grokCallback }),
    });
    setGrokCallback("");
    setGrokLogin(null);
    await reload();
  });

  const discoverModels = () => run("discover", async () => {
    if (!selectedCredential) throw new Error(tr("请先导入或连接凭证", "Import or connect a credential first"));
    const type = isCodex ? "codex" : "grok";
    const result = await fetchJson<{ models: ModelOption[] }>(
      `/model-auth/${type}/${encodeURIComponent(credentialId)}/models`,
      { method: "POST" },
    );
    setModels(result.models);
    setModel((current) => result.models.some((item) => item.id === current)
      ? current
      : (result.models[0]?.id ?? ""));
    setMessage(tr(
      `检测到 ${result.models.length} 个可选模型`,
      `Detected ${result.models.length} selectable models`,
    ));
  });

  const testConnection = () => run("test", async () => {
    if (!model) throw new Error(tr("请先检测并选择模型", "Detect and choose a model first"));
    const type = isCodex ? "codex" : "grok";
    const result = await fetchJson<{ ok: boolean; latencyMs: number }>(
      `/model-auth/${type}/${encodeURIComponent(credentialId)}/test`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      },
    );
    if (!result.ok) throw new Error(tr("真实请求测试失败", "Real request test failed"));
    setVerifiedFingerprint(`${credentialId}\0${model}`);
    setMessage(tr(
      `真实请求成功（${result.latencyMs} ms）`,
      `Real request succeeded (${result.latencyMs} ms)`,
    ));
  });

  const saveBackend = () => run("save", async () => {
    if (!selectedCredential) throw new Error(tr("请选择凭证", "Choose a credential"));
    if (!tested) throw new Error(tr("请先使用所选模型完成真实请求测试", "Test a real request with the selected model first"));
    let state = await fetchJson<{ revision: string; backends: BackendInstanceDTO[] }>("/model-backends");
    const backend = {
      id: backendId.trim(),
      displayName: backendName.trim(),
      service,
      provider: "openai" as const,
      baseUrl: isCodex ? "https://chatgpt.com/backend-api/codex" : "https://api.x.ai/v1",
      credentialRef: { id: credentialId, kind },
      enabled,
      transport: { apiFormat: isCodex ? "responses" as const : "chat" as const, stream: true },
    };
    if (existingBackend) {
      await fetchJson(`/model-backends/${encodeURIComponent(existingBackend.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: state.revision, backend }),
      });
    } else {
      await fetchJson("/model-backends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: state.revision, existingCredential: true, backend }),
      });
    }

    const routeState = await fetchJson<{ revision: string; routes: LogicalModelRouteDTO[] }>("/model-routes");
    const route = routeState.routes.find((item) =>
      item.candidates.some((candidate) => candidate.backendId === backend.id));
    if (includeInFailover) {
      const routePayload = {
        id: route?.id ?? `route-${backend.id}`,
        displayName: `${backendName.trim()} route`,
        promptFamily: isCodex ? "gpt" as const : "grok" as const,
        enabled: true,
        candidates: [{ backendId: backend.id, upstreamModelId: model }],
      };
      await fetchJson(route ? `/model-routes/${encodeURIComponent(route.id)}` : "/model-routes", {
        method: route ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: routeState.revision, route: routePayload }),
      });
    } else if (route) {
      await fetchJson(`/model-routes/${encodeURIComponent(route.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: routeState.revision }),
      });
    }
    setMessage(tr("后端已保存，可在故障管理中直接使用", "Backend saved and ready for failover management"));
    await reload();
  });

  if (!view) {
    return <div role="status" className="mx-auto flex max-w-3xl items-center gap-2 p-8 text-sm"><Loader2 className="animate-spin" size={16} />Loading</div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <button onClick={nav.toServices} className="inline-flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-sm hover:bg-secondary/50">
        <ArrowLeft size={15} />{tr("返回服务商管理", "Back to providers")}
      </button>

      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-primary/10 p-2.5 text-primary">{isCodex ? <FileKey2 size={22} /> : <LogIn size={22} />}</div>
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">{isCodex ? "CODEX AUTH.JSON" : "GROK OAUTH"}</p>
            <h1 className="font-serif text-3xl">{title}</h1>
          </div>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          {isCodex
            ? tr("导入本机 auth.json，检测凭证可用模型，再用所选模型发起一次真实请求。原文件不会被修改。", "Import a local auth.json, detect credential models, then make one real request with the selected model. The source file is never modified.")
            : tr("连接本机 Grok OAuth 账号，检测模型并完成真实请求后保存为统一后端。", "Connect a local Grok OAuth account, detect models, and complete a real request before saving the unified backend.")}
        </p>
      </header>

      {error && <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
      {message && <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-600"><CheckCircle2 size={16} />{message}</div>}

      <section className="space-y-4 rounded-2xl border border-border/50 bg-card/50 p-5">
        <div>
          <h2 className="font-medium">{tr("1. 连接凭证", "1. Connect credential")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{tr("Token 只保存在用户级凭证目录，页面仅显示安全状态。", "Tokens stay in the user credential directory; this page exposes only safe status.")}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-xs">{tr("凭证 ID", "Credential ID")}<input value={credentialId} onChange={(event) => setCredentialId(event.target.value)} className={fieldClass} /></label>
          <label className="space-y-1.5 text-xs">{tr("显示名称", "Display name")}<input value={credentialLabel} onChange={(event) => setCredentialLabel(event.target.value)} className={fieldClass} /></label>
        </div>
        {isCodex ? (
          <>
            <label className="block cursor-pointer rounded-xl border border-dashed border-border/70 p-4 text-sm transition-colors hover:border-primary/50">
              <span className="font-medium">{tr("选择 auth.json", "Choose auth.json")}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{tr("导入副本；重新选择会安全替换已有副本。", "Imports a managed copy; selecting again safely replaces it.")}</span>
              <input
                type="file"
                accept=".json,application/json"
                className="mt-3 block w-full text-xs"
                disabled={busy === "import"}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void importCodexFile(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            {view.codexCandidates.map((candidate) => (
              <div key={candidate.candidateId} className="flex items-center justify-between gap-3 rounded-xl border border-border/40 p-3 text-xs">
                <span>{candidate.sources.join(" → ")} · {candidate.safeFileName} · {candidate.state}{candidate.accountHint ? ` · ${candidate.accountHint}` : ""}</span>
                <button disabled={candidate.state !== "available" || Boolean(busy)} onClick={() => void importCodexCandidate(candidate.candidateId)} className="shrink-0 rounded-lg border px-3 py-1.5 disabled:opacity-40">{tr("导入副本", "Import copy")}</button>
              </div>
            ))}
          </>
        ) : (
          <>
            {!view.grokConfig.configured && (
              <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
                <p className="text-sm text-amber-700">
                  {tr("首次登录需要填写 Grok OIDC 应用信息；这些字段不包含 Token。", "First login needs the Grok OIDC application settings; these fields do not contain tokens.")}
                </p>
                <div className="grid gap-3">
                  <label className="space-y-1 text-xs">Issuer<input value={grokIssuer} onChange={(event) => setGrokIssuer(event.target.value)} placeholder="https://..." className={fieldClass} /></label>
                  <label className="space-y-1 text-xs">Client ID<input value={grokClientId} onChange={(event) => setGrokClientId(event.target.value)} className={fieldClass} /></label>
                  <label className="space-y-1 text-xs">Redirect URI<input value={grokRedirectUri} onChange={(event) => setGrokRedirectUri(event.target.value)} className={fieldClass} /></label>
                </div>
              </div>
            )}
            <button disabled={!grokConfigReady || Boolean(busy)} onClick={() => void startGrokLogin()} className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm text-primary-foreground disabled:opacity-50">
              {busy === "login" ? <Loader2 className="animate-spin" size={15} /> : <LogIn size={15} />}{tr("打开 Grok 登录", "Open Grok login")}
            </button>
            {grokLogin && (
              <div className="space-y-2 rounded-xl border border-border/50 p-3">
                <p className="text-xs text-muted-foreground">{tr("浏览器完成后会自动回到此页；也可粘贴完整回调 URL。", "The page updates automatically after browser login; you may also paste the full callback URL.")}</p>
                <div className="flex gap-2"><input value={grokCallback} onChange={(event) => setGrokCallback(event.target.value)} placeholder="http://127.0.0.1:.../callback?code=..." className={fieldClass} /><button disabled={!grokCallback.trim()} onClick={() => void completeGrokLogin()} className="shrink-0 rounded-xl border px-3 text-sm disabled:opacity-40">{tr("完成", "Complete")}</button></div>
              </div>
            )}
          </>
        )}
        {credentials.length > 0 && (
          <label className="space-y-1.5 text-xs">{tr("已连接凭证", "Connected credential")}
            <select value={credentialId} onChange={(event) => setCredentialId(event.target.value)} className={fieldClass}>
              {credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.label} · {credential.maskedHint ?? credential.id}</option>)}
            </select>
          </label>
        )}
      </section>

      <section className="space-y-4 rounded-2xl border border-border/50 bg-card/50 p-5">
        <div>
          <h2 className="font-medium">{tr("2. 检测与验证模型", "2. Detect and verify model")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{tr("检测只读取模型目录；测试连接会使用下方选择的模型发起最小真实请求。", "Detection reads the model catalogue; Test connection makes a minimal real request with the selected model below.")}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
          <button disabled={!selectedCredential || Boolean(busy)} onClick={() => void discoverModels()} className="inline-flex items-center justify-center gap-2 rounded-xl border border-border/70 px-4 py-2.5 text-sm disabled:opacity-40">
            {busy === "discover" ? <Loader2 className="animate-spin" size={15} /> : <Search size={15} />}{tr("检测支持模型", "Detect supported models")}
          </button>
          <select value={model} onChange={(event) => setModel(event.target.value)} className={fieldClass} disabled={models.length === 0}>
            <option value="">{tr("请先检测模型", "Detect models first")}</option>
            {models.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
          </select>
        </div>
        <button disabled={!model || Boolean(busy)} onClick={() => void testConnection()} className="inline-flex items-center justify-center gap-2 rounded-xl border border-primary/40 px-4 py-2.5 text-sm text-primary disabled:opacity-40">
          {busy === "test" ? <Loader2 className="animate-spin" size={15} /> : <ShieldCheck size={15} />}{tr("测试连接（真实请求）", "Test connection (real request)")}
        </button>
      </section>

      <section className="space-y-4 rounded-2xl border border-border/50 bg-card/50 p-5">
        <h2 className="font-medium">{tr("3. 保存统一后端", "3. Save unified backend")}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-xs">{tr("后端 ID", "Backend ID")}<input value={backendId} disabled={Boolean(existingBackend)} onChange={(event) => setBackendId(event.target.value)} className={fieldClass} /></label>
          <label className="space-y-1.5 text-xs">{tr("后端名称", "Backend name")}<input value={backendName} onChange={(event) => setBackendName(event.target.value)} className={fieldClass} /></label>
        </div>
        <div className="flex flex-wrap gap-6 text-sm">
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{tr("启用此后端", "Enable this backend")}</label>
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={includeInFailover} onChange={(event) => setIncludeInFailover(event.target.checked)} />{tr("纳入自动故障切换", "Include in automatic failover")}</label>
        </div>
        <button disabled={!tested || Boolean(busy)} onClick={() => void saveBackend()} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-40">
          {busy === "save" ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}{existingBackend ? tr("更新后端", "Update backend") : tr("保存后端", "Save backend")}
        </button>
      </section>
    </div>
  );
}
