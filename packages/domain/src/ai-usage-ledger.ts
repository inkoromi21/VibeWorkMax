import {
  actualAiCost,
  estimateWorstCaseCost,
  estimateInputTokens,
  type AiBudgetPolicy,
  type AiCostEstimate,
  type AiPricingCatalog,
} from '@vibework/ai';
import { newUuid } from '@vibework/shared';
import type { Pool, PoolClient } from 'pg';
import type { AiRequest, AiResult } from '@vibework/ai';

export type AiLedgerStatus =
  'RESERVED' | 'SUCCEEDED' | 'SUCCEEDED_USAGE_UNKNOWN' | 'FAILED_UNKNOWN' | 'DENIED';

export interface AiUsageLedgerEntry {
  id: string;
  operation: string;
  provider: string;
  model: string;
  operationIdentity: string;
  attempt: number;
  day: string;
  status: AiLedgerStatus;
  estimatedCost: number | null;
  actualCost: number | null;
  currency: string | null;
}

export type AiBudgetReservation =
  | { kind: 'RESERVED'; entry: AiUsageLedgerEntry; estimate: AiCostEstimate }
  | { kind: 'EXISTING'; entry: AiUsageLedgerEntry }
  | {
      kind: 'DENIED';
      entry: AiUsageLedgerEntry;
      reason:
        'BUDGET_DISABLED' | 'MISSING_PRICE' | 'INPUT_LIMIT' | 'OPERATION_LIMIT' | 'DAILY_LIMIT';
    };

function dayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`AI ledger ${field} is invalid`);
  return value;
}

/** node-postgres parses PostgreSQL `date` columns as Date instances by default. */
function requiredDay(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return value.toISOString().slice(0, 10);
  throw new Error('AI ledger operation_day is invalid');
}

function rowToEntry(row: Record<string, unknown>): AiUsageLedgerEntry {
  return {
    id: requiredString(row.id, 'id'),
    operation: requiredString(row.operation, 'operation'),
    provider: requiredString(row.provider, 'provider'),
    model: requiredString(row.model, 'model'),
    operationIdentity: requiredString(row.operation_identity, 'operation_identity'),
    attempt: Number(row.attempt),
    day: requiredDay(row.operation_day),
    status: row.status as AiLedgerStatus,
    estimatedCost: row.estimated_cost === null ? null : Number(row.estimated_cost),
    actualCost: row.actual_cost === null ? null : Number(row.actual_cost),
    currency: row.currency === null ? null : requiredString(row.currency, 'currency'),
  };
}

async function writeAudit(
  client: PoolClient,
  input: {
    action: string;
    targetId: string;
    result: 'SUCCEEDED' | 'FAILED' | 'DENIED';
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const eventId = newUuid();
  await client.query(
    `INSERT INTO decision_events(event_id,actor_type,action,target_type,target_id,target_version,metadata)
     VALUES ($1,'SYSTEM',$2,'AI_USAGE_LEDGER',$3,1,$4)`,
    [eventId, input.action, input.targetId, input.metadata],
  );
  await client.query(
    `INSERT INTO audit_events(id,event_id,actor_type,action,target_type,target_id,target_version,result,metadata)
     VALUES ($1,$2,'SYSTEM',$3,'AI_USAGE_LEDGER',$4,1,$5,$6)`,
    [newUuid(), eventId, input.action, input.targetId, input.result, input.metadata],
  );
}

/**
 * PostgreSQL-backed, globally atomic budget ledger. A day/currency advisory
 * transaction lock serializes admission before the provider is ever called.
 */
export class PostgresAiUsageLedger {
  constructor(
    private readonly pool: Pool,
    private readonly pricing: AiPricingCatalog | null,
    private readonly policy: AiBudgetPolicy,
  ) {}

  /** Best-effort queue admission; `preflight` remains the authoritative atomic reservation. */
  async canAfford(input: { request: AiRequest; provider: string; now?: Date }): Promise<boolean> {
    if (
      this.policy.mode === 'disabled' ||
      !this.pricing ||
      !this.policy.maxOperationCost ||
      !this.policy.dailyAiBudget ||
      estimateInputTokens(input.request.prompt) > input.request.maxInputTokens
    )
      return false;
    const estimate = estimateWorstCaseCost(this.pricing, input.provider, input.request);
    if (!estimate || estimate.totalCost > this.policy.maxOperationCost) return false;
    const day = dayUtc(input.now ?? new Date());
    const current = await this.pool.query<{ reserved_cost: string; charged_cost: string }>(
      `SELECT reserved_cost,charged_cost FROM ai_budget_days
       WHERE operation_day=$1 AND currency=$2`,
      [day, estimate.currency],
    );
    const totals = current.rows[0];
    return (
      Number(totals?.reserved_cost ?? 0) + Number(totals?.charged_cost ?? 0) + estimate.totalCost <=
      this.policy.dailyAiBudget
    );
  }

  async preflight(input: {
    request: AiRequest;
    provider: string;
    operationIdentity: string;
    attempt?: number;
    now?: Date;
    provenance?: Record<string, unknown>;
  }): Promise<AiBudgetReservation> {
    const attempt = input.attempt ?? 0;
    if (!input.operationIdentity.trim()) throw new Error('AI operation identity is required');
    if (!Number.isInteger(attempt) || attempt < 0)
      throw new Error('AI operation attempt must be a non-negative integer');
    const now = input.now ?? new Date();
    const day = dayUtc(now);
    const model =
      input.request.modelPolicy.preferredModel ?? input.request.modelPolicy.allowedModels[0] ?? '';
    const estimate = this.pricing
      ? estimateWorstCaseCost(this.pricing, input.provider, input.request)
      : null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // This covers absent rows as well as existing rows, avoiding a read-then-write race.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `ai-budget:${day}:${this.pricing?.currency ?? 'UNKNOWN'}`,
      ]);
      const existing = await client.query<Record<string, unknown>>(
        `SELECT id,operation,provider,model,operation_identity,attempt,operation_day,status,estimated_cost,actual_cost,currency
         FROM ai_usage_ledger WHERE operation=$1 AND operation_identity=$2 AND attempt=$3 FOR UPDATE`,
        [input.request.operationKind, input.operationIdentity, attempt],
      );
      if (existing.rowCount === 1) {
        await client.query('COMMIT');
        return { kind: 'EXISTING', entry: rowToEntry(existing.rows[0] ?? {}) };
      }

      const entryId = newUuid();
      const deny = async (
        reason:
          'BUDGET_DISABLED' | 'MISSING_PRICE' | 'INPUT_LIMIT' | 'OPERATION_LIMIT' | 'DAILY_LIMIT',
      ) => {
        await client.query(
          `INSERT INTO ai_usage_ledger(id,operation,provider,model,operation_identity,attempt,operation_day,status,currency,metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'DENIED',$8,$9)`,
          [
            entryId,
            input.request.operationKind,
            input.provider,
            model,
            input.operationIdentity,
            attempt,
            day,
            this.pricing?.currency ?? null,
            { reason, ...(input.provenance ?? {}) },
          ],
        );
        await writeAudit(client, {
          action: 'AI_BUDGET_DENIED',
          targetId: entryId,
          result: 'DENIED',
          metadata: { operation: input.request.operationKind, reason, attempt },
        });
        await client.query('COMMIT');
        return {
          kind: 'DENIED' as const,
          reason,
          entry: {
            id: entryId,
            operation: input.request.operationKind,
            provider: input.provider,
            model,
            operationIdentity: input.operationIdentity,
            attempt,
            day,
            status: 'DENIED' as const,
            estimatedCost: null,
            actualCost: null,
            currency: this.pricing?.currency ?? null,
          },
        };
      };
      if (this.policy.mode === 'disabled') return await deny('BUDGET_DISABLED');
      if (!estimate || !this.pricing) return await deny('MISSING_PRICE');
      if (estimateInputTokens(input.request.prompt) > input.request.maxInputTokens)
        return await deny('INPUT_LIMIT');
      if (!this.policy.maxOperationCost || !this.policy.dailyAiBudget)
        return await deny('BUDGET_DISABLED');
      if (estimate.totalCost > this.policy.maxOperationCost) return await deny('OPERATION_LIMIT');

      await client.query(
        `INSERT INTO ai_budget_days(operation_day,currency,reserved_cost,charged_cost)
         VALUES ($1,$2,0,0) ON CONFLICT (operation_day,currency) DO NOTHING`,
        [day, estimate.currency],
      );
      const budget = await client.query<{ reserved_cost: string; charged_cost: string }>(
        `SELECT reserved_cost,charged_cost FROM ai_budget_days WHERE operation_day=$1 AND currency=$2 FOR UPDATE`,
        [day, estimate.currency],
      );
      const totals = budget.rows[0];
      if (!totals) throw new Error('AI budget day row was not created');
      if (
        Number(totals.reserved_cost) + Number(totals.charged_cost) + estimate.totalCost >
        this.policy.dailyAiBudget
      )
        return await deny('DAILY_LIMIT');
      await client.query(
        `UPDATE ai_budget_days SET reserved_cost=reserved_cost+$3,updated_at=now()
         WHERE operation_day=$1 AND currency=$2`,
        [day, estimate.currency, estimate.totalCost],
      );
      await client.query(
        `INSERT INTO ai_usage_ledger(id,operation,provider,model,operation_identity,attempt,operation_day,status,input_tokens,output_tokens,estimated_input_cost,estimated_output_cost,estimated_cost,currency,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'RESERVED',$8,$9,$10,$11,$12,$13,$14)`,
        [
          entryId,
          input.request.operationKind,
          input.provider,
          model,
          input.operationIdentity,
          attempt,
          day,
          estimate.inputTokens,
          estimate.outputTokens,
          estimate.inputCost,
          estimate.outputCost,
          estimate.totalCost,
          estimate.currency,
          input.provenance ?? {},
        ],
      );
      await client.query('COMMIT');
      return {
        kind: 'RESERVED',
        entry: {
          id: entryId,
          operation: input.request.operationKind,
          provider: input.provider,
          model,
          operationIdentity: input.operationIdentity,
          attempt,
          day,
          status: 'RESERVED',
          estimatedCost: estimate.totalCost,
          actualCost: null,
          currency: estimate.currency,
        },
        estimate,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcile(input: {
    entryId: string;
    result: AiResult<unknown>;
    provider: string;
  }): Promise<AiUsageLedgerEntry> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<Record<string, unknown>>(
        `SELECT id,operation,provider,model,operation_identity,attempt,operation_day,status,estimated_cost,actual_cost,currency
         FROM ai_usage_ledger WHERE id=$1 FOR UPDATE`,
        [input.entryId],
      );
      const entry = selected.rows[0];
      if (!entry) throw new Error('AI ledger entry not found');
      if (entry.status !== 'RESERVED') {
        await client.query('COMMIT');
        return rowToEntry(entry);
      }
      const currency = entry.currency === null ? null : requiredString(entry.currency, 'currency');
      const actual = this.pricing
        ? actualAiCost(this.pricing, input.provider, input.result.model, input.result.usage)
        : null;
      const settledCost = actual?.totalCost ?? Number(entry.estimated_cost);
      if (!currency) throw new Error('Reserved AI ledger entry has no currency');
      await client.query(
        `UPDATE ai_budget_days SET reserved_cost=GREATEST(0,reserved_cost-$3),charged_cost=charged_cost+$4,updated_at=now()
         WHERE operation_day=$1 AND currency=$2`,
        [entry.operation_day, currency, Number(entry.estimated_cost), settledCost],
      );
      const status: AiLedgerStatus = actual ? 'SUCCEEDED' : 'SUCCEEDED_USAGE_UNKNOWN';
      await client.query(
        `UPDATE ai_usage_ledger SET provider=$2,model=$3,status=$4,input_tokens=$5,output_tokens=$6,actual_input_cost=$7,actual_output_cost=$8,actual_cost=$9,provider_request_id=$10,
           metadata=metadata || jsonb_build_object('structured_result',$11::jsonb),completed_at=now(),updated_at=now()
         WHERE id=$1`,
        [
          input.entryId,
          input.provider,
          input.result.model,
          status,
          input.result.usage.inputTokens,
          input.result.usage.outputTokens,
          actual?.inputCost ?? null,
          actual?.outputCost ?? null,
          actual?.totalCost ?? null,
          input.result.providerRequestId,
          JSON.stringify(input.result.value),
        ],
      );
      if (actual && actual.totalCost > Number(entry.estimated_cost))
        await writeAudit(client, {
          action: 'AI_BUDGET_RECONCILED_OVERAGE',
          targetId: input.entryId,
          result: 'SUCCEEDED',
          metadata: {
            estimatedCost: Number(entry.estimated_cost),
            actualCost: actual.totalCost,
            operation: entry.operation,
          },
        });
      await client.query('COMMIT');
      return {
        ...rowToEntry(entry),
        provider: input.provider,
        model: input.result.model,
        status,
        actualCost: actual?.totalCost ?? null,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Unknown provider outcome keeps its worst-case reservation for the day. */
  async markProviderFailure(entryId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ai_usage_ledger SET status='FAILED_UNKNOWN',updated_at=now() WHERE id=$1 AND status='RESERVED'`,
      [entryId],
    );
  }

  async replayStructuredResult(entryId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<{ value: unknown }>(
      `SELECT metadata->'structured_result' AS value FROM ai_usage_ledger
       WHERE id=$1 AND status IN ('SUCCEEDED','SUCCEEDED_USAGE_UNKNOWN')`,
      [entryId],
    );
    const value = result.rows[0]?.value;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  async recordFallback(input: {
    entryId: string;
    operation: string;
    reason: 'BUDGET_EXCEEDED' | 'INVALID_OUTPUT' | 'PROVIDER_UNAVAILABLE';
    provenance: Record<string, unknown>;
  }): Promise<void> {
    const client = await this.pool.connect();
    const eventId = newUuid();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ai-fallback:${input.entryId}`,
      ]);
      const event = await client.query(
        `INSERT INTO decision_events(event_id,actor_type,action,target_type,target_id,target_version,metadata)
         SELECT $1,'SYSTEM','AI_FALLBACK','AI_USAGE_LEDGER',$2,1,$3
         WHERE NOT EXISTS (
           SELECT 1 FROM decision_events
           WHERE action='AI_FALLBACK' AND target_type='AI_USAGE_LEDGER' AND target_id=$2
         ) RETURNING event_id`,
        [
          eventId,
          input.entryId,
          { operation: input.operation, reason: input.reason, ...input.provenance },
        ],
      );
      if (event.rowCount === 1)
        await client.query(
          `INSERT INTO audit_events(id,event_id,actor_type,action,target_type,target_id,target_version,result,metadata)
           VALUES ($1,$2,'SYSTEM','AI_FALLBACK','AI_USAGE_LEDGER',$3,1,'SUCCEEDED',$4)`,
          [newUuid(), eventId, input.entryId, { operation: input.operation, reason: input.reason }],
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
