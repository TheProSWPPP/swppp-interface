// The read-only live preview must not open tracking pixels or other remote resources.
export const previewEmailCsp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; form-action 'none'; base-uri 'none'";
export function previewEmailBody(html: string): string {
 const doc = new DOMParser().parseFromString(html, 'text/html');
 sanitize(doc);
 return [...doc.head.querySelectorAll('style')].map(node => node.outerHTML).join('') + doc.body.innerHTML;
}

function sanitize(doc: Document) {
 doc.querySelectorAll('meta,base,script,link,iframe,object,embed,form,audio,video,source').forEach(node => node.remove());
 doc.querySelectorAll('*').forEach(node => {
  for (const attribute of Array.from(node.attributes)) {
   const name = attribute.localName.toLowerCase();
   if (name === 'href' || name === 'target' || name.startsWith('on') || name === 'srcset' || (name === 'src' && !attribute.value.startsWith('data:image/'))) node.removeAttributeNode(attribute);
  }
 });
}

// Preserve the original body attributes and head styles inside the sandbox, after the
// preview's CSP and defaults. CSP blocks CSS imports/background URLs as well as pixels.
export function previewEmailDocument(html: string, defaultStyle: string): string {
 const doc = new DOMParser().parseFromString(html, 'text/html');
 sanitize(doc);
 const csp = doc.createElement('meta');
 csp.httpEquiv = 'Content-Security-Policy';
 csp.content = previewEmailCsp;
 const style = doc.createElement('style');
 style.textContent = defaultStyle;
 doc.head.prepend(csp, style);
 return '<!doctype html>' + doc.documentElement.outerHTML;
}

// Templates fill sample fields; actual queue/timeline drafts keep their saved text.
// Apollo adds the assigned sender signature to the outgoing first-touch email.
export function firstTouchPreview(body: string, signatureHtml?: string, fillSample = true): string {
  const filled = (fillSample ? (body || "")
    .replace(/\{First\}/g, "Matt")
    .replace(/\{ENV\}/g, "EPA")
    .replace(/\{SWPPP\}/g, "SWPPP") : body || "")
    .replace(/\s*\{Sig\}/g, "");
  const esc = filled.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const bodyHtml = esc.replace(/\n/g, "<br>");
  const sig = (signatureHtml || "").trim();
  const signatureText = sig ? new DOMParser().parseFromString(sig.replace(/<br\s*\/?\s*>|<\/(?:div|p)>/gi, " "), "text/html").body.textContent?.replace(/\s+/g, " ").trim() : "";
  const includesSignature = !!signatureText && filled.replace(/\s+/g, " ").includes(signatureText);
  return `<div style="font-family:Georgia,'Times New Roman',serif;color:#1a5276;font-size:15px;line-height:1.55">${bodyHtml}${sig && !includesSignature ? `<br><br>${sig}` : ""}</div>`;
}
