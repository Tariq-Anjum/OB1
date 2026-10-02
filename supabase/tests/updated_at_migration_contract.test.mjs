import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../migrations/20261002153000_thoughts_updated_at_monotonic_revision.sql", import.meta.url), "utf8");

test("revision migration rejects legacy non-finite values before enforcing finite revisions", () => {
  const preflight = migration.match(/IF\s+EXISTS\s*\([\s\S]*?\)\s*THEN[\s\S]*?RAISE\s+EXCEPTION[\s\S]*?END\s+IF/iu);
  assert.ok(preflight, "migration needs a fail-closed preflight for existing revision values");
  assert.match(preflight[0], /NOT\s+isfinite\s*\(\s*updated_at\s*\)/iu);
  assert.match(preflight[0], /updated_at\s+IS\s+NULL/iu, "NULL is not a finite CAS revision");

  const constraint = migration.match(/ALTER\s+TABLE\s+public\.thoughts[\s\S]*?ADD\s+CONSTRAINT\s+thoughts_updated_at_finite_check[\s\S]*?;/iu);
  assert.ok(constraint, "migration must enforce the finite revision domain");
  assert.match(constraint[0], /updated_at\s+IS\s+NOT\s+NULL[\s\S]*?isfinite\s*\(\s*updated_at\s*\)/iu);
  assert.ok(
    migration.indexOf(preflight[0]) < migration.indexOf(constraint[0]),
    "legacy data preflight must precede constraint installation",
  );
});
