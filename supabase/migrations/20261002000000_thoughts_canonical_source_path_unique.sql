CREATE UNIQUE INDEX thoughts_canonical_source_path_uidx
ON public.thoughts ((metadata->>'canonical_source_path'))
WHERE metadata->>'canonical_source_path' IS NOT NULL;
