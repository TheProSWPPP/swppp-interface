#!/usr/bin/env node
// Seed sdr_users + sdr_mailboxes for Phase 3 SDR interface.
// Idempotent: re-runs upsert by unique constraints (username/email/apollo_mailbox_id).
// Usage:
//   DATABASE_URL=<railway_url> APOLLO_API_KEY=<key> node scripts/seed-sdr.mjs
//
// Pulls live mailbox list from Apollo and links to user by email local-part match
// (dc@proswppp.co -> derek, mh@ -> michael, jg@ -> josie, th@ -> terry).

import pg from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { listEmailAccounts } from "../lib/apolloClient.js";

const USERS = [
  { username: "derek",   email: "dc@proswppp.com", display_name: "Derek Chinners",  role: "admin", mailbox_prefix: "dc" },
  { username: "michael", email: "mh@proswppp.com", display_name: "Michael Hill",    role: "sdr",   mailbox_prefix: "mh" },
  { username: "josie",   email: "jg@proswppp.com", display_name: "Josie Godfrey",   role: "sdr",   mailbox_prefix: "jg" },
  { username: "terry",   email: "th@proswppp.com", display_name: "Terry Harris",    role: "sdr",   mailbox_prefix: "th" },
];

function randomPassword() {
  return crypto.randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 12);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  if (!process.env.APOLLO_API_KEY) throw new Error("APOLLO_API_KEY required");

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  console.log("→ Pulling live mailboxes from Apollo…");
  const mailboxes = await listEmailAccounts();
  console.log(`  found ${mailboxes.length} connected mailbox(es):`, mailboxes.map((m) => m.email));

  console.log("\n→ Upserting sdr_users…");
  const credentials = [];
  for (const u of USERS) {
    const pw = randomPassword();
    const hash = await bcrypt.hash(pw, 10);
    const { rows } = await pool.query(
      `INSERT INTO sdr_users (username, email, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             role = EXCLUDED.role,
             updated_at = NOW()
       RETURNING id, username, (xmax = 0) AS inserted`,
      [u.username, u.email, hash, u.display_name, u.role],
    );
    const inserted = rows[0].inserted;
    if (inserted) {
      console.log(`  ✓ inserted ${u.username} (${u.email}) — password: ${pw}`);
      credentials.push({ username: u.username, email: u.email, password: pw });
    } else {
      console.log(`  · ${u.username} already exists (password unchanged)`);
    }
    u.id = rows[0].id;
  }

  console.log("\n→ Upserting sdr_mailboxes (linking to users by email prefix)…");
  for (const mb of mailboxes) {
    const prefix = mb.email.split("@")[0];
    const owner = USERS.find((u) => u.mailbox_prefix === prefix);
    if (!owner) {
      console.log(`  ⚠ ${mb.email} — no matching user prefix, skipping owner link`);
    }
    const dailyLimit = mb.email_daily_threshold ?? 20;
    const warmupCap = mb.mailwarming_vendor?.max_daily_emails ?? 0;
    const warmupStatus = mb.mailwarming_vendor?.inbox_status === "started" ? "warming" : "pending";

    await pool.query(
      `INSERT INTO sdr_mailboxes (email, display_name, apollo_mailbox_id, owner_user_id,
                                   daily_send_limit, warmup_status, warmup_current_cap, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (email) DO UPDATE
         SET apollo_mailbox_id = EXCLUDED.apollo_mailbox_id,
             owner_user_id = COALESCE(EXCLUDED.owner_user_id, sdr_mailboxes.owner_user_id),
             daily_send_limit = EXCLUDED.daily_send_limit,
             warmup_status = EXCLUDED.warmup_status,
             warmup_current_cap = EXCLUDED.warmup_current_cap,
             updated_at = NOW()`,
      [
        mb.email,
        owner?.display_name ?? mb.email,
        mb.id,
        owner?.id ?? null,
        dailyLimit,
        warmupStatus,
        warmupCap,
        mb.active !== false,
      ],
    );
    console.log(`  ✓ ${mb.email} → owner=${owner?.username ?? "(unlinked)"} apollo_id=${mb.id}`);
  }

  console.log("\n✓ Seed complete.");
  if (credentials.length) {
    console.log("\n=========================================");
    console.log("NEW USER CREDENTIALS — share securely:");
    console.log("=========================================");
    for (const c of credentials) {
      console.log(`  ${c.username.padEnd(10)} ${c.email.padEnd(24)} ${c.password}`);
    }
    console.log("=========================================\n");
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  if (err.data) console.error(err.data);
  process.exit(1);
});
