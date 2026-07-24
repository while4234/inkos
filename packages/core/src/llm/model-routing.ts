import { createHash } from "node:crypto";
import { z } from "zod";

export const MODEL_ROUTING_SCHEMA_VERSION = 1 as const;

const StableIdSchema = z.string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/, "must be a stable lowercase identifier");

export const CredentialKindSchema = z.enum([
  "api_key",
  "codex",
  "grok_oauth",
]);

export const CredentialMetadataSchema = z.object({
  id: StableIdSchema,
  kind: CredentialKindSchema,
  label: z.string().min(1),
  scope: z.enum(["project", "user"]).default("project"),
}).strict();

export const CredentialRefSchema = z.object({
  id: StableIdSchema,
  kind: CredentialKindSchema,
}).strict();

export const BackendTransportSchema = z.object({
  apiFormat: z.enum(["chat", "responses"]).default("chat"),
  stream: z.boolean().default(true),
}).strict();

export const ModelPriceMetadataSchema = z.object({
  currency: z.string().min(3).max(8),
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
  cacheReadPerMillion: z.number().nonnegative().optional(),
  cacheWritePerMillion: z.number().nonnegative().optional(),
  reasoningPerMillion: z.number().nonnegative().optional(),
  source: z.string().min(1).max(120),
  revision: z.string().min(1).max(80),
}).strict();

export const BackendInstanceSchema = z.object({
  id: StableIdSchema,
  displayName: z.string().min(1),
  service: z.string().min(1),
  provider: z.enum(["anthropic", "openai", "custom"]),
  baseUrl: z.string().url(),
  credentialRef: CredentialRefSchema,
  enabled: z.boolean().default(true),
  transport: BackendTransportSchema,
}).strict();

export const LogicalModelCandidateSchema = z.object({
  backendId: StableIdSchema,
  upstreamModelId: z.string().min(1),
  pricing: ModelPriceMetadataSchema.optional(),
}).strict();

export const PromptFamilySchema = z.enum([
  "gpt",
  "grok",
  "deepseek",
  "none",
  // Compatibility sentinel for routes migrated before prompt-family selection
  // was strict. The runtime resolves it once from explicit service/model rules.
  "generic",
]);

export const ModelGlobalPromptOverrideSchema = z.object({
  text: z.string().min(1).max(32_768),
  revision: z.number().int().positive().default(1),
}).strict();

export const LogicalModelRouteSchema = z.object({
  id: StableIdSchema,
  displayName: z.string().min(1),
  promptFamily: PromptFamilySchema.default("generic"),
  globalPrompt: ModelGlobalPromptOverrideSchema.optional(),
  enabled: z.boolean().default(true),
  candidates: z.array(LogicalModelCandidateSchema).min(1, "must contain at least one candidate"),
}).strict();

export const ModelRoutingConfigSchema = z.object({
  version: z.literal(MODEL_ROUTING_SCHEMA_VERSION),
  credentials: z.array(CredentialMetadataSchema),
  backends: z.array(BackendInstanceSchema),
  routes: z.array(LogicalModelRouteSchema),
  defaultRouteId: StableIdSchema.nullable(),
}).strict().superRefine((routing, context) => {
  addDuplicateIdIssues(routing.credentials, "credentials", context);
  addDuplicateIdIssues(routing.backends, "backends", context);
  addDuplicateIdIssues(routing.routes, "routes", context);

  const credentials = new Map(routing.credentials.map((credential) => [credential.id, credential]));
  const backends = new Map(routing.backends.map((backend) => [backend.id, backend]));
  const routes = new Map(routing.routes.map((route) => [route.id, route]));

  routing.backends.forEach((backend, index) => {
    const credential = credentials.get(backend.credentialRef.id);
    if (!credential) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `credentialRef.id references missing credential "${backend.credentialRef.id}"`,
        path: ["backends", index, "credentialRef", "id"],
      });
      return;
    }
    if (credential.kind !== backend.credentialRef.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `credentialRef.kind "${backend.credentialRef.kind}" does not match credential kind "${credential.kind}"`,
        path: ["backends", index, "credentialRef", "kind"],
      });
    }
  });

  routing.routes.forEach((route, routeIndex) => {
    const candidates = new Set<string>();
    route.candidates.forEach((candidate, candidateIndex) => {
      const candidateKey = `${candidate.backendId}\0${candidate.upstreamModelId}`;
      if (candidates.has(candidateKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate candidate for backend "${candidate.backendId}" and upstream model "${candidate.upstreamModelId}"`,
          path: ["routes", routeIndex, "candidates", candidateIndex],
        });
      }
      candidates.add(candidateKey);
      if (!backends.has(candidate.backendId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `backendId references missing backend "${candidate.backendId}"`,
          path: ["routes", routeIndex, "candidates", candidateIndex, "backendId"],
        });
      }
    });
  });

  if (routing.routes.length === 0) {
    if (routing.defaultRouteId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "defaultRouteId must be null until the first logical route is configured",
        path: ["defaultRouteId"],
      });
    }
    return;
  }

  if (routing.defaultRouteId === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "defaultRouteId is required when logical routes are configured",
      path: ["defaultRouteId"],
    });
    return;
  }

  const defaultRoute = routes.get(routing.defaultRouteId);
  if (!defaultRoute) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `defaultRouteId references missing route "${routing.defaultRouteId}"`,
      path: ["defaultRouteId"],
    });
  } else if (!defaultRoute.enabled) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `defaultRouteId references disabled route "${routing.defaultRouteId}"`,
      path: ["defaultRouteId"],
    });
  } else if (!defaultRoute.candidates.some((candidate) => backends.get(candidate.backendId)?.enabled)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `defaultRouteId references route "${routing.defaultRouteId}" without an enabled backend candidate`,
      path: ["defaultRouteId"],
    });
  }
});

export const RouteLLMOverrideSchema = z.object({
  routeId: StableIdSchema,
}).strict();

export type CredentialKind = z.infer<typeof CredentialKindSchema>;
export type CredentialMetadata = z.infer<typeof CredentialMetadataSchema>;
export type CredentialRef = z.infer<typeof CredentialRefSchema>;
export type BackendTransport = z.infer<typeof BackendTransportSchema>;
export type ModelPriceMetadata = z.infer<typeof ModelPriceMetadataSchema>;
export type BackendInstance = z.infer<typeof BackendInstanceSchema>;
export type LogicalModelCandidate = z.infer<typeof LogicalModelCandidateSchema>;
export type PromptFamily = z.infer<typeof PromptFamilySchema>;
export type LogicalModelRoute = z.infer<typeof LogicalModelRouteSchema>;
export type ModelRoutingConfig = z.infer<typeof ModelRoutingConfigSchema>;
export type RouteLLMOverride = z.infer<typeof RouteLLMOverrideSchema>;

export function stableRoutingId(
  prefix: "credential" | "backend" | "route",
  identity: string,
): string {
  const digest = createHash("sha256")
    .update(`${prefix}\0${identity}`)
    .digest("hex")
    .slice(0, 16);
  return `${prefix}-${digest}`;
}

export function resolveLogicalModelRoute(
  routing: ModelRoutingConfig,
  routeId: string,
): LogicalModelRoute {
  const route = routing.routes.find((candidate) => candidate.id === routeId);
  if (!route) {
    throw new Error(`Logical model route "${routeId}" is not configured.`);
  }
  if (!route.enabled) {
    throw new Error(`Logical model route "${routeId}" is disabled.`);
  }
  return route;
}

function addDuplicateIdIssues(
  entries: readonly { readonly id: string }[],
  field: "credentials" | "backends" | "routes",
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate id "${entry.id}"`,
        path: [field, index, "id"],
      });
    }
    seen.add(entry.id);
  });
}
