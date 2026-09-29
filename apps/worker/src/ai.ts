import { createBudgetedAiOperations } from '@vibework/domain';
import type { Pool } from 'pg';

/** Composition root: disabled mode is deterministic and never performs network I/O. */
export function createWorkerAiOperations(pool: Pool) {
  return createBudgetedAiOperations(pool);
}
