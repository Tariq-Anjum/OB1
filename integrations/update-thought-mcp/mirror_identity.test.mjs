import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAdoptionUpdate,
  buildAtomicMirrorInsert,
  classifyInsertFailure,
  classifySourceRows,
  executeMirrorPlan,
  planMirrorSync,
  validateCanonicalSourcePath,
  validateLegacyAdoption,
} from "./mirror_identity.mjs";

const sourcePath = "entries/projects/zhoor-reviewer-auth-containment.md";
const otherPath = "entries/projects/other-entry.md";
const expectedUpdatedAt = "2026-10-01T14:32:35.856751+00:00";
const legacyContent = "[projects] zhoor-reviewer-auth-containment (updated 2026-10-01): title\n\nbody";
const marked = (path, tail = " source text") => `[my-ai-brain:${path}]${tail}`;
const validRow = (id = "row-1", path = sourcePath) => ({
  id,
  content: marked(path),
  metadata: {
    source: "my-ai-brain",
    canonical_source_path: path,
    mirror_status: "active",
  },
  updated_at: expectedUpdatedAt,
});

test("new mirror insert carries the marker and matching metadata atomically", () => {
  const row = buildAtomicMirrorInsert({
    sourcePath,
    content: marked(sourcePath),
    embedding: [0.1, 0.2],
    fingerprint: "fingerprint",
    metadata: { type: "observation", topics: ["ZHOOR"] },
  });
  assert.equal(row.content, marked(sourcePath));
  assert.deepEqual(
    {
      source: row.metadata.source,
      canonical_source_path: row.metadata.canonical_source_path,
      mirror_status: row.metadata.mirror_status,
    },
    { source: "my-ai-brain", canonical_source_path: sourcePath, mirror_status: "active" },
  );
  assert.equal(row.embedding, "[0.1,0.2]");
  assert.equal(row.content_fingerprint, "fingerprint");
});

test("one valid mapping plans an update to the same UUID", () => {
  const row = validRow("stable-uuid");
  const resolution = classifySourceRows(sourcePath, [row]);
  assert.equal(resolution.status, "EXACT_ONE_VALID");
  const plan = planMirrorSync({ sourcePath, content: marked(sourcePath), resolution });
  assert.equal(plan.kind, "update");
  assert.equal(plan.id, "stable-uuid");
  assert.equal(plan.expectedUpdatedAt, expectedUpdatedAt);
});

test("NONE plans one atomic create", () => {
  const resolution = classifySourceRows(sourcePath, []);
  assert.equal(resolution.status, "NONE");
  assert.deepEqual(
    planMirrorSync({ sourcePath, content: marked(sourcePath), resolution }),
    { kind: "create" },
  );
});

test("NONE executes exactly one insert containing both identities", async () => {
  const inserted = [];
  let updates = 0;
  const result = await executeMirrorPlan({
    sourcePath,
    content: marked(sourcePath),
    legacyCandidates: [],
    resolution: { status: "NONE" },
    embedding: [0.1],
    fingerprint: "sha256-value",
    insert: async (payload) => { inserted.push(payload); return { id: "new-row" }; },
    update: async () => { updates += 1; },
    reread: async () => ({ status: "NONE" }),
  });
  assert.deepEqual(result, { kind: "created", row: { id: "new-row" } });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].content, marked(sourcePath));
  assert.equal(inserted[0].metadata.canonical_source_path, sourcePath);
  assert.equal(updates, 0);
});

test("EXACT_ONE executes one CAS update for the same UUID and never inserts", async () => {
  const row = validRow("same-uuid");
  const updates = [];
  let inserts = 0;
  const result = await executeMirrorPlan({
    sourcePath,
    content: marked(sourcePath, " updated"),
    legacyCandidates: [],
    resolution: { status: "EXACT_ONE_VALID", row },
    embedding: [0.2],
    fingerprint: "new-fingerprint",
    insert: async () => { inserts += 1; },
    update: async (...args) => { updates.push(args); return { id: row.id }; },
    reread: async () => ({ status: "EXACT_ONE_VALID", row }),
  });
  assert.deepEqual(result, { kind: "updated", row: { id: "same-uuid" } });
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0], "same-uuid");
  assert.equal(updates[0][1], expectedUpdatedAt);
  assert.equal(inserts, 0);
});

test("a 23505 insert race is reread and returned as conflict, never retried as update", async () => {
  let inserts = 0;
  let updates = 0;
  let rereads = 0;
  const result = await executeMirrorPlan({
    sourcePath,
    content: marked(sourcePath),
    legacyCandidates: [],
    resolution: { status: "NONE" },
    embedding: [0.1],
    fingerprint: "sha256-value",
    insert: async () => { inserts += 1; throw { code: "23505" }; },
    update: async () => { updates += 1; },
    reread: async () => { rereads += 1; return { status: "EXACT_ONE_VALID", row: validRow("raced-row") }; },
  });
  assert.deepEqual(result, {
    kind: "concurrent_mapping",
    sourcePath,
    current: { status: "EXACT_ONE_VALID", row: validRow("raced-row") },
  });
  assert.equal(inserts, 1);
  assert.equal(rereads, 1);
  assert.equal(updates, 0);
});

test("23505 is classified as a unique violation and never converted to update", () => {
  assert.deepEqual(classifyInsertFailure({ code: "23505" }, sourcePath), {
    kind: "UNIQUE_VIOLATION",
    sourcePath,
  });
});

test("23505 with no source mapping remains a fail-closed unique conflict", async () => {
  const result = await executeMirrorPlan({
    sourcePath,
    content: marked(sourcePath),
    legacyCandidates: [],
    resolution: { status: "NONE" },
    embedding: [0.1],
    fingerprint: "sha256-value",
    insert: async () => { throw { code: "23505" }; },
    update: async () => assert.fail("unique violation must never be retried as update"),
    reread: async () => ({ status: "NONE" }),
  });
  assert.deepEqual(result, {
    kind: "unique_conflict",
    sourcePath,
    current: { status: "NONE" },
  });
});

test("duplicate marker claims are CONFLICT", () => {
  assert.equal(
    classifySourceRows(sourcePath, [validRow("one"), validRow("two")]).status,
    "CONFLICT",
  );
});

test("duplicate metadata claims are CONFLICT", () => {
  const row = (id) => ({
    id,
    content: "legacy content without a source marker",
    metadata: { source: "my-ai-brain", canonical_source_path: sourcePath, mirror_status: "active" },
  });
  assert.equal(classifySourceRows(sourcePath, [row("one"), row("two")]).status, "CONFLICT");
});

test("marker and metadata disagreement on one row is CONFLICT", () => {
  assert.equal(
    classifySourceRows(sourcePath, [
      { ...validRow(), content: marked(otherPath) },
    ]).status,
    "CONFLICT",
  );
});

test("different rows claiming the path through marker and metadata are CONFLICT", () => {
  const metadataOnly = {
    id: "metadata-row",
    content: "legacy content",
    metadata: { source: "my-ai-brain", canonical_source_path: sourcePath, mirror_status: "active" },
  };
  assert.equal(
    classifySourceRows(sourcePath, [validRow("marker-row"), metadataOnly]).status,
    "CONFLICT",
  );
});

test("source-less legacy candidates block normal create and are not adopted", () => {
  assert.deepEqual(
    planMirrorSync({
      sourcePath,
      content: marked(sourcePath),
      resolution: { status: "NONE" },
      legacyCandidates: [{ id: "legacy-row", content: legacyContent, metadata: {} }],
    }),
    { kind: "blocked", reason: "LEGACY_CANDIDATE_REQUIRES_ADOPTION" },
  );
});

test("explicit adoption requires UUID, exact evidence, unique owner, and current revision", () => {
  const target = {
    id: "target-uuid",
    content: legacyContent,
    content_fingerprint: "legacy-fingerprint",
    metadata: { source: "mcp" },
    updated_at: expectedUpdatedAt,
  };
  assert.equal(validateLegacyAdoption({
    sourcePath,
    sourceResolution: { status: "NONE" },
    target,
    explicitId: "target-uuid",
    expectedUpdatedAt,
    expectedLegacyContent: legacyContent,
    expectedLegacyFingerprint: "legacy-fingerprint",
    legacyCandidateIds: ["target-uuid"],
    canonicalOwnerPaths: [sourcePath],
  }), true);
});

test("adoption update preserves target UUID and establishes both identities", () => {
  const target = { id: "preserved-uuid", updated_at: expectedUpdatedAt, metadata: { type: "observation" } };
  const update = buildAdoptionUpdate({
    sourcePath,
    target,
    expectedUpdatedAt,
    content: marked(sourcePath),
    embedding: [0.3],
    fingerprint: "new-fingerprint",
  });
  assert.equal(update.id, "preserved-uuid");
  assert.equal(update.expectedUpdatedAt, expectedUpdatedAt);
  assert.equal(update.updates.content, marked(sourcePath));
  assert.equal(update.updates.metadata.source, "my-ai-brain");
  assert.equal(update.updates.metadata.canonical_source_path, sourcePath);
  assert.equal(update.updates.metadata.mirror_status, "active");
});

test("adoption refuses a target carrying another canonical path", () => {
  assert.throws(() => validateLegacyAdoption({
    sourcePath,
    sourceResolution: { status: "NONE" },
    target: { id: "target-uuid", content: legacyContent, metadata: { source: "my-ai-brain", canonical_source_path: otherPath }, updated_at: expectedUpdatedAt },
    explicitId: "target-uuid",
    expectedUpdatedAt,
    expectedLegacyContent: legacyContent,
    expectedLegacyFingerprint: "legacy-fingerprint",
    legacyCandidateIds: ["target-uuid"],
    canonicalOwnerPaths: [sourcePath],
  }), /target already claims/i);
});

test("adoption refuses a requested path claimed by another row", () => {
  assert.throws(() => validateLegacyAdoption({
    sourcePath,
    sourceResolution: { status: "EXACT_ONE_VALID", row: validRow("other-row") },
    target: { id: "target-uuid", content: legacyContent, content_fingerprint: "legacy-fingerprint", metadata: {}, updated_at: expectedUpdatedAt },
    explicitId: "target-uuid",
    expectedUpdatedAt,
    expectedLegacyContent: legacyContent,
    expectedLegacyFingerprint: "legacy-fingerprint",
    legacyCandidateIds: ["target-uuid"],
    canonicalOwnerPaths: [sourcePath],
  }), /source path is not unused/i);
});

test("adoption rejects a stale expected timestamp", () => {
  assert.throws(() => validateLegacyAdoption({
    sourcePath,
    sourceResolution: { status: "NONE" },
    target: { id: "target-uuid", content: legacyContent, metadata: {}, updated_at: "2026-10-02T00:00:00Z" },
    explicitId: "target-uuid",
    expectedUpdatedAt,
    expectedLegacyContent: legacyContent,
    expectedLegacyFingerprint: "legacy-fingerprint",
    legacyCandidateIds: ["target-uuid"],
    canonicalOwnerPaths: [sourcePath],
  }), /stale|concurrency/i);
});

test("adoption rejects excluded rows", () => {
  assert.throws(() => validateLegacyAdoption({
    sourcePath,
    sourceResolution: { status: "NONE" },
    target: { id: "target-uuid", content: legacyContent, metadata: { mirror_status: "historical_superseded" }, updated_at: expectedUpdatedAt },
    explicitId: "target-uuid",
    expectedUpdatedAt,
    expectedLegacyContent: legacyContent,
    expectedLegacyFingerprint: "legacy-fingerprint",
    legacyCandidateIds: ["target-uuid"],
    canonicalOwnerPaths: [sourcePath],
  }), /excluded/i);
});

test("adoption rejects a second canonical owner for the legacy evidence", () => {
  assert.throws(() => validateLegacyAdoption({
    sourcePath,
    sourceResolution: { status: "NONE" },
    target: { id: "target-uuid", content: legacyContent, content_fingerprint: "legacy-fingerprint", metadata: {}, updated_at: expectedUpdatedAt },
    explicitId: "target-uuid",
    expectedUpdatedAt,
    expectedLegacyContent: legacyContent,
    expectedLegacyFingerprint: "legacy-fingerprint",
    legacyCandidateIds: ["target-uuid"],
    canonicalOwnerPaths: [sourcePath, otherPath],
  }), /exactly one canonical owner/i);
});

test("invalid and noncanonical source paths are rejected", () => {
  for (const invalid of ["../escape.md", "/absolute.md", "entries/projects/../x.md", "entries/Projects/name.md", "entries/projects/name.MD", "entries\\projects\\name.md"]) {
    assert.throws(() => validateCanonicalSourcePath(invalid));
  }
});

test("excluded mappings participate in conflict instead of being silently ignored", () => {
  const excluded = {
    ...validRow(),
    metadata: { ...validRow().metadata, mirror_status: "historical_superseded" },
  };
  assert.equal(classifySourceRows(sourcePath, [excluded]).status, "CONFLICT");
});
