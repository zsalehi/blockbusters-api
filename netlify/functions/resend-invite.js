// resend-invite.js
const { supabaseAdmin } = require("./_supabaseAdmin")
const { Resend } = require("resend")
const crypto = require("crypto")

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
      if (
        status === 429 ||
        name === "rate_limit_exceeded" ||
        msg.toLowerCase().includes("too many requests")
      ) {
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
    const authHeader = event.headers.authorization || event.headers.Authorization || ""
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
    if (!bearer) return json(401, { error: "Missing bearer token" })

    const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(bearer)
    if (userErr || !userRes?.user) return json(401, { error: "Invalid session" })
    const user = userRes.user

    const body = JSON.parse(event.body || "{}")
    const invitation_id = String(body.invitation_id || "").trim()
    if (!invitation_id) return json(400, { error: "invitation_id is required" })

    // If you have last_sent_at, we can enforce a cooldown.
    // If you don't, this select still works—Supabase will just ignore unknown column? (No; it will error.)
    // So: select it optionally with a safe fallback approach: try the extended select, then fallback.
    let inv = null

    // Attempt select with last_sent_at (if column exists)
    {
      const { data, error } = await supabaseAdmin
        .from("team_invitations")
        .select(
          "id, token, status, invitee_email, team_id, team_member_id, expires_at, created_at, last_sent_at, teams:team_id ( id, name, captain_user_id )"
        )
        .eq("id", invitation_id)
        .single()

      if (!error && data) inv = data
      else {
        // Fallback if last_sent_at doesn't exist
        const { data: data2, error: error2 } = await supabaseAdmin
          .from("team_invitations")
          .select(
            "id, token, status, invitee_email, team_id, team_member_id, expires_at, created_at, teams:team_id ( id, name, captain_user_id )"
          )
          .eq("id", invitation_id)
          .single()

        if (error2 || !data2) return json(404, { error: "Invite not found" })
        inv = data2
      }
    }

    const team = inv.teams
    if (!team) return json(400, { error: "Team not found for invite" })
    if (team.captain_user_id !== user.id) return json(403, { error: "Only the captain can resend invites" })

    // Optional cooldown (default 30 seconds) if last_sent_at exists
    const cooldownSeconds = Number(process.env.INVITE_RESEND_COOLDOWN_SECONDS || 30)
    if (inv.last_sent_at) {
      const last = new Date(inv.last_sent_at).getTime()
      const now = Date.now()
      if (!Number.isNaN(last) && now - last < cooldownSeconds * 1000) {
        const wait = Math.ceil((cooldownSeconds * 1000 - (now - last)) / 1000)
        return json(429, { error: `Please wait ${wait}s before resending again.` })
      }
    }

    // Allow resend for pending OR revoked.
    // If revoked, reopen it with a new token (invalidates old link).
    let tokenToSend = inv.token
    let reopened = false
    const nowIso = new Date().toISOString()

    if (inv.status === "revoked") {
      tokenToSend = crypto.randomBytes(24).toString("hex")
      reopened = true

      const patch = {
        status: "pending",
        token: tokenToSend,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        created_at: nowIso, // treat as re-sent "now"
      }
      // update last_sent_at if column exists
      if (inv.last_sent_at !== undefined) patch.last_sent_at = nowIso

      const { error: reopenErr } = await supabaseAdmin
        .from("team_invitations")
        .update(patch)
        .eq("id", inv.id)

      if (reopenErr) return json(400, { error: reopenErr.message })
    } else if (inv.status === "pending") {
      // just stamp last_sent_at if available
      if (inv.last_sent_at !== undefined) {
        const { error: stampErr } = await supabaseAdmin
          .from("team_invitations")
          .update({ last_sent_at: nowIso })
          .eq("id", inv.id)
        if (stampErr) {
          // not fatal
          console.error("last_sent_at update failed:", stampErr.message)
        }
      }
    } else {
      return json(400, { error: `Invite cannot be resent (status: ${inv.status})` })
    }

    const siteUrl = process.env.SITE_URL || "https://blockbusterstrivia.com"
    const from = process.env.RESEND_FROM || "BlockBusters Trivia <noreply@blockbusterstrivia.com>"
    const link = `${siteUrl}/invite?token=${tokenToSend}`

    const payload = {
      from,
      to: inv.invitee_email,
      subject: `Reminder: join ${team.name}`,
      html: `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto">
          <h2>${reopened ? "You’re invited again" : "Reminder: you’re invited"}</h2>
          <p>You’ve been invited to join <b>${team.name}</b>.</p>
          <p><a href="${link}">Accept Invite</a></p>
          <p style="color:#666">If the button doesn’t work, copy/paste this link:<br/>${link}</p>
        </div>
      `,
    }

    const r = await sendResendWithRetry(payload)
    if (!r.ok) {
      console.error("Resend invite email failed:", {
        to: inv.invitee_email,
        message: r.error?.message || r.error,
        statusCode: r.error?.statusCode || r.error?.status,
        name: r.error?.name,
      })
      // Don’t break the whole flow—tell UI it failed
      return json(502, { error: "Email send failed. Please try again in a moment." })
    }

    return json(200, { ok: true, reopened })
  } catch (e) {
    return json(500, { error: e.message || "Server error" })
  }
}
