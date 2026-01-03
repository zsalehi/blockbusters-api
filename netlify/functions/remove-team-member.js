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
  const team_member_id = String(body.team_member_id || "").trim()
  if (!team_member_id) return json(400, { error: "team_member_id is required" })

  // Load roster row + team
  const { data: tm, error: tmErr } = await supabaseAdmin
    .from("team_members")
    .select("id, role, team_id, user_id, member_email, teams:team_id ( id, captain_user_id )")
    .eq("id", team_member_id)
    .single()

  if (tmErr || !tm) return json(404, { error: "Team member not found" })
  if (!tm.teams) return json(400, { error: "Team not found for member" })

  if (tm.teams.captain_user_id !== user.id) {
    return json(403, { error: "Only the captain can remove team members" })
  }

  if (tm.role === "captain") {
    return json(400, { error: "You cannot remove the captain from the roster" })
  }

  // Revoke any pending invites tied to this roster slot
  // (safe even if none exist)
  await supabaseAdmin
    .from("team_invitations")
    .update({ status: "revoked" })
    .eq("team_member_id", tm.id)
    .eq("status", "pending")

  // Delete the roster row
  const { error: delErr } = await supabaseAdmin
    .from("team_members")
    .delete()
    .eq("id", tm.id)

  if (delErr) return json(400, { error: delErr.message })

  return json(200, { ok: true })
}
