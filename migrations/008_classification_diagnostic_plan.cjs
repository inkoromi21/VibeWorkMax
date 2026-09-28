exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE decision_events
      ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb
      CHECK (jsonb_typeof(metadata) = 'object');

    CREATE TABLE classification_decisions (
      id uuid PRIMARY KEY,
      event_id uuid NOT NULL UNIQUE REFERENCES decision_events(event_id) ON DELETE RESTRICT,
      problem_version_id uuid NOT NULL REFERENCES problem_versions(id) ON DELETE RESTRICT,
      type text CHECK (type IN ('DIRECTION','KNOWLEDGE_GAP','SKILL','PRACTICE_READINESS')),
      status text NOT NULL CHECK (status IN ('CLASSIFIED','AMBIGUOUS')),
      confidence numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 500),
      path text NOT NULL CHECK (path IN ('deterministic','ai','clarification')),
      rules_version text NOT NULL,
      prompt_version text,
      model_identifier text,
      clarification_needed boolean NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((status = 'AMBIGUOUS' AND type IS NULL AND clarification_needed) OR (status = 'CLASSIFIED' AND type IS NOT NULL AND NOT clarification_needed))
    );
    CREATE INDEX classification_decisions_problem_version_idx ON classification_decisions(problem_version_id, created_at);

    CREATE TABLE diagnostic_sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      problem_version_id uuid NOT NULL REFERENCES problem_versions(id) ON DELETE RESTRICT,
      classification_decision_id uuid NOT NULL REFERENCES classification_decisions(id) ON DELETE RESTRICT,
      snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
      plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
      catalog_version text NOT NULL,
      method_version text NOT NULL,
      template_version text NOT NULL,
      question_count integer NOT NULL DEFAULT 0 CHECK (question_count BETWEEN 0 AND 12),
      additional_consent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX diagnostic_sessions_user_idx ON diagnostic_sessions(user_id, created_at);

    CREATE TABLE diagnostic_question_instances (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES diagnostic_sessions(id) ON DELETE CASCADE,
      ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 11),
      template_version_id text NOT NULL,
      area text NOT NULL,
      reason text NOT NULL,
      evidence_role text NOT NULL,
      constraints jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(constraints) = 'array'),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(session_id, ordinal)
    );
    CREATE TABLE diagnostic_answer_submissions (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES diagnostic_sessions(id) ON DELETE CASCADE,
      question_instance_id uuid NOT NULL REFERENCES diagnostic_question_instances(id) ON DELETE RESTRICT,
      answer_kind text NOT NULL CHECK (answer_kind IN ('CHOICE','TEXT','SKIP','DONT_KNOW')),
      answer_value jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(session_id, question_instance_id)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS diagnostic_answer_submissions, diagnostic_question_instances, diagnostic_sessions, classification_decisions CASCADE;
    ALTER TABLE decision_events DROP COLUMN IF EXISTS metadata;
  `);
};
