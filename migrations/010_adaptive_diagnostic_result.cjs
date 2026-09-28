exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE diagnostic_sessions
      ADD COLUMN parent_session_id uuid REFERENCES diagnostic_sessions(id) ON DELETE RESTRICT;

    ALTER TABLE diagnostic_question_instances
      ADD COLUMN instance_key text,
      ADD COLUMN public_payload jsonb CHECK (public_payload IS NULL OR jsonb_typeof(public_payload) = 'object'),
      ADD COLUMN issued_at timestamptz;
    UPDATE diagnostic_question_instances
      SET instance_key = template_version_id || ':legacy:' || ordinal::text,
          issued_at = created_at
      WHERE instance_key IS NULL;
    ALTER TABLE diagnostic_question_instances
      ALTER COLUMN instance_key SET NOT NULL;
    ALTER TABLE diagnostic_question_instances
      ADD CONSTRAINT diagnostic_question_instances_session_instance_key_key UNIQUE(session_id, instance_key);

    ALTER TABLE diagnostic_answer_submissions
      ADD COLUMN assistance_reported text NOT NULL DEFAULT 'NONE'
        CHECK (assistance_reported IN ('NONE','HINT','SOLUTION'));

    CREATE TABLE diagnostic_evidence_records (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES diagnostic_sessions(id) ON DELETE CASCADE,
      question_instance_id uuid REFERENCES diagnostic_question_instances(id) ON DELETE RESTRICT,
      answer_submission_id uuid REFERENCES diagnostic_answer_submissions(id) ON DELETE RESTRICT,
      evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
      role text NOT NULL CHECK (role IN ('ASSESSMENT','PREFERENCE','UNKNOWN')),
      disclosed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((role = 'ASSESSMENT' AND answer_submission_id IS NOT NULL) OR role <> 'ASSESSMENT'),
      UNIQUE(answer_submission_id, role)
    );
    CREATE INDEX diagnostic_evidence_records_session_idx
      ON diagnostic_evidence_records(session_id, created_at);

    CREATE TABLE diagnostic_results (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES diagnostic_sessions(id) ON DELETE RESTRICT,
      previous_result_id uuid REFERENCES diagnostic_results(id) ON DELETE RESTRICT,
      status text NOT NULL CHECK (status IN ('COMPLETED','COMPLETED_PARTIAL','PAUSED')),
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX diagnostic_results_session_idx ON diagnostic_results(session_id, created_at DESC);
    ALTER TABLE diagnostic_sessions
      ADD COLUMN parent_result_id uuid REFERENCES diagnostic_results(id) ON DELETE RESTRICT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE diagnostic_sessions DROP COLUMN IF EXISTS parent_result_id;
    DROP TABLE IF EXISTS diagnostic_results;
    DROP TABLE IF EXISTS diagnostic_evidence_records;
    ALTER TABLE diagnostic_question_instances
      DROP CONSTRAINT IF EXISTS diagnostic_question_instances_session_instance_key_key;
    ALTER TABLE diagnostic_question_instances
      DROP COLUMN IF EXISTS issued_at,
      DROP COLUMN IF EXISTS public_payload,
      DROP COLUMN IF EXISTS instance_key;
    ALTER TABLE diagnostic_answer_submissions DROP COLUMN IF EXISTS assistance_reported;
    ALTER TABLE diagnostic_sessions DROP COLUMN IF EXISTS parent_session_id;
  `);
};
