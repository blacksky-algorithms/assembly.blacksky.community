-- Track Open Collective funder status on xid records
ALTER TABLE xids ADD COLUMN IF NOT EXISTS is_funder BOOLEAN DEFAULT FALSE;
