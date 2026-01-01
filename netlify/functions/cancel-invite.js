const { supabaseAdmin } = require("./_supabaseAdmin")

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
    .select("id, status, team_id, teams:team_id ( id, captain_user_id )")
    .eq("id", invitation_id)
    .single()

  if (invErr || !inv) return json(404, { error: "Invite not found" })
  if (inv.status !== "pending") return json(400, { error: "Only pending invites can be cancelled" })

  const team = inv.teams
  if (!team) return json(400, { error: "Team not found for invite" })
  if (team.captain_user_id !== user.id) return json(403, { error: "Only the captain can cancel invites" })

  const { error: updErr } = await supabaseAdmin
    .from("team_invitations")
    .update({ status: "revoked" })
    .eq("id", inv.id)

  if (updErr) return json(400, { error: updErr.message })

  return json(200, { ok: true })
}
