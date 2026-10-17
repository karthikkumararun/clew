import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One tool call the mock model makes. */
export interface MockToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** What the mock model answers to one request. */
export interface MockReply {
  text?: string;
  tools?: MockToolCall[];
}

export interface RecordedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: {
    model: string;
    stream?: boolean;
    messages: {
      role: string;
      content: string | null;
      tool_calls?: unknown[];
      tool_call_id?: string;
    }[];
    tools?: { function: { name: string } }[];
  };
  /** The system prompt: the context the app sent, as the model would read it. */
  system: string;
  /** True when this is a ghost-text request (a single `<before>`/`<after>` message, no tools). */
  completion: boolean;
}

export type Responder = (req: RecordedRequest, turn: number) => MockReply;

/**
 * An OpenAI-compatible chat server for the AI journeys (spec: ai-assistant, ai-providers). It
 * records every request, so a test can assert what the app sent (schema only on production, no
 * rows), and plays scripted answers as server-sent events. Nothing leaves the machine.
 */
export class MockLlm {
  private server: Server | null = null;
  readonly requests: RecordedRequest[] = [];
  private responder: Responder = () => ({ text: "OK" });
  port = 0;

  /** Decide the answer to each request; `turn` counts the chat requests so far. */
  respond(f: Responder) {
    this.responder = f;
  }

  get url() {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  /** Requests of the chat panel (not ghost text). */
  chats() {
    return this.requests.filter((r) => !r.completion);
  }

  completions() {
    return this.requests.filter((r) => r.completion);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = req.url ?? "";
    if (req.method === "GET" && path.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }
    if (!path.endsWith("/chat/completions")) {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    const body = JSON.parse(raw || "{}") as RecordedRequest["body"];
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const completion = !body.tools?.length && /<before>/.test(JSON.stringify(body.messages));
    const recorded: RecordedRequest = { path, headers: req.headers, body, system, completion };
    this.requests.push(recorded);
    const reply = this.responder(recorded, this.requests.length - 1);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (delta: object, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
    if (reply.text) {
      // Two pieces, so the panel streams.
      const mid = Math.max(1, Math.floor(reply.text.length / 2));
      send({ content: reply.text.slice(0, mid) });
      send({ content: reply.text.slice(mid) });
    }
    (reply.tools ?? []).forEach((t, i) => {
      send({
        tool_calls: [
          {
            index: i,
            id: `call_${this.requests.length}_${i}`,
            function: { name: t.name, arguments: JSON.stringify(t.args) },
          },
        ],
      });
    });
    send({}, reply.tools?.length ? "tool_calls" : "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  }
}
