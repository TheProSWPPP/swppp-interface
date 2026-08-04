// One-shot: create the "Project Value" custom LEAD field in Pipedrive.
//
// Why not the built-in Value field: `deal_value` (labelled "Value" in the UI) is already in
// use for Pro SWPPP's own quote amounts — $9,988 / $4,997 / $3,897 / $2,497 / $1,797 across
// 11 leads as of 2026-08-03. Putting a $464M construction budget in the same column would
// make revenue unreadable and there would be no way to tell the two apart.
//
// Note the endpoint: Pipedrive leads share DEAL fields. `/v1/leadFields` is read-only and
// POSTing to it 404s; every existing custom lead field here (Lead Score, Project Stage,
// Lead Origin) is really a deal field, confirmed 2026-08-03.
//
// Monetary, not double: Pipedrive renders monetary as currency, and field_type is IMMUTABLE
// after creation (a PUT changing it returns 200 and silently keeps the old type).
//
// Idempotent: if a field with this name already exists it prints the existing key.
const TOKEN = process.env.PIPEDRIVE_API_TOKEN || "3089d0ffb03a7f996c5f10156fd4ebfaad9fca28";
const NAME = "Project Value";

const list = await (await fetch(`https://api.pipedrive.com/v1/dealFields?api_token=${TOKEN}&limit=500`)).json();
const existing = (list.data || []).find((f) => f.name === NAME);
if (existing) {
  console.log(`ALREADY EXISTS  key=${existing.key}  type=${existing.field_type}`);
  process.exit(0);
}

const res = await fetch(`https://api.pipedrive.com/v1/dealFields?api_token=${TOKEN}&limit=500`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: NAME, field_type: "monetary" }),
});
const body = await res.json();
if (!res.ok || !body.success) {
  console.error("FAILED", res.status, JSON.stringify(body).slice(0, 400));
  process.exit(1);
}
console.log(`CREATED  key=${body.data.key}  type=${body.data.field_type}`);

// Guard: prove we did not disturb the native Value field. It is a LEAD field, so this
// check has to read /leadFields even though the create above went to /dealFields.
const after = await (await fetch(`https://api.pipedrive.com/v1/leadFields?api_token=${TOKEN}`)).json();
const dealValue = (after.data || []).find((f) => f.key === "deal_value");
console.log(`deal_value still present: ${!!dealValue}  label="${dealValue?.name}"`);
