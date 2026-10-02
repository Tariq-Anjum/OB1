-- Ensure every successful UPDATE produces a new exact CAS revision,
-- including repeated updates within one transaction and identical values.
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
