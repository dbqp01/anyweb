// Recognises bot challenges (captcha, WAF interstitials) so the engine stops and hands the page to the person
// instead of reporting a vague failure or retrying into a ban. It never tries to pass a challenge itself.

// Interstitials that replace the whole page, whatever the status.
const INTERSTITIAL = [
  /challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform|<title>\s*(?:just a moment|attention required)/i,
  /captcha-delivery\.com|geo\.captcha-delivery/i, // DataDome
  /px-captcha|_pxCaptcha/i, // PerimeterX / HUMAN
  /_Incapsula_Resource|Request unsuccessful\. Incapsula/i,
  /<title>[^<]*(?:access denied|request blocked|¡alto|no puedes acceder)[^<]*<\/title>/i,
];
// On a blocking status, a captcha widget or a block notice is enough.
const ON_BLOCK = /g-recaptcha|recaptcha\/api|hcaptcha\.com|cf-turnstile|captcha|access denied|¡alto|no puedes acceder|bot detect/i;
const BLOCKING = new Set([403, 405, 429, 503]);

export function isChallenge({ status = 200, headers, html = '' }) {
  if (headers?.get?.('cf-mitigated') === 'challenge') return true;
  const head = html.slice(0, 65536);
  return INTERSTITIAL.some(pattern => pattern.test(head)) || (BLOCKING.has(status) && ON_BLOCK.test(head));
}
