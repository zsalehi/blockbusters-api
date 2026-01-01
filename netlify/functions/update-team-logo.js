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
  const team_id = String(body.team_id || "").trim()
  const logo_url = String(body.logo_url || "").trim()

  if (!team_id) return json(400, { error: "team_id is required" })
  if (!logo_url) return json(400, { error: "logo_url is required" })

  // Captain check
  const { data: team, error: teamErr } = await supabaseAdmin
    .from("teams")
    .select("id, captain_user_id")
    .eq("id", team_id)
    .single()

  if (teamErr || !team) return json(404, { error: "Team not found" })
  if (team.captain_user_id !== user.id) return json(403, { error: "Only the captain can update the logo" })

  const { error: updErr } = await supabaseAdmin
    .from("teams")
    .update({ logo_url })
    .eq("id", team_id)

  if (updErr) return json(400, { error: updErr.message })

  return json(200, { ok: true })
}
