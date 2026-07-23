import { z } from "zod";
import { RoutingTraceSchema } from "../llm/routing-trace.js";
import { PlayModeSchema, SessionKindSchema, type PlayMode, type SessionKind } from "./session.js";
export type { SessionKind };
export type { PlayMode };

export const TranscriptRoleSchema = z.enum(["user", "assistant", "toolResult", "system"]);
export type TranscriptRole = z.infer<typeof TranscriptRoleSchema>;

const BaseEventSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
});

export const SessionCreatedEventSchema = BaseEventSchema.extend({
  type: z.literal("session_created"),
  bookId: z.string().nullable(),
  sessionKind: SessionKindSchema.optional(),
  playMode: PlayModeSchema.optional(),
  title: z.string().nullable().default(null),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const SessionMetadataUpdatedEventSchema = BaseEventSchema.extend({
  type: z.literal("session_metadata_updated"),
  bookId: z.string().nullable().optional(),
  sessionKind: SessionKindSchema.optional(),
  playMode: PlayModeSchema.optional(),
  title: z.string().nullable().optional(),
  updatedAt: z.number().int().nonnegative(),
});

export const RequestStartedEventSchema = BaseEventSchema.extend({
  type: z.literal("request_started"),
  requestId: z.string().min(1),
  sessionKind: SessionKindSchema.optional(),
  input: z.string(),
});

export const RequestCommittedEventSchema = BaseEventSchema.extend({
  type: z.literal("request_committed"),
  requestId: z.string().min(1),
});

export const RequestFailedEventSchema = BaseEventSchema.extend({
  type: z.literal("request_failed"),
  requestId: z.string().min(1),
  error: z.string(),
});

export const RoutingSummaryEventSchema = BaseEventSchema.extend({
  type: z.literal("routing_summary"),
  requestId: z.string().min(1),
  logicalModelId: z.string().min(1).max(160),
  attempts: z.array(z.object({
    backendId: z.string().min(1).max(160),
    upstreamModelId: z.string().min(1).max(160),
    attemptNumber: z.number().int().nonnegative(),
    reason: z.string().min(1).max(80).optional(),
    visibleOutput: z.boolean(),
  }).strict()).max(100),
  switches: z.array(z.object({
    fromBackendId: z.string().min(1).max(160),
    toBackendId: z.string().min(1).max(160),
    reason: z.string().min(1).max(80).optional(),
  }).strict()).max(50),
  actualBackendId: z.string().min(1).max(160).nullable(),
  actualModelId: z.string().min(1).max(160).nullable(),
  promptFamily: z.string().min(1).max(40).nullable(),
  promptRevision: z.number().int().nonnegative().nullable(),
  retryCount: z.number().int().nonnegative(),
  terminalState: z.enum(["succeeded", "failed", "interrupted", "exhausted", "cancelled"]),
  trace: RoutingTraceSchema.optional(),
});

export const MessageEventSchema = BaseEventSchema.extend({
  type: z.literal("message"),
  requestId: z.string().min(1),
  uuid: z.string().min(1),
  parentUuid: z.string().min(1).nullable(),
  role: TranscriptRoleSchema,
  piTurnIndex: z.number().int().nonnegative().optional(),
  toolCallId: z.string().min(1).optional(),
  sourceToolAssistantUuid: z.string().min(1).optional(),
  legacyDisplay: z.object({
    thinking: z.string().optional(),
    toolExecutions: z.array(z.unknown()).optional(),
  }).optional(),
  message: z.unknown(),
});

export const TranscriptEventSchema = z.discriminatedUnion("type", [
  SessionCreatedEventSchema,
  SessionMetadataUpdatedEventSchema,
  RequestStartedEventSchema,
  RequestCommittedEventSchema,
  RequestFailedEventSchema,
  RoutingSummaryEventSchema,
  MessageEventSchema,
]);

export type SessionCreatedEvent = z.infer<typeof SessionCreatedEventSchema>;
export type SessionMetadataUpdatedEvent = z.infer<typeof SessionMetadataUpdatedEventSchema>;
export type RequestStartedEvent = z.infer<typeof RequestStartedEventSchema>;
export type RequestCommittedEvent = z.infer<typeof RequestCommittedEventSchema>;
export type RequestFailedEvent = z.infer<typeof RequestFailedEventSchema>;
export type RoutingSummaryEvent = z.infer<typeof RoutingSummaryEventSchema>;
export type MessageEvent = z.infer<typeof MessageEventSchema>;
export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>;
