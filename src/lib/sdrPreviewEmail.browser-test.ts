import { previewEmailBody, previewEmailDocument, previewEmailCsp, firstTouchPreview } from './sdrPreviewEmail';

// Run in the native preview browser: import this module and call runEmailPreviewRegressions().
// The fixture never renders or fetches its external URLs.
export function runEmailPreviewRegressions() {
  const checks: string[] = [];
  const check = (name: string, condition: boolean) => {
    if (!condition) throw new Error(name);
    checks.push(name);
  };
  const input = `<html><head><style>.signature{font-family:Georgia;color:#0066cc}</style>
    <meta http-equiv="refresh" content="0;url=https://tracking.invalid"><link rel="stylesheet" href="https://tracking.invalid/style"></head>
    <body class="email" style="line-height:1.6"><p>Hello &amp; thanks,</p><p>Second paragraph.</p>
    <div class="signature">Alex<br>Example Co</div><blockquote>Previous message</blockquote>
    <a href="https://tracking.invalid" target="_blank" onclick="alert(1)">Website</a>
    <svg><a xlink:href="https://tracking.invalid"><text>SVG link</text></a></svg>
    <img src="https://tracking.invalid/pixel" srcset="https://tracking.invalid/pixel 2x" width="1" height="1">
    <script>alert(1)</script><iframe src="https://tracking.invalid"></iframe><form action="https://tracking.invalid"><button>Submit</button></form></body></html>`;
  const clean = previewEmailBody(input);
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  check('preserves head typography styles', !!doc.querySelector('style')?.textContent?.includes('.signature'));
  check('preserves paragraph, signature and quote structure', doc.querySelectorAll('p').length === 2 && !!doc.querySelector('.signature br') && !!doc.querySelector('blockquote'));
  check('preserves decoded message text', doc.body.textContent?.includes('Hello & thanks,') === true);
  check('removes active and refresh content', !doc.querySelector('script,iframe,form,meta,base,link'));
  check('removes HTML and SVG navigation and event attributes', [...doc.querySelectorAll('*')].every(node => [...node.attributes].every(a => a.localName !== 'href' && a.name !== 'target' && !a.name.startsWith('on'))));
  check('removes remote image and responsive source URLs', !doc.querySelector('img[src],img[srcset]'));
  const rendered = new DOMParser().parseFromString(previewEmailDocument(input, 'body{font-size:14px}'), 'text/html');
  check('keeps original body classes and spacing', rendered.body.className === 'email' && rendered.body.style.lineHeight === '1.6');
  check('places restrictive CSP before original email CSS', rendered.head.firstElementChild?.getAttribute('content') === previewEmailCsp && rendered.head.querySelectorAll('style').length === 2);
  check('retains offline embedded image without remote requests', previewEmailBody('<img src="data:image/png;base64,AA=="><img src="/api/sdr/track/open/123">').includes('data:image/png;base64,AA==') && !previewEmailBody('<img src="/api/sdr/track/open/123">').includes('src='));
  const actual = firstTouchPreview('Customer,\n\nScope & pricing <confirmed>\n\nRegards,', '<div>Alex Example</div><div>rep-c@example.test<br>Example Co</div>', false);
  const actualDoc = new DOMParser().parseFromString(actual, 'text/html');
  check('renders actual draft safely with paragraph spacing and assigned signature', actualDoc.body.textContent?.includes('Scope & pricing <confirmed>') === true && actualDoc.querySelectorAll('br').length === 7 && actualDoc.body.textContent?.includes('Alex Example') === true);
  const alreadySigned = firstTouchPreview('Regards,\nAlex Example\nrep-c@example.test\nExample Co', '<div>Alex Example</div><div>rep-c@example.test<br>Example Co</div>', false);
  check('does not duplicate a signature already in the draft', (alreadySigned.match(/Alex Example/g) || []).length === 1);
  check('fills sample fields only in template samples', firstTouchPreview('{First}: {ENV} / {SWPPP}', undefined, true).includes('Matt: EPA / SWPPP') && firstTouchPreview('{First}: {ENV} / {SWPPP}', undefined, false).includes('{First}: {ENV} / {SWPPP}'));
  return checks;
}
