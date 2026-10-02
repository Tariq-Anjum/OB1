-- Run against an isolated PostgreSQL database after the revision-trigger
-- migration. The fixture and trigger are session-local; no public rows change.
DO $phase2_revision_test$
DECLARE
  v0 timestamptz;
  v1 timestamptz;
  v2 timestamptz;
  v3 timestamptz;
  v4 timestamptz;
  v5 timestamptz;
  v_offset_text text;
  v_offset_token timestamptz;
  changed_rows bigint;
  final_content text;
BEGIN
  PERFORM set_config('search_path', 'pg_temp, public', true);
  CREATE TEMP TABLE phase2_updated_at_probe (
    id integer PRIMARY KEY,
    content text NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT phase2_updated_at_finite_check
      CHECK (updated_at IS NOT NULL AND isfinite(updated_at))
  );
  EXECUTE 'CREATE TRIGGER phase2_updated_at_probe_trigger '
       || 'BEFORE UPDATE ON pg_temp.phase2_updated_at_probe '
       || 'FOR EACH ROW EXECUTE FUNCTION update_updated_at()';

  -- Neither infinity sentinel may enter the finite revision domain.
  BEGIN
    INSERT INTO pg_temp.phase2_updated_at_probe(id, content, updated_at)
    VALUES (90, 'positive infinity', 'infinity');
    RAISE EXCEPTION 'positive infinity unexpectedly passed finite revision check';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO pg_temp.phase2_updated_at_probe(id, content, updated_at)
    VALUES (91, 'negative infinity', '-infinity');
    RAISE EXCEPTION 'negative infinity unexpectedly passed finite revision check';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  INSERT INTO pg_temp.phase2_updated_at_probe(id, content, updated_at)
  VALUES (1, 'same content', '2026-10-01T14:32:35.856751+00:00');
  SELECT updated_at INTO v0 FROM pg_temp.phase2_updated_at_probe WHERE id = 1;

  -- The BEFORE trigger must override an attempted non-finite revision with a
  -- finite, strictly newer value; the row cannot enter an infinite state.
  UPDATE pg_temp.phase2_updated_at_probe
     SET updated_at = 'infinity'
   WHERE id = 1
   RETURNING updated_at INTO v5;
  IF NOT isfinite(v5) OR NOT (v5 > v0) THEN
    RAISE EXCEPTION 'attempted infinity update did not produce a finite newer revision: v0=%, v5=%', v0, v5;
  END IF;
  v0 := v5;

  -- Identical content still creates a new revision.
  UPDATE pg_temp.phase2_updated_at_probe
     SET content = content
   WHERE id = 1
   RETURNING updated_at INTO v1;
  IF NOT (v1 > v0) THEN
    RAISE EXCEPTION 'first identical UPDATE did not advance updated_at: v0=%, v1=%', v0, v1;
  END IF;
  UPDATE pg_temp.phase2_updated_at_probe
     SET content = 'stale v0 must not match'
   WHERE id = 1 AND updated_at = v0;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 0 THEN
    RAISE EXCEPTION 'CAS token v0 updated % rows after v1 was created', changed_rows;
  END IF;

  -- Equivalent timestamp text with a different offset must match the exact
  -- PostgreSQL timestamptz value.
  v_offset_text := to_char(v1 AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '+05:30';
  v_offset_token := v_offset_text::timestamptz;
  IF v_offset_token <> v1 THEN
    RAISE EXCEPTION 'offset-equivalent token did not parse to v1: v1=%, token=%', v1, v_offset_token;
  END IF;

  -- This is a second UPDATE on the same row in the same transaction and is
  -- intentionally content-identical. It must invalidate v1.
  UPDATE pg_temp.phase2_updated_at_probe
     SET content = content
   WHERE id = 1 AND updated_at = v_offset_token
   RETURNING updated_at INTO v2;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact-current offset-equivalent CAS unexpectedly failed';
  END IF;
  IF NOT (v2 > v1) THEN
    RAISE EXCEPTION 'second identical UPDATE did not advance updated_at: v1=%, v2=%', v1, v2;
  END IF;
  UPDATE pg_temp.phase2_updated_at_probe
     SET content = 'stale v1 must not match'
   WHERE id = 1 AND updated_at = v1;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 0 THEN
    RAISE EXCEPTION 'CAS token v1 updated % rows after v2 was created', changed_rows;
  END IF;

  UPDATE pg_temp.phase2_updated_at_probe
     SET content = 'concurrent writer'
   WHERE id = 1 AND updated_at = v2
   RETURNING updated_at INTO v3;
  IF NOT FOUND OR NOT (v3 > v2) THEN
    RAISE EXCEPTION 'exact-current CAS did not succeed with a newer revision';
  END IF;
  UPDATE pg_temp.phase2_updated_at_probe
     SET content = 'stale v2 must not match'
   WHERE id = 1 AND updated_at = v2;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 0 THEN
    RAISE EXCEPTION 'CAS token v2 updated % rows after v3 was created', changed_rows;
  END IF;

  -- A stale request formed before the concurrent writer must affect zero rows.
  UPDATE pg_temp.phase2_updated_at_probe
     SET content = 'stale writer'
   WHERE id = 1 AND updated_at = v2;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 0 THEN
    RAISE EXCEPTION 'stale CAS updated % rows after the concurrent writer', changed_rows;
  END IF;
  SELECT content INTO final_content FROM pg_temp.phase2_updated_at_probe WHERE id = 1;
  IF final_content <> 'concurrent writer' THEN
    RAISE EXCEPTION 'stale CAS replaced the current content: %', final_content;
  END IF;

  UPDATE pg_temp.phase2_updated_at_probe
     SET content = 'exact-current writer'
   WHERE id = 1 AND updated_at = v3
   RETURNING updated_at INTO v4;
  IF NOT FOUND OR NOT (v4 > v3) THEN
    RAISE EXCEPTION 'exact-current revision did not permit a newer update';
  END IF;
  UPDATE pg_temp.phase2_updated_at_probe
     SET content = 'stale v3 must not match'
   WHERE id = 1 AND updated_at = v3;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 0 THEN
    RAISE EXCEPTION 'CAS token v3 updated % rows after v4 was created', changed_rows;
  END IF;

  -- Every prior CAS token is now stale.
  FOREACH v_offset_token IN ARRAY ARRAY[v0, v1, v2, v3] LOOP
    UPDATE pg_temp.phase2_updated_at_probe
       SET content = 'stale token must not match'
     WHERE id = 1 AND updated_at = v_offset_token;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 0 THEN
      RAISE EXCEPTION 'stale CAS token % updated % rows', v_offset_token, changed_rows;
    END IF;
  END LOOP;

  DROP TABLE pg_temp.phase2_updated_at_probe;
END;
$phase2_revision_test$;
