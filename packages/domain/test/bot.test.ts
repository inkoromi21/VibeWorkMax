import { describe, expect, it } from 'vitest';
import {
  BotService,
  MemoryBotRepository,
  classifyProblem,
  consentPolicyFromEnvironment,
} from '../src/index.js';

const legal = { enabled: true, version: 'test-v1', minAge: 14 };
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected value');
  return value;
}
async function send(service: BotService, eventId: string, actorId: string, text: string) {
  return service.handle({ eventId, actorId, kind: 'MESSAGE', text });
}

describe('bot conversation aggregate', () => {
  it('classifies deterministic requests and sends ambiguity to clarification', () => {
    expect(classifyProblem('не понимаю тему дробей').type).toBe('KNOWLEDGE_GAP');
    expect(classifyProblem('привет')).toMatchObject({ type: null, status: 'ambiguous' });
  });
  it('keeps personal-data processing disabled for incomplete legal configuration', () => {
    expect(consentPolicyFromEnvironment({ CONSENT_DOCUMENT_VERSION: 'v1' }).enabled).toBe(false);
    expect(
      consentPolicyFromEnvironment({
        CONSENT_DOCUMENT_VERSION: 'v1',
        PRIVACY_POLICY_URL: 'https://privacy.example',
        TERMS_OF_USE_URL: 'https://terms.example',
        AGE_POLICY_VERSION: 'age-v1',
        MIN_AGE: '14',
        REPRESENTATIVE_CONSENT_UNDER: '18',
      }).enabled,
    ).toBe(true);
  });
  it('requires consent, confirms the problem, and survives a service restart', async () => {
    const repository = new MemoryBotRepository();
    const first = new BotService(repository, legal);
    await first.handle({ eventId: '1', actorId: 'a', kind: 'START' });
    await first.handle({ eventId: '2', actorId: 'a', kind: 'CALLBACK', callback: 'b1c' });
    await send(first, '3', 'a', '18');
    const current = await repository.get('a');
    const next = new BotService(repository, legal);
    const problem = await next.handle({
      eventId: '4',
      actorId: 'a',
      kind: 'CALLBACK',
      callback: `b${must(current).revision.toString(36)}n`,
    });
    expect(problem.replies[0]?.text).toContain('Опишите');
    await send(next, '5', 'a', 'не понимаю дроби');
    const beforeConfirm = await repository.get('a');
    expect(beforeConfirm?.state).toBe('CONFIRM_PROBLEM');
    const confirmed = await next.handle({
      eventId: '6',
      actorId: 'a',
      kind: 'CALLBACK',
      callback: `b${must(beforeConfirm).revision.toString(36)}y`,
    });
    expect(confirmed.replies[0]?.text).toContain('учебный контекст');
    const profile = await repository.get('a');
    const diagnosed = await next.handle({
      eventId: '7',
      actorId: 'a',
      kind: 'CALLBACK',
      callback: `b${must(profile).revision.toString(36)}b`,
    });
    expect(diagnosed.replies[0]?.text).toContain('Количество вопросов');
  });
  it('safely rejects stale callbacks and makes duplicate events inert', async () => {
    const repository = new MemoryBotRepository();
    const service = new BotService(repository, legal);
    await service.handle({ eventId: 'start', actorId: 'b', kind: 'START' });
    const stale = await service.handle({
      eventId: 'stale',
      actorId: 'b',
      kind: 'CALLBACK',
      callback: 'b0n',
    });
    expect(stale.replies[0]?.text).toContain('устарела');
    const duplicate = await service.handle({
      eventId: 'stale',
      actorId: 'b',
      kind: 'CALLBACK',
      callback: 'b0n',
    });
    expect(duplicate.replies).toHaveLength(0);
  });
  it('rejects a callback that is current but invalid for the active state', async () => {
    const repository = new MemoryBotRepository();
    const service = new BotService(repository, legal);
    await service.handle({ eventId: 'start-current', actorId: 'invalid', kind: 'START' });
    const current = await repository.get('invalid');
    const result = await service.handle({
      eventId: 'invalid-action',
      actorId: 'invalid',
      kind: 'CALLBACK',
      callback: `b${must(current).revision.toString(36)}p`,
    });
    expect(result.replies[0]?.text).toContain('устарела');
  });
  it('does not create a profile path after refusal and deduplicates notifications', async () => {
    const repository = new MemoryBotRepository();
    const service = new BotService(repository, legal);
    await service.handle({ eventId: 'start', actorId: 'c', kind: 'START' });
    const declined = await service.handle({
      eventId: 'no',
      actorId: 'c',
      kind: 'CALLBACK',
      callback: 'b1d',
    });
    expect(declined.replies[0]?.text).toContain('не обрабатываю');
    const first = await service.handle({
      eventId: 'notify',
      actorId: 'c',
      kind: 'SYSTEM',
      systemEvent: 'plan.published',
    });
    const second = await service.handle({
      eventId: 'notify',
      actorId: 'c',
      kind: 'SYSTEM',
      systemEvent: 'plan.published',
    });
    expect(first.replies).toHaveLength(1);
    expect(second.replies).toHaveLength(0);
  });
  it('creates the course-build effect once after goal confirmation', async () => {
    const repository = new MemoryBotRepository();
    const service = new BotService(repository, legal);
    await service.handle({ eventId: 'result-start', actorId: 'goal', kind: 'START' });
    const current = await repository.get('goal');
    await repository.transact('force-result', 'goal', (conversation) => ({
      ...must(conversation),
      state: 'RESULT',
      revision: must(current).revision + 1,
    }));
    const result = await repository.get('goal');
    await service.handle({
      eventId: 'enter-goal',
      actorId: 'goal',
      kind: 'CALLBACK',
      callback: `b${must(result).revision.toString(36)}g`,
    });
    const goal = await repository.get('goal');
    const first = await service.handle({
      eventId: 'confirm-goal',
      actorId: 'goal',
      kind: 'CALLBACK',
      callback: `b${must(goal).revision.toString(36)}g`,
    });
    expect(first.jobs).toHaveLength(1);
    const duplicate = await service.handle({
      eventId: 'confirm-goal',
      actorId: 'goal',
      kind: 'CALLBACK',
      callback: `b${must(goal).revision.toString(36)}g`,
    });
    expect(duplicate.jobs).toHaveLength(0);
  });
});
