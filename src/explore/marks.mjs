import { WorkflowError } from '../artifact/errors.mjs';

const TOOL = /^[a-z][a-z0-9_]{1,79}$/;
const FIELD = /^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/;
const signatureOf = mark => `${mark.role}\0${mark.tool}\0${JSON.stringify(Object.entries(mark.input).sort())}`;

export function createMarks(recorder, actions) {
  const marks = [];
  let open = null;
  return {
    begin({ tool, input, role, execution = 'http', extract = null }) {
      if (typeof tool !== 'string' || !TOOL.test(tool)) throw new WorkflowError('INVALID_INPUT', 400);
      if (!['train', 'eval'].includes(role)) throw new WorkflowError('INVALID_INPUT', 400);
      if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) throw new WorkflowError('INVALID_INPUT', 400);
      for (const [field, value] of Object.entries(input)) {
        if (!FIELD.test(field)) throw new WorkflowError('INVALID_INPUT', 400);
        if (typeof value !== 'string' || !value.trim() || value.length > 120) throw new WorkflowError('INVALID_INPUT', 400);
      }
      // Retried CLI calls must not record the same demonstration twice.
      const signature = signatureOf({ tool, input, role });
      if (marks.some(mark => signatureOf(mark) === signature)) return { phase: 'begin', tool, role, requests: 0, duplicate: true };
      if (open && signatureOf(open) === signature) return { phase: 'begin', tool, role, requests: 0, duplicate: true };
      if (open) throw new WorkflowError('MARK_ALREADY_OPEN', 409, { tool: open.tool });
      open = { tool, input: { ...input }, role, execution, extract, browser_actions: [], requestCursor: recorder.cursor(), actionCursor: actions.count, started_at: new Date().toISOString() };
      return { phase: 'begin', tool, role, requests: 0 };
    },
    record(action) {
      if (open?.execution === 'browser') {
        if (open.browser_actions.length >= 32) throw new WorkflowError('BUDGET_EXHAUSTED', 429);
        open.browser_actions.push(action);
      }
    },
    end(browser_output) {
      if (!open) return { phase: 'end', ended: false };
      const requests = recorder.since(open.requestCursor);
      if (!requests.length && !open.browser_actions.length) {
        const { tool } = open;
        open = null;
        throw new WorkflowError('EMPTY_MARK', 409, { tool });
      }
      const mark = {
        tool: open.tool, input: open.input, role: open.role, requests,
        actions: actions.count - open.actionCursor, started_at: open.started_at, ended_at: new Date().toISOString(),
        ...(open.execution === 'browser' ? { browser_actions: open.browser_actions, browser_output } : {}),
      };
      marks.push(mark);
      open = null;
      return { phase: 'end', ended: true, tool: mark.tool, role: mark.role, requests: requests.length, actions: mark.actions };
    },
    reset() {
      marks.length = 0;
      open = null;
      return { reset: true };
    },
    list: () => marks,
    open: () => open && { tool: open.tool, input: open.input, role: open.role, execution: open.execution, extract: open.extract,
      requests: recorder.cursor() - open.requestCursor, actions: actions.count - open.actionCursor, started_at: open.started_at },
  };
}
