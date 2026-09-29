import { describe, expect, it } from 'vitest';
import { contentInfrastructureReady, validateCatalogRecord } from '../src/index.js';

describe('versioned content catalog', () => {
  it('rejects a rubric without a usable criterion and a block without a versioned competency', () => {
    const base = {
      logicalId: 'demo-record',
      status: 'DRAFT' as const,
      dataMode: 'DEMO_SYNTHETIC' as const,
      sourceUrl: null,
      license: null,
      provenance: 'Repository synthetic fixture',
      checkedAt: '2026-09-29T00:00:00.000Z',
      expertApproval: 'APPROVED' as const,
    };
    expect(validateCatalogRecord({ ...base, kind: 'RUBRIC', payload: { criteria: [] } })).toContain(
      'INVALID_PAYLOAD',
    );
    expect(
      validateCatalogRecord({
        ...base,
        kind: 'LEARNING_BLOCK',
        payload: { title: 'Разобрать основу', durationMinutes: 15 },
      }),
    ).toContain('INVALID_PAYLOAD');
  });

  it('rejects an unverifiable published source', () => {
    expect(
      validateCatalogRecord({
        kind: 'SOURCE_RECORD',
        logicalId: 'unsafe-source',
        status: 'PUBLISHED',
        dataMode: 'VERIFIED_SOURCE',
        payload: {},
        sourceUrl: 'http://example.test/source',
        license: ' ',
        provenance: 'import',
        checkedAt: '2026-09-29T00:00:00.000Z',
        expertApproval: 'PENDING',
      }),
    ).toEqual(
      expect.arrayContaining(['INVALID_SOURCE_URL', 'MISSING_LICENSE', 'EXPERT_APPROVAL_REQUIRED']),
    );
  });

  it('reports readiness only for an available database with published records', () => {
    expect(contentInfrastructureReady({ databaseAvailable: true, publishedRecordCount: 1 })).toBe(
      true,
    );
    expect(contentInfrastructureReady({ databaseAvailable: true, publishedRecordCount: 0 })).toBe(
      false,
    );
    expect(contentInfrastructureReady({ databaseAvailable: false, publishedRecordCount: 1 })).toBe(
      false,
    );
  });
});
