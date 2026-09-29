exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE diagnostic_answer_submissions ADD COLUMN idempotency_key text;
    UPDATE diagnostic_answer_submissions SET idempotency_key = id::text WHERE idempotency_key IS NULL;
    ALTER TABLE diagnostic_answer_submissions ALTER COLUMN idempotency_key SET NOT NULL;
    ALTER TABLE diagnostic_answer_submissions
      ADD CONSTRAINT diagnostic_answer_session_idempotency_key UNIQUE(session_id, idempotency_key);

    CREATE TABLE learning_routes (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      diagnostic_result_id uuid NOT NULL REFERENCES diagnostic_results(id) ON DELETE RESTRICT,
      goal_id uuid REFERENCES goals(id) ON DELETE RESTRICT,
      version integer NOT NULL CHECK (version > 0),
      status text NOT NULL CHECK (status IN ('CANDIDATE','ACTIVE','SUPERSEDED')),
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
      published_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(user_id, version)
    );
    CREATE UNIQUE INDEX learning_routes_one_active_user
      ON learning_routes(user_id) WHERE status='ACTIVE';

    CREATE TABLE learning_positions (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      route_id uuid NOT NULL REFERENCES learning_routes(id) ON DELETE RESTRICT,
      step_id text,
      position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
      revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE attempts (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      route_id uuid REFERENCES learning_routes(id) ON DELETE RESTRICT,
      task_version_id text NOT NULL,
      rubric_version text NOT NULL,
      assistance_level text NOT NULL CHECK (assistance_level IN ('NONE','HINT','SOLUTION')),
      independent_pass_eligible boolean NOT NULL,
      answer_payload jsonb NOT NULL CHECK (jsonb_typeof(answer_payload)='object'),
      idempotency_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(user_id,idempotency_key)
    );
    CREATE TABLE review_versions (
      id uuid PRIMARY KEY,
      attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE RESTRICT,
      version integer NOT NULL CHECK (version > 0),
      rubric_version text NOT NULL,
      status text NOT NULL CHECK (status IN ('PENDING','READY')),
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(attempt_id,version)
    );
    CREATE TABLE disputes (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
      reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE notification_preferences (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled boolean NOT NULL DEFAULT true,
      quiet_hours jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quiet_hours)='object'),
      revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS notification_preferences, disputes, review_versions, attempts,
      learning_positions, learning_routes CASCADE;
    ALTER TABLE diagnostic_answer_submissions
      DROP CONSTRAINT IF EXISTS diagnostic_answer_session_idempotency_key;
    ALTER TABLE diagnostic_answer_submissions DROP COLUMN IF EXISTS idempotency_key;
  `);
};
