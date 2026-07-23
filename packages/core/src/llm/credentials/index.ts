import type { CredentialKind, CredentialRef } from "../model-routing.js";
import { loadSecrets } from "../secrets.js";
import {
  CodexAuthCredentialProvider,
  CodexCredentialStore,
  type ResolvedCodexCredential,
} from "./codex-auth.js";
import {
  GrokCredentialStore,
  GrokOAuthCredentialProvider,
  type ResolvedGrokOAuthCredential,
} from "./grok-oauth.js";

export interface ResolvedApiKeyCredential {
  readonly kind: "api_key";
  readonly apiKey: string;
}

export type ResolvedCredential =
  | ResolvedApiKeyCredential
  | ResolvedCodexCredential
  | ResolvedGrokOAuthCredential;

export interface CredentialResolveOptions {
  readonly signal?: AbortSignal;
}

export interface CredentialProvider<T extends ResolvedCredential = ResolvedCredential> {
  readonly kind: CredentialKind;
  resolve(ref: CredentialRef, options?: CredentialResolveOptions): Promise<T>;
}

export class ProjectApiKeyCredentialProvider implements CredentialProvider<ResolvedApiKeyCredential> {
  public readonly kind = "api_key" as const;

  public constructor(private readonly projectRoot: string) {}

  public async resolve(ref: CredentialRef): Promise<ResolvedApiKeyCredential> {
    if (ref.kind !== this.kind) {
      throw new Error(`Credential "${ref.id}" uses unsupported kind "${ref.kind}" for the project API key provider.`);
    }

    const secrets = await loadSecrets(this.projectRoot, { strict: true });
    const apiKey = secrets.credentials?.[ref.id]?.apiKey;
    if (!apiKey) {
      throw new Error(`API key credential "${ref.id}" is not configured.`);
    }
    return { kind: this.kind, apiKey };
  }
}

export class CredentialResolver {
  private readonly providers = new Map<CredentialKind, CredentialProvider>();

  public constructor(providers: readonly CredentialProvider[]) {
    providers.forEach((provider) => this.providers.set(provider.kind, provider));
  }

  public async resolve(
    ref: CredentialRef,
    options?: CredentialResolveOptions,
  ): Promise<ResolvedCredential> {
    const provider = this.providers.get(ref.kind);
    if (!provider) {
      throw new Error(`Credential kind "${ref.kind}" is not supported by this InkOS installation.`);
    }
    return provider.resolve(ref, options);
  }
}

export function createProjectCredentialResolver(
  projectRoot: string,
  options: {
    readonly codexStore?: CodexCredentialStore;
    readonly grokStore?: GrokCredentialStore;
  } = {},
): CredentialResolver {
  return new CredentialResolver([
    new ProjectApiKeyCredentialProvider(projectRoot),
    new CodexAuthCredentialProvider(options.codexStore ?? new CodexCredentialStore()),
    new GrokOAuthCredentialProvider(options.grokStore ?? new GrokCredentialStore()),
  ]);
}

export * from "./codex-auth.js";
export * from "./grok-oauth.js";
