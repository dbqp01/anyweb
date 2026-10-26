import { serve } from './server.mjs';

const site = JSON.parse(__WEB2API_SITE__);
serve(site);
