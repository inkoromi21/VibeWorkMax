import type { DiagnosticRequestType } from '@vibework/content';

/**
 * Versioned behavioural fixtures transcribed from the permitted legacy pain
 * mapping. They are data for TypeScript tests, never a legacy runtime import.
 */
export const LEGACY_PAIN_CLASSIFICATION_FIXTURES = [
  { id: 'pain-1', text: 'Я не знаю, кем стать', expected: 'DIRECTION' },
  {
    id: 'pain-2',
    text: 'У меня нет опыта для стажировки, меня не возьмут',
    expected: 'PRACTICE_READINESS',
  },
  {
    id: 'pain-3',
    text: 'В маленьком городе нет вакансий, нужна удалённая работа',
    expected: 'PRACTICE_READINESS',
  },
  { id: 'pain-4', text: 'Нет денег на курсы, хочу освоить навык', expected: 'SKILL' },
  { id: 'pain-5', text: 'Боюсь собеседования перед стажировкой', expected: 'PRACTICE_READINESS' },
  { id: 'pain-6', text: 'Слишком много информации, не знаю с чего начать', expected: null },
  { id: 'pain-7', text: 'Я ничего не умею', expected: 'KNOWLEDGE_GAP' },
  { id: 'pain-8', text: 'Всё умею, но работу не дают', expected: 'PRACTICE_READINESS' },
] as const satisfies readonly {
  id: string;
  text: string;
  expected: DiagnosticRequestType | null;
}[];
