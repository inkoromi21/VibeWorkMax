import { ApplicationError } from './errors.js';

const ALLOWED_FIELDS = new Set(['event', 'occurred_at', 'component', 'result', 'duration_bucket']);
const FORBIDDEN = /(answer|text|content|credential|token|secret|password|initdata|payload)/i;

export type AnalyticsEvent = Record<string, string | number | boolean | null>;

export function validateAnalyticsEvent(event: AnalyticsEvent): AnalyticsEvent {
  for (const key of Object.keys(event)) {
    if (!ALLOWED_FIELDS.has(key) || FORBIDDEN.test(key)) {
      throw new ApplicationError({
        code: 'UNSAFE_ANALYTICS_EVENT',
        message: 'Analytics event contains a forbidden field',
        statusCode: 422,
      });
    }
  }
  return event;
}
