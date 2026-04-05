-- Store AT Protocol URIs and CIDs for strongRef backlinking
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS at_uri TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS at_cid TEXT;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS at_uri TEXT;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS at_cid TEXT;
