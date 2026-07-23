import {
  CodexCredentialStore,
  GrokCredentialStore,
  GrokOAuthClient,
  GrokOAuthLoginManager,
  grokOAuthConfigFromEnv,
  grokOAuthConfigurationStatus,
  type GrokOAuthConfig,
} from "@actalk/inkos-core";
import type { Hono } from "hono";
import { registerModelAuthRoutes } from "./model-auth.js";
import { registerModelBackendRoutes } from "./model-backends.js";
import {
  registerModelHealthRoutes,
  type ModelHealthRouteOptions,
} from "./model-health.js";
import { ModelManagementStore } from "./model-management-store.js";
import { registerModelRouteRoutes } from "./model-routes.js";
import { StudioRoutingActivity } from "./model-routing-activity.js";

export interface ModelManagementRegistration {
  readonly store: ModelManagementStore;
  readonly activity: StudioRoutingActivity;
}

export interface ModelManagementRouteOptions
  extends Partial<Omit<ModelHealthRouteOptions, "activity">> {
  readonly codexStore?: CodexCredentialStore;
  readonly grokStore?: GrokCredentialStore;
  readonly grokConfig?: Partial<GrokOAuthConfig>;
  readonly grokClient?: GrokOAuthClient;
  readonly grokLoginManager?: GrokOAuthLoginManager;
}

export function registerModelManagementRoutes(
  app: Hono,
  projectRoot: string,
  options: ModelManagementRouteOptions = {},
): ModelManagementRegistration {
  const store = new ModelManagementStore(projectRoot);
  const codexStore = options.codexStore ?? new CodexCredentialStore();
  const grokStore = options.grokStore ?? new GrokCredentialStore();
  const grokConfig = options.grokConfig ?? grokOAuthConfigFromEnv();
  const grokConfiguration = grokOAuthConfigurationStatus(grokConfig);
  const grokClient = options.grokClient
    ?? (grokConfiguration.configured
      ? new GrokOAuthClient(grokConfig as GrokOAuthConfig)
      : undefined);
  const grokLoginManager = options.grokLoginManager
    ?? (grokClient ? new GrokOAuthLoginManager(grokClient, grokStore) : undefined);
  const activity = new StudioRoutingActivity();
  registerModelAuthRoutes(app, store, codexStore, {
    store: grokStore,
    config: grokConfiguration,
    loginManager: grokLoginManager,
  });
  registerModelBackendRoutes(app, store, codexStore, grokStore);
  registerModelRouteRoutes(app, store);
  registerModelHealthRoutes(app, store, { ...options, activity });
  return { store, activity };
}
