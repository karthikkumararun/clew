import { describe, expect, it } from "vitest";
import { defaultProvider, isPlainHttpRemote, shortModel } from "./providers";

describe("provider defaults", () => {
  it("Claude defaults to Sonnet 5.5 and the first-party base URL (spec: ai-providers › Model list)", () => {
    const p = defaultProvider("anthropic");
    expect(p).toMatchObject({
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-5-5",
    });
  });

  it("OpenAI starts without a model until a key lists them", () => {
    expect(defaultProvider("openai")).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      model: "",
    });
  });

  it("a local model needs no auth and points at Ollama", () => {
    expect(defaultProvider("local")).toMatchObject({
      auth: "none",
      baseUrl: "http://localhost:11434",
    });
  });

  it("custom endpoints get the next free id", () => {
    expect(defaultProvider("custom", []).id).toBe("custom-1");
    expect(defaultProvider("custom", ["custom-1", "custom-2"]).id).toBe("custom-3");
  });
});

describe("isPlainHttpRemote (spec: ai-providers › Plain HTTP)", () => {
  it("flags http to another machine only", () => {
    expect(isPlainHttpRemote("http://llm.internal.example.com/v1")).toBe(true);
    expect(isPlainHttpRemote("https://llm.internal.example.com/v1")).toBe(false);
    expect(isPlainHttpRemote("http://localhost:11434")).toBe(false);
    expect(isPlainHttpRemote("http://127.0.0.1:1234")).toBe(false);
    expect(isPlainHttpRemote("nonsense")).toBe(false);
  });
});

describe("shortModel", () => {
  it("shortens Claude ids and leaves others alone", () => {
    expect(shortModel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(shortModel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(shortModel("gpt-5")).toBe("gpt-5");
  });
});
