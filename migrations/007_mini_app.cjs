exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE mini_app_session_secrets (
      session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      csrf_hash char(64) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE mini_app_states (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE mini_app_problem_drafts (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      revision integer NOT NULL CHECK (revision >= 0),
      raw_text text NOT NULL CHECK (length(raw_text) <= 1000),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE mini_app_attachments (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('QUARANTINED','SCANNING','ACCEPTED','REJECTED')),
      object_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE mini_app_export_requests (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('QUEUED','READY','EXPIRED')), created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE mini_app_deletion_requests (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('PENDING_POLICY','CONFIRMED','COMPLETED')), confirmed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};
exports.down = (pgm) => {
  pgm.sql(
    'DROP TABLE IF EXISTS mini_app_deletion_requests, mini_app_export_requests, mini_app_attachments, mini_app_problem_drafts, mini_app_states, mini_app_session_secrets CASCADE;',
  );
};
