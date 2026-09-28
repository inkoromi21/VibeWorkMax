exports.up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
    BEGIN NEW.updated_at = now(); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
    CREATE TABLE users (id uuid PRIMARY KEY, version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL, revoked_at timestamptz, version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK (revoked_at IS NULL OR revoked_at >= created_at));
    CREATE INDEX sessions_user_id_idx ON sessions(user_id);
    CREATE TABLE profile_versions (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, version integer NOT NULL CHECK (version > 0), payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id, version));
    CREATE INDEX profile_versions_user_id_idx ON profile_versions(user_id);
    CREATE TABLE problems (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX problems_user_id_idx ON problems(user_id);
    CREATE TABLE problem_versions (id uuid PRIMARY KEY, problem_id uuid NOT NULL REFERENCES problems(id) ON DELETE CASCADE, version integer NOT NULL CHECK (version > 0), payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(problem_id, version));
    CREATE INDEX problem_versions_problem_id_idx ON problem_versions(problem_id);
    CREATE TABLE goals (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'), version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX goals_user_id_idx ON goals(user_id);
    CREATE TABLE consents (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, consent_type text NOT NULL CHECK (length(consent_type) > 0), document_version text NOT NULL CHECK (length(document_version) > 0), granted boolean NOT NULL, occurred_at timestamptz NOT NULL, version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id, consent_type, document_version));
    CREATE INDEX consents_user_id_idx ON consents(user_id);
    CREATE TABLE idempotency_keys (id uuid PRIMARY KEY, scope text NOT NULL CHECK (length(scope) > 0), key_hash char(64) NOT NULL, request_hash char(64) NOT NULL, status text NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED')), response jsonb CHECK (response IS NULL OR jsonb_typeof(response) = 'object'), resource_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(scope, key_hash));
    CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER sessions_updated_at BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER profile_versions_updated_at BEFORE UPDATE ON profile_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER problems_updated_at BEFORE UPDATE ON problems FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER problem_versions_updated_at BEFORE UPDATE ON problem_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER goals_updated_at BEFORE UPDATE ON goals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER consents_updated_at BEFORE UPDATE ON consents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER idempotency_keys_updated_at BEFORE UPDATE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};
exports.down = (pgm) => {
  pgm.sql(
    `DROP TABLE IF EXISTS idempotency_keys, consents, goals, problem_versions, problems, profile_versions, sessions, users CASCADE; DROP FUNCTION IF EXISTS set_updated_at();`,
  );
};
