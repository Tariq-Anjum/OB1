/**
 * update-thought-mcp — Standalone MCP Edge Function with generic thought
 * updates and source-aware my-ai-brain mirror operations.
 *
 * Why a separate Edge Function?
 *   The core `open-brain` MCP server (server/index.ts) is curated and does not
 *   expose an update path. This integration adds one without modifying the
 *   core server. Deploy it alongside your main MCP connector and register it
 *   as a separate custom connector in Claude Desktop (or your client of
 *   choice).
 *
 * Behavior:
 *   - `content` — when provided, overwrites the thought text and regenerates
 *     the embedding. Omit to leave content unchanged.
 *   - `metadata_patch` — shallow-merged into the existing metadata JSONB.
 *     Keys not present in the patch are left alone.
 *   - `if_unchanged_since` — optional ISO 8601 timestamp (with offset). When
 *     provided, the update is rejected with a STALE_READ error if the stored
 *     `updated_at` has advanced past that reference. Every write also compares
 *     against the row revision captured by its initial read.
 *
 * Auth: x-brain-key header OR ?key=... URL query parameter (same pattern as
 * the core server — see server/index.ts).
 *
 * Env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   OPENROUTER_API_KEY        — used when content needs embedding
 *   MCP_ACCESS_KEY
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import {
  buildAdoptionUpdate,
  buildAdoptionRestoration,
  buildAtomicMirrorInsert,
  findApprovedLegacyAdoption,
  lookupMirrorSourceRows,
  planMirrorSync,
  sourceMarkerPath,
  validateCanonicalSourcePath,
  validateLegacyAdoption,
} from "./mirror_identity.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function contentFingerprint(text: string): Promise<string> {
  const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const MIRROR_ROW_FIELDS =
  "id, content, metadata, created_at, updated_at, content_fingerprint";
const MIRROR_ROLLBACK_FIELDS = `${MIRROR_ROW_FIELDS}, embedding`;
const MAX_LOOKUP_ROWS = 1000;

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function toolJson(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function lookupMirrorSource(sourcePath: string) {
  return lookupMirrorSourceRows(supabase, sourcePath, MAX_LOOKUP_ROWS);
}

async function lookupLegacyCandidates(expectedLegacyContent: string) {
  const fingerprint = await contentFingerprint(expectedLegacyContent);
  const [fingerprintResult, contentResult] = await Promise.all([
    supabase.from("thoughts").select(MIRROR_ROW_FIELDS)
      .eq("content_fingerprint", fingerprint).limit(MAX_LOOKUP_ROWS),
    supabase.from("thoughts").select(MIRROR_ROW_FIELDS)
      .eq("content", expectedLegacyContent).limit(MAX_LOOKUP_ROWS),
  ]);
  if (fingerprintResult.error) {
    throw new Error(`legacy fingerprint lookup failed: ${fingerprintResult.error.message}`);
  }
  if (contentResult.error) {
    throw new Error(`legacy content lookup failed: ${contentResult.error.message}`);
  }
  const fingerprintRows = fingerprintResult.data ?? [];
  const contentRows = contentResult.data ?? [];
  if (fingerprintRows.length >= MAX_LOOKUP_ROWS || contentRows.length >= MAX_LOOKUP_ROWS) {
    throw new Error("legacy candidate lookup exceeded its bound; refusing to create or adopt");
  }
  const rowsById = new Map<string, (typeof fingerprintRows)[number]>();
  for (const row of [...fingerprintRows, ...contentRows]) {
    const previous = rowsById.get(row.id);
    if (previous && (
      previous.content !== row.content ||
      previous.updated_at !== row.updated_at ||
      previous.content_fingerprint !== row.content_fingerprint ||
      JSON.stringify(previous.metadata ?? null) !== JSON.stringify(row.metadata ?? null)
    )) {
      throw new Error("legacy candidate changed during lookup; retry after a fresh read");
    }
    rowsById.set(row.id, row);
  }
  return { fingerprint, rows: [...rowsById.values()] };
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain-update-thought",
  version: "1.1.0",
});

server.registerTool(
  "update_thought",
  {
    title: "Update Thought",
    description:
      "Update an existing thought by ID. Provide `content` to overwrite the text and regenerate its embedding, `metadata_patch` to shallow-merge changes into the existing metadata, or both. Keys not mentioned in `metadata_patch` are left unchanged. Pass `if_unchanged_since` (ISO 8601 timestamp from your last read) for optimistic concurrency — the update is rejected with STALE_READ if another writer has touched the row since then.",
    inputSchema: {
      id: z.string().uuid().describe("UUID of the thought to update"),
      content: z
        .string()
        .min(1)
        .max(50_000)
        .optional()
        .describe("New text content — triggers re-embedding when provided"),
      metadata_patch: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Partial metadata to shallow-merge into the existing metadata JSONB. New keys are added; existing keys are overwritten; keys not mentioned are left alone.",
        ),
      if_unchanged_since: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe(
          "Optional ISO 8601 timestamp (with timezone). When provided, the update is rejected with STALE_READ if the stored updated_at has advanced past this reference. Every write also compares the revision fetched internally, so concurrent changes during this call are always rejected.",
        ),
    },
  },
  async ({ id, content, metadata_patch, if_unchanged_since }) => {
    try {
      // Fetch existing row. We need updated_at for the concurrency check and
      // metadata for the shallow-merge.
      const { data: existing, error: fetchError } = await supabase
        .from("thoughts")
        .select(MIRROR_ROW_FIELDS)
        .eq("id", id)
        .single();

      if (fetchError || !existing) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Thought not found: ${id}`,
            },
          ],
          isError: true,
        };
      }

      let sourcePath: string | null = null;
      if (content !== undefined) {
        try {
          sourcePath = sourceMarkerPath(content);
        } catch {
          throw new Error("Invalid my-ai-brain source identity in content");
        }
      }
      const existingMetadata =
        (existing.metadata as Record<string, unknown> | null) ?? {};
      let existingMarkerPath: string | null = null;
      try {
        existingMarkerPath = sourceMarkerPath(existing.content as string);
      } catch {
        throw new Error("Existing thought has an invalid source identity marker");
      }
      const existingMetadataPath = existingMetadata.canonical_source_path;
      const existingClaimsIdentity =
        existingMarkerPath !== null ||
        existingMetadataPath !== undefined && existingMetadataPath !== null ||
        existingMetadata.source === "my-ai-brain";

      if (existingClaimsIdentity) {
        if (
          typeof existingMetadataPath !== "string" ||
          existingMarkerPath !== existingMetadataPath ||
          existingMetadata.source !== "my-ai-brain"
        ) {
          throw new Error("Existing thought has conflicting my-ai-brain source identity");
        }
        const existingResolution = await lookupMirrorSource(existingMetadataPath);
        if (
          existingResolution.status !== "EXACT_ONE_VALID" ||
          existingResolution.row.id !== id
        ) {
          throw new Error(`Existing source mapping is ${existingResolution.status}; refusing generic update`);
        }
        if (content !== undefined && sourcePath !== existingMetadataPath) {
          throw new Error("Mapped my-ai-brain content must retain its canonical source marker");
        }
      } else if (sourcePath !== null) {
        const resolution = await lookupMirrorSource(sourcePath);
        if (resolution.status !== "EXACT_ONE_VALID" || resolution.row.id !== id) {
          throw new Error(`Source mapping is ${resolution.status} or points to another UUID; generic update refused`);
        }
      }

      const protectedIdentityKeys = ["canonical_source_path", "source", "mirror_status"];
      if (metadata_patch && protectedIdentityKeys.some((key) => key in metadata_patch)) {
        if (existingClaimsIdentity ||
          metadata_patch.source === "my-ai-brain" ||
          (metadata_patch.canonical_source_path !== undefined && metadata_patch.canonical_source_path !== null)) {
          throw new Error("my-ai-brain identity fields are managed by source-aware mirror operations");
        }
      }

      // Optimistic concurrency check. Reject if stored updated_at is strictly
      // newer than the caller's reference timestamp.
      if (if_unchanged_since) {
        const storedMs = new Date(
          (existing.updated_at as string) ?? (existing.created_at as string),
        ).getTime();
        const clientMs = new Date(if_unchanged_since).getTime();
        if (
          Number.isFinite(storedMs) &&
          Number.isFinite(clientMs) &&
          storedMs > clientMs
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `STALE_READ: thought has been modified since ${if_unchanged_since}. ` +
                  `Current updated_at: ${existing.updated_at}. Re-fetch and retry.`,
              },
            ],
            isError: true,
          };
        }
      }

      const updates: Record<string, unknown> = {};

      if (content !== undefined) {
        if (!OPENROUTER_API_KEY) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "OPENROUTER_API_KEY is not set on this Edge Function; content updates cannot re-embed.",
              },
            ],
            isError: true,
          };
        }
        const [embedding, fingerprint] = await Promise.all([
          getEmbedding(content),
          contentFingerprint(content),
        ]);
        updates.content = content;
        updates.embedding = `[${embedding.join(",")}]`;
        updates.content_fingerprint = fingerprint;
      }

      if (metadata_patch !== undefined || sourcePath !== null) {
        const merged = {
          ...existingMetadata,
          ...(metadata_patch ?? {}),
        };
        updates.metadata = merged;
      }

      if (Object.keys(updates).length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No changes supplied; thought ${id} unchanged.`,
            },
          ],
        };
      }

      if (typeof existing.updated_at !== "string" || !existing.updated_at) {
        throw new Error("Thought has no updated_at concurrency token");
      }
      const updateQuery = supabase
        .from("thoughts")
        .update(updates)
        .eq("id", id)
        .eq("updated_at", existing.updated_at);
      const { data, error } = await updateQuery
        .select("id, content, metadata, created_at, updated_at")
        .maybeSingle();

      if (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `update_thought error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
      if (!data) {
        return toolError("STALE_READ: thought changed during update; re-fetch and retry.");
      }

      const parts = [
        `Updated thought ${data.id}`,
        content !== undefined ? "  · content replaced and re-embedded" : null,
        metadata_patch !== undefined ? "  · metadata merged" : null,
        `  · updated_at: ${data.updated_at}`,
      ].filter(Boolean);

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "lookup_mirror_source",
  {
    title: "Look Up Canonical Mirror Source",
    description: "Read and classify marker and metadata claims for one canonical path without modifying any thought. Only EXACT_ONE_VALID identifies a unique active mapping.",
    inputSchema: { canonical_source_path: z.string().min(1).max(256) },
  },
  async ({ canonical_source_path }) => {
    try {
      return toolJson(await lookupMirrorSource(canonical_source_path));
    } catch (err: unknown) {
      return toolError(`lookup_mirror_source failed: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "inspect_mirror_thought",
  {
    title: "Inspect Mirror Thought",
    description: "Read one thought by UUID. Set include_rollback_image only before an explicit adoption to preserve the complete source-less row preimage, including its embedding.",
    inputSchema: {
      id: z.string().uuid().describe("UUID of the existing thought"),
      include_rollback_image: z.boolean().optional(),
    },
  },
  async ({ id, include_rollback_image }) => {
    try {
      const { data, error } = await supabase.from("thoughts")
        .select(include_rollback_image ? MIRROR_ROLLBACK_FIELDS : MIRROR_ROW_FIELDS)
        .eq("id", id).maybeSingle();
      if (error) return toolError(`inspect_mirror_thought failed: ${error.message}`);
      if (!data) return toolError(`Thought not found: ${id}`);
      return toolJson(data as Record<string, unknown>);
    } catch (err: unknown) {
      return toolError(`inspect_mirror_thought failed: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "restore_legacy_mirror_adoption",
  {
    title: "Restore Legacy Mirror Adoption",
    description: "Restore a same-UUID pre-adoption row image only when the current row still uniquely maps to the requested canonical path and its updated_at matches the fresh expected revision.",
    inputSchema: {
      id: z.string().uuid(),
      canonical_source_path: z.string().min(1).max(256),
      expected_updated_at: z.string().datetime({ offset: true }),
      before_image: z.record(z.string(), z.unknown()),
    },
  },
  async ({ id, canonical_source_path, expected_updated_at, before_image }) => {
    try {
      validateCanonicalSourcePath(canonical_source_path);
      const { data: current, error: currentError } = await supabase.from("thoughts")
        .select(MIRROR_ROLLBACK_FIELDS).eq("id", id).maybeSingle();
      if (currentError) throw new Error(`rollback target lookup failed: ${currentError.message}`);
      if (!current) throw new Error(`Thought not found: ${id}`);
      const sourceResolution = await lookupMirrorSource(canonical_source_path);
      const restoration = buildAdoptionRestoration({
        sourcePath: canonical_source_path,
        current,
        beforeImage: before_image,
        explicitId: id,
        expectedUpdatedAt: expected_updated_at,
        sourceResolution,
      });
      const { data, error } = await supabase.from("thoughts")
        .update(restoration.updates)
        .eq("id", id)
        .eq("updated_at", expected_updated_at)
        .eq("created_at", before_image.created_at as string)
        .select(MIRROR_ROW_FIELDS)
        .maybeSingle();
      if (error) throw new Error(`adoption rollback failed: ${error.message}`);
      if (!data) throw new Error("STALE_READ: adopted thought changed during rollback");
      return toolJson({ id: data.id, operation: "restored", canonical_source_path });
    } catch (err: unknown) {
      return toolError(`restore_legacy_mirror_adoption failed: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "sync_mirror_thought",
  {
    title: "Sync Canonical Mirror Thought",
    description: "Create or update one my-ai-brain mirror by canonical relative source path. Creates include marker and metadata identity in the initial row insert; ambiguous legacy matches fail closed.",
    inputSchema: {
      canonical_source_path: z.string().min(1).max(256),
      content: z.string().min(1).max(50_000),
      expected_legacy_content: z.string().min(1).max(50_000),
    },
  },
  async ({ canonical_source_path, content, expected_legacy_content }) => {
    try {
      validateCanonicalSourcePath(canonical_source_path);
      if (sourceMarkerPath(content) !== canonical_source_path) {
        throw new Error("content marker does not match canonical_source_path");
      }
      if (!OPENROUTER_API_KEY) {
        throw new Error("OPENROUTER_API_KEY is not set; source mirror writes require embeddings");
      }

      const [resolution, legacy] = await Promise.all([
        lookupMirrorSource(canonical_source_path),
        lookupLegacyCandidates(expected_legacy_content),
      ]);
      const plan = planMirrorSync({
        sourcePath: canonical_source_path,
        content,
        resolution,
        legacyCandidates: legacy.rows,
      });
      if (plan.kind === "blocked") {
        throw new Error(`${plan.reason}: no row was changed`);
      }

      const [embedding, fingerprint] = await Promise.all([
        getEmbedding(content),
        contentFingerprint(content),
      ]);
      const metadata = plan.kind === "update"
        ? plan.row.metadata
        : { type: "observation", topics: [], people: [], action_items: [] };
      const payload = buildAtomicMirrorInsert({
        sourcePath: canonical_source_path,
        content,
        embedding,
        fingerprint,
        metadata: (metadata as Record<string, unknown> | null) ?? {},
      });

      if (plan.kind === "update") {
        if (typeof plan.expectedUpdatedAt !== "string" || !plan.expectedUpdatedAt) {
          throw new Error("mapped row has no updated_at concurrency token");
        }
        const { data, error } = await supabase.from("thoughts")
          .update(payload)
          .eq("id", plan.id)
          .eq("updated_at", plan.expectedUpdatedAt)
          .select(MIRROR_ROW_FIELDS)
          .maybeSingle();
        if (error) throw new Error(`source-aware update failed: ${error.message}`);
        if (!data) throw new Error("STALE_READ: mapped mirror changed during update");
        return toolJson({ id: data.id, operation: "updated", canonical_source_path });
      }

      const { data, error } = await supabase.from("thoughts")
        .insert(payload)
        .select(MIRROR_ROW_FIELDS)
        .single();
      if (error) {
        if (error.code === "23505") {
          const current = await lookupMirrorSource(canonical_source_path);
          if (current.status === "EXACT_ONE_VALID") {
            throw new Error(`CONCURRENT_MAPPING: ${canonical_source_path} now maps to ${current.row.id}; no retry or update was attempted`);
          }
          throw new Error(`UNIQUE_INSERT_CONFLICT: ${canonical_source_path} lookup is ${current.status}; no retry or update was attempted`);
        }
        throw new Error(`source-aware insert failed: ${error.message}`);
      }
      return toolJson({ id: data.id, operation: "created", canonical_source_path });
    } catch (err: unknown) {
      return toolError(`sync_mirror_thought failed: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "adopt_legacy_mirror_thought",
  {
    title: "Adopt Proven Legacy Mirror Thought",
    description: "Adopt the one server-approved source-less legacy thought. Requires the exact canonical snapshot, owner inventory, content hashes, current source lookup, and updated_at evidence; never creates or deletes a row.",
    inputSchema: {
      id: z.string().uuid(),
      canonical_source_path: z.string().min(1).max(256),
      content: z.string().min(1).max(50_000),
      expected_updated_at: z.string().datetime({ offset: true }),
      expected_legacy_content: z.string().min(1).max(50_000),
      expected_legacy_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      canonical_owner_paths: z.array(z.string().max(256)).max(20),
      canonical_commit: z.string().regex(/^[a-f0-9]{40,64}$/),
      canonical_inventory_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    },
  },
  async ({
    id,
    canonical_source_path,
    content,
    expected_updated_at,
    expected_legacy_content,
    expected_legacy_fingerprint,
    canonical_owner_paths,
    canonical_commit,
    canonical_inventory_sha256,
  }) => {
    try {
      validateCanonicalSourcePath(canonical_source_path);
      if (sourceMarkerPath(content) !== canonical_source_path) {
        throw new Error("adoption content marker does not match canonical source path");
      }
      const approvedAdoption = findApprovedLegacyAdoption(id, canonical_source_path);
      if (!approvedAdoption) {
        throw new Error("no server-approved legacy adoption exists for this UUID and source path");
      }
      const [canonicalContentSha256, canonicalLegacySha256] = await Promise.all([
        sha256Hex(content),
        sha256Hex(expected_legacy_content),
      ]);
      if (canonical_commit !== approvedAdoption.canonicalCommit) {
        throw new Error("canonical source commit does not match the server-approved adoption");
      }
      if (canonical_inventory_sha256 !== approvedAdoption.canonicalInventorySha256) {
        throw new Error("canonical owner inventory does not match the server-approved adoption");
      }
      if (!OPENROUTER_API_KEY) {
        throw new Error("OPENROUTER_API_KEY is not set; adoption requires re-embedding");
      }
      const computedLegacyFingerprint = await contentFingerprint(expected_legacy_content);
      if (computedLegacyFingerprint !== expected_legacy_fingerprint) {
        throw new Error("expected legacy fingerprint does not match canonical evidence");
      }

      const { data: target, error: targetError } = await supabase.from("thoughts")
        .select(MIRROR_ROW_FIELDS).eq("id", id).maybeSingle();
      if (targetError) throw new Error(`target lookup failed: ${targetError.message}`);
      if (!target) throw new Error(`Thought not found: ${id}`);

      const [sourceResolution, legacy] = await Promise.all([
        lookupMirrorSource(canonical_source_path),
        lookupLegacyCandidates(expected_legacy_content),
      ]);
      validateLegacyAdoption({
        sourcePath: canonical_source_path,
        sourceResolution,
        target,
        explicitId: id,
        expectedUpdatedAt: expected_updated_at,
        expectedLegacyContent: expected_legacy_content,
        expectedLegacyFingerprint: legacy.fingerprint,
        legacyCandidateIds: legacy.rows.map((row) => row.id),
        canonicalOwnerPaths: canonical_owner_paths,
        canonicalCommit: canonical_commit,
        canonicalContentSha256,
        canonicalLegacySha256,
        canonicalInventorySha256: canonical_inventory_sha256,
        approvedAdoption,
        content,
      });
      if (legacy.fingerprint !== expected_legacy_fingerprint) {
        throw new Error("legacy fingerprint changed during adoption checks");
      }

      const [embedding, fingerprint] = await Promise.all([
        getEmbedding(content),
        contentFingerprint(content),
      ]);
      const adoption = buildAdoptionUpdate({
        sourcePath: canonical_source_path,
        target,
        expectedUpdatedAt: expected_updated_at,
        content,
        embedding,
        fingerprint,
      });
      const { data, error } = await supabase.from("thoughts")
        .update(adoption.updates)
        .eq("id", id)
        .eq("updated_at", expected_updated_at)
        .eq("content", expected_legacy_content)
        .eq("content_fingerprint", expected_legacy_fingerprint)
        .select(MIRROR_ROW_FIELDS)
        .maybeSingle();
      if (error) {
        if (error.code === "23505") {
          const current = await lookupMirrorSource(canonical_source_path);
          throw new Error(`CONCURRENT_MAPPING: adoption lost a uniqueness race; current lookup is ${current.status}`);
        }
        throw new Error(`legacy adoption update failed: ${error.message}`);
      }
      if (!data) throw new Error("STALE_READ: legacy thought changed during adoption");
      return toolJson({
        id: data.id,
        operation: "adopted",
        canonical_source_path,
        updated_at: data.updated_at,
      });
    } catch (err: unknown) {
      return toolError(`adopt_legacy_mirror_thought failed: ${(err as Error).message}`);
    }
  },
);

// --- Hono app with auth + CORS ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

const app = new Hono();

app.options("*", (c) => c.text("ok", 200, corsHeaders));

app.all("*", async (c) => {
  // Reject non-POST requests up front. This server is stateless over
  // streamable HTTP: there is no standalone SSE stream (GET) or session
  // termination (DELETE) to serve. Without this guard a GET falls through to
  // StreamableHTTPTransport.handleRequest, which parks it on an SSE stream
  // that never emits and never closes. mcp-remote always sends a GET probe
  // (OAuth discovery) before its initialize POST, so that probe hangs and
  // the MCP handshake times out at the client with no error server-side.
  if (c.req.method !== "POST") {
    return c.json({ error: "Method not allowed" }, 405, { ...corsHeaders, Allow: "POST, OPTIONS" });
  }

  const provided =
    c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401, corsHeaders);
  }

  // Same Accept-header workaround as the core server — Claude Desktop's custom
  // connectors do not send `text/event-stream` by default.
  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
