import pino, { type DestinationStream, type Logger } from 'pino';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.x-max-bot-api-secret',
  'req.headers.cookie',
  'req.body',
  'request.body',
  'token',
  'accessToken',
  'refreshToken',
  'credentials',
  'secret',
  'password',
  'initData',
  'diagnostics',
  'raw_text',
  'text',
  'payload',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.credentials',
  '*.secret',
  '*.password',
  '*.initData',
  '*.diagnostics',
  '*.raw_text',
  '*.text',
  '*.payload',
  'job.data.payload',
  'outbox.payload',
];

export function createLogger(destination?: DestinationStream): Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: { paths: redactPaths, censor: '[REDACTED]' },
      base: null,
      serializers: {
        err: (error: Error) => ({ name: error.name, message: 'internal failure' }),
      },
    },
    destination,
  );
}
