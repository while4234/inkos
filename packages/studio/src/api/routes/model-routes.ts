import { LogicalModelRouteSchema } from "@actalk/inkos-core";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import { logicalModelRouteDTO } from "./model-dto.js";
import { ModelManagementStore } from "./model-management-store.js";
import {
  optionalString,
  parseCoreSchema,
  requestRecord,
  revisionFromRequest,
} from "./model-route-errors.js";

export function registerModelRouteRoutes(app: Hono, store: ModelManagementStore): void {
  app.get("/api/v1/model-routes", async (c) => {
    const { routing, revision } = await store.read();
    return c.json({
      revision,
      defaultRouteId: routing.defaultRouteId,
      routes: routing.routes.map((route) => logicalModelRouteDTO(route, routing.defaultRouteId)),
    }, 200, { ETag: `"${revision}"` });
  });

  app.post("/api/v1/model-routes", async (c) => {
    const raw = requestRecord(await c.req.json());
    const body = {
      revision: optionalString(raw.revision, "revision"),
      route: parseCoreSchema(LogicalModelRouteSchema, raw.route),
    };
    const result = await store.updateRouting(
      revisionFromRequest(body, c.req.header("If-Match")),
      (routing) => {
        if (routing.routes.some((route) => route.id === body.route.id)) {
          throw new ApiError(409, "MODEL_ROUTE_DUPLICATE_ID", `Route "${body.route.id}" already exists.`);
        }
        routing.routes.push(body.route);
      },
    );
    return c.json({ ok: true, revision: result.revision }, 201, { ETag: `"${result.revision}"` });
  });

  app.put("/api/v1/model-routes/:routeId", async (c) => {
    const raw = requestRecord(await c.req.json());
    const body = {
      revision: optionalString(raw.revision, "revision"),
      route: parseCoreSchema(LogicalModelRouteSchema, raw.route),
    };
    const routeId = c.req.param("routeId");
    if (body.route.id !== routeId) {
      throw new ApiError(400, "MODEL_ROUTE_ID_MISMATCH", "Route path and payload IDs must match.");
    }
    const result = await store.updateRouting(
      revisionFromRequest(body, c.req.header("If-Match")),
      (routing) => {
        const index = routing.routes.findIndex((route) => route.id === routeId);
        if (index < 0) throw new ApiError(404, "MODEL_ROUTE_NOT_FOUND", `Route "${routeId}" was not found.`);
        routing.routes[index] = body.route;
      },
    );
    return c.json({ ok: true, revision: result.revision }, 200, { ETag: `"${result.revision}"` });
  });

  app.delete("/api/v1/model-routes/:routeId", async (c) => {
    const raw = requestRecord(await c.req.json().catch(() => ({})));
    const body = { revision: optionalString(raw.revision, "revision") };
    const routeId = c.req.param("routeId");
    const result = await store.updateRouting(
      revisionFromRequest(body, c.req.header("If-Match")),
      (routing) => {
        if (routing.defaultRouteId === routeId) {
          throw new ApiError(409, "MODEL_ROUTE_IS_DEFAULT", "Choose another default route before deleting this route.");
        }
        const index = routing.routes.findIndex((route) => route.id === routeId);
        if (index < 0) throw new ApiError(404, "MODEL_ROUTE_NOT_FOUND", `Route "${routeId}" was not found.`);
        routing.routes.splice(index, 1);
      },
    );
    return c.json({ ok: true, revision: result.revision }, 200, { ETag: `"${result.revision}"` });
  });

  app.put("/api/v1/model-routes/:routeId/default", async (c) => {
    const raw = requestRecord(await c.req.json().catch(() => ({})));
    const body = { revision: optionalString(raw.revision, "revision") };
    const routeId = c.req.param("routeId");
    const result = await store.updateRouting(
      revisionFromRequest(body, c.req.header("If-Match")),
      (routing) => {
        const route = routing.routes.find((item) => item.id === routeId);
        if (!route) throw new ApiError(404, "MODEL_ROUTE_NOT_FOUND", `Route "${routeId}" was not found.`);
        if (!route.enabled) throw new ApiError(409, "MODEL_ROUTE_DISABLED", "A disabled route cannot be the default.");
        routing.defaultRouteId = routeId;
      },
    );
    return c.json({ ok: true, revision: result.revision }, 200, { ETag: `"${result.revision}"` });
  });
}
