exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE bot_transition_job_outbox ADD COLUMN enqueued_at timestamptz;
    CREATE INDEX bot_transition_job_outbox_pending_idx
      ON bot_transition_job_outbox(created_at) WHERE enqueued_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS bot_transition_job_outbox_pending_idx;
    ALTER TABLE bot_transition_job_outbox DROP COLUMN IF EXISTS enqueued_at;
  `);
};
