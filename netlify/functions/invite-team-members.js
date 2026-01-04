// invite-team-members.js
const { createClient } = require("@supabase/supabase-js")
const { Resend } = require("resend")
const crypto = require("crypto")

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const resend = new Resend(process.env.RESEND_API_KEY)

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  }
}

function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase()
}

function isValidDOB(dob) {
  if (!dob) return false
  const dt = new Date(dob)
  if (Number.isNaN(dt.getTime())) return false
  return dt < new Date()
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// Resend: 2 req/sec limit. We pace and retry on 429.
async function sendResendWithRetry(payload, opts = {}) {
  const {
    maxAttempts = 5,
    baseDelayMs = 650, // ~1.5 req/sec pacing (safe under 2/sec)
    jitterMs = 150,
  } = opts

  let attempt = 0
  while (attempt < maxAttempts) {
    attempt++
    try {
      // Gentle pacing BEFORE every attempt to avoid bursts
      await sleep(baseDelayMs + Math.floor(Math.random() * jitterMs))

      const res = await resend.emails.send(payload)
      return { ok: true, res }
    } catch (err) {
      const status = err?.statusCode || err?.status || null
      const name = err?.name || ""
      const msg = String(err?.message || "")

      // Retry on Resend rate limits (429)
      if (status === 429 || name === "rate_limit_exceeded" || msg.toLowerCase().includes("too many requests")) {
        const backoff = Math.min(4000, baseDelayMs * Math.pow(2, attempt - 1))
        await sleep(backoff + Math.floor(Math.random() * jitterMs))
        continue
      }

      // Non-retryable error
      return { ok: false, error: err }
    }
  }

  return { ok: false, error: new Error("Resend rate limit: max retries exceeded") }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true })
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" })

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null
    if (!bearer) return json(401, { error: "Missing bearer token" })

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(bearer)
    if (userErr || !userData?.user) return json(401, { error: "Invalid session" })

    const user = userData.user
    const captainEmail = normalizeEmail(user.email)

    const body = JSON.parse(event.body || "{}")
    const team_id = String(body.team_id || "").trim()
    const members = Array.isArray(body.members) ? body.members : []

    if (!team_id) return json(400, { error: "team_id is required" })
    if (!members.length) return json(400, { error: "members[] is required" })

    const { data: team, error: teamErr } = await supabaseAdmin
      .from("teams")
      .select("id, name, competition_id, captain_user_id")
      .eq("id", team_id)
      .single()

    if (teamErr || !team) return json(404, { error: "Team not found" })
    if (team.captain_user_id !== user.id) return json(403, { error: "Only the captain can invite" })

    // Size cap
    const { count, error: countErr } = await supabaseAdmin
      .from("team_members")
      .select("*", { count: "exact", head: true })
      .eq("team_id", team_id)

    if (countErr) return json(400, { error: countErr.message })

    const currentSize = count || 0
    const remainingSlots = Math.max(0, 4 - currentSize)
    if (remainingSlots <= 0) return json(400, { error: "Team is already full (max 4)." })
    if (members.length > remainingSlots) return json(400, { error: `Only ${remainingSlots} slot(s) left.` })

    // Clean + validate
    const cleaned = members.map((m) => ({
      full_name: String(m.full_name || "").trim(),
      date_of_birth: String(m.date_of_birth || "").trim(),
      email: normalizeEmail(m.email),
      handle: String(m.handle || "").trim(),
      phone: String(m.phone || "").trim(),
    }))

    for (let i = 0; i < cleaned.length; i++) {
      const r = cleaned[i]
      if (!r.full_name) return json(400, { error: `Member ${i + 1}: full_name is required.` })
      if (!isValidDOB(r.date_of_birth)) return json(400, { error: `Member ${i + 1}: valid date_of_birth is required.` })
    }

    // Prevent duplicates by email already on roster (for provided emails)
    const emails = cleaned.map((r) => r.email).filter(Boolean)
    if (emails.length) {
      const { data: existingEmails, error: exErr } = await supabaseAdmin
        .from("team_members")
        .select("member_email")
        .eq("team_id", team_id)
        .in("member_email", emails)

      if (exErr) return json(400, { error: exErr.message })
      if (existingEmails && existingEmails.length) {
        return json(400, { error: "One or more emails are already on the roster for this team." })
      }
    }

    const nowIso = new Date().toISOString()

    // Insert roster rows
    const rosterRows = cleaned.map((m) => ({
      team_id,
      user_id: null,
      role: "member",
      full_name: m.full_name,
      date_of_birth: m.date_of_birth,
      handle: m.handle || null,
      phone: m.phone || null,
      member_email: m.email || null,
      created_at: nowIso,
    }))

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("team_members")
      .insert(rosterRows)
      .select("id, member_email")

    if (insErr) return json(400, { error: insErr.message })

    // Load existing invites (avoid duplicate pending invites)
    const { data: existingInvites, error: invErr } = await supabaseAdmin
      .from("team_invitations")
      .select("invitee_email, status")
      .eq("team_id", team_id)

    if (invErr) return json(400, { error: invErr.message })

    const pendingSet = new Set(
      (existingInvites || [])
        .filter((i) => i.status === "pending")
        .map((i) => normalizeEmail(i.invitee_email))
        .filter(Boolean)
    )

    // Build invite targets with deterministic team_member_id linkage
    const inviteTargets = (inserted || [])
      .map((r) => ({
        team_member_id: r.id,
        email: normalizeEmail(r.member_email),
      }))
      .filter((x) => !!x.email)
      .filter((x) => !pendingSet.has(x.email))

    let invites = []
    if (inviteTargets.length) {
      const inviteRows = inviteTargets.map((t) => ({
        team_id,
        competition_id: team.competition_id, // source of truth = team
        invitee_email: t.email,
        status: "pending",
        token: crypto.randomBytes(24).toString("hex"),
        inviter_user_id: user.id,
        team_member_id: t.team_member_id, // ✅ deterministic linking later
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        created_at: nowIso,
      }))

      const { data: invInserted, error: invInsErr } = await supabaseAdmin
        .from("team_invitations")
        .insert(inviteRows)
        .select("invitee_email, token")

      if (invInsErr) return json(400, { error: invInsErr.message })
      invites = invInserted || []
    }

    // Send emails (best-effort, rate-limited)
    const siteUrl = process.env.SITE_URL || "https://blockbusterstrivia.com"
    const from = process.env.RESEND_FROM || "BlockBusters Trivia <noreply@blockbusterstrivia.com>"

    let email_attempted = 0
    let email_sent = 0
    let email_failed = 0

    for (const row of invites) {
      email_attempted++
      const link = `${siteUrl}/invite?token=${row.token}`

      const payload = {
        from,
        to: row.invitee_email,
        subject: `You’re invited to join ${team.name}`,
        html: `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto">
            <h2>You’re invited</h2>
            <p><b>${captainEmail || "A team captain"}</b> invited you to join <b>${team.name}</b>.</p>
            <p><a href="${link}">Accept Invite</a></p>
            <p style="color:#666">If the button doesn’t work, copy/paste this link:<br/>${link}</p>
          </div>
        `,
      }

      const r = await sendResendWithRetry(payload)
      if (r.ok) email_sent++
      else {
        email_failed++
        console.error("Invite email failed:", {
          to: row.invitee_email,
          message: r.error?.message || r.error,
          statusCode: r.error?.statusCode || r.error?.status,
          name: r.error?.name,
        })
      }
    }

    return json(200, {
      ok: true,
      inserted_count: (inserted || []).length,
      invites_count: invites.length,
      email_attempted,
      email_sent,
      email_failed,
    })
  } catch (e) {
    return json(500, { error: e.message || "Server error" })
  }
}
