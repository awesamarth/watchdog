import { createInterface } from "node:readline";

let streaming = false;
let model = { provider: "test", id: "test-model", name: "Test Model" };
let thinkingLevel = "medium";
let messageCount = 0;
let followUps = [];
let runSequence = 0;

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const respond = (request, data) => write({
  id: request.id,
  type: "response",
  command: request.type,
  success: true,
  ...(data === undefined ? {} : { data }),
});

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "get_state") {
    respond(request, {
      model,
      thinkingLevel,
      isStreaming: streaming,
      sessionId: "fake-session",
      messageCount,
      pendingMessageCount: followUps.length,
    });
    return;
  }
  if (request.type === "get_available_models") {
    respond(request, { models: [model, { provider: "test", id: "other-model" }] });
    return;
  }
  if (request.type === "set_model") {
    model = { provider: request.provider, id: request.modelId };
    respond(request, model);
    return;
  }
  if (request.type === "set_thinking_level") {
    thinkingLevel = request.level;
    respond(request);
    return;
  }
  if (request.type === "new_session") {
    messageCount = 0;
    followUps = [];
    respond(request, { cancelled: false });
    return;
  }
  if (request.type === "get_messages") {
    respond(request, { messages: [] });
    return;
  }
  if (request.type === "get_session_stats") {
    respond(request, { tokens: { total: 15 }, cost: 0.001 });
    return;
  }
  if (request.type === "steer") {
    respond(request);
    return;
  }
  if (request.type === "follow_up") {
    followUps.push(request.message);
    respond(request);
    return;
  }
  if (request.type === "abort") {
    runSequence += 1;
    streaming = false;
    followUps = [];
    respond(request);
    write({ type: "agent_settled" });
    return;
  }
  if (request.type === "prompt") {
    respond(request);
    run(request.message);
    return;
  }
  write({ id: request.id, type: "response", command: request.type, success: false, error: "unsupported command" });
});

function run(message) {
  const sequence = ++runSequence;
  streaming = true;
  const timestamp = Date.now();
  write({ type: "agent_start" });
  write({ type: "message_start", message: { role: "assistant", content: [], timestamp } });
  write({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp },
    assistantMessageEvent: { type: "text_delta", delta: "done" },
  });
  const finish = () => {
    if (!streaming || sequence !== runSequence) return;
    messageCount += 1;
    write({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `done: ${message}` }],
        timestamp,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
      },
    });
    write({ type: "agent_end", messages: [] });
    const followUp = followUps.shift();
    if (followUp) {
      queueMicrotask(() => run(followUp));
      return;
    }
    streaming = false;
    write({ type: "agent_settled" });
  };
  if (String(message).includes("SLOW")) setTimeout(finish, 250);
  else queueMicrotask(finish);
}
