import { join } from 'node:path';
import { home } from '../../artifact/site.mjs';

export const temuProfileDir = (env = process.env) => join(home(env), 'profiles', 'temu-chrome');
