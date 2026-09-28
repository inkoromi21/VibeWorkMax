exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE bot_reply_outbox (
      id uuid PRIMARY KEY,
      event_id text NOT NULL REFERENCES max_webhook_events(event_id) ON DELETE CASCADE,
      ordinal integer NOT NULL CHECK (ordinal >= 0),
      actor_id_hash char(64) NOT NULL,
      message jsonb NOT NULL CHECK (jsonb_typeof(message) = 'object'),
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED')),
      delivered_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(event_id, ordinal)
    );
    CREATE INDEX bot_reply_outbox_pending_idx ON bot_reply_outbox(status, created_at);
    CREATE TABLE bot_transition_job_outbox (
      event_id text NOT NULL REFERENCES max_webhook_events(event_id) ON DELETE CASCADE,
      job_type text NOT NULL CHECK (job_type IN ('course.build', 'attempt.grade')),
      job_key text NOT NULL CHECK (length(job_key) BETWEEN 1 AND 200),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(event_id, job_type, job_key)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS bot_transition_job_outbox, bot_reply_outbox CASCADE;');
};
