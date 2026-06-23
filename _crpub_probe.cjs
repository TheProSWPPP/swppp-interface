const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
let cookie = "";
async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Cookie: cookie }, redirect: "manual", signal: AbortSignal.timeout(30000) });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const loc = r.headers.get("location");
  return { status: r.status, loc, html: await r.text() };
}
function strip(h) { return h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " "); }

(async () => {
  const CN = "CN605629153"; // SOMMER AHRENS / Midland
  // 1) search form
  let r = await get("https://www15.tceq.texas.gov/crpub/index.cfm?fuseaction=cust.newSearch");
  console.log("[newSearch]", r.status, "cookie set:", !!cookie);
  // dump input field names
  const inputs = [...r.html.matchAll(/<input[^>]*name="([^"]+)"[^>]*>/gi)].map(m => m[1]);
  const selects = [...r.html.matchAll(/<select[^>]*name="([^"]+)"[^>]*>/gi)].map(m => m[1]);
  console.log("inputs:", [...new Set(inputs)]);
  console.log("selects:", [...new Set(selects)]);
  const action = (r.html.match(/<form[^>]*action="([^"]+)"/i) || [])[1];
  console.log("form action:", action);

  // 2) try search by CN via GET
  const tries = [
    `https://www15.tceq.texas.gov/crpub/index.cfm?fuseaction=cust.CustSearch&pgFlag=showSearch&cust_id_arg=${CN}`,
    `https://www15.tceq.texas.gov/crpub/index.cfm?fuseaction=cust.CustSearch&customerIDNumber=${CN}`,
    `https://www15.tceq.texas.gov/crpub/index.cfm?fuseaction=cust.CustSearch&cnNumber=${CN}`,
  ];
  for (const u of tries) {
    r = await get(u);
    const hasResult = /CN\d/.test(r.html);
    console.log(`\n[search ${u.split("&").slice(1).join("&")}] status=${r.status} loc=${r.loc||"-"} len=${r.html.length} hasCN=${hasResult} phoneWord=${/phone/i.test(r.html)}`);
    const links = [...new Set([...r.html.matchAll(/index\.cfm\?fuseaction=cust\.[^"'>\s]+/gi)].map(m => m[0]))].slice(0, 6);
    if (links.length) console.log("  cust links:", links);
  }
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
