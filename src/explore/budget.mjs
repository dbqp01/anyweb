import { WorkflowError } from '../artifact/errors.mjs';

export function createBudget({ maxActions = Infinity, maxMinutes = Infinity } = {}) {
  const started = Date.now();
  let actions = 0;
  return {
    spend() {
      const elapsed = Date.now() - started;
      if (actions >= maxActions) throw new WorkflowError('BUDGET_EXHAUSTED', 429, { reason: 'actions', actions, max_actions: maxActions });
      if (elapsed >= maxMinutes * 60000) throw new WorkflowError('BUDGET_EXHAUSTED', 429, { reason: 'minutes', elapsed_ms: elapsed, max_minutes: maxMinutes });
      actions++;
    },
    status: () => ({
      actions, max_actions: Number.isFinite(maxActions) ? maxActions : null,
      max_minutes: Number.isFinite(maxMinutes) ? maxMinutes : null, elapsed_ms: Date.now() - started,
    }),
  };
}
