exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE max_user_identities (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id_hash char(64) NOT NULL UNIQUE,
      encrypted_recipient text,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(user_id, actor_id_hash)
    );

    WITH actors AS (
      SELECT actor_id_hash FROM bot_conversations
      UNION SELECT actor_id_hash FROM max_webhook_events
    ), mapped AS (
      SELECT actor_id_hash,
        (substr(actor_id_hash, 1, 8) || '-' || substr(actor_id_hash, 9, 4) || '-' ||
         substr(actor_id_hash, 13, 4) || '-' || substr(actor_id_hash, 17, 4) || '-' ||
         substr(actor_id_hash, 21, 12))::uuid AS user_id
      FROM actors
    )
    INSERT INTO users(id) SELECT user_id FROM mapped ON CONFLICT DO NOTHING;
    WITH actors AS (
      SELECT actor_id_hash FROM bot_conversations
      UNION SELECT actor_id_hash FROM max_webhook_events
    )
    INSERT INTO max_user_identities(user_id, actor_id_hash)
    SELECT (substr(actor_id_hash, 1, 8) || '-' || substr(actor_id_hash, 9, 4) || '-' ||
            substr(actor_id_hash, 13, 4) || '-' || substr(actor_id_hash, 17, 4) || '-' ||
            substr(actor_id_hash, 21, 12))::uuid, actor_id_hash
    FROM actors ON CONFLICT DO NOTHING;

    CREATE TABLE bot_callback_tokens (
      token varchar(48) PRIMARY KEY,
      actor_id_hash char(64) NOT NULL,
      conversation_id uuid NOT NULL REFERENCES bot_conversations(id) ON DELETE CASCADE,
      revision integer NOT NULL CHECK (revision >= 0),
      action text NOT NULL,
      target_ref text,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX bot_callback_tokens_active_idx ON bot_callback_tokens(actor_id_hash, expires_at) WHERE consumed_at IS NULL;

    CREATE TABLE bot_notification_preferences (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled boolean NOT NULL DEFAULT true,
      quiet_hours jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quiet_hours) = 'object'),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE bot_reviews (
      id uuid PRIMARY KEY,
      attempt_id uuid NOT NULL UNIQUE REFERENCES bot_attempts(id) ON DELETE RESTRICT,
      rubric_version text NOT NULL,
      status text NOT NULL CHECK (status IN ('READY', 'PENDING_REVIEW')),
      summary text NOT NULL CHECK (length(summary) <= 1000),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE bot_disputes (
      id uuid PRIMARY KEY,
      attempt_id uuid NOT NULL REFERENCES bot_attempts(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(
    'DROP TABLE IF EXISTS bot_disputes, bot_reviews, bot_notification_preferences, bot_callback_tokens, max_user_identities CASCADE;',
  );
};
