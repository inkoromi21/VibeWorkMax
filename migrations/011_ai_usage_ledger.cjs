exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE ai_budget_days (
      operation_day date NOT NULL,
      currency char(3) NOT NULL,
      reserved_cost numeric(18,8) NOT NULL DEFAULT 0 CHECK (reserved_cost >= 0),
      charged_cost numeric(18,8) NOT NULL DEFAULT 0 CHECK (charged_cost >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (operation_day, currency)
    );
    CREATE TABLE ai_usage_ledger (
      id uuid PRIMARY KEY,
      operation text NOT NULL CHECK (length(operation) > 0),
      provider text NOT NULL CHECK (length(provider) > 0),
      model text NOT NULL CHECK (length(model) > 0),
      operation_identity text NOT NULL CHECK (length(operation_identity) > 0),
      attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= 1),
      operation_day date NOT NULL,
      status text NOT NULL CHECK (status IN ('RESERVED','SUCCEEDED','SUCCEEDED_USAGE_UNKNOWN','FAILED_UNKNOWN','DENIED')),
      input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
      output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
      estimated_input_cost numeric(18,8) CHECK (estimated_input_cost IS NULL OR estimated_input_cost >= 0),
      estimated_output_cost numeric(18,8) CHECK (estimated_output_cost IS NULL OR estimated_output_cost >= 0),
      estimated_cost numeric(18,8) CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
      actual_input_cost numeric(18,8) CHECK (actual_input_cost IS NULL OR actual_input_cost >= 0),
      actual_output_cost numeric(18,8) CHECK (actual_output_cost IS NULL OR actual_output_cost >= 0),
      actual_cost numeric(18,8) CHECK (actual_cost IS NULL OR actual_cost >= 0),
      currency char(3),
      provider_request_id text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(operation, operation_identity, attempt),
      CHECK ((status = 'RESERVED' AND estimated_cost IS NOT NULL) OR status <> 'RESERVED')
    );
    CREATE INDEX ai_usage_ledger_day_status_idx ON ai_usage_ledger(operation_day, status);
    CREATE INDEX ai_usage_ledger_identity_idx ON ai_usage_ledger(operation_identity);
    CREATE TRIGGER ai_budget_days_updated_at BEFORE UPDATE ON ai_budget_days FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER ai_usage_ledger_updated_at BEFORE UPDATE ON ai_usage_ledger FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS ai_usage_ledger, ai_budget_days CASCADE;');
};
