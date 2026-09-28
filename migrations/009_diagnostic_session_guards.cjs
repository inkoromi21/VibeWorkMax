exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE diagnostic_sessions
      ADD COLUMN status text NOT NULL DEFAULT 'IN_PROGRESS'
        CHECK (status IN ('IN_PROGRESS','PAUSED','COMPLETED','COMPLETED_PARTIAL','SUPERSEDED')),
      ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      ADD COLUMN finished_at timestamptz;

    ALTER TABLE bot_conversations DROP CONSTRAINT IF EXISTS bot_conversations_state_check;
    ALTER TABLE bot_conversations ADD CONSTRAINT bot_conversations_state_check
      CHECK (state IN ('ENTRY','AGE','CONSENT','PROBLEM','CLARIFY','CONFIRM_PROBLEM','PROFILE','DIAGNOSIS','RESULT','GOAL','LEARNING','ATTEMPT','PAUSED','CONTINUATION'));

    ALTER TABLE diagnostic_question_instances
      ADD CONSTRAINT diagnostic_question_instances_session_id_id_key UNIQUE(session_id, id);
    ALTER TABLE diagnostic_answer_submissions
      ADD CONSTRAINT diagnostic_answer_submissions_session_question_fk
        FOREIGN KEY (session_id, question_instance_id)
        REFERENCES diagnostic_question_instances(session_id, id)
        ON DELETE RESTRICT;

    CREATE INDEX diagnostic_sessions_active_user_idx
      ON diagnostic_sessions(user_id, created_at DESC)
      WHERE status IN ('IN_PROGRESS','PAUSED');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS diagnostic_sessions_active_user_idx;
    ALTER TABLE diagnostic_answer_submissions
      DROP CONSTRAINT IF EXISTS diagnostic_answer_submissions_session_question_fk;
    ALTER TABLE diagnostic_question_instances
      DROP CONSTRAINT IF EXISTS diagnostic_question_instances_session_id_id_key;
    ALTER TABLE diagnostic_sessions
      DROP COLUMN IF EXISTS finished_at,
      DROP COLUMN IF EXISTS revision,
      DROP COLUMN IF EXISTS status;
    ALTER TABLE bot_conversations DROP CONSTRAINT IF EXISTS bot_conversations_state_check;
    ALTER TABLE bot_conversations ADD CONSTRAINT bot_conversations_state_check
      CHECK (state IN ('ENTRY','AGE','CONSENT','PROBLEM','CLARIFY','CONFIRM_PROBLEM','DIAGNOSIS','RESULT','GOAL','LEARNING','ATTEMPT','PAUSED','CONTINUATION'));
  `);
};
