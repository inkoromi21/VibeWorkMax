exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE decision_events (event_id uuid PRIMARY KEY, actor_type text NOT NULL CHECK (length(actor_type) > 0), actor_id uuid REFERENCES users(id) ON DELETE SET NULL, action text NOT NULL CHECK (length(action) > 0), target_type text NOT NULL CHECK (length(target_type) > 0), target_id uuid NOT NULL, target_version integer NOT NULL CHECK (target_version > 0), created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX decision_events_target_idx ON decision_events(target_type, target_id);
    CREATE TABLE audit_events (id uuid PRIMARY KEY, event_id uuid NOT NULL UNIQUE REFERENCES decision_events(event_id) ON DELETE RESTRICT, actor_type text NOT NULL CHECK (length(actor_type) > 0), actor_id uuid REFERENCES users(id) ON DELETE SET NULL, action text NOT NULL CHECK (length(action) > 0), target_type text NOT NULL CHECK (length(target_type) > 0), target_id uuid NOT NULL, target_version integer NOT NULL CHECK (target_version > 0), result text NOT NULL CHECK (result IN ('SUCCEEDED', 'FAILED', 'DENIED')), metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'), created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX audit_events_target_idx ON audit_events(target_type, target_id);
    CREATE INDEX audit_events_actor_idx ON audit_events(actor_type, actor_id);
    CREATE TABLE notification_outbox (id uuid PRIMARY KEY, event_id uuid NOT NULL UNIQUE REFERENCES decision_events(event_id) ON DELETE RESTRICT, event_type text NOT NULL CHECK (length(event_type) > 0), payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'), status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'DEAD')), attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), available_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz, locked_by text, delivered_at timestamptz, last_error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK ((status = 'DELIVERED' AND delivered_at IS NOT NULL) OR status <> 'DELIVERED'));
    CREATE INDEX notification_outbox_ready_idx ON notification_outbox(status, available_at);
    CREATE TRIGGER notification_outbox_updated_at BEFORE UPDATE ON notification_outbox FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};
exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS notification_outbox, audit_events, decision_events CASCADE;');
};
