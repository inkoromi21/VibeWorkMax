exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE mini_app_export_requests
      ADD COLUMN payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload)='object'),
      ADD COLUMN ready_at timestamptz,
      ADD COLUMN expires_at timestamptz;
    ALTER TABLE mini_app_export_requests DROP CONSTRAINT IF EXISTS mini_app_export_requests_status_check;
    ALTER TABLE mini_app_export_requests ADD CONSTRAINT mini_app_export_requests_status_check
      CHECK (status IN ('QUEUED','READY','EXPIRED'));
    ALTER TABLE mini_app_export_requests ADD CONSTRAINT mini_app_export_ready_payload_check
      CHECK (status<>'READY' OR (payload IS NOT NULL AND ready_at IS NOT NULL AND expires_at IS NOT NULL));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE mini_app_export_requests DROP CONSTRAINT IF EXISTS mini_app_export_ready_payload_check;
    ALTER TABLE mini_app_export_requests DROP COLUMN IF EXISTS expires_at, DROP COLUMN IF EXISTS ready_at,
      DROP COLUMN IF EXISTS payload;
  `);
};
