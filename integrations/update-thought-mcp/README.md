# Update Thought MCP

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@txcfi-scott](https://github.com/txcfi-scott)**

> Standalone MCP Edge Function that adds an `update_thought` tool with optional `if_unchanged_since` optimistic concurrency for multi-writer setups.

## What It Does

The core Open Brain MCP server captures, searches, lists, and summarises thoughts but does not expose an update path. This integration adds `update_thought` plus narrowly scoped source-aware operations for canonical my-ai-brain mirrors. Deploy it as a separate Supabase Edge Function and register it as its own custom connector alongside your main Open Brain connector.

The tool supports three arguments:

- `content` — when provided, overwrites the thought's text and regenerates its embedding via OpenRouter.
- `metadata_patch` — shallow-merged into the existing `metadata` JSONB. Keys not present in the patch are left alone.
- `if_unchanged_since` — optional ISO 8601 timestamp. When supplied, the update is rejected with `STALE_READ` if the stored `updated_at` has advanced past that reference. Omit for last-write-wins behaviour (backward compatible).

Why it matters: once more than one agent writes to the same Open Brain (Claude Desktop, Codex, a background worker, etc.), last-write-wins silently drops concurrent edits. Optimistic concurrency is the cheapest fix — pass the `updated_at` you read, and the server rejects the write if something changed in between.

### Canonical my-ai-brain mirror operations

The integration also exposes three operations for the canonical Markdown
memory mirror:

- `inspect_mirror_thought(id)` reads one row and its current `updated_at` token.
- `inspect_mirror_thought(id, include_rollback_image=true)` returns the full row preimage, including its embedding, for a one-time adoption rollback file.
- `sync_mirror_thought(canonical_source_path, content, expected_legacy_content)` updates the one row whose leading marker and JSONB metadata agree, or inserts a new row with both identities in the same insert. It never adopts an unmarked legacy row automatically.
- `adopt_legacy_mirror_thought(...)` is an explicit same-UUID update for a source-less row after checking the requested path, content/fingerprint evidence, unique canonical owner, matching canonical/legacy render evidence, and current timestamp. It never creates or deletes a thought.
- `restore_legacy_mirror_adoption(...)` restores a saved complete before-image to the same UUID only while the adopted mapping is still uniquely active and the supplied `updated_at` token is current.

Active my-ai-brain rows carry both
`[my-ai-brain:<canonical-relative-path>]` at the start of `content` and
`metadata.source = "my-ai-brain"`,
`metadata.canonical_source_path = "<canonical-relative-path>"`, and
`metadata.mirror_status = "active"`. Marker and metadata must agree. Ambiguity
fails closed.

The partial unique index in
[`supabase/migrations/20261002000000_thoughts_canonical_source_path_unique.sql`](../../supabase/migrations/20261002000000_thoughts_canonical_source_path_unique.sql)
enforces one non-null canonical path per row set. Before applying it, check
that there are no duplicate non-null paths:

```sql
SELECT metadata->>'canonical_source_path' AS source_path, count(*)
FROM public.thoughts
WHERE metadata->>'canonical_source_path' IS NOT NULL
GROUP BY 1
HAVING count(*) > 1;
```

Rollback for that index is:

```sql
DROP INDEX IF EXISTS public.thoughts_canonical_source_path_uidx;
```

Adoption is a privileged controller operation. Use the governed canonical
my-ai-brain helper, which derives the source content and singleton owner set
from the complete canonical entry inventory. The Edge Function independently
checks that the new marked content and legacy evidence agree on category and
body, that the exact target still matches the legacy fingerprint, and that
both the source path and target revision remain unused/current. Do not use
adoption as a general-purpose source reassignment action. A legacy adoption
must also match a server-side approval pinned to the target UUID, source path,
canonical commit, content hashes, and complete inventory digest. This
installation includes one such approval for the reviewed ZHOOR reviewer-auth
row. Any other legacy adoption requires a separately reviewed Edge Function
candidate; caller-supplied owner paths alone never authorize adoption.

The regression suite is `node --test integrations/update-thought-mcp/mirror_identity.test.mjs`.

Before an adoption, call `inspect_mirror_thought` with
`include_rollback_image=true` and save its complete response privately. The
reviewed `ob1-mirror adopt` helper does this before mutation under
`$XDG_STATE_HOME/my-ai-brain/ob1-adoption-rollback/` (defaulting to
`~/.local/state/...`, directory mode `0700`, file mode `0600`). If adoption
verification fails, use the helper's explicit `restore --id ... --path ...`
action. It fetches a fresh current revision and asks
`restore_legacy_mirror_adoption` to restore the original content, embedding,
fingerprint, and metadata with a compare-and-swap update. Keep the before-image
until the adopted row has passed readback verification.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- Supabase CLI installed (`npm i -g supabase` or your preferred method)
- [Deno](https://deno.land/) runtime available locally for type-checking (optional but recommended)
- OpenRouter API key (only required when your callers pass `content` — needed for re-embedding)

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
UPDATE THOUGHT MCP -- CREDENTIAL TRACKER
--------------------------------------

FROM YOUR OPEN BRAIN SETUP
  Project URL:              ____________
  Service role key:         ____________
  OpenRouter API key:       ____________
  MCP access key:           ____________

GENERATED DURING SETUP
  Update Thought URL:       https://<project>.supabase.co/functions/v1/update-thought-mcp
  Custom connector name:    Open Brain — Update

--------------------------------------
```

## Steps

### 1. Create the Edge Function in your project

From the root of your local Open Brain repo (the one you set up during getting-started):

**1. Create the function folder:**

```bash
supabase functions new update-thought-mcp
```

**2. Copy the integration code:**

```bash
curl -o supabase/functions/update-thought-mcp/index.ts \
  https://raw.githubusercontent.com/NateBJones-Projects/OB1/main/integrations/update-thought-mcp/index.ts
curl -o supabase/functions/update-thought-mcp/mirror_identity.mjs \
  https://raw.githubusercontent.com/NateBJones-Projects/OB1/main/integrations/update-thought-mcp/mirror_identity.mjs
curl -o supabase/functions/update-thought-mcp/deno.json \
  https://raw.githubusercontent.com/NateBJones-Projects/OB1/main/integrations/update-thought-mcp/deno.json
```

### 2. Set environment variables

Reuse the same secrets as the core Open Brain server:

```bash
supabase secrets set \
  OPENROUTER_API_KEY="your-openrouter-key" \
  MCP_ACCESS_KEY="your-mcp-access-key"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by the platform.

### 3. Deploy

```bash
supabase functions deploy update-thought-mcp --no-verify-jwt
```

### 4. Register the connector in Claude Desktop

Open **Settings → Connectors → Add custom connector** and paste:

```
https://<project>.supabase.co/functions/v1/update-thought-mcp?key=<MCP_ACCESS_KEY>
```

Name it something distinct from your main Open Brain connector (e.g. `Open Brain — Update`) so the tool shows up clearly in your tool list.

### 5. Verify

Ask Claude: `Call the update_thought tool with id = "<uuid-from-your-db>" and metadata_patch = {"reviewed": true}.` You should see a success message and the thought's `updated_at` timestamp advance.

To verify optimistic concurrency:

1. Read a thought and note its `updated_at` (call it T0).
2. Call `update_thought` with `if_unchanged_since = T0` — it succeeds. `updated_at` is now T1.
3. Call `update_thought` again with `if_unchanged_since = T0` — it is rejected with `STALE_READ`.

## Expected Outcome

- A new Edge Function at `https://<project>.supabase.co/functions/v1/update-thought-mcp`.
- A custom connector registered in your AI client that exposes `update_thought`, `inspect_mirror_thought`, `sync_mirror_thought`, `adopt_legacy_mirror_thought`, and `restore_legacy_mirror_adoption`.
- Updating an existing thought replaces its content, re-embeds it, or merges a metadata patch.
- When `if_unchanged_since` is passed, the server rejects writes that would overwrite a concurrent change with a `STALE_READ` error, giving the caller a clear signal to re-fetch and retry.

The [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) covers how to manage your tool surface area once you add this (and any other) custom connector.

## Troubleshooting

**Issue: Tool call returns `401 Invalid or missing access key`**
Solution: Make sure the `?key=` parameter in your connector URL matches the `MCP_ACCESS_KEY` secret you set with `supabase secrets set`. If you rotate the key, re-deploy the function and update the connector URL.

**Issue: `OPENROUTER_API_KEY is not set on this Edge Function; content updates cannot re-embed.`**
Solution: This appears only when a caller passes `content`. Set the secret (`supabase secrets set OPENROUTER_API_KEY=...`) and re-deploy. Updates that only pass `metadata_patch` work without an embedding provider.

**Issue: Updates always succeed even though I expected `STALE_READ`**
Solution: `if_unchanged_since` is optional. Confirm you are actually passing it, and that the timestamp you read was the thought's `updated_at` (not `created_at`). The default `update_updated_at` trigger from the getting-started guide keeps `updated_at` current on every write.

## Attribution

Adapted from a multi-participant capture design used across live Claude / ChatGPT / Codex sessions. Released here as a standalone integration so any Open Brain user can opt in without touching the core server.
