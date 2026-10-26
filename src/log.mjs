import pino from 'pino';

const redact = {
  paths: ['authorization', 'cookie', 'headers.authorization', 'headers.cookie', 'session', '*.authorization', '*.cookie'],
  censor: '[REDACTED]',
};

export function createLogger(name, level = process.env.WEB2API_LOG_LEVEL || 'info') {
  return pino({ name, level, redact }, pino.destination(2));
}
