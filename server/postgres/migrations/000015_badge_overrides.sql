-- Manual badge overrides by DID.
-- is_granted = true means badge is forced on.
-- is_granted = false means badge is forcibly removed and cannot be re-added automatically.
CREATE TABLE IF NOT EXISTS badge_overrides (
  did TEXT NOT NULL,
  badge TEXT NOT NULL,
  is_granted BOOLEAN NOT NULL,
  created BIGINT DEFAULT now_as_millis(),
  PRIMARY KEY (did, badge)
);
