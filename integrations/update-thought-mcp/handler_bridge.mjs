// Controlled fixture transport for the real registered handlers. No network,
// credentials or production DB: stdin commands, stdout JSON, fake SDK/DB only.
import readline from "node:readline";
import { handlers, state } from "./handler_fixture.mjs";
let resume;
const output = value => process.stdout.write(JSON.stringify(value) + "\n");
async function command(request) {
  switch (request.action) {
    case "setup": state.row = request.row; return { ready: true };
    case "pause":
      state.remoteGate = new Promise(resolve => { resume = resolve; });
      state.readCompleted = () => output({ event: "paused" });
      return { ready: true };
    case "clear_pause": state.remoteGate = null; return { ready: true };
    case "resume": resume(); return { ready: true };
    case "rpc": {
      const { method, params } = request;
      if (method === "initialize") return { result: { protocolVersion: "2025-06-18" } };
      if (method.startsWith("notifications/")) return null;
      return { result: await handlers.get(params.name)(params.arguments) };
    }
    case "inspect": return { row: state.row, attempts: state.attempts, writes: state.writes };
    default: throw new Error("unknown fixture command");
  }
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  // Requests remain independent; a timed-out consumer cannot cancel a handler.
  command(request).then(result => output({ id: request.id, result }), error => output({ id: request.id, error: error.message }));
}
