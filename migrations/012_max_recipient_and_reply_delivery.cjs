exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE max_webhook_events ADD COLUMN encrypted_recipient text;

    ALTER TABLE bot_reply_outbox
      DROP CONSTRAINT bot_reply_outbox_status_check,
      ADD CONSTRAINT bot_reply_outbox_status_check CHECK (status IN ('PENDING', 'SENDING', 'DELIVERED')),
      ADD COLUMN delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
      ADD COLUMN claimed_at timestamptz,
      ADD COLUMN last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 100);
    CREATE INDEX bot_reply_outbox_recovery_idx ON bot_reply_outbox(status, claimed_at, created_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS bot_reply_outbox_recovery_idx;
    ALTER TABLE bot_reply_outbox
      DROP CONSTRAINT bot_reply_outbox_status_check,
      ADD CONSTRAINT bot_reply_outbox_status_check CHECK (status IN ('PENDING', 'DELIVERED')),
      DROP COLUMN IF EXISTS last_error_code,
      DROP COLUMN IF EXISTS claimed_at,
      DROP COLUMN IF EXISTS delivery_attempts;
    ALTER TABLE max_webhook_events DROP COLUMN IF EXISTS encrypted_recipient;
  `);
};
