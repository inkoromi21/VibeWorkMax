exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE mini_app_attachments
      ADD COLUMN attempt_id uuid REFERENCES attempts(id) ON DELETE RESTRICT,
      ADD COLUMN byte_size integer CHECK (byte_size > 0 AND byte_size <= 5242880),
      ADD COLUMN sha256 char(64),
      ADD COLUMN mime_type text,
      ADD COLUMN idempotency_key text,
      ADD COLUMN scan_result text CHECK (scan_result IN ('CLEAN','INFECTED','UNAVAILABLE')),
      ADD COLUMN scanned_at timestamptz;
    CREATE UNIQUE INDEX mini_app_attachments_idempotency_idx
      ON mini_app_attachments(user_id,idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX mini_app_attachments_attempt_idx
      ON mini_app_attachments(attempt_id,created_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS mini_app_attachments_attempt_idx;
    DROP INDEX IF EXISTS mini_app_attachments_idempotency_idx;
    ALTER TABLE mini_app_attachments
      DROP COLUMN IF EXISTS scanned_at,
      DROP COLUMN IF EXISTS scan_result,
      DROP COLUMN IF EXISTS mime_type,
      DROP COLUMN IF EXISTS idempotency_key,
      DROP COLUMN IF EXISTS sha256,
      DROP COLUMN IF EXISTS byte_size,
      DROP COLUMN IF EXISTS attempt_id;
  `);
};
