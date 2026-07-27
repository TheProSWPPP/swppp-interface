// SDR team administration — the missing onboarding path.
//
// Before this module the ONLY way to create an `sdr_users` row was to edit the
// hardcoded 4-person array in `scripts/seed-sdr.mjs` and re-run it by hand with
// DATABASE_URL + APOLLO_API_KEY in the environment. Likewise `sdr_mailboxes`
// rows could only appear via `POST /api/sdr/mailboxes/sync` (which pulls from
// Apollo and never sets owner_user_id / pipedrive_sender_id / permit_daily_cap).
// Those three columns had zero runtime writers anywhere in the codebase.
//
// registerSdrTeamRoutes(app, pool) adds, all admin-only:
//   GET    /api/sdr/admin/users             list every user (incl. inactive)
//   POST   /api/sdr/admin/users             create a user (bcrypt password)
//   PATCH  /api/sdr/admin/users/:id         edit display_name/email/role/active/password
//   DELETE /api/sdr/admin/users/:id         guarded un-do for a mis-typed row
//   POST   /api/sdr/admin/mailboxes         create a mailbox row, inactive by default
//   DELETE /api/sdr/admin/mailboxes/:id     guarded un-do for a mis-typed row
//
// Deliberately NOT here: a permit_enabled toggle. `PATCH /api/permits/mailboxes/:id`
// (lib/permitRoutes.js) already owns that switch; duplicating it would create a
// second surface that can drift. This module only accepts permit_enabled as a
// creation-time default (false unless explicitly asked for).
//
// Onboarding order that actually works (verified against server.js:2159-2198):
//   1. POST /api/sdr/admin/users             → the person can log in
//   2. POST /api/sdr/admin/mailboxes         → active:false, permit_enabled:false
//        (`oauth/start` 403s on any mailbox not already visible in sdr_mailboxes,
//         so the row has to exist BEFORE consent even though the callback itself
//         upserts sdr_inbox_accounts by local-part without checking this table)
//   3. GET /api/sdr/inbox/oauth/start?mailbox=<email> → Google consent → callback
//   4. PATCH /api/sdr/mailboxes/:id          → set owner_user_id / pipedrive_sender_id
//                                              / permit_daily_cap, then active:true
//   5. PATCH /api/permits/mailboxes/:id      → permit_enabled:true, if they send permits
//
// Note: a 5th sender still needs a Pipedrive `Launch_Sequence` dropdown option and
// matching entries in SENDER_BY_OPTION_ID (lib/sdrDraftGenerator.js) +
// PIPEDRIVE_LAUNCH_SENDER_IDS (src/lib/pipedriveFields.ts). That is a code change
// gated on a Pipedrive change and is out of this module's reach by design.

import bcrypt from "bcryptjs";
import crypto from "crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(["sdr", "admin"]);
const BCRYPT_ROUNDS = 10; // same cost factor scripts/seed-sdr.mjs uses ($2b$10$)
const MIN_PASSWORD_LEN = 8;

// Same generator as scripts/seed-sdr.mjs:22 — 12 URL-safe chars.
function randomPassword() {
  return crypto.randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 12);
}

function isAdmin(req) {
  return req.sdrUser?.role === "admin";
}

function audit(pool, req, action, targetKind, targetId, summary) {
  return pool
    .query(
      `INSERT INTO nurture_audit (sdr_user, action, target_kind, target_id, summary)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.sdrUser?.username || req.sdrUser?.sub || null, action, targetKind, targetId, summary],
    )
    .catch(() => {});
}

const USER_COLS = `id, username, email, display_name, role, active, last_login_at, created_at, updated_at,
                   (password_hash IS NOT NULL AND password_hash <> '') AS has_password`;

export function registerSdrTeamRoutes(app, pool) {
  // ---------------------------------------------------------------- users

  // Full roster, including inactive users (unlike /api/sdr/auth/users which is
  // the active-only login picker). Never returns password_hash.
  app.get("/api/sdr/admin/users", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    if (!isAdmin(req)) return res.status(403).json({ error: "Admin only" });
    try {
      const { rows } = await pool.query(
        `SELECT ${USER_COLS},
                (SELECT coalesce(json_agg(json_build_object(
                          'id', m.id, 'email', m.email, 'active', m.active,
                          'permit_enabled', m.permit_enabled,
                          'pipedrive_sender_id', m.pipedrive_sender_id,
                          'permit_daily_cap', m.permit_daily_cap) ORDER BY m.email), '[]'::json)
                   FROM sdr_mailboxes m WHERE m.owner_user_id = u.id) AS mailboxes
           FROM sdr_users u
          ORDER BY role DESC, username`,
      );
      res.json({ users: rows, require_password: sdrPasswordRequired() });
    } catch (err) {
      console.error("GET /api/sdr/admin/users error:", err);
      res.status(500).json({ error: "Failed to list users" });
    }
  });

  // Create a user. Mirrors scripts/seed-sdr.mjs's hashing exactly:
  // bcrypt.hash(plaintext, 10). If no password is supplied we generate one and
  // return it ONCE in the response (the only time it is ever visible).
  app.post("/api/sdr/admin/users", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    if (!isAdmin(req)) return res.status(403).json({ error: "Admin only" });

    const body = req.body || {};
    const username = String(body.username || "").trim().toLowerCase();
    const email = String(body.email || "").trim().toLowerCase();
    const displayName = body.display_name == null ? null : String(body.display_name).trim() || null;
    const role = String(body.role || "sdr").trim().toLowerCase();
    const active = body.active === undefined ? true : body.active === true || body.active === "true";

    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: "username required — 2-32 chars, letters/digits/._- and must start alphanumeric" });
    }
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "valid email required" });
    if (!ROLES.has(role)) return res.status(400).json({ error: "role must be 'sdr' or 'admin'" });

    let plaintext = null;
    let generated = false;
    if (body.password === undefined || body.password === null || body.password === "") {
      plaintext = randomPassword();
      generated = true;
    } else {
      plaintext = String(body.password);
      if (plaintext.length < MIN_PASSWORD_LEN) {
        return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
      }
    }

    try {
      const hash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
      const { rows } = await pool.query(
        `INSERT INTO sdr_users (username, email, password_hash, display_name, role, active)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${USER_COLS}`,
        [username, email, hash, displayName, role, active],
      );
      const user = rows[0];
      await audit(pool, req, "team.user.create", "sdr_user", user.id, `${username} (${role}, ${active ? "active" : "inactive"})`);
      // The mailbox local-part must match the user's email local-part or the
      // inbox will be invisible to them (visibleMailboxes, server.js:2126-2139).
      res.status(201).json({
        user,
        generated_password: generated ? plaintext : undefined,
        next_steps: [
          `Create their mailbox row: POST /api/sdr/admin/mailboxes { email: "${username === "" ? "<local>" : email.split("@")[0]}@proswppp.co", owner_user_id: "${user.id}", active: false }`,
          "Send them through Gmail consent: GET /api/sdr/inbox/oauth/start?mailbox=<that email>",
          "Then PATCH /api/sdr/mailboxes/:id to set pipedrive_sender_id + permit_daily_cap and flip active:true",
        ],
      });
    } catch (err) {
      if (err.code === "23505") {
        const which = /username/.test(err.detail || "") ? "username" : "email";
        return res.status(409).json({ error: `That ${which} is already taken` });
      }
      if (err.code === "23514") return res.status(400).json({ error: "Value rejected by a database constraint" });
      console.error("POST /api/sdr/admin/users error:", err);
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  // Edit a user. This is also the ONLY way to set a password on the four
  // pre-existing users, whose password_hash was written by seed-sdr.mjs from a
  // random string that was printed once and never stored. Nobody knows those
  // passwords, so every existing user must be PATCHed here before
  // REQUIRE_PASSWORD is ever switched on.
  app.patch("/api/sdr/admin/users/:id", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    if (!isAdmin(req)) return res.status(403).json({ error: "Admin only" });
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid user id — must be a UUID" });

    const body = req.body || {};
    const sets = [];
    const params = [];
    const changed = [];

    if (body.display_name !== undefined) {
      params.push(body.display_name == null ? null : String(body.display_name).trim() || null);
      sets.push(`display_name = $${params.length}`);
      changed.push("display_name");
    }
    if (body.email !== undefined) {
      const email = String(body.email).trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "valid email required" });
      params.push(email);
      sets.push(`email = $${params.length}`);
      changed.push("email");
    }
    if (body.role !== undefined) {
      const role = String(body.role).trim().toLowerCase();
      if (!ROLES.has(role)) return res.status(400).json({ error: "role must be 'sdr' or 'admin'" });
      params.push(role);
      sets.push(`role = $${params.length}`);
      changed.push("role");
    }
    if (body.active !== undefined) {
      if (typeof body.active !== "boolean") return res.status(400).json({ error: "active must be a boolean" });
      params.push(body.active);
      sets.push(`active = $${params.length}`);
      changed.push(`active=${body.active}`);
    }

    let generated = null;
    if (body.password !== undefined || body.generate_password === true) {
      let plaintext;
      if (body.generate_password === true && (body.password === undefined || body.password === null || body.password === "")) {
        plaintext = randomPassword();
        generated = plaintext;
      } else {
        plaintext = String(body.password);
        if (plaintext.length < MIN_PASSWORD_LEN) {
          return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
        }
      }
      const hash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
      params.push(hash);
      sets.push(`password_hash = $${params.length}`);
      changed.push("password");
    }

    if (!sets.length) {
      return res.status(400).json({
        error: "Nothing to update — supply display_name, email, role, active, password, or generate_password",
      });
    }

    // Never let an admin demote/deactivate the last remaining active admin —
    // that would leave the tool with no one who can administer it.
    if (body.role === "sdr" || body.active === false) {
      const { rows: adm } = await pool.query(
        `SELECT count(*)::int AS n FROM sdr_users WHERE role = 'admin' AND active = TRUE AND id <> $1`,
        [req.params.id],
      );
      const { rows: cur } = await pool.query(`SELECT role, active FROM sdr_users WHERE id = $1`, [req.params.id]);
      if (cur[0]?.role === "admin" && cur[0]?.active && adm[0].n === 0) {
        return res.status(409).json({ error: "Refusing to remove the last active admin" });
      }
    }

    try {
      params.push(req.params.id);
      const { rows } = await pool.query(
        `UPDATE sdr_users SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${params.length} RETURNING ${USER_COLS}`,
        params,
      );
      if (!rows[0]) return res.status(404).json({ error: "User not found" });
      await audit(pool, req, "team.user.update", "sdr_user", req.params.id, changed.join(", "));
      res.json({ user: rows[0], generated_password: generated || undefined });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "That email is already taken" });
      console.error("PATCH /api/sdr/admin/users/:id error:", err);
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  // Un-do for a mis-typed onboarding row. Heavily guarded: this is NOT an
  // offboarding tool — to remove a real person, set active:false instead, which
  // preserves their history. Deactivation is the reversible action; deletion is
  // only allowed while the row is still inert.
  app.delete("/api/sdr/admin/users/:id", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    if (!isAdmin(req)) return res.status(403).json({ error: "Admin only" });
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid user id — must be a UUID" });
    if (req.params.id === req.sdrUser?.sub) return res.status(409).json({ error: "You cannot delete your own account" });
    try {
      const { rows } = await pool.query(
        `SELECT id, username, role, active, last_login_at,
                (SELECT count(*)::int FROM sdr_mailboxes m WHERE m.owner_user_id = sdr_users.id) AS mailbox_count
           FROM sdr_users WHERE id = $1`,
        [req.params.id],
      );
      const u = rows[0];
      if (!u) return res.status(404).json({ error: "User not found" });
      if (u.last_login_at) {
        return res.status(409).json({ error: "This user has signed in before — deactivate them instead of deleting (keeps their history)" });
      }
      if (u.mailbox_count > 0) {
        return res.status(409).json({ error: "Unassign their mailbox(es) first (PATCH the mailbox owner_user_id)" });
      }
      const linked = await pool.query(
        `SELECT (SELECT count(*)::int FROM sdr_inbox_accounts WHERE owner_user_id = $1
                    OR connected_by_user_id = $1) AS inbox_links`,
        [req.params.id],
      );
      if (linked.rows[0].inbox_links > 0) {
        return res.status(409).json({ error: "This user has a connected inbox — deactivate them instead" });
      }
      await pool.query(`DELETE FROM sdr_users WHERE id = $1`, [req.params.id]);
      await audit(pool, req, "team.user.delete", "sdr_user", req.params.id, `${u.username} (never signed in)`);
      res.json({ deleted: true, user: { id: u.id, username: u.username } });
    } catch (err) {
      console.error("DELETE /api/sdr/admin/users/:id error:", err);
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  // ------------------------------------------------------------- mailboxes

  // Create an sdr_mailboxes row up front, INACTIVE by default, so a person can
  // be onboarded with sending switched off. `POST /api/sdr/mailboxes/sync` can
  // only mirror what Apollo already knows about and never sets ownership; this
  // route is the deliberate, ownership-aware alternative.
  app.post("/api/sdr/admin/mailboxes", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    if (!isAdmin(req)) return res.status(403).json({ error: "Admin only" });

    const body = req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "valid email required" });

    const displayName = body.display_name == null ? null : String(body.display_name).trim() || null;
    const apolloId = body.apollo_mailbox_id ? String(body.apollo_mailbox_id).trim() : null;

    let ownerUserId = null;
    if (body.owner_user_id) {
      ownerUserId = String(body.owner_user_id);
      if (!UUID_RE.test(ownerUserId)) return res.status(400).json({ error: "owner_user_id must be a UUID" });
    }

    const nums = {};
    for (const [key, min, max] of [["pipedrive_sender_id", 1, 2147483647], ["daily_send_limit", 0, 500], ["permit_daily_cap", 0, 500]]) {
      if (body[key] === undefined || body[key] === null || body[key] === "") { nums[key] = null; continue; }
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < min || n > max) {
        return res.status(400).json({ error: `${key} must be an integer between ${min} and ${max}` });
      }
      nums[key] = n;
    }

    // Both default OFF. Onboarding must never start a mailbox sending by accident.
    const active = body.active === true;
    const permitEnabled = body.permit_enabled === true;

    try {
      if (ownerUserId) {
        const { rows: ow } = await pool.query(`SELECT id, email FROM sdr_users WHERE id = $1`, [ownerUserId]);
        if (!ow[0]) return res.status(400).json({ error: "owner_user_id does not match any user" });
        // Inbox visibility (server.js:2126-2139) matches on email local-part, not
        // owner_user_id, so a mismatch silently hides the inbox from its owner.
        if (ow[0].email.split("@")[0] !== email.split("@")[0]) {
          return res.status(400).json({
            error: `Local-part mismatch: mailbox "${email}" would be invisible to ${ow[0].email} (inbox visibility matches on the part before the @). Fix the user's email or the mailbox address.`,
          });
        }
      }
      const { rows } = await pool.query(
        `INSERT INTO sdr_mailboxes (email, display_name, apollo_mailbox_id, owner_user_id, pipedrive_sender_id,
                                    daily_send_limit, permit_daily_cap, active, permit_enabled)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 20), $7, $8, $9)
         RETURNING id, email, display_name, apollo_mailbox_id, owner_user_id, pipedrive_sender_id,
                   daily_send_limit, permit_daily_cap, warmup_status, warmup_current_cap,
                   active, permit_enabled, created_at, updated_at`,
        [email, displayName, apolloId, ownerUserId, nums.pipedrive_sender_id,
         nums.daily_send_limit, nums.permit_daily_cap, active, permitEnabled],
      );
      const mb = rows[0];
      await audit(pool, req, "team.mailbox.create", "sdr_mailbox", mb.id, `${email} (${active ? "ACTIVE" : "inactive"})`);
      res.status(201).json({
        mailbox: mb,
        next_steps: [
          `Send the owner through Gmail consent: GET /api/sdr/inbox/oauth/start?mailbox=${encodeURIComponent(email)}`,
          "When they're ready to send: PATCH /api/sdr/mailboxes/:id { active: true }",
          "For permit outreach: PATCH /api/permits/mailboxes/:id { permit_enabled: true }",
        ],
      });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "A mailbox with that email (or Apollo id) already exists" });
      if (err.code === "23503") return res.status(400).json({ error: "owner_user_id does not match any user" });
      console.error("POST /api/sdr/admin/mailboxes error:", err);
      res.status(500).json({ error: "Failed to create mailbox" });
    }
  });

  // Un-do for a mis-typed mailbox row. Refuses anything that is live or has sent.
  app.delete("/api/sdr/admin/mailboxes/:id", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    if (!isAdmin(req)) return res.status(403).json({ error: "Admin only" });
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid mailbox id — must be a UUID" });
    try {
      const { rows } = await pool.query(
        `SELECT id, email, active,
                (SELECT count(*)::int FROM sdr_sends s WHERE s.mailbox_id = sdr_mailboxes.id) AS send_count
           FROM sdr_mailboxes WHERE id = $1`,
        [req.params.id],
      );
      const mb = rows[0];
      if (!mb) return res.status(404).json({ error: "Mailbox not found" });
      if (mb.active) return res.status(409).json({ error: "Deactivate the mailbox first (PATCH { active: false })" });
      if (mb.send_count > 0) {
        return res.status(409).json({ error: `This mailbox has ${mb.send_count} send(s) on record — deactivate it instead of deleting` });
      }
      await pool.query(`DELETE FROM sdr_mailboxes WHERE id = $1`, [req.params.id]);
      await audit(pool, req, "team.mailbox.delete", "sdr_mailbox", req.params.id, `${mb.email} (never sent)`);
      res.json({ deleted: true, mailbox: { id: mb.id, email: mb.email } });
    } catch (err) {
      console.error("DELETE /api/sdr/admin/mailboxes/:id error:", err);
      res.status(500).json({ error: "Failed to delete mailbox" });
    }
  });
}

// Single source of truth for the password-enforcement flag. Anything other than
// an explicit truthy string leaves enforcement OFF, which is today's behaviour.
// Exported so the login route, the admin roster and the tests all read the same
// value rather than each re-parsing process.env.
export function sdrPasswordRequired() {
  return /^(1|true|yes|on)$/i.test(String(process.env.REQUIRE_PASSWORD || "").trim());
}
