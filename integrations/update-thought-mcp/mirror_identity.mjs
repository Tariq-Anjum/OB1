const CANONICAL_SOURCE = "my-ai-brain";
const SOURCE_PATH_RE = /^entries\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\.md$/;

export function validateCanonicalSourcePath(sourcePath) {
  if (typeof sourcePath !== "string" || !SOURCE_PATH_RE.test(sourcePath)) {
    throw new TypeError("Invalid canonical source path");
  }
  return sourcePath;
}

export function sourceMarkerPath(content) {
  if (typeof content !== "string" || !content.startsWith("[my-ai-brain:")) {
    return null;
  }
  const end = content.indexOf("]");
  if (end < 0) throw new TypeError("Invalid my-ai-brain source marker");
  const sourcePath = content.slice("[my-ai-brain:".length, end);
  validateCanonicalSourcePath(sourcePath);
  const next = content[end + 1];
  if (next !== undefined && next !== " " && next !== "\n") {
    throw new TypeError("Invalid my-ai-brain source marker delimiter");
  }
  return sourcePath;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isExcludedMirror(metadata) {
  if (!isRecord(metadata)) return false;
  return [
    metadata.mirror_status,
    metadata.lifecycle_status,
    metadata.record_status,
    metadata.status,
  ].some((value) =>
    value === "historical_superseded" || value === "accidental_duplicate"
  );
}

function sameSnapshot(left, right) {
  return JSON.stringify([
    left.content,
    left.metadata ?? null,
    left.updated_at ?? null,
    left.created_at ?? null,
    left.content_fingerprint ?? null,
  ]) === JSON.stringify([
    right.content,
    right.metadata ?? null,
    right.updated_at ?? null,
    right.created_at ?? null,
    right.content_fingerprint ?? null,
  ]);
}

export function classifySourceRows(sourcePath, candidateRows) {
  validateCanonicalSourcePath(sourcePath);
  if (!Array.isArray(candidateRows)) return { status: "CONFLICT" };

  const rowsById = new Map();
  for (const row of candidateRows) {
    if (!isRecord(row) || typeof row.id !== "string") return { status: "CONFLICT" };
    const previous = rowsById.get(row.id);
    if (previous && !sameSnapshot(previous, row)) return { status: "CONFLICT" };
    rowsById.set(row.id, row);
  }

  const claims = [];
  for (const row of rowsById.values()) {
    const metadata = isRecord(row.metadata) ? row.metadata : {};
    let markerPath;
    let invalidMarker = false;
    try {
      markerPath = sourceMarkerPath(row.content);
    } catch {
      invalidMarker = true;
      markerPath = null;
    }
    const metadataPath = metadata.canonical_source_path;
    const claimsByMarker = markerPath === sourcePath;
    const claimsByMetadata = metadataPath === sourcePath;
    if (invalidMarker || claimsByMarker || claimsByMetadata) {
      claims.push({ row, markerPath, metadata, claimsByMarker, claimsByMetadata, invalidMarker });
    }
  }

  if (claims.length === 0) return { status: "NONE" };
  if (claims.length !== 1) return { status: "CONFLICT" };
  const claim = claims[0];
  if (
    claim.invalidMarker ||
    !claim.claimsByMarker ||
    !claim.claimsByMetadata ||
    claim.metadata.source !== CANONICAL_SOURCE ||
    claim.metadata.mirror_status !== "active" ||
    isExcludedMirror(claim.metadata)
  ) {
    return { status: "CONFLICT" };
  }
  return { status: "EXACT_ONE_VALID", row: claim.row };
}

export function buildAtomicMirrorInsert({
  sourcePath,
  content,
  embedding,
  fingerprint,
  metadata = {},
}) {
  validateCanonicalSourcePath(sourcePath);
  if (sourceMarkerPath(content) !== sourcePath) {
    throw new TypeError("Mirror content marker does not match canonical source path");
  }
  if (!Array.isArray(embedding) || typeof fingerprint !== "string" || !fingerprint) {
    throw new TypeError("Mirror embedding and content fingerprint are required");
  }
  const safeMetadata = isRecord(metadata) ? metadata : {};
  return {
    content,
    embedding: `[${embedding.join(",")}]`,
    content_fingerprint: fingerprint,
    metadata: {
      ...safeMetadata,
      source: CANONICAL_SOURCE,
      canonical_source_path: sourcePath,
      mirror_status: "active",
    },
  };
}

export function planMirrorSync({
  sourcePath,
  content,
  resolution,
  legacyCandidates = [],
}) {
  validateCanonicalSourcePath(sourcePath);
  if (sourceMarkerPath(content) !== sourcePath) {
    throw new TypeError("Mirror content marker does not match canonical source path");
  }
  if (!resolution || resolution.status === "CONFLICT") {
    return { kind: "blocked", reason: "CONFLICT" };
  }
  if (!Array.isArray(legacyCandidates)) {
    return { kind: "blocked", reason: "LEGACY_CANDIDATE_LOOKUP_INVALID" };
  }
  if (resolution.status === "EXACT_ONE_VALID") {
    if (!resolution.row || typeof resolution.row.id !== "string") {
      return { kind: "blocked", reason: "CONFLICT" };
    }
    if (legacyCandidates.some((row) => row?.id !== resolution.row.id)) {
      return { kind: "blocked", reason: "LEGACY_CANDIDATE_REQUIRES_ADOPTION" };
    }
    return {
      kind: "update",
      id: resolution.row.id,
      expectedUpdatedAt: resolution.row.updated_at,
      row: resolution.row,
    };
  }
  if (resolution.status === "NONE") {
    if (legacyCandidates.length > 0) {
      return { kind: "blocked", reason: "LEGACY_CANDIDATE_REQUIRES_ADOPTION" };
    }
    return { kind: "create" };
  }
  return { kind: "blocked", reason: "CONFLICT" };
}

export function classifyInsertFailure(error, sourcePath) {
  if (error?.code !== "23505") return null;
  return { kind: "UNIQUE_VIOLATION", sourcePath };
}

export async function executeMirrorPlan({
  sourcePath,
  content,
  legacyCandidates = [],
  resolution,
  embedding,
  fingerprint,
  metadata = {},
  insert,
  update,
  reread,
}) {
  const plan = planMirrorSync({ sourcePath, content, resolution, legacyCandidates });
  if (plan.kind === "blocked") {
    throw new Error(plan.reason);
  }
  const payload = buildAtomicMirrorInsert({
    sourcePath,
    content,
    embedding,
    fingerprint,
    metadata: plan.kind === "update"
      ? { ...(plan.row.metadata ?? {}), ...metadata }
      : metadata,
  });
  if (plan.kind === "update") {
    const row = await update(plan.id, plan.expectedUpdatedAt, payload);
    if (!row) throw new Error("STALE_READ: mapped mirror changed during update");
    return { kind: "updated", row };
  }
  try {
    const row = await insert(payload);
    return { kind: "created", row };
  } catch (error) {
    const failure = classifyInsertFailure(error, sourcePath);
    if (!failure) throw error;
    const current = await reread();
    if (current?.status !== "EXACT_ONE_VALID") {
      return {
        kind: "unique_conflict",
        sourcePath,
        current,
      };
    }
    return {
      kind: "concurrent_mapping",
      sourcePath,
      current,
    };
  }
}

export function validateLegacyAdoption({
  sourcePath,
  sourceResolution,
  target,
  explicitId,
  expectedUpdatedAt,
  expectedLegacyContent,
  expectedLegacyFingerprint,
  legacyCandidateIds,
  canonicalOwnerPaths,
}) {
  validateCanonicalSourcePath(sourcePath);
  if (sourceResolution?.status !== "NONE") {
    throw new Error("source path is not unused");
  }
  if (!isRecord(target) || typeof explicitId !== "string" || target.id !== explicitId) {
    throw new Error("explicit target thought UUID does not match the row");
  }
  const metadata = isRecord(target.metadata) ? target.metadata : {};
  let targetMarker;
  try {
    targetMarker = sourceMarkerPath(target.content);
  } catch {
    throw new Error("target has an invalid source identity marker");
  }
  if (targetMarker !== null || (metadata.canonical_source_path !== undefined && metadata.canonical_source_path !== null)) {
    throw new Error("target already claims another canonical path");
  }
  if (metadata.source === CANONICAL_SOURCE) {
    throw new Error("target has an incomplete my-ai-brain identity");
  }
  if (isExcludedMirror(metadata)) {
    throw new Error("target is excluded from adoption");
  }
  if (typeof expectedUpdatedAt !== "string" || !expectedUpdatedAt || target.updated_at !== expectedUpdatedAt) {
    throw new Error("STALE_READ: adoption concurrency token does not match");
  }
  if (target.content !== expectedLegacyContent || typeof expectedLegacyContent !== "string") {
    throw new Error("target content does not match expected legacy evidence");
  }
  if (!expectedLegacyFingerprint || target.content_fingerprint !== expectedLegacyFingerprint) {
    throw new Error("target content fingerprint does not match expected legacy evidence");
  }
  if (!Array.isArray(legacyCandidateIds) || legacyCandidateIds.length !== 1 || legacyCandidateIds[0] !== explicitId) {
    throw new Error("legacy content evidence is not unique to the explicit target");
  }
  if (!Array.isArray(canonicalOwnerPaths) || canonicalOwnerPaths.length !== 1 || canonicalOwnerPaths[0] !== sourcePath) {
    throw new Error("expected exactly one canonical owner for legacy content");
  }
  return true;
}

export function buildAdoptionUpdate({
  sourcePath,
  target,
  expectedUpdatedAt,
  content,
  embedding,
  fingerprint,
}) {
  validateCanonicalSourcePath(sourcePath);
  if (!isRecord(target) || typeof target.id !== "string") {
    throw new TypeError("adoption target UUID is required");
  }
  const payload = buildAtomicMirrorInsert({
    sourcePath,
    content,
    embedding,
    fingerprint,
    metadata: target.metadata,
  });
  return {
    id: target.id,
    expectedUpdatedAt,
    updates: payload,
  };
}
