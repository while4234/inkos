import { ApiError } from "../errors.js";

export function requestRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "MODEL_ROUTING_VALIDATION_ERROR", "Request body must be an object.");
  }
  return value as Record<string, unknown>;
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ApiError(400, "MODEL_ROUTING_VALIDATION_ERROR", `${field} must be a string.`);
  }
  return value;
}

export function requiredString(value: unknown, field: string): string {
  const result = optionalString(value, field)?.trim();
  if (!result) {
    throw new ApiError(400, "MODEL_ROUTING_VALIDATION_ERROR", `${field} is required.`);
  }
  return result;
}

export function parseCoreSchema<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ApiError(
    400,
    "MODEL_ROUTING_VALIDATION_ERROR",
    parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "),
  );
}

export function revisionFromRequest(
  body: { readonly revision?: string },
  ifMatch: string | undefined,
): string | undefined {
  return body.revision ?? ifMatch?.replace(/^W\/|"/g, "");
}
