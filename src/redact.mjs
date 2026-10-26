const SECRET = /token|cookie|secret|password|authorization/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SECRET.test(key) ? '[REDACTED]' : redact(child)]));
  return value;
}

export function redactUrl(value) {
  try {
    const url = new URL(value);
    for (const [key, value] of [...url.searchParams.entries()]) {
      // `token=0` is a public embed flag; longer token-like values stay redacted.
      if (SECRET.test(key) && !(key.toLowerCase() === 'token' && /^[0-9]{1,2}$/.test(value))) url.searchParams.set(key, '[REDACTED]');
    }
    return url.href;
  } catch { return value; }
}
