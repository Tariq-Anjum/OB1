import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Load the actual TypeScript entrypoint; replace only external SDK/runtime/DB
// boundaries. Node's native TypeScript loader executes every registered handler.
const handlers = new Map();
const state = { rows: [], pauseNextRead: false, remoteGate: null, pauseNextUpdate: false, writes: 0, attempts: [], timestampAliases: new Map() };
Object.defineProperty(state, "row", {
  get() { return this.rows[0] ?? null; },
  set(value) { this.rows = value ? [value] : []; },
});
const copy = (value) => structuredClone(value);
// Model the unconditional BEFORE UPDATE trigger, including identical values.
const nextRevision = () => new Date(Date.UTC(2026, 9, 2, 2) + ++state.writes).toISOString();
class Query {
  filters = [];
  updates = null;
  insertion = null;
  select() { return this; }
  eq(key, value) {
    if (key === "updated_at") this.expectedRevision = value;
    // Optional golden PostgreSQL equivalent representations supplied by tests.
    // No timestamp arithmetic or precision reduction; production uses Postgres.
    const dbValue = value => state.timestampAliases.get(value) ?? value;
    this.filters.push(row => key === "updated_at" ? dbValue(row[key]) === dbValue(value) : row[key] === value);
    return this;
  }
  like(key, pattern) { this.filters.push(row => row[key].startsWith(pattern.slice(0, -1))); return this; }
  contains(key, values) { this.filters.push(row => Object.entries(values).every(([k, v]) => row[key]?.[k] === v)); return this; }
  limit() { return this; }
  update(updates) { this.updates = updates; return this; }
  insert(payload) { this.insertion = payload; return this; }
  execute() {
    if (this.insertion) {
      const row = { ...copy(this.insertion), id: state.rows.length ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111", created_at: "2026-10-02T00:00:00Z", updated_at: nextRevision() };
      state.rows.push(row);
      return [copy(row)];
    }
    if (this.updates) state.attempts.push(this.expectedRevision);
    const matched = state.rows.filter(row => this.filters.every(filter => filter(row)));
    if (this.updates) for (const row of matched) Object.assign(row, copy(this.updates), { updated_at: nextRevision() });
    return copy(matched);
  }
  async single() {
    if (this.insertion && state.rows.some(row => row.metadata?.canonical_source_path === this.insertion.metadata?.canonical_source_path)) return { data: null, error: { code: "23505", message: "fixture canonical path uniqueness" } };
    const snapshot = this.execute()[0] ?? null;
    if (state.pauseNextRead) {
      state.pauseNextRead = false;
      state.readCompleted();
      await state.resumeRead;
    }
    return { data: snapshot, error: null };
  }
  async maybeSingle() {
    if (this.updates && state.pauseNextUpdate) {
      state.pauseNextUpdate = false;
      state.readCompleted();
      await state.resumeRead;
    }
    return { data: this.execute()[0] ?? null, error: null };
  }
  async then(resolve, reject) {
    const gate = state.remoteGate;
    if (gate) { state.readCompleted(); await gate; }
    return Promise.resolve({ data: this.execute(), error: null }).then(resolve, reject);
  }
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


export { handlers, state, database };
