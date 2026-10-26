import { WorkflowError } from '../artifact/errors.mjs';

// Capture stable selectors, never Playwright's snapshot-local refs or arbitrary page scripts.
export async function describeLocator(locator) {
  const description = await locator.evaluate(element => {
    if (element.matches('input[type="password"], input[type="file"]')) return null;
    const attr = name => element.getAttribute(name);
    if (attr('data-testid')) return { kind: 'css', value: `[data-testid=${JSON.stringify(attr('data-testid'))}]` };
    if (element.id) return { kind: 'css', value: `[id=${JSON.stringify(element.id)}]` };
    const label = attr('aria-label') || element.labels?.[0]?.textContent?.trim();
    if (label) return { kind: 'label', name: label };
    const role = attr('role') || ({ BUTTON: 'button', A: 'link' })[element.tagName];
    const name = element.textContent?.replace(/\s+/g, ' ').trim();
    if (role && name) return { kind: 'role', role, name };
    return null;
  });
  if (!description) throw new WorkflowError('BROWSER_SELECTOR_REQUIRED', 422, { detail: 'Use an element with a stable id, test id, label or accessible button/link name' });
  return description;
}
