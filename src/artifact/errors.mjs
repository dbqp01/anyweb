export class WorkflowError extends Error {
  constructor(code, status = 502, details = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

export function parse(schema, value, code = 'INVALID_INPUT') {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new WorkflowError(code, code === 'INVALID_INPUT' ? 400 : 502, { issues: result.error.issues });
  }
  return result.data;
}
