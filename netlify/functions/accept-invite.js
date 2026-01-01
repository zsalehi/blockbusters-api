const { supabaseAdmin } = require("./_supabaseAdmin");

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
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!bearer) return json(401, { error: "Missing bearer token" });

  const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(bearer);
  if (userErr || !userRes?.user) return json(401, { error: "Invalid session" });
  const user = userRes.user;

  const body = JSON.parse(event.body || "{}");
  const token = String(body.token || "").trim();
  if (!token) return json(400, { error: "token is required" });

  const { data: invite, error: invErr } = await supabaseAdmin
    .from("team_invitations")
    .select("id, team_id, competition_id, invitee_email, status, expires_at")
    .eq("token", token)
    .single();

  if (invErr || !invite) return json(404, { error: "Invite not found" });
  if (invite.status !== "pending") return json(400, { error: "Invite is not pending" });
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
  return json(400, { error: "Invite expired" })
  }


  // Strict email match (recommended for MVP security)
  const authedEmail = (user.email || "").trim().toLowerCase();
  const invitedEmail = (invite.invitee_email || "").trim().toLowerCase();
  if (authedEmail !== invitedEmail) return json(403, { error: "Invite sent to a different email" });

  const { count, error: countErr } = await supabaseAdmin
  .from("team_members")
  .select("*", { count: "exact", head: true })
  .eq("team_id", invite.team_id)

  if (countErr) return json(400, { error: countErr.message })

  // count includes captain and anyone already accepted
  if ((count || 0) >= 4) return json(400, { error: "Team is already full (max 4 members)." })


  const { error: memberErr } = await supabaseAdmin
  .from("team_members")
  .upsert(
    { team_id: invite.team_id, user_id: user.id, role: "member" },
    { onConflict: "team_id,user_id" }
  )


  if (memberErr) return json(400, { error: memberErr.message });

  await supabaseAdmin
    .from("team_invitations")
    .update({ status: "accepted", invitee_user_id: user.id })
    .eq("id", invite.id);

  return json(200, { ok: true });
};
