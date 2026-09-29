import { ApplicationError } from '@vibework/shared';
import type { Pool } from 'pg';
import type { ConsentPolicy } from './bot.js';

export interface AccessDecision {
  allowed: boolean;
  reason?: 'LEGAL_CONFIGURATION_MISSING' | 'CONSENT_REQUIRED' | 'AGE_NOT_ALLOWED';
}

/** Shared server-side gate used by every channel before personal-data writes. */
export class PostgresAccessPolicy {
  constructor(
    private readonly pool: Pool,
    private readonly policy: ConsentPolicy,
  ) {}

  async decide(userId: string): Promise<AccessDecision> {
    if (!this.policy.enabled || !this.policy.version)
      return { allowed: false, reason: 'LEGAL_CONFIGURATION_MISSING' };
    const result = await this.pool.query<{
      age: number | null;
      granted: boolean | null;
    }>(
      `SELECT
         (SELECT NULLIF(payload->>'age','')::integer FROM profile_versions
          WHERE user_id=$1 ORDER BY version DESC LIMIT 1) AS age,
         (SELECT granted FROM consents
          WHERE user_id=$1 AND consent_type='PERSONAL_DATA' AND document_version=$2
          ORDER BY occurred_at DESC LIMIT 1) AS granted`,
      [userId, this.policy.version],
    );
    const row = result.rows[0];
    if (row?.granted !== true) return { allowed: false, reason: 'CONSENT_REQUIRED' };
    if (row.age === null) return { allowed: false, reason: 'AGE_NOT_ALLOWED' };
    if (this.policy.minAge !== undefined && row.age < this.policy.minAge)
      return { allowed: false, reason: 'AGE_NOT_ALLOWED' };
    if (
      this.policy.representativeRequiredUnder !== undefined &&
      row.age < this.policy.representativeRequiredUnder
    )
      return { allowed: false, reason: 'AGE_NOT_ALLOWED' };
    return { allowed: true };
  }

  async assertAllowed(userId: string): Promise<void> {
    const decision = await this.decide(userId);
    if (decision.allowed) return;
    throw new ApplicationError({
      code: decision.reason ?? 'ACCESS_BLOCKED',
      message:
        decision.reason === 'LEGAL_CONFIGURATION_MISSING'
          ? 'Обработка данных временно недоступна: юридические документы не настроены'
          : decision.reason === 'CONSENT_REQUIRED'
            ? 'Нужно актуальное согласие на обработку данных'
            : 'Возрастной допуск не подтверждён',
      statusCode: 403,
    });
  }
}
