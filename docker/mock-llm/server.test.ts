// @vitest-environment node
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockServer } from "./server.mjs";

let base = "";
const { server, log } = createMockServer();
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (path: string, body: unknown) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("mock LLM (spec: e2e-testing › Docker stack)", () => {
  it("lists models", async () => {
    const r = await (await fetch(`${base}/v1/models`)).json();
    expect(r.data.length).toBeGreaterThan(0);
  });

  it("answers OpenAI chat with a scripted tool call chosen by marker", async () => {
    const r = await (
      await post("/v1/chat/completions", {
        messages: [{ role: "user", content: "fix it [[fix-carrier]]" }],
      })
    ).json();
    const call = r.choices[0].message.tool_calls[0];
    expect(call.function.name).toBe("edit_console");
    expect(JSON.parse(call.function.arguments).sql).toContain("carrier");
  });

  it("streams OpenAI chunks ending in [DONE]", async () => {
    const text = await (
      await post("/v1/chat/completions", {
        stream: true,
        messages: [{ role: "user", content: "[[hello]]" }],
      })
    ).text();
    expect(text).toContain("Hello");
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("answers Anthropic messages, streaming and not", async () => {
    const plain = await (
      await post("/v1/messages", { messages: [{ role: "user", content: "[[hello]]" }] })
    ).json();
    expect(plain.content[0].text).toBe("Hello from the mock model.");
    const streamed = await (
      await post("/v1/messages", {
        stream: true,
        messages: [{ role: "user", content: [{ type: "text", text: "[[fix-carrier]]" }] }],
      })
    ).text();
    expect(streamed).toContain("message_stop");
    expect(streamed).toContain("input_json_delta");
  });

  it("records requests so tests can inspect what was sent, and clears them", async () => {
    await fetch(`${base}/__requests`, { method: "DELETE" });
    await post("/v1/messages", { messages: [{ role: "user", content: "schema only please" }] });
    const seen = await (await fetch(`${base}/__requests`)).json();
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0].body)).toContain("schema only please");
    expect(log).toHaveLength(1);
  });
});
