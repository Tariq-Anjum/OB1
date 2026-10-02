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

export async function lookupMirrorSourceRows(supabase, sourcePath, maxRows) {
  validateCanonicalSourcePath(sourcePath);
  const markerPrefix = `[my-ai-brain:${sourcePath}`;
  const [markerResult, metadataResult] = await Promise.all([
    supabase.from("thoughts").select("id, content, metadata, created_at, updated_at, content_fingerprint")
      .like("content", `${markerPrefix}%`).limit(maxRows),
    supabase.from("thoughts").select("id, content, metadata, created_at, updated_at, content_fingerprint")
      .contains("metadata", { canonical_source_path: sourcePath }).limit(maxRows),
  ]);
  if (markerResult.error) throw new Error(`source marker lookup failed: ${markerResult.error.message}`);
  if (metadataResult.error) throw new Error(`source metadata lookup failed: ${metadataResult.error.message}`);
  const markerRows = markerResult.data ?? [];
  const metadataRows = metadataResult.data ?? [];
  if (markerRows.length >= maxRows || metadataRows.length >= maxRows) {
    throw new Error(`source lookup exceeded ${maxRows} rows; refusing to choose a mapping`);
  }
  return classifySourceRows(sourcePath, [...markerRows, ...metadataRows]);
}

export const LEGACY_ADOPTION_APPROVALS = Object.freeze([
  Object.freeze({
    id: "b5b70849-80cd-4388-a3bc-b09ca8ded2a8",
    sourcePath: "entries/projects/zhoor-reviewer-auth-containment.md",
    canonicalCommit: "6a7ed1913f1d677e4f3ae07d3f534f28f8854853",
    canonicalContentSha256: "3c073f2e75c7f26250a29cb3c48e99a948e1f894fac5199f2627090e9be7a829",
    canonicalLegacySha256: "79dcc3bc6686cd0da5fde566509dfb21da6940918febd91a5c7bb34183e1b1b3",
    canonicalOwnerPaths: Object.freeze(["entries/projects/zhoor-reviewer-auth-containment.md"]),
    canonicalInventorySha256: "ef121425d3ede84d220be464cc5e047946c3ee54eba23958dd1885daa385b30e",
  }),
]);

export function findApprovedLegacyAdoption(id, sourcePath, approvals = LEGACY_ADOPTION_APPROVALS) {
  validateCanonicalSourcePath(sourcePath);
  if (!Array.isArray(approvals)) return null;
  return approvals.find((approval) =>
    isRecord(approval) && approval.id === id && approval.sourcePath === sourcePath
  ) ?? null;
}

export function validateLegacyAdoptionApproval(approval, evidence) {
  if (!isRecord(approval) || !isRecord(evidence)) {
    throw new Error("no server-approved legacy adoption evidence was supplied");
  }
  const ownerPathsMatch = Array.isArray(approval.canonicalOwnerPaths) &&
    Array.isArray(evidence.canonicalOwnerPaths) &&
    JSON.stringify(approval.canonicalOwnerPaths) === JSON.stringify(evidence.canonicalOwnerPaths);
  if (
    approval.id !== evidence.id ||
    approval.sourcePath !== evidence.sourcePath ||
    approval.canonicalCommit !== evidence.canonicalCommit ||
    approval.canonicalContentSha256 !== evidence.canonicalContentSha256 ||
    approval.canonicalLegacySha256 !== evidence.canonicalLegacySha256 ||
    approval.canonicalInventorySha256 !== evidence.canonicalInventorySha256 ||
    !ownerPathsMatch
  ) {
    throw new Error("canonical source evidence does not match the server-approved legacy adoption");
  }
  return true;
}

export function validateAdoptionRenderAgreement(sourcePath, content, legacyContent) {
  validateCanonicalSourcePath(sourcePath);
  if (sourceMarkerPath(content) !== sourcePath) {
    throw new Error("replacement content marker does not match canonical source path");
  }
  const contentSeparator = content.indexOf("\n\n");
  const legacySeparator = legacyContent.indexOf("\n\n");
  if (contentSeparator < 0) {
    throw new Error("replacement content does not match legacy source evidence");
  }
  const contentHeader = content.slice(0, contentSeparator).split("\n");
  const legacyHeader = legacyContent.slice(0, legacySeparator < 0 ? legacyContent.length : legacySeparator);
  const contentTitle = /^\[my-ai-brain:[^\]]+\] \S.*$/.test(contentHeader[0] ?? "");
  const legacyMatch = /^\[([a-z0-9][a-z0-9-]*)\] \S.*$/.exec(legacyHeader.split("\n", 1)[0] ?? "");
  const contentMatch = /^Category: ([a-z0-9][a-z0-9-]*) \| Confidence: \S+ \| Agent: \S+ \| Updated: \S+$/.exec(contentHeader[1] ?? "");
  if (!contentTitle || contentHeader.length !== 2 || !legacyMatch || !contentMatch) {
    throw new Error("replacement or legacy render is missing valid category evidence");
  }
  const legacyCategory = legacyMatch[1];
  const contentCategory = contentMatch[1];
  const sourceCategory = sourcePath.split("/")[1];
  const legacyBody = legacySeparator < 0 ? "" : legacyContent.slice(legacySeparator + 2);
  const contentBody = content.slice(contentSeparator + 2);
  if (
    contentCategory !== legacyCategory ||
    contentCategory !== sourceCategory ||
    contentBody !== legacyBody
  ) {
    throw new Error("replacement category or body does not match legacy source evidence and canonical source path");
  }
  return true;
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
  canonicalCommit,
  canonicalContentSha256,
  canonicalLegacySha256,
  canonicalInventorySha256,
  approvedAdoption,
  content,
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
  validateAdoptionRenderAgreement(sourcePath, content, expectedLegacyContent);
  validateLegacyAdoptionApproval(approvedAdoption, {
    id: explicitId,
    sourcePath,
    canonicalCommit,
    canonicalContentSha256,
    canonicalLegacySha256,
    canonicalOwnerPaths,
    canonicalInventorySha256,
  });
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

export function buildAdoptionRestoration({
  sourcePath,
  current,
  beforeImage,
  explicitId,
  expectedUpdatedAt,
  sourceResolution,
}) {
  validateCanonicalSourcePath(sourcePath);
  if (!isRecord(current) || !isRecord(beforeImage) || current.id !== explicitId || beforeImage.id !== explicitId) {
    throw new Error("rollback UUID does not match the explicit target");
  }
  if (typeof expectedUpdatedAt !== "string" || current.updated_at !== expectedUpdatedAt) {
    throw new Error("STALE_READ: adopted thought changed before rollback");
  }
  if (current.created_at !== beforeImage.created_at) {
    throw new Error("rollback image does not belong to the current thought");
  }
  if (sourceResolution?.status !== "EXACT_ONE_VALID" || sourceResolution.row?.id !== explicitId) {
    throw new Error("current canonical mapping is not uniquely owned by the target");
  }
  const currentMetadata = isRecord(current.metadata) ? current.metadata : {};
  if (
    sourceMarkerPath(current.content) !== sourcePath ||
    currentMetadata.source !== CANONICAL_SOURCE ||
    currentMetadata.canonical_source_path !== sourcePath ||
    currentMetadata.mirror_status !== "active"
  ) {
    throw new Error("current thought is not the active adoption being rolled back");
  }

  const beforeMetadata = isRecord(beforeImage.metadata) ? beforeImage.metadata : {};
  let beforeMarker;
  try {
    beforeMarker = sourceMarkerPath(beforeImage.content);
  } catch {
    throw new Error("rollback image contains an invalid source marker");
  }
  if (
    beforeMarker !== null ||
    beforeMetadata.canonical_source_path !== undefined && beforeMetadata.canonical_source_path !== null ||
    beforeMetadata.source === CANONICAL_SOURCE ||
    isExcludedMirror(beforeMetadata)
  ) {
    throw new Error("rollback image is not a source-less active legacy row");
  }
  if (
    typeof beforeImage.content !== "string" ||
    typeof beforeImage.content_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(beforeImage.content_fingerprint) ||
    beforeImage.metadata !== null && !isRecord(beforeImage.metadata) ||
    !Object.hasOwn(beforeImage, "embedding") ||
    typeof beforeImage.embedding !== "string"
  ) {
    throw new Error("rollback image is missing original content, embedding, or fingerprint");
  }
  return {
    id: explicitId,
    expectedUpdatedAt,
    updates: {
      content: beforeImage.content,
      embedding: beforeImage.embedding,
      content_fingerprint: beforeImage.content_fingerprint,
      metadata: beforeImage.metadata ?? null,
    },
  };
}
