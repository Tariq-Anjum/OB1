import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LEGACY_ADOPTION_APPROVALS, lookupMirrorSourceRows } from "./mirror_identity.mjs";
import { handlers, state, database } from "./handler_fixture.mjs";
const copy = value => structuredClone(value);

const approval = LEGACY_ADOPTION_APPROVALS[0];
const path = "entries/projects/zhoor-reviewer-auth-containment.md";
const body = "ZHOOR independent reviewers use a dedicated OpenAI Sign in with ChatGPT OAuth profile. Keep one authoritative rotating authorization store shared across fresh reviewer sessions; start primary and secondary reviewers sequentially so each refresh result is persisted before the next process starts. The primary route is Pi GPT-6.1 Sol high; the secondary route is Pi GPT-6.1 Sol xhigh; worker routes are unchanged. Pi remains pinned at 0.99.1.\n\nThis maintenance was published on 2026-10-01 at 3262193f7a13e3465cb122a2b9fe62668b969044. The synthetic rotation regression and 60-test orchestration suite passed; both disposable probes and both exact-SHA reviews passed. No downstream card was started.";
const content = `[my-ai-brain:${path}] ZHOOR reviewer OAuth profile and rotating authorization-store rule\nCategory: projects | Confidence: verified | Agent: Codex | Updated: 2026-10-01\n\n${body}`;
const legacy = `[projects] zhoor-reviewer-auth-containment (updated 2026-10-01): ZHOOR reviewer OAuth profile and rotating authorization-store rule\n\n${body}`;
const fingerprint = createHash("sha256").update(legacy.toLowerCase().trim().replace(/\s+/g, " ")).digest("hex");
function resetRow() {
  state.row = { id: approval.id, content: legacy, metadata: { source: "mcp" }, created_at: "2026-10-01T10:00:00+00:00", updated_at: "2026-10-01T14:32:35.856751+00:00", content_fingerprint: fingerprint, embedding: "[0.1,0.2]" };
  state.pauseNextRead = false;
  state.remoteGate = null;
  state.pauseNextUpdate = false;
  state.writes = 0;
  state.attempts = [];
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

test("identical mapped confirmation advances revision and invalidates outstanding fence", async () => {
  resetRow();
  await adopt();
  const original = copy(state.row);
  const request = { canonical_source_path: path, content: original.content, expected_legacy_content: legacy, expected_id: original.id, expected_updated_at: original.updated_at };
  const confirmation = await handlers.get("sync_mirror_thought")(request);
  assert.notEqual(confirmation.isError, true, confirmation.content[0].text);
  assert.notEqual(state.row.updated_at, original.updated_at);
  assert.equal(state.row.id, original.id);
  assert.equal(state.row.content, original.content);
  assert.deepEqual(state.row.metadata, original.metadata);
  const confirmed = copy(state.row);
  const stale = await handlers.get("sync_mirror_thought")({ ...request, content: content + "\nold generation" });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /STALE_WRITE_CONFLICT/);
  assert.deepEqual(state.row, confirmed);
  assert.equal(state.rows.length, 1);
});

for (const stage of ["before source lookup", "before final database update"]) {
  test(`detached R1 request retains pre-dispatch fence ${stage} after R2 confirmation`, async () => {
    resetRow();
    await adopt();
    const initial = await lookupMirrorSourceRows(database, path, 1000);
    const v0 = initial.row.updated_at;
    const r1 = { canonical_source_path: path, content: content + "\nR1", expected_legacy_content: legacy, expected_id: initial.row.id, expected_updated_at: v0 };
    let resume;
    const entered = new Promise(resolve => { state.readCompleted = resolve; });
    state.resumeRead = new Promise(resolve => { resume = resolve; });
    if (stage === "before source lookup") state.remoteGate = state.resumeRead;
    else state.pauseNextUpdate = true;
    const pending = handlers.get("sync_mirror_thought")(copy(r1));
    await entered;
    // Losing the client consumer does not cancel the real remote handler.
    await assert.rejects(Promise.race([pending, Promise.reject(new Error("client timeout"))]), /client timeout/);
    state.remoteGate = null;
    const r2Content = content + "\nR2";
    const newer = await handlers.get("sync_mirror_thought")({ ...r1, content: r2Content });
    assert.notEqual(newer.isError, true, newer.content[0].text);
    const ack = JSON.parse(newer.content[0].text);
    const confirmed = await lookupMirrorSourceRows(database, path, 1000);
    assert.equal(ack.id, approval.id);
    assert.equal(ack.operation, "updated");
    assert.equal(ack.canonical_source_path, path);
    assert.equal(confirmed.status, "EXACT_ONE_VALID");
    assert.equal(confirmed.row.content, r2Content);
    assert.notEqual(confirmed.row.updated_at, v0);
    const confirmedR2 = copy(state.row);
    const beforeAttempts = state.attempts.length;
    resume();
    const stale = await pending;
    assert.equal(stale.isError, true, "detached old payload committed after confirmed R2");
    assert.match(stale.content[0].text, /STALE_WRITE_CONFLICT/);
    assert.deepEqual(state.row, confirmedR2);
    const mapping = await lookupMirrorSourceRows(database, path, 1000);
    assert.equal(mapping.status, "EXACT_ONE_VALID");
    assert.equal(mapping.row.id, approval.id);
    assert.equal(state.writes, 2, "adoption + R2 only; no stale write or duplicate");
    assert.ok(state.attempts.slice(beforeAttempts).every(token => token === v0), "stale request refreshed its write fence");
    assert.ok(state.attempts.length - beforeAttempts <= 1, "stale request retried its write");
  });
}

test("mapped sync without a complete request fence fails closed", async () => {
  for (const fence of [{}, { expected_id: approval.id }, { expected_updated_at: "2026-10-02T02:00:01+00:00" }]) {
    resetRow(); await adopt(); const before = copy(state.row);
    const result = await handlers.get("sync_mirror_thought")({ canonical_source_path: path, content: content + "\nold", expected_legacy_content: legacy, ...fence });
    assert.equal(result.isError, true, "missing fence defaulted to server's current revision");
    assert.deepEqual(state.row, before);
  }
});

test("create-only request cannot turn into update of a newly mapped source", async () => {
  resetRow(); await adopt(); const before = copy(state.row);
  const result = await handlers.get("sync_mirror_thought")({ canonical_source_path: path, content: content + "\nold create", expected_legacy_content: legacy });
  assert.equal(result.isError, true);
  assert.deepEqual(state.row, before);
});

test("NONE create requires no revision and establishes identity atomically", async () => {
  resetRow(); state.row = null;
  const result = await handlers.get("sync_mirror_thought")({ canonical_source_path: path, content, expected_legacy_content: legacy });
  assert.notEqual(result.isError, true, result.content[0].text);
  const ack = JSON.parse(result.content[0].text);
  assert.equal(ack.operation, "created");
  assert.equal(ack.canonical_source_path, path);
  assert.equal(state.row.content, content);
  assert.equal(state.row.metadata.source, "my-ai-brain");
  assert.equal(state.row.metadata.canonical_source_path, path);
  assert.equal(state.row.metadata.mirror_status, "active");
  assert.equal(state.writes, 1);
});

test("update fence cannot create a replacement row when its mapping disappears", async () => {
  resetRow(); state.row = null;
  const result = await handlers.get("sync_mirror_thought")({ canonical_source_path: path, content, expected_legacy_content: legacy, expected_id: approval.id, expected_updated_at: "2026-10-02T00:00:00Z" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /STALE_WRITE_CONFLICT/);
  assert.equal(state.row, null);
  assert.equal(state.writes, 0);
});
