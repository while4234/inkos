import { describe, expect, it } from "vitest";
import {
  MODEL_GLOBAL_PROMPT_ASSETS,
  applyModelGlobalPrompt,
  countModelGlobalPromptMarkers,
  resolveModelGlobalPrompt,
  stripKnownModelGlobalPromptPrefixes,
  transformGrokHistory,
  type PromptCompatibleMessage,
} from "../llm/model-global-prompt.js";

describe("model-global prompt family resolution", () => {
  it.each([
    {
      name: "explicit route family wins over endpoint and model",
      input: { configuredFamily: "grok" as const, service: "openai", model: "deepseek-v4" },
      family: "grok",
      source: "explicit",
    },
    {
      name: "explicit none disables injection",
      input: { configuredFamily: "none" as const, service: "openai", model: "gpt-5" },
      family: "none",
      source: "explicit",
    },
    {
      name: "known endpoint is preferred for a legacy route",
      input: {
        configuredFamily: "generic" as const,
        endpoint: "https://api.deepseek.com/v1",
        service: "custom",
        model: "gpt-5",
      },
      family: "deepseek",
      source: "endpoint",
    },
    {
      name: "known service is preferred for a legacy route",
      input: { configuredFamily: "generic" as const, service: "xai", model: "gpt-5" },
      family: "grok",
      source: "service",
    },
    {
      name: "normalized GPT model fallback",
      input: { configuredFamily: "generic" as const, service: "custom", model: "openai/gpt-5.4" },
      family: "gpt",
      source: "model",
    },
    {
      name: "normalized DeepSeek model fallback",
      input: { configuredFamily: "generic" as const, service: "custom", model: "models/deepseek-v4" },
      family: "deepseek",
      source: "model",
    },
  ])("$name", ({ input, family, source }) => {
    expect(resolveModelGlobalPrompt(input)).toMatchObject({
      family,
      source,
      enabled: family !== "none",
    });
  });

  it("uses the other/custom family for unknown models", () => {
    const result = resolveModelGlobalPrompt({
      configuredFamily: "generic",
      service: "custom",
      model: "writer-vendor-42",
    });

    expect(result).toMatchObject({
      family: "generic",
      enabled: true,
      source: "unknown",
    });
  });

  it("lets an explicit probe opt-out override a configured family", () => {
    expect(resolveModelGlobalPrompt({
      configuredFamily: "gpt",
      model: "gpt-5",
      mode: "disabled",
    })).toEqual({
      family: "none",
      enabled: false,
      source: "disabled",
    });
  });

  it("selects the saved project prompt after resolving the model family", () => {
    const result = resolveModelGlobalPrompt({
      configuredFamily: "generic",
      endpoint: "https://api.deepseek.com/v1",
      model: "vendor-model",
      customPrompts: {
        gpt: {
          id: "project:gpt",
          revision: 2,
          text: "GPT family prompt",
        },
        deepseek: {
          id: "project:deepseek",
          revision: 5,
          text: "DeepSeek family prompt",
        },
      },
    });

    expect(result).toMatchObject({
      family: "deepseek",
      assetId: "project:deepseek",
      revision: 5,
      source: "endpoint",
    });
    expect(result.renderedText).toContain("DeepSeek family prompt");
    expect(result.renderedText).not.toContain("GPT family prompt");
  });
});

describe("model-global prompt assets", () => {
  it.each(["gpt", "grok", "deepseek", "generic"] as const)(
    "publishes a stable, bounded and safety-preserving %s asset",
    (family) => {
      const asset = MODEL_GLOBAL_PROMPT_ASSETS[family];
      expect(asset).toMatchObject({
        id: `inkos:model-global-prompt:${family}`,
        family,
        revision: 1,
      });
      expect(asset.renderedText).toContain(`family="${family}" revision="1"`);
      expect(countModelGlobalPromptMarkers(asset.renderedText)).toBe(1);
      expect(asset.text).toContain("requested");
      expect(asset.text.toLowerCase()).not.toMatch(
        /bypass|ignore (?:all|the) (?:provider|platform|safety)|higher authority|权限解锁/,
      );
    },
  );

  it("keeps family-specific guidance independently reviewable", () => {
    expect(MODEL_GLOBAL_PROMPT_ASSETS.gpt.text).toContain("chain-of-thought");
    expect(MODEL_GLOBAL_PROMPT_ASSETS.grok.text).toContain("tool-call identifiers");
    expect(MODEL_GLOBAL_PROMPT_ASSETS.deepseek.text).toContain("explicit constraints");
  });
});

describe("model-global prompt injection", () => {
  const gpt = resolveModelGlobalPrompt({ configuredFamily: "gpt" });
  const grok = resolveModelGlobalPrompt({ configuredFamily: "grok" });

  it("is idempotent and replaces another known family instead of stacking", () => {
    const original = [
      { role: "system", content: "role prompt\n\nproject prompt pack" },
      { role: "user", content: "write chapter" },
    ];
    const first = applyModelGlobalPrompt(original, gpt);
    const second = applyModelGlobalPrompt(first.messages, gpt);
    const switched = applyModelGlobalPrompt(second.messages, grok);

    expect(second.messages).toEqual(first.messages);
    expect(countModelGlobalPromptMarkers(String(switched.messages[0]?.content))).toBe(1);
    expect(String(switched.messages[0]?.content)).toContain('family="grok"');
    expect(String(switched.messages[0]?.content)).not.toContain('family="gpt"');
    expect(String(switched.messages[0]?.content)).toContain("role prompt\n\nproject prompt pack");
    expect(original).toEqual([
      { role: "system", content: "role prompt\n\nproject prompt pack" },
      { role: "user", content: "write chapter" },
    ]);
  });

  it("uses the saved route prompt with a safe revision and remains idempotent", () => {
    const custom = resolveModelGlobalPrompt({
      configuredFamily: "deepseek",
      customPrompt: {
        id: "project:route-writer",
        text: "Always preserve established character continuity.",
        revision: 3,
      },
    });
    const first = applyModelGlobalPrompt([
      { role: "system", content: "role prompt" },
      { role: "user", content: "write chapter" },
    ], custom);
    const second = applyModelGlobalPrompt(first.messages, custom);
    const system = String(second.messages[0]?.content);

    expect(second.messages).toEqual(first.messages);
    expect(countModelGlobalPromptMarkers(system)).toBe(1);
    expect(system).toContain('id="project:route-writer"');
    expect(system).toContain('revision="3"');
    expect(system).toContain("Always preserve established character continuity.");
    expect(custom).toMatchObject({
      assetId: "project:route-writer",
      revision: 3,
      enabled: true,
    });
    expect(JSON.stringify({
      assetId: custom.assetId,
      revision: custom.revision,
    })).not.toContain("character continuity");
  });

  it("strips stacked current/older marked revisions before applying the target", () => {
    const current = MODEL_GLOBAL_PROMPT_ASSETS.gpt.renderedText;
    const old = current
      .replace('revision="1"', 'revision="0"')
      .replace(MODEL_GLOBAL_PROMPT_ASSETS.gpt.text, "legacy safe adapter");
    const messages = [{
      role: "system",
      content: `${current}\n\n${old}\n\nrole prompt`,
    }];

    const result = applyModelGlobalPrompt(messages, grok);
    const system = String(result.messages[0]?.content);
    expect(countModelGlobalPromptMarkers(system)).toBe(1);
    expect(system).toContain('family="grok"');
    expect(system).toContain("role prompt");
    expect(system).not.toContain("legacy safe adapter");
  });

  it("creates a leading system message when none exists", () => {
    const input = [{ role: "user", content: "write chapter" }];
    const result = applyModelGlobalPrompt(input, gpt);

    expect(result.messages[0]).toMatchObject({ role: "system" });
    expect(result.messages[1]).toEqual(input[0]);
    expect(input).toEqual([{ role: "user", content: "write chapter" }]);
  });

  it("preserves multiple system messages and prepends before role and prompt-pack content", () => {
    const result = applyModelGlobalPrompt([
      { role: "system", content: "role prompt" },
      { role: "system", content: "project prompt pack" },
      { role: "user", content: "request" },
    ], gpt);

    expect(String(result.messages[0]?.content)).toMatch(
      /^<!-- inkos:model-global-prompt[\s\S]*\n\nrole prompt$/,
    );
    expect(result.messages.slice(1)).toEqual([
      { role: "system", content: "project prompt pack" },
      { role: "user", content: "request" },
    ]);
  });

  it("clones structured blocks and preserves non-string content", () => {
    const opaque = { type: "image", source: { uri: "fixture://cover" } };
    const input: PromptCompatibleMessage[] = [
      {
        role: "system",
        content: [
          opaque,
          { type: "text", text: "role prompt" },
          { type: "schema", value: { type: "object" } },
        ],
      },
      { role: "user", content: [{ type: "text", text: "request" }] },
    ];
    const original = structuredClone(input);
    const result = applyModelGlobalPrompt(input, gpt);
    const blocks = result.messages[0]?.content as Array<Record<string, unknown>>;

    expect(blocks[0]?.text).toBe(MODEL_GLOBAL_PROMPT_ASSETS.gpt.renderedText);
    expect(countModelGlobalPromptMarkers(String(blocks[0]?.text))).toBe(1);
    expect(blocks[1]).toEqual(opaque);
    expect(blocks[1]).not.toBe(opaque);
    expect(blocks[2]).toEqual({ type: "text", text: "role prompt" });
    expect(blocks[3]).toEqual({ type: "schema", value: { type: "object" } });
    expect(result.messages[1]).toEqual(input[1]);
    expect(input).toEqual(original);
  });

  it("inserts before the first opaque system message instead of discarding it", () => {
    const opaque = { role: "system", content: { type: "binary", bytes: [1, 2] } };
    const following = { role: "system", content: "role prompt" };
    const result = applyModelGlobalPrompt([opaque, following], gpt);

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toEqual({
      role: "system",
      content: MODEL_GLOBAL_PROMPT_ASSETS.gpt.renderedText,
    });
    expect(result.messages[1]).toEqual(opaque);
    expect(result.messages[1]).not.toBe(opaque);
    expect(result.messages[2]).toEqual(following);
  });

  it("disabled mode strips an existing prefix without changing business content", () => {
    const enabled = applyModelGlobalPrompt([
      { role: "system", content: "role prompt" },
      { role: "user", content: "request" },
    ], gpt);
    const disabled = applyModelGlobalPrompt(enabled.messages, resolveModelGlobalPrompt({
      configuredFamily: "gpt",
      mode: "disabled",
    }));

    expect(disabled.messages).toEqual([
      { role: "system", content: "role prompt" },
      { role: "user", content: "request" },
    ]);
  });

  it("strips legacy unmarked prompt text using longest known assets first", () => {
    const asset = MODEL_GLOBAL_PROMPT_ASSETS.deepseek;
    expect(stripKnownModelGlobalPromptPrefixes(
      `${asset.text}\n\nrole prompt`,
    )).toBe("role prompt");
  });

  it("strips a previously injected project-owned route marker", () => {
    const projectPrompt = [
      '<!-- inkos:model-global-prompt id="project:custom" family="gpt" revision="1" -->',
      "project-owned content",
      "<!-- /inkos:model-global-prompt -->",
    ].join("\n");

    expect(stripKnownModelGlobalPromptPrefixes(projectPrompt)).toBe("");
  });
});

describe("Grok history compatibility", () => {
  it("removes replayed thinking/reasoning while retaining text and tool semantics", () => {
    const input = [
      { role: "system", content: [{ type: "text", text: "system" }] },
      { role: "user", content: [{ type: "text", text: "request" }] },
      {
        role: "assistant",
        reasoning_content: "root private reasoning",
        content: [
          { type: "thinking", text: "private thought" },
          { type: "text", text: "answer" },
          { type: "tool_call", id: "call-1", name: "lookup" },
          { type: "reasoning", text: "more private thought" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_result", tool_call_id: "call-1", text: "result" },
        ],
      },
      { role: "assistant", thinking: "empty", content: [] },
    ];
    const original = structuredClone(input);
    const result = transformGrokHistory(input);

    expect(result[0]).toEqual(input[0]);
    expect(result[1]).toEqual(input[1]);
    expect(result[2]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "answer" },
        { type: "tool_call", id: "call-1", name: "lookup" },
      ],
    });
    expect(result[3]).toEqual(input[3]);
    expect(result[4]).toEqual({ role: "assistant", content: [] });
    expect(input).toEqual(original);
  });

  it("is a semantic no-op for production string messages", () => {
    const input = [
      { role: "system", content: "system" },
      { role: "assistant", content: "answer" },
    ];
    expect(transformGrokHistory(input)).toEqual(input);
    expect(transformGrokHistory(input)[0]).not.toBe(input[0]);
  });
});
