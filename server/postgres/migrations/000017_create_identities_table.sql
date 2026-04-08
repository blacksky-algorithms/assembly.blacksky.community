-- Global identity directory: one row per person, indexed by DID.
-- DID is nullable for email-only records that haven't been linked yet.

CREATE TABLE IF NOT EXISTS identities (
    id SERIAL PRIMARY KEY,
    did TEXT UNIQUE,
    email TEXT,
    alt_email_1 TEXT,
    alt_email_2 TEXT,
    handle TEXT,
    display_name TEXT,
    avatar_url TEXT,
    is_member BOOLEAN DEFAULT FALSE,
    is_funder BOOLEAN DEFAULT FALSE,
    is_team BOOLEAN DEFAULT FALSE,
    is_oss_supporter BOOLEAN DEFAULT FALSE,
    source TEXT,
    member_updated_at BIGINT,
    funder_updated_at BIGINT,
    team_updated_at BIGINT,
    oss_updated_at BIGINT,
    created BIGINT DEFAULT now_as_millis(),
    modified BIGINT DEFAULT now_as_millis()
);

CREATE INDEX IF NOT EXISTS identities_email_idx ON identities (LOWER(email));
CREATE INDEX IF NOT EXISTS identities_alt_email_1_idx ON identities (LOWER(alt_email_1));
CREATE INDEX IF NOT EXISTS identities_alt_email_2_idx ON identities (LOWER(alt_email_2));
CREATE INDEX IF NOT EXISTS identities_handle_idx ON identities (LOWER(handle));
