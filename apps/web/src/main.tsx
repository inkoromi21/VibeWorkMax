import { Component, StrictMode, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { MaxUI } from '@maxhub/max-ui';
import '@maxhub/max-ui/dist/styles.css';
import './styles.css';
import { createBridge } from './bridge.js';

interface AppState {
  revision: number;
  problemDraft: string;
  problem: {
    text: string;
    classification: {
      type: string | null;
      interpretation: string;
      status?: 'classified' | 'ambiguous';
    };
    version: number;
  } | null;
  diagnosticProfile?: { educationTrack: 'school' | 'student'; interestIds?: string[] };
  canonicalDiagnostic?: {
    sessionId: string;
    problemVersionId: string;
    sessionRevision: number;
    questionInstanceId: string | null;
    publicQuestion: {
      question_kind?: string;
      prompt?: string;
      options?: { id: string; label: string }[];
    } | null;
  };
  diagnostic: { index: number; paused: boolean; completed: boolean; additionalConsent: boolean };
  result: {
    version: number;
    evidenceSufficiency: 'LIMITED' | 'PARTIAL';
    findings: { label: string; status: 'KNOWN' | 'GAP' | 'UNKNOWN' }[];
    source: string;
  } | null;
  goal: { text: string; version: number } | null;
  route: {
    version: number;
    status: 'ACTIVE';
    goalVersion: number;
    contentMode: 'DEMO';
    step: { title: string; rationale: string; durationMinutes: number };
  } | null;
  attemptCount: number;
  notificationsEnabled: boolean;
}
interface Question {
  id: string;
  kind: string;
  prompt: string;
  options?: readonly string[];
}
type AppModel = ReturnType<typeof useApp>;
const initial: AppState = {
  revision: 0,
  problemDraft: '',
  problem: null,
  diagnostic: { index: 0, paused: false, completed: false, additionalConsent: false },
  result: null,
  goal: null,
  route: null,
  attemptCount: 0,
  notificationsEnabled: true,
};
const demoQuestions: Question[] = [
  {
    id: 'experience',
    kind: 'single',
    prompt: 'Что уже пробовали?',
    options: ['Самостоятельно', 'С преподавателем', 'Пока не пробовал'],
  },
  {
    id: 'examples',
    kind: 'multi',
    prompt: 'Что вызывает трудность?',
    options: ['Термины', 'Порядок действий', 'Проверка ответа'],
  },
  { id: 'explain', kind: 'short', prompt: 'Коротко опишите один пример.' },
  { id: 'practice', kind: 'practical', prompt: 'Решите небольшую практическую задачу.' },
  {
    id: 'format',
    kind: 'preference',
    prompt: 'Какой формат первого шага удобнее?',
    options: ['Пример', 'Задача', 'Пояснение'],
  },
];

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <main className="shell">
        <section className="card">
          <h1>Не удалось открыть приложение</h1>
          <p>Данные не потеряны. Попробуйте перезагрузить страницу.</p>
          <button onClick={() => window.location.reload()}>Перезагрузить</button>
        </section>
      </main>
    ) : (
      this.props.children
    );
  }
}

function useApp() {
  const bridge = useMemo(createBridge, []);
  const [state, setState] = useState<AppState>(initial);
  const [csrf, setCsrf] = useState('');
  const [mode, setMode] = useState<'loading' | 'connected' | 'demo'>('loading');
  const [notice, setNotice] = useState('');
  const [questions, setQuestions] = useState<Question[]>(demoQuestions);
  useEffect(() => {
    const connect = async () => {
      try {
        const session = await fetch(
          bridge.initData ? '/api/mini-app/session' : '/api/mini-app/dev-session',
          {
            method: 'POST',
            credentials: 'include',
            headers: bridge.initData ? { 'content-type': 'application/json' } : undefined,
            ...(bridge.initData ? { body: JSON.stringify({ initData: bridge.initData }) } : {}),
          } as RequestInit,
        );
        if (!session.ok) throw new Error('session unavailable');
        const token = (await session.json()) as { csrfToken: string };
        const bootstrap = await fetch('/api/mini-app/bootstrap', { credentials: 'include' });
        if (!bootstrap.ok) throw new Error('bootstrap unavailable');
        const payload = (await bootstrap.json()) as {
          state: AppState;
          csrfToken: string;
          questions: Question[];
          access?: { allowed: boolean; reason?: string };
        };
        setState(payload.state);
        setQuestions(payload.questions);
        setCsrf(payload.csrfToken || token.csrfToken);
        setMode('connected');
        if (payload.access?.allowed === false)
          setNotice(
            payload.access.reason === 'LEGAL_CONFIGURATION_MISSING'
              ? 'Сохранение данных временно недоступно: юридические документы не настроены.'
              : 'Для сохранения данных завершите подтверждение согласия и возраста в боте.',
          );
      } catch {
        setMode('demo');
        setNotice('Demo-режим: серверная сессия недоступна, данные не сохраняются.');
      }
    };
    void connect();
  }, [bridge.initData]);
  const mutate = async (path: string, body: Record<string, unknown>) => {
    if (mode !== 'connected') return null;
    const response = await fetch(path, {
      method:
        path === '/api/mini-app/problem-draft' || path === '/api/mini-app/notification-preferences'
          ? 'PUT'
          : 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({ ...body, revision: state.revision }),
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(error.message ?? 'Не удалось сохранить изменения');
    }
    const payload = (await response.json()) as {
      state?: AppState;
      review?: { feedback: string; attemptId?: string; status?: 'PENDING' | 'READY' };
      id?: string;
      status?: string;
    };
    if (payload.state) setState(payload.state);
    return payload;
  };
  return { bridge, state, setState, mode, notice, mutate, questions };
}

function Shell({ app, children }: { app: AppModel; children: ReactNode }) {
  const location = useLocation();
  const headingRef = useRef<HTMLDivElement>(null);
  useEffect(() => headingRef.current?.focus(), [location.pathname]);
  return (
    <main className="shell">
      <header className="header">
        <span className="brand">VibeWork MAX</span>
        <span className="badge">
          {app.bridge.clientPlatform} · {app.bridge.version}
        </span>
      </header>
      {app.mode === 'loading' ? (
        <p role="status" className="notice">
          Подключаем защищённую сессию…
        </p>
      ) : null}
      {app.notice ? (
        <p role="status" className="notice">
          {app.notice}
        </p>
      ) : null}
      <div ref={headingRef} tabIndex={-1} className="route-focus">
        {children}
      </div>
      <nav className="nav" aria-label="Разделы">
        {(
          [
            { to: '/problem', label: 'Запрос' },
            { to: '/diagnosis', label: 'Диагностика' },
            { to: '/result', label: 'Результат' },
            { to: '/progress', label: 'Прогресс' },
          ] as const
        ).map(({ to, label }) => (
          <Link key={to} to={to} aria-current={location.pathname === to ? 'page' : undefined}>
            {label}
          </Link>
        ))}
      </nav>
    </main>
  );
}

function Problem({ app }: { app: AppModel }) {
  const [text, setText] = useState(app.state.problemDraft);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const submit = async () => {
    try {
      await app.mutate('/api/mini-app/problems', { text });
      if (app.mode !== 'connected')
        app.setState((state) => ({
          ...state,
          revision: state.revision + 1,
          problemDraft: text,
          problem: {
            text,
            classification: {
              type: 'KNOWLEDGE_GAP',
              interpretation: 'Тип будет определён сервером.',
            },
            version: (state.problem?.version ?? 0) + 1,
          },
        }));
      app.bridge.setUnsaved(false);
      void navigate('/diagnosis');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ошибка сохранения');
    }
  };
  return (
    <section className="card stack">
      <div>
        <h1>С чем нужна помощь?</h1>
        <p className="muted">
          Опишите ситуацию своими словами. Профильные вопросы появятся только если они действительно
          нужны.
        </p>
      </div>
      <label htmlFor="problem">
        Ваш запрос
        <textarea
          id="problem"
          value={text}
          maxLength={1000}
          onChange={(event) => {
            setText(event.target.value);
            app.bridge.setUnsaved(true);
          }}
          onBlur={() =>
            void app.mutate('/api/mini-app/problem-draft', { text }).catch(() => undefined)
          }
          placeholder="Например: не понимаю, как проверить решение задачи"
        />
      </label>
      <p className="hint">Черновик сохраняется автоматически. Профессия не обязательна.</p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button disabled={!text.trim()} onClick={() => void submit()}>
          Продолжить
        </button>
        {app.state.problem ? (
          <button className="secondary" onClick={() => void navigate('/diagnosis')}>
            Продолжить диагностику
          </button>
        ) : null}
      </div>
    </section>
  );
}

function Diagnosis({ app }: { app: AppModel }) {
  const navigate = useNavigate();
  const [answer, setAnswer] = useState('');
  const [interests, setInterests] = useState('');
  const index = app.state.diagnostic.index;
  const questions = app.questions;
  const canonical = app.state.canonicalDiagnostic;
  const question = canonical?.publicQuestion
    ? {
        id: canonical.questionInstanceId ?? 'completed',
        kind:
          canonical.publicQuestion.question_kind === 'SHORT_TEXT'
            ? 'short'
            : canonical.publicQuestion.question_kind === 'PREFERENCE'
              ? 'preference'
              : 'single',
        prompt: canonical.publicQuestion.prompt ?? '',
        options: canonical.publicQuestion.options?.map((option) => option.label),
      }
    : questions[index];
  if (!app.state.problem?.classification.type)
    return (
      <section className="card stack">
        <h1>Уточните, что нужно получить</h1>
        <p>Это поможет выбрать один из четырёх диагностических сценариев.</p>
        <div className="actions">
          {[
            ['Выбрать направление', 'DIRECTION'],
            ['Закрыть пробел', 'KNOWLEDGE_GAP'],
            ['Освоить навык', 'SKILL'],
            ['Подготовиться к практике', 'PRACTICE_READINESS'],
          ].map(([label, type]) => (
            <button
              key={type}
              onClick={() => void app.mutate('/api/mini-app/problems/clarification', { type })}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
    );
  if (!app.state.diagnosticProfile) {
    const interestIds = interests
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 3);
    const saveProfile = (educationTrack: 'school' | 'student') => {
      void app.mutate('/api/mini-app/diagnostic-profile', {
        educationTrack,
        ...(app.state.problem?.classification.type === 'DIRECTION' ? { interestIds } : {}),
      });
      if (app.mode !== 'connected')
        app.setState((state) => ({
          ...state,
          diagnosticProfile: {
            educationTrack,
            ...(state.problem?.classification.type === 'DIRECTION' ? { interestIds } : {}),
          },
        }));
    };
    return (
      <section className="card stack">
        <h1>Немного контекста</h1>
        <p>Укажите только текущий учебный этап. Это не карьерный тест.</p>
        {app.state.problem.classification.type === 'DIRECTION' ? (
          <label htmlFor="interests">
            Что вам интересно? До трёх слов через запятую
            <input
              id="interests"
              value={interests}
              onChange={(event) => setInterests(event.target.value)}
              placeholder="Например: дизайн, люди"
            />
          </label>
        ) : null}
        <div className="actions">
          <button onClick={() => saveProfile('school')}>Школа</button>
          <button onClick={() => saveProfile('student')}>Колледж или вуз</button>
        </div>
      </section>
    );
  }
  const update = async (
    action: 'answer' | 'skip' | 'unknown' | 'pause' | 'resume' | 'finish' | 'more',
    value?: string,
  ) => {
    await app.mutate('/api/mini-app/diagnosis', {
      action,
      answer: value,
      ...(canonical?.questionInstanceId
        ? {
            questionInstanceId: canonical.questionInstanceId,
            sessionRevision: canonical.sessionRevision,
          }
        : {}),
    });
    if (app.mode !== 'connected')
      app.setState((state) => ({
        ...state,
        revision: state.revision + 1,
        result:
          action === 'finish' ||
          (action !== 'pause' &&
            action !== 'resume' &&
            state.diagnostic.index + 1 >= questions.length)
            ? {
                version: (state.result?.version ?? 0) + 1,
                evidenceSufficiency: 'LIMITED',
                findings: [
                  { label: 'Формулировка запроса', status: 'KNOWN' },
                  { label: 'Нужен короткий проверяемый первый шаг', status: 'GAP' },
                  { label: 'Остальные навыки пока не проверены', status: 'UNKNOWN' },
                ],
                source: 'Ответы в диагностике; DEMO-интерпретация без production-рубрики.',
              }
            : state.result,
        diagnostic:
          action === 'pause'
            ? { ...state.diagnostic, paused: true }
            : action === 'resume'
              ? { ...state.diagnostic, paused: false }
              : action === 'more'
                ? { ...state.diagnostic, additionalConsent: true }
                : action === 'finish'
                  ? { ...state.diagnostic, completed: true }
                  : {
                      index: Math.min(state.diagnostic.index + 1, questions.length),
                      paused: false,
                      completed: state.diagnostic.index + 1 >= questions.length,
                      additionalConsent: state.diagnostic.additionalConsent,
                    },
      }));
    setAnswer('');
  };
  if (app.state.diagnostic.completed || !question)
    return (
      <section className="card stack">
        <h1>Диагностика завершена</h1>
        <p>Даже при неполных данных неизвестное остаётся неизвестным.</p>
        <button onClick={() => void navigate('/result')}>Открыть результат</button>
      </section>
    );
  if (app.state.diagnostic.paused)
    return (
      <section className="card stack">
        <h1>Диагностика на паузе</h1>
        <p>Текущая позиция сохранена.</p>
        <button onClick={() => void update('resume')}>Продолжить</button>
      </section>
    );
  if (index >= 8 && !app.state.diagnostic.additionalConsent)
    return (
      <section className="card stack">
        <h1>Основные вопросы завершены</h1>
        <p>Можно закончить сейчас или разрешить до четырёх дополнительных уточняющих вопросов.</p>
        <div className="actions">
          <button onClick={() => void update('more')}>Продолжить</button>
          <button className="secondary" onClick={() => void update('finish')}>
            Завершить
          </button>
        </div>
      </section>
    );
  return (
    <section className="card stack">
      <div>
        <p className="hint">
          Вопрос {index + 1} из {questions.length} · {question.kind}
        </p>
        <div
          className="progress"
          aria-label={`Пройдено ${String(index)} из ${String(questions.length)}`}
        >
          <span style={{ width: `${String((index / questions.length) * 100)}%` }} />
        </div>
        <h1>{question.prompt}</h1>
        {index > 2 ? (
          <p className="hint">
            Дополнительный вопрос помогает выбрать первый шаг. Его можно пропустить.
          </p>
        ) : null}
      </div>
      {question.options ? (
        <div
          className="options"
          role={question.kind === 'multi' ? 'group' : undefined}
          aria-label={question.prompt}
        >
          {question.options.map((option) => (
            <button key={option} className="option" onClick={() => void update('answer', option)}>
              {option}
            </button>
          ))}
        </div>
      ) : (
        <label htmlFor="answer">
          Ответ
          <textarea
            id="answer"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Введите ответ"
          />
        </label>
      )}
      <div className="actions">
        {question.options ? null : (
          <button disabled={!answer.trim()} onClick={() => void update('answer', answer)}>
            Сохранить и дальше
          </button>
        )}
        <button className="secondary" onClick={() => void update('unknown')}>
          Не знаю
        </button>
        <button className="secondary" onClick={() => void update('skip')}>
          Пропустить
        </button>
        <button className="ghost" onClick={() => void update('pause')}>
          Пауза
        </button>
        {index > 0 ? (
          <button className="ghost" onClick={() => void update('finish')}>
            Завершить сейчас
          </button>
        ) : null}
      </div>
    </section>
  );
}

function Result({ app }: { app: AppModel }) {
  const [goal, setGoal] = useState(
    app.state.goal?.text ?? 'Выполнить первый короткий шаг по своей теме',
  );
  const navigate = useNavigate();
  const save = async () => {
    await app.mutate('/api/mini-app/goals', { text: goal });
    if (app.mode !== 'connected')
      app.setState((state) => ({
        ...state,
        revision: state.revision + 1,
        goal: { text: goal, version: (state.goal?.version ?? 0) + 1 },
        route: {
          version: (state.route?.version ?? 0) + 1,
          status: 'ACTIVE',
          goalVersion: (state.goal?.version ?? 0) + 1,
          contentMode: 'DEMO',
          step: {
            title: 'Разобрать основу',
            rationale: 'Нужен короткий проверяемый первый шаг',
            durationMinutes: 15,
          },
        },
      }));
    void navigate('/route');
  };
  return (
    <section className="card stack">
      <div>
        <h1>Что мы видим сейчас</h1>
        <p className="muted">Это объяснимый промежуточный результат, а не оценка в процентах.</p>
      </div>
      {(app.state.result?.findings ?? []).map((finding) => (
        <div className="definition" key={finding.label}>
          <span>{finding.label}</span>
          <span
            className={`pill ${finding.status === 'GAP' ? 'gap' : finding.status === 'UNKNOWN' ? 'unknown' : ''}`}
          >
            {finding.status.toLowerCase()}
          </span>
        </div>
      ))}
      <p>
        <strong>Достаточность evidence:</strong>{' '}
        {app.state.result?.evidenceSufficiency.toLowerCase() ?? 'limited'}.{' '}
        {app.state.result?.source ?? 'Источник: demo-состояние; production-рубрика не подключена.'}
      </p>
      <p className="hint">Первый шаг: короткая самостоятельная практика.</p>
      <label htmlFor="goal">
        Цель
        <input id="goal" value={goal} onChange={(event) => setGoal(event.target.value)} />
      </label>
      <div className="actions">
        <button onClick={() => void save()}>Подтвердить цель</button>
        <button className="secondary" onClick={() => setGoal('')}>
          Изменить
        </button>
      </div>
    </section>
  );
}

function RoutePage({ app }: { app: AppModel }) {
  const navigate = useNavigate();
  return (
    <section className="card stack">
      <h1>Ваш маршрут</h1>
      <p className="hint">
        Версия маршрута {app.state.route?.version ?? 1} · цель v{app.state.route?.goalVersion ?? 1}{' '}
        · {app.state.route?.contentMode ?? 'DEMO'}
      </p>
      <article className="route-step">
        <h2>1. {app.state.route?.step.title ?? 'Разобрать основу'}</h2>
        <p>
          Почему этот шаг:{' '}
          {app.state.route?.step.rationale ?? 'нужен короткий проверяемый первый шаг'}.
        </p>
        <p className="hint">
          Предпосылки: нет блокирующих условий · {app.state.route?.step.durationMinutes ?? 15} минут
        </p>
        <button onClick={() => void navigate('/lesson')}>Открыть шаг</button>
      </article>
      <p className="hint">
        Это активный DEMO-маршрут. Реальный каталог и версии контента пока не получены.
      </p>
    </section>
  );
}

function Lesson({ app }: { app: AppModel }) {
  const [answer, setAnswer] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [review, setReview] = useState('');
  const [reviewStatus, setReviewStatus] = useState<'PENDING' | 'READY'>('PENDING');
  const [attemptId, setAttemptId] = useState('');
  const [disputeStatus, setDisputeStatus] = useState('');
  useEffect(() => {
    if (!attemptId || reviewStatus === 'READY' || app.mode !== 'connected') return;
    const refresh = async () => {
      const response = await fetch(`/api/mini-app/attempts/${attemptId}/review`, {
        credentials: 'include',
      });
      if (!response.ok) return;
      const latest = (await response.json()) as {
        status: 'PENDING' | 'READY';
        feedback: string;
      };
      setReviewStatus(latest.status);
      setReview(latest.feedback);
    };
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 2_000);
    return () => window.clearInterval(timer);
  }, [attemptId, reviewStatus, app.mode]);
  const submit = async () => {
    const response = await app.mutate('/api/mini-app/attempts', { answer });
    if (app.mode !== 'connected')
      app.setState((state) => ({
        ...state,
        revision: state.revision + 1,
        attemptCount: state.attemptCount + 1,
      }));
    setSubmitted(true);
    setReview(response?.review?.feedback ?? 'Попытка отправлена на проверку.');
    setReviewStatus(response?.review?.status === 'READY' ? 'READY' : 'PENDING');
    setAttemptId(response?.review?.attemptId ?? '');
  };
  return (
    <section className="card stack">
      <h1>Шаг: основа</h1>
      <p>Материал DEMO: сначала выделите условие и выполните один проверяемый шаг.</p>
      <p>
        <a href="https://dev.max.ru/docs" target="_blank" rel="noreferrer">
          Источник и метод
        </a>
      </p>
      <h2>Практика</h2>
      <p>Решение скрыто до отправки ответа.</p>
      <label htmlFor="attempt">
        Ваш ответ
        <textarea
          id="attempt"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          disabled={submitted}
        />
      </label>
      <p className="hint">
        Файл можно прикрепить, когда серверный scanner доступен. Сейчас upload безопасно отключён.
      </p>
      {submitted ? (
        <>
          <p role="status" className="notice">
            {review}
          </p>
          <h2>{reviewStatus === 'READY' ? 'Проверка' : 'Проверка выполняется'}</h2>
          <p>Критерии DEMO: понятное рассуждение, проверяемый шаг, самостоятельность.</p>
          <div className="actions">
            <button
              onClick={() => {
                setSubmitted(false);
                setAnswer('');
                setAttemptId('');
              }}
            >
              Новая попытка
            </button>
            <button
              className="secondary"
              disabled={!attemptId || reviewStatus !== 'READY' || app.mode !== 'connected'}
              onClick={() =>
                void app
                  .mutate('/api/mini-app/disputes', {
                    attemptId,
                    reason: 'Прошу проверить review повторно',
                  })
                  .then(() => setDisputeStatus('Спор сохранён и ожидает рассмотрения.'))
              }
            >
              Оспорить review
            </button>
            {disputeStatus ? <p role="status">{disputeStatus}</p> : null}
          </div>
        </>
      ) : (
        <button disabled={!answer.trim()} onClick={() => void submit()}>
          Отправить на проверку
        </button>
      )}
    </section>
  );
}

function Progress({ app }: { app: AppModel }) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dataStatus, setDataStatus] = useState('');
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const toggleNotifications = async () => {
    await app.mutate('/api/mini-app/notification-preferences', {
      enabled: !app.state.notificationsEnabled,
    });
    if (app.mode !== 'connected')
      app.setState((state) => ({
        ...state,
        revision: state.revision + 1,
        notificationsEnabled: !state.notificationsEnabled,
      }));
  };
  const exportData = async () => {
    const result = await app.mutate('/api/mini-app/export-requests', {});
    if (result?.id && result.status === 'READY') {
      await app.bridge.download(
        `/api/mini-app/export-requests/${encodeURIComponent(result.id)}/download`,
        `vibework-export-${result.id}.json`,
      );
      setDataStatus('Экспорт готов и передан клиенту MAX для скачивания.');
    }
  };
  const requestDeletion = async () => {
    const result = await app.mutate('/api/mini-app/deletion-requests', {});
    setDataStatus(
      result?.status === 'PENDING_POLICY'
        ? 'Запрос сохранён со статусом PENDING_POLICY.'
        : 'Запрос удаления сохранён.',
    );
    setDeleteOpen(false);
    requestAnimationFrame(() => deleteButtonRef.current?.focus());
  };
  return (
    <section className="card stack">
      <h1>Прогресс и данные</h1>
      <div className="definition">
        <span>Прохождение</span>
        <span>{app.state.attemptCount} попыток</span>
      </div>
      <div className="definition">
        <span>Mastery</span>
        <span className="pill unknown">не подтверждено</span>
      </div>
      <div className="definition">
        <span>Evidence sufficiency</span>
        <span className="pill unknown">limited</span>
      </div>
      <p>Сертификат пока недоступен: сервер не подтвердил выполнение цели.</p>
      <p className="muted">
        Возможности появятся после подтверждённой цели. Сейчас доступных источников нет.
      </p>
      <label>
        <input
          type="checkbox"
          checked={app.state.notificationsEnabled}
          onChange={() => void toggleNotifications()}
        />{' '}
        Уведомления о следующем шаге
      </label>
      <div className="actions">
        <Link to="/problem">Новый запрос</Link>
        <button disabled={app.mode !== 'connected'} onClick={() => void exportData()}>
          Экспортировать данные
        </button>
        <button ref={deleteButtonRef} className="ghost" onClick={() => setDeleteOpen(true)}>
          Удалить данные
        </button>
      </div>
      {deleteOpen ? (
        <section className="notice" role="dialog" aria-modal="true" aria-labelledby="delete-title">
          <h2 id="delete-title">Подтвердите удаление</h2>
          <p>
            Запрос будет сохранён, но останется PENDING_POLICY до утверждения политики хранения.
          </p>
          <button onClick={() => void requestDeletion()}>Создать запрос удаления</button>
          <button
            className="secondary"
            autoFocus
            onClick={() => {
              setDeleteOpen(false);
              requestAnimationFrame(() => deleteButtonRef.current?.focus());
            }}
          >
            Понятно
          </button>
        </section>
      ) : null}
      {dataStatus ? <p role="status">{dataStatus}</p> : null}
    </section>
  );
}

function App() {
  const app = useApp();
  return (
    <Shell app={app}>
      <Routes>
        <Route path="/problem" element={<Problem app={app} />} />
        <Route path="/diagnosis" element={<Diagnosis app={app} />} />
        <Route path="/result" element={<Result app={app} />} />
        <Route path="/route" element={<RoutePage app={app} />} />
        <Route path="/lesson" element={<Lesson app={app} />} />
        <Route path="/progress" element={<Progress app={app} />} />
        <Route path="*" element={<Navigate to="/problem" replace />} />
      </Routes>
    </Shell>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(
  <StrictMode>
    <MaxUI>
      <BrowserRouter>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </BrowserRouter>
    </MaxUI>
  </StrictMode>,
);
