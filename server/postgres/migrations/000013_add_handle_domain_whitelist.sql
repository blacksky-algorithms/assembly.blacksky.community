-- Add handle domain pattern for gating conversations by atproto handle domain
-- Example values: '%.blacksky.team', '%.bsky.social'
-- When set, only participants with handles matching the pattern can participate
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS auth_handle_domain_pattern TEXT;
