exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE attempt_grade_outbox (
      attempt_id uuid PRIMARY KEY REFERENCES attempts(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      enqueued_at timestamptz
    );
    CREATE INDEX attempt_grade_outbox_pending_idx
      ON attempt_grade_outbox(created_at) WHERE enqueued_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS attempt_grade_outbox;');
};
