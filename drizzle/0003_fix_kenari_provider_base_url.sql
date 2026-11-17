-- The seeded Kenari AI row pointed at a host that does not exist (api.kenariai.com, NXDOMAIN), so
-- every catalog test/sync failed with "fetch failed". kenari.id/v1 is the documented gateway base
-- URL; only the exact placeholder is rewritten so an operator's own URL is left alone.
UPDATE "ai_providers"
SET "base_url" = 'https://kenari.id/v1', "updated_at" = now()
WHERE "code" = 'KENARI_AI' AND "base_url" = 'https://api.kenariai.com/v1';
