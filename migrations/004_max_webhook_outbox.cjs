exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE max_webhook_job_outbox (
      event_id text PRIMARY KEY REFERENCES max_webhook_events(event_id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'QUEUED', 'PROCESSED', 'FAILED')),
      queued_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX max_webhook_job_outbox_ready_idx ON max_webhook_job_outbox(status, created_at);
    CREATE TRIGGER max_webhook_job_outbox_updated_at
      BEFORE UPDATE ON max_webhook_job_outbox FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS max_webhook_job_outbox CASCADE;');
};
