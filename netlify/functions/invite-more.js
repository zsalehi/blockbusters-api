const crypto = require("crypto")
const { supabaseAdmin } = require("./_supabaseAdmin")
const { Resend } = require("resend")

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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true })
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" })

  const authHeader = event.headers.authorization || event.headers.Authorization || ""
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
  if (!bearer) return json(401, { error: "Missing bearer token" })

  const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(bearer)
  if (userErr || !userRes?.user) return json(401, { error: "Invalid session" })
  const user = userRes.user

  const body = JSON.parse(event.body || "{}")
  const team_id = String(body.team_id || "").trim()
  const emails = Array.isArray(body.emails) ? body.emails : []

  if (!team_id) return json(400, { error: "team_id is required" })
  if (!emails.length) return json(400, { error: "emails is required" })

  const normalized = Array.from(
    new Set(
      emails
        .map((e) => String(e || "").trim().toLowerCase())
        .filter(Boolean)
    )
  )

  // Load team (need competition_id + captain)
  const { data: team, error: teamErr } = await supabaseAdmin
    .from("teams")
    .select("id, name, competition_id, captain_user_id")
    .eq("id", team_id)
    .single()

  if (teamErr || !team) return json(404, { error: "Team not found" })
  if (team.captain_user_id !== user.id) return json(403, { error: "Only the captain can invite" })

  // Team size cap (max 4)
  const { count, error: countErr } = await supabaseAdmin
    .from("team_members")
    .select("*", { count: "exact", head: true })
    .eq("team_id", team_id)

  if (countErr) return json(400, { error: countErr.message })
  const currentSize = count || 0
  const remainingSlots = Math.max(0, 4 - currentSize)
  if (remainingSlots <= 0) return json(400, { error: "Team is already full (max 4)." })
  if (normalized.length > remainingSlots) return json(400, { error: `Only ${remainingSlots} slot(s) left.` })

  // Avoid inviting someone already on the team
  const { data: existingMembers, error: memErr } = await supabaseAdmin
    .from("team_members")
    .select("user_id, profiles:id ( id )")
    .eq("team_id", team_id)

  if (memErr) return json(400, { error: memErr.message })

  // Also avoid duplicate pending invites for same email
  const { data: existingInvites, error: invErr } = await supabaseAdmin
    .from("team_invitations")
    .select("invitee_email, status")
    .eq("team_id", team_id)

  if (invErr) return json(400, { error: invErr.message })

  // Build invite rows with required fields
  const inviteRows = normalized.map((email) => ({
    team_id,
    competition_id: team.competition_id,
    invitee_email: email,
    status: "pending",
    token: crypto.randomBytes(24).toString("hex"),
    invited_by: user.email,       // NOT NULL
    inviter_user_id: user.id,     // NOT NULL
  }))

  // Filter out emails already invited pending
  const pendingSet = new Set(
    (existingInvites || [])
      .filter((i) => i.status === "pending")
      .map((i) => (i.invitee_email || "").toLowerCase())
  )

  const toInsert = inviteRows.filter((r) => !pendingSet.has(r.invitee_email))

  if (toInsert.length === 0) return json(200, { ok: true, inserted: 0 })

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("team_invitations")
    .insert(toInsert)
    .select("invitee_email, token")

  if (insErr) return json(400, { error: insErr.message })

  // Send emails
  const siteUrl = process.env.SITE_URL || "https://blockbusterstrivia.com"
  const from = process.env.RESEND_FROM || "BlockBusters Trivia <noreply@blockbusterstrivia.com>"

  for (const row of inserted || []) {
    const link = `${siteUrl}/invite?token=${row.token}`
    await resend.emails.send({
      from,
      to: row.invitee_email,
      subject: `You’re invited to join ${team.name}`,
      html: `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto">
          <h2>You’re invited</h2>
          <p>You’ve been invited to join <b>${team.name}</b>.</p>
          <p><a href="${link}">Accept Invite</a></p>
          <p style="color:#666">If the button doesn’t work, copy/paste this link:<br/>${link}</p>
        </div>
      `,
    })
  }

  return json(200, { ok: true, inserted: (inserted || []).length })
}
