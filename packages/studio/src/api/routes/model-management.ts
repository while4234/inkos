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

export function registerModelManagementRoutes(
  app: Hono,
  projectRoot: string,
  options: Partial<Omit<ModelHealthRouteOptions, "activity">> = {},
): ModelManagementRegistration {
  const store = new ModelManagementStore(projectRoot);
  const activity = new StudioRoutingActivity();
  registerModelAuthRoutes(app, store);
  registerModelBackendRoutes(app, store);
  registerModelRouteRoutes(app, store);
  registerModelHealthRoutes(app, store, { ...options, activity });
  return { store, activity };
}
