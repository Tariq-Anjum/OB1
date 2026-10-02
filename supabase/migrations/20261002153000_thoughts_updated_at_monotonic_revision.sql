-- Ensure every successful UPDATE produces a new exact CAS revision,
-- including repeated updates within one transaction and identical values.
-- Reject legacy values before tightening the revision domain. The constraint
-- below validates again while holding the table lock, closing the preflight
-- to-DDL race.
DO $finite_updated_at_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.thoughts
     WHERE updated_at IS NULL OR NOT isfinite(updated_at)
  ) THEN
    RAISE EXCEPTION 'thoughts.updated_at contains NULL or a non-finite revision';
  END IF;
END;
$finite_updated_at_preflight$;

ALTER TABLE public.thoughts
  ADD CONSTRAINT thoughts_updated_at_finite_check
  CHECK (updated_at IS NOT NULL AND isfinite(updated_at));

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := GREATEST(
    clock_timestamp(),
    OLD.updated_at + interval '1 microsecond'
  );
  RETURN NEW;
END;
$function$;
