import { CodexCredentialStore } from "@actalk/inkos-core";
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
}

export function registerModelManagementRoutes(
  app: Hono,
  projectRoot: string,
  options: ModelManagementRouteOptions = {},
): ModelManagementRegistration {
  const store = new ModelManagementStore(projectRoot);
  const codexStore = options.codexStore ?? new CodexCredentialStore();
  const activity = new StudioRoutingActivity();
  registerModelAuthRoutes(app, store, codexStore);
  registerModelBackendRoutes(app, store, codexStore);
  registerModelRouteRoutes(app, store);
  registerModelHealthRoutes(app, store, { ...options, activity });
  return { store, activity };
}
