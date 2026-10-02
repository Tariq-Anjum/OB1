import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as identity from "./mirror_identity.mjs";

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
const legacyFingerprint = "a".repeat(64);
const legacyContent = "[projects] zhoor-reviewer-auth-containment (updated 2026-10-01): title\n\nbody";
const marked = (path, tail = " source text") => `[my-ai-brain:${path}]${tail}`;
const rendered = (path, body = "body", category = "projects") =>
  `[my-ai-brain:${path}] title\nCategory: ${category} | Confidence: verified | Agent: controller | Updated: 2026-10-01\n\n${body}`;
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const testApproval = (path = sourcePath, id = "target-uuid") => ({
  id,
  sourcePath: path,
  canonicalCommit: "a".repeat(40),
  canonicalContentSha256: sha256(rendered(path)),
  canonicalLegacySha256: sha256(legacyContent),
  canonicalOwnerPaths: [path],
  canonicalInventorySha256: "b".repeat(64),
});
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

test("lookup adapter includes malformed marker-only rows instead of returning NONE", async () => {
  const malformed = {
    id: "malformed-marker",
    content: `[my-ai-brain:${sourcePath}`,
    metadata: { source: "legacy" },
    updated_at: expectedUpdatedAt,
  };
  const fakeSupabase = {
    from(table) {
      assert.equal(table, "thoughts");
      return {
        select() {
          return {
            like(column, pattern) {
              assert.equal(column, "content");
              return {
                limit(limit) {
                  assert.ok(limit > 0);
                  const prefix = pattern.slice(0, -1);
                  return Promise.resolve({
                    data: [malformed].filter((row) => row.content.startsWith(prefix)),
                    error: null,
                  });
                },
              };
            },
            contains(column, filter) {
              assert.equal(column, "metadata");
              assert.deepEqual(filter, { canonical_source_path: sourcePath });
              return {
                limit(limit) {
                  assert.ok(limit > 0);
                  return Promise.resolve({ data: [], error: null });
                },
              };
            },
          };
        },
      };
    },
  };

  assert.equal(typeof identity.lookupMirrorSourceRows, "function");
  const resolution = await identity.lookupMirrorSourceRows(fakeSupabase, sourcePath, 1000);
  assert.equal(resolution.status, "CONFLICT");
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
  const approval = testApproval();
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
    canonicalCommit: approval.canonicalCommit,
    canonicalContentSha256: approval.canonicalContentSha256,
    canonicalLegacySha256: approval.canonicalLegacySha256,
    canonicalInventorySha256: approval.canonicalInventorySha256,
    content: rendered(sourcePath),
    approvedAdoption: approval,
  }), true);
});

test("adoption approval is server-selected and binds UUID, path, commit, content, and owner inventory", () => {
  const approved = identity.findApprovedLegacyAdoption(
    "b5b70849-80cd-4388-a3bc-b09ca8ded2a8",
    sourcePath,
  );
  assert.ok(approved);
  assert.equal(approved.canonicalCommit, "9b855bd8bac870b8c600d5f054a83ac61e5abdd0");
  assert.equal(approved.canonicalContentSha256, "3c073f2e75c7f26250a29cb3c48e99a948e1f894fac5199f2627090e9be7a829");
  assert.equal(approved.canonicalLegacySha256, "79dcc3bc6686cd0da5fde566509dfb21da6940918febd91a5c7bb34183e1b1b3");
  assert.deepEqual(approved.canonicalOwnerPaths, [sourcePath]);
  assert.equal(approved.canonicalInventorySha256, "ef121425d3ede84d220be464cc5e047946c3ee54eba23958dd1885daa385b30e");
  assert.equal(identity.findApprovedLegacyAdoption("not-authorized", sourcePath), null);
  assert.equal(identity.findApprovedLegacyAdoption("b5b70849-80cd-4388-a3bc-b09ca8ded2a8", otherPath), null);
  const approval = testApproval();
  const evidence = {
    id: approval.id,
    sourcePath: approval.sourcePath,
    canonicalCommit: approval.canonicalCommit,
    canonicalContentSha256: approval.canonicalContentSha256,
    canonicalLegacySha256: approval.canonicalLegacySha256,
    canonicalOwnerPaths: approval.canonicalOwnerPaths,
    canonicalInventorySha256: approval.canonicalInventorySha256,
  };
  assert.equal(identity.validateLegacyAdoptionApproval(approval, evidence), true);
  assert.throws(() => identity.validateLegacyAdoptionApproval(approval, {
    ...evidence,
    sourcePath: otherPath,
  }), /server-approved legacy adoption/i);
  assert.throws(() => identity.validateLegacyAdoptionApproval(approval, {
    ...evidence,
    canonicalCommit: "c".repeat(40),
  }), /server-approved legacy adoption/i);
  assert.throws(() => identity.validateLegacyAdoptionApproval(approval, {
    ...evidence,
    canonicalInventorySha256: "d".repeat(64),
  }), /server-approved legacy adoption/i);
  assert.throws(() => identity.validateLegacyAdoptionApproval(approval, {
    ...evidence,
    canonicalContentSha256: "e".repeat(64),
  }), /server-approved legacy adoption/i);
  assert.throws(() => identity.validateLegacyAdoptionApproval(approval, {
    ...evidence,
    canonicalOwnerPaths: [sourcePath, otherPath],
  }), /server-approved legacy adoption/i);
});

test("adoption render agreement rejects missing or malformed category evidence", () => {
  assert.throws(() => identity.validateAdoptionRenderAgreement(
    otherPath,
    `[my-ai-brain:${otherPath}] title\n\nbody`,
    "ordinary thought\n\nbody",
  ), /category/i);
  assert.throws(() => identity.validateAdoptionRenderAgreement(
    otherPath,
    `[my-ai-brain:${otherPath}] title\nCategory: | Confidence: verified | Agent: controller | Updated: 2026-10-01\n\nbody`,
    "[projects] title\n\nbody",
  ), /category/i);
});

test("adoption render agreement rejects a category inconsistent with the source path", () => {
  assert.throws(() => identity.validateAdoptionRenderAgreement(
    sourcePath,
    rendered(sourcePath, "body", "tools"),
    "[tools] title\n\nbody",
  ), /category.*source path/i);
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

test("adoption rejects replacement content unrelated to the legacy row evidence", () => {
  assert.throws(() => validateLegacyAdoption({
    sourcePath,
    sourceResolution: { status: "NONE" },
    target: {
      id: "target-uuid",
      content: legacyContent,
      content_fingerprint: "legacy-fingerprint",
      metadata: {},
      updated_at: expectedUpdatedAt,
    },
    explicitId: "target-uuid",
    expectedUpdatedAt,
    expectedLegacyContent: legacyContent,
    expectedLegacyFingerprint: "legacy-fingerprint",
    legacyCandidateIds: ["target-uuid"],
    canonicalOwnerPaths: [sourcePath],
    content: marked(sourcePath, " unrelated replacement body"),
  }), /does not match legacy source evidence/);
});

test("guarded adoption rollback restores the same UUID and complete original row payload", () => {
  const beforeImage = {
    id: "target-uuid",
    content: legacyContent,
    embedding: "[0.1,0.2]",
    content_fingerprint: legacyFingerprint,
    metadata: { source: "mcp", type: "observation" },
    created_at: "2026-10-01T10:00:00+00:00",
    updated_at: expectedUpdatedAt,
  };
  const current = {
    id: "target-uuid",
    content: rendered(sourcePath),
    embedding: "[0.3,0.4]",
    content_fingerprint: "active-fingerprint",
    metadata: { source: "my-ai-brain", canonical_source_path: sourcePath, mirror_status: "active" },
    created_at: beforeImage.created_at,
    updated_at: "2026-10-02T00:00:00+00:00",
  };
  assert.equal(typeof identity.buildAdoptionRestoration, "function");
  const restoration = identity.buildAdoptionRestoration({
    sourcePath,
    current,
    beforeImage,
    explicitId: "target-uuid",
    expectedUpdatedAt: current.updated_at,
    sourceResolution: { status: "EXACT_ONE_VALID", row: current },
  });
  assert.equal(restoration.id, "target-uuid");
  assert.equal(restoration.updates.content, legacyContent);
  assert.equal(restoration.updates.embedding, "[0.1,0.2]");
  assert.equal(restoration.updates.content_fingerprint, legacyFingerprint);
  assert.deepEqual(restoration.updates.metadata, beforeImage.metadata);
});

test("guarded adoption rollback rejects a stale current-row revision", () => {
  assert.equal(typeof identity.buildAdoptionRestoration, "function");
  assert.throws(() => identity.buildAdoptionRestoration({
    sourcePath,
    current: validRow("target-uuid"),
    beforeImage: { id: "target-uuid", content: legacyContent, embedding: "[0.1]", content_fingerprint: legacyFingerprint, metadata: {}, created_at: "2026-10-01T10:00:00+00:00" },
    explicitId: "target-uuid",
    expectedUpdatedAt: "2026-10-01T00:00:00+00:00",
    sourceResolution: { status: "EXACT_ONE_VALID", row: validRow("target-uuid") },
}), /stale/i);
});

test("guarded rollback rejects an incomplete or noncanonical database before-image", () => {
  const current = {
    id: "target-uuid",
    content: rendered(sourcePath),
    embedding: "[0.3,0.4]",
    content_fingerprint: "active-fingerprint",
    metadata: { source: "my-ai-brain", canonical_source_path: sourcePath, mirror_status: "active" },
    created_at: "2026-10-01T10:00:00+00:00",
    updated_at: "2026-10-02T00:00:00+00:00",
  };
  assert.throws(() => identity.buildAdoptionRestoration({
    sourcePath,
    current,
    beforeImage: {
      id: "target-uuid",
      content: legacyContent,
      embedding: [0.1, 0.2],
      content_fingerprint: "not-a-sha256",
      metadata: [],
      created_at: current.created_at,
    },
    explicitId: "target-uuid",
    expectedUpdatedAt: current.updated_at,
    sourceResolution: { status: "EXACT_ONE_VALID", row: current },
  }), /rollback image is missing/i);
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
