// Deterministic mock LLM for end-to-end tests (spec: e2e-testing › Docker stack).
// Speaks the OpenAI-compatible (/v1/chat/completions, /v1/models) and Anthropic-compatible
// (/v1/messages) APIs, streaming or not. The reply is picked by a marker like [[fix-carrier]] in
// the last user message. Every request is logged so tests can assert what context was sent.
import { createServer } from "node:http";

/** marker -> reply. `tool` makes the model call a tool instead of writing text. */
export const SCRIPTS = {
  "fix-carrier": {
    text: "I rewrote the query to filter on the carrier.",
    tool: { name: "edit_console", input: { sql: "SELECT * FROM shipments WHERE carrier = 'DHL'" } },
  },
  hello: { text: "Hello from the mock model." },
};
const DEFAULT_REPLY = { text: "Mock reply." };

const MODELS = ["mock-gpt", "mock-claude"];
const marker = (text) => /\[\[([\w-]+)\]\]/.exec(text)?.[1];

function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((p) => (typeof p === "string" ? p : (p.text ?? ""))).join("\n");
    }
  }
  return "";
}

const pick = (messages) => SCRIPTS[marker(lastUserText(messages))] ?? DEFAULT_REPLY;
const words = (text) => text.split(/(?<= )/);

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [event, data] of events) {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  }
  res.end();
}

function openai(body, res) {
  const reply = pick(body.messages);
  const id = "chatcmpl-mock";
  const toolCalls = reply.tool
    ? [
        {
          id: "call_mock",
          type: "function",
          function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.input) },
        },
      ]
    : undefined;
  if (!body.stream) {
    const message = {
      role: "assistant",
      content: reply.text,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    };
    return json(res, {
      id,
      object: "chat.completion",
      model: body.model ?? MODELS[0],
      choices: [{ index: 0, message, finish_reason: toolCalls ? "tool_calls" : "stop" }],
    });
  }
  const chunk = (delta, finish = null) => ({
    id,
    object: "chat.completion.chunk",
    model: body.model ?? MODELS[0],
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const events = [[null, chunk({ role: "assistant" })]];
  for (const w of words(reply.text)) events.push([null, chunk({ content: w })]);
  if (toolCalls)
    events.push([null, chunk({ tool_calls: toolCalls.map((t, index) => ({ index, ...t })) })]);
  events.push([null, chunk({}, toolCalls ? "tool_calls" : "stop")], [null, "[DONE]"]);
  sse(res, events);
}

function anthropic(body, res) {
  const reply = pick(body.messages);
  const model = body.model ?? MODELS[1];
  const content = [{ type: "text", text: reply.text }];
  if (reply.tool)
    content.push({
      type: "tool_use",
      id: "toolu_mock",
      name: reply.tool.name,
      input: reply.tool.input,
    });
  const stop = reply.tool ? "tool_use" : "end_turn";
  if (!body.stream) {
    return json(res, {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stop,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
  const events = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model,
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    ...words(reply.text).map((w) => [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: w } },
    ]),
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ];
  if (reply.tool) {
    events.push(
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_mock", name: reply.tool.name, input: {} },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.tool.input) },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
    );
  }
  events.push(
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } },
    ],
    ["message_stop", { type: "message_stop" }],
  );
  sse(res, events);
}

function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export function createMockServer() {
  /** Every API request, newest last: what a test asserts the app sent. */
  const log = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") return json(res, { ok: true });
    if (req.method === "GET" && url.pathname === "/__requests") return json(res, log);
    if (req.method === "DELETE" && url.pathname === "/__requests") {
      log.length = 0;
      return json(res, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, { object: "list", data: MODELS.map((id) => ({ id, object: "model" })) });
    }
    if (
      req.method === "POST" &&
      (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/messages")
    ) {
      const body = await readBody(req);
      log.push({
        path: url.pathname,
        authorization: req.headers.authorization ?? req.headers["x-api-key"] ?? null,
        body,
      });
      return url.pathname === "/v1/messages" ? anthropic(body, res) : openai(body, res);
    }
    return json(res, { error: "not found" }, 404);
  });
  return { server, log };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.PORT ?? 8080);
  createMockServer().server.listen(port, "0.0.0.0", () => console.log(`mock-llm on :${port}`));
}
