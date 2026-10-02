import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { LEGACY_ADOPTION_APPROVALS, lookupMirrorSourceRows } from "./mirror_identity.mjs";

// Load the actual TypeScript entrypoint; replace only external SDK/runtime/DB
// boundaries. Node's native TypeScript loader executes every registered handler.
const handlers = new Map();
const state = { row: null, pauseNextRead: false };
const copy = (value) => structuredClone(value);
class Query {
  filters = [];
  updates = null;
  select() { return this; }
  eq(key, value) { this.filters.push(row => row[key] === value); return this; }
  like(key, pattern) { this.filters.push(row => row[key].startsWith(pattern.slice(0, -1))); return this; }
  contains(key, values) { this.filters.push(row => Object.entries(values).every(([k, v]) => row[key]?.[k] === v)); return this; }
  limit() { return this; }
  update(updates) { this.updates = updates; return this; }
  execute() {
    if (!state.row || !this.filters.every(filter => filter(state.row))) return [];
    if (this.updates) state.row = { ...state.row, ...copy(this.updates), updated_at: "2026-10-02T02:00:00+00:00" };
    return [copy(state.row)];
  }
  async single() {
    const snapshot = this.execute()[0] ?? null;
    if (state.pauseNextRead) {
      state.pauseNextRead = false;
      state.readCompleted();
      await state.resumeRead;
    }
    return { data: snapshot, error: null };
  }
  async maybeSingle() { return { data: this.execute()[0] ?? null, error: null }; }
  then(resolve, reject) { return Promise.resolve({ data: this.execute(), error: null }).then(resolve, reject); }
}
const database = { from(table) { assert.equal(table, "thoughts"); return new Query(); } };
globalThis.__ob1HandlerFixture = { handlers, database };
globalThis.Deno = { env: { get: () => "fixture-only" }, serve() {} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) });
const sdk = `
const fixture = globalThis.__ob1HandlerFixture;
export class McpServer { registerTool(name, schema, handler) { fixture.handlers.set(name, handler); } }
export class StreamableHTTPTransport {}
export class Hono { options() {} all() {} fetch() {} }
const chain = new Proxy(function () { return chain; }, { get() { return chain; } });
export const z = chain;
export const createClient = () => fixture.database;
`;
const external = new Set(["jsr:@supabase/functions-js/edge-runtime.d.ts", "@modelcontextprotocol/sdk/server/mcp.js", "@hono/mcp", "hono", "zod", "@supabase/supabase-js"]);
const hooks = registerHooks({ resolve(specifier, context, next) {
  return external.has(specifier)
    ? { url: `data:text/javascript,${encodeURIComponent(sdk)}`, shortCircuit: true }
    : next(specifier, context);
} });
try { await import("./index.ts"); } finally { hooks.deregister(); }

const approval = LEGACY_ADOPTION_APPROVALS[0];
const path = "entries/projects/zhoor-reviewer-auth-containment.md";
const body = "ZHOOR independent reviewers use a dedicated OpenAI Sign in with ChatGPT OAuth profile. Keep one authoritative rotating authorization store shared across fresh reviewer sessions; start primary and secondary reviewers sequentially so each refresh result is persisted before the next process starts. The primary route is Pi GPT-6.1 Sol high; the secondary route is Pi GPT-6.1 Sol xhigh; worker routes are unchanged. Pi remains pinned at 0.99.1.\n\nThis maintenance was published on 2026-10-01 at 3262193f7a13e3465cb122a2b9fe62668b969044. The synthetic rotation regression and 60-test orchestration suite passed; both disposable probes and both exact-SHA reviews passed. No downstream card was started.";
const content = `[my-ai-brain:${path}] ZHOOR reviewer OAuth profile and rotating authorization-store rule\nCategory: projects | Confidence: verified | Agent: Codex | Updated: 2026-10-01\n\n${body}`;
const legacy = `[projects] zhoor-reviewer-auth-containment (updated 2026-10-01): ZHOOR reviewer OAuth profile and rotating authorization-store rule\n\n${body}`;
const fingerprint = createHash("sha256").update(legacy.toLowerCase().trim().replace(/\s+/g, " ")).digest("hex");
function resetRow() {
  state.row = { id: approval.id, content: legacy, metadata: { source: "mcp" }, created_at: "2026-10-01T10:00:00+00:00", updated_at: "2026-10-01T14:32:35.856751+00:00", content_fingerprint: fingerprint, embedding: "[0.1,0.2]" };
  state.pauseNextRead = false;
}
async function adopt() {
  const result = await handlers.get("adopt_legacy_mirror_thought")({ id: approval.id, canonical_source_path: path, content, expected_updated_at: state.row.updated_at, expected_legacy_content: legacy, expected_legacy_fingerprint: fingerprint, canonical_owner_paths: [path], canonical_commit: approval.canonicalCommit, canonical_inventory_sha256: approval.canonicalInventorySha256 });
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(JSON.parse(result.content[0].text).operation, "adopted");
}

for (const [name, replacement] of [
  ["content", { content: "ordinary replacement" }],
  ["metadata", { metadata_patch: { type: "observation" } }],
  ["content and metadata", { content: "ordinary replacement", metadata_patch: { type: "observation" } }],
]) {
  test(`stale generic ${name} handler cannot erase a completed same-UUID adoption`, async () => {
    resetRow();
    let resume;
    const read = new Promise(resolve => { state.readCompleted = resolve; });
    state.resumeRead = new Promise(resolve => { resume = resolve; });
    state.pauseNextRead = true;
    const pending = handlers.get("update_thought")({ id: approval.id, ...replacement });
    await read;
    try { await adopt(); } finally { resume(); }
    const result = await pending;
    assert.equal(result.isError, true, "stale generic handler committed after adoption");
    assert.match(result.content[0].text, /STALE_READ/);
    assert.equal(state.row.content, content);
    assert.equal(state.row.metadata.source, "my-ai-brain");
    assert.equal(state.row.metadata.canonical_source_path, path);
    assert.equal(state.row.metadata.mirror_status, "active");
    const resolution = await lookupMirrorSourceRows(database, path, 1000);
    assert.equal(resolution.status, "EXACT_ONE_VALID");
    assert.equal(resolution.row.id, approval.id);
  });
}
test("ordinary non-racing generic handler still updates the same UUID", async () => {
  resetRow();
  const result = await handlers.get("update_thought")({ id: approval.id, content: "ordinary replacement", metadata_patch: { type: "observation" } });
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(state.row.id, approval.id);
  assert.equal(state.row.content, "ordinary replacement");
  assert.equal(state.row.metadata.type, "observation");
});
test("source lookup handler independently reads mapping without writing", async () => {
  resetRow();
  await adopt();
  const before = copy(state.row);
  assert.equal(typeof handlers.get("lookup_mirror_source"), "function");
  const result = await handlers.get("lookup_mirror_source")({ canonical_source_path: path });
  assert.notEqual(result.isError, true, result.content[0].text);
  const resolution = JSON.parse(result.content[0].text);
  assert.equal(resolution.status, "EXACT_ONE_VALID");
  assert.equal(resolution.row.id, approval.id);
  assert.deepEqual(state.row, before);
});
