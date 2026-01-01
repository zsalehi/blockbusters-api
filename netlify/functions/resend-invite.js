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
  const invitation_id = String(body.invitation_id || "").trim()
  if (!invitation_id) return json(400, { error: "invitation_id is required" })

  const { data: inv, error: invErr } = await supabaseAdmin
    .from("team_invitations")
    .select("id, token, status, invitee_email, team_id, teams:team_id ( id, name, captain_user_id )")
    .eq("id", invitation_id)
    .single()

  if (invErr || !inv) return json(404, { error: "Invite not found" })
  if (inv.status !== "pending") return json(400, { error: "Invite is not pending" })

  const team = inv.teams
  if (!team) return json(400, { error: "Team not found for invite" })
  if (team.captain_user_id !== user.id) return json(403, { error: "Only the captain can resend invites" })

  const siteUrl = process.env.SITE_URL || "https://blockbusterstrivia.com"
  const from = process.env.RESEND_FROM || "BlockBusters Trivia <noreply@blockbusterstrivia.com>"
  const link = `${siteUrl}/invite?token=${inv.token}`

  await resend.emails.send({
    from,
    to: inv.invitee_email,
    subject: `Reminder: join ${team.name}`,
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto">
        <h2>Reminder: you’re invited</h2>
        <p>You’ve been invited to join <b>${team.name}</b>.</p>
        <p><a href="${link}">Accept Invite</a></p>
        <p style="color:#666">If the button doesn’t work, copy/paste this link:<br/>${link}</p>
      </div>
    `,
  })

  return json(200, { ok: true })
}
