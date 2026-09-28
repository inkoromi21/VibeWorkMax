exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE max_webhook_events (
      event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 200),
      actor_id_hash char(64) NOT NULL,
      event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'QUEUED', 'PROCESSED', 'FAILED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz
    );
    CREATE INDEX max_webhook_events_status_idx ON max_webhook_events(status, created_at);
    CREATE TABLE bot_conversations (
      id uuid PRIMARY KEY,
      actor_id_hash char(64) NOT NULL UNIQUE,
      state text NOT NULL CHECK (state IN ('ENTRY','AGE','CONSENT','PROBLEM','CLARIFY','CONFIRM_PROBLEM','DIAGNOSIS','RESULT','GOAL','LEARNING','ATTEMPT','PAUSED','CONTINUATION')),
      revision integer NOT NULL CHECK (revision >= 0),
      data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER bot_conversations_updated_at BEFORE UPDATE ON bot_conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TABLE bot_processed_events (
      event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 240),
      actor_id_hash char(64) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE bot_consents (
      id uuid PRIMARY KEY,
      actor_id_hash char(64) NOT NULL,
      document_version text NOT NULL CHECK (length(document_version) > 0),
      granted_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(actor_id_hash, document_version)
    );
    CREATE TABLE bot_problem_versions (
      id uuid PRIMARY KEY,
      actor_id_hash char(64) NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      raw_text text NOT NULL CHECK (length(raw_text) BETWEEN 1 AND 1000),
      interpretation jsonb NOT NULL CHECK (jsonb_typeof(interpretation) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(actor_id_hash, version)
    );
    CREATE TABLE bot_answer_submissions (
      id uuid PRIMARY KEY,
      actor_id_hash char(64) NOT NULL,
      question_id text NOT NULL,
      idempotency_key char(64) NOT NULL,
      answer_kind text NOT NULL CHECK (answer_kind IN ('CHOICE','TEXT','SKIP','DONT_KNOW')),
      answer_value jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(actor_id_hash, question_id, idempotency_key)
    );
    CREATE TABLE bot_attempts (
      id uuid PRIMARY KEY,
      actor_id_hash char(64) NOT NULL,
      idempotency_key char(64) NOT NULL,
      answer_text text NOT NULL CHECK (length(answer_text) <= 4000),
      rubric_version text NOT NULL DEFAULT 'demo-v1',
      independent_pass_eligible boolean NOT NULL,
      status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','GRADED','DISPUTED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(actor_id_hash, idempotency_key)
    );
    CREATE TABLE bot_goals (
      id uuid PRIMARY KEY,
      actor_id_hash char(64) NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      text text NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(actor_id_hash, version)
    );
    CREATE TABLE bot_notification_events (
      event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 200),
      actor_id_hash char(64) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE bot_learning_state (
      actor_id_hash char(64) PRIMARY KEY,
      current_step_id text NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      version integer NOT NULL CHECK (version > 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE bot_step_open_events (
      actor_id_hash char(64) NOT NULL,
      step_id text NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(actor_id_hash, step_id, position)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(
    `DROP TABLE IF EXISTS bot_step_open_events, bot_learning_state, bot_notification_events, bot_goals, bot_attempts, bot_answer_submissions, bot_problem_versions, bot_consents, bot_processed_events, bot_conversations, max_webhook_events CASCADE;`,
  );
};
