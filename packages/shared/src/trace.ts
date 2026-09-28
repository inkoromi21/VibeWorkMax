import { AsyncLocalStorage } from 'node:async_hooks';
import { asUuid, isUuid, newUuid, type TraceId } from './ids.js';

export interface TraceContext {
  traceId: TraceId;
}

const storage = new AsyncLocalStorage<TraceContext>();

export function normalizeTraceId(candidate?: string): TraceId {
  return candidate && isUuid(candidate) ? asUuid<TraceId>(candidate) : newUuid<TraceId>();
}

export function runWithTrace<T>(context: TraceContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}

export function requireTraceId(): TraceId {
  return currentTrace()?.traceId ?? newUuid<TraceId>();
}
