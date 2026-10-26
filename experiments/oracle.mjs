import { isDeepStrictEqual } from 'node:util';

// Fixed expected outcomes, never inferred from traces or supplied to the recipe compiler.
export const cases = [
  { input: 'Phone Max', expected: { id: 'p3', name: 'Phone Max', price: 800, description: 'Max phone' } },
  { input: 'Tablet Mini', expected: { id: 'p4', name: 'Tablet Mini', price: 450, description: 'Small tablet' } },
  { input: 'Camera Lite', expected: { id: 'p5', name: 'Camera Lite', price: 650, description: 'Travel camera' } },
];
export function verdict(expected, actual) {
  return { passed: isDeepStrictEqual(expected, actual), expected, actual };
}
