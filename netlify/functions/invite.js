const crypto = require("crypto");
const { Resend } = require("resend");
const { supabaseAdmin } = require("./_supabaseAdmin");

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      // CORS (Framer → Netlify)
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

function normalizeEmail(e) {
  return (e || "").trim().toLowerCase();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!bearer) return json(401, { error: "Missing bearer token" });

  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.EMAIL_FROM || "BlockBusters <onboarding@resend.dev>";

  // Validate caller session (must be logged in)
  const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(bearer);
  if (userErr || !userRes?.user) return json(401, { error: "Invalid session" });
  const inviter = userRes.user;

  const body = JSON.parse(event.body || "{}");
  const team_id = String(body.team_id || "").trim();
  const invitee_email = normalizeEmail(body.invitee_email);

  if (!team_id || !invitee_email) return json(400, { error: "team_id and invitee_email are required" });

  // Load team + competition
  const { data: team, error: teamErr } = await supabaseAdmin
    .from("teams")
    .select("id, competition_id, name")
    .eq("id", team_id)
    .single();
  if (teamErr || !team) return json(404, { error: "Team not found" });

  // Ensure inviter is on the team (member)
  const { data: member } = await supabaseAdmin
    .from("team_members")
    .select("team_id, role")
    .eq("team_id", team_id)
    .eq("user_id", inviter.id)
    .maybeSingle();
  if (!member) return json(403, { error: "Only team members can invite" });

  // Optional: only captains can invite
  // if (member.role !== "captain") return json(403, { error: "Only captains can invite" });

  // Create invite row
  const token = crypto.randomBytes(32).toString("base64url");

  const { data: invite, error: invErr } = await supabaseAdmin
    .from("team_invitations")
    .insert({
      team_id,
      competition_id: team.competition_id,
      inviter_user_id: inviter.id,
      invitee_email,
      token,
      status: "pending",
    })
    .select("id, token, expires_at")
    .single();

  if (invErr) {
    // e.g., duplicate pending invite constraint
    return json(400, { error: invErr.message });
  }

  const acceptUrl = `${process.env.SITE_URL}/invite?token=${invite.token}`;

  // Send email
  const { error: emailErr } = await resend.emails.send({
    from,
    to: invitee_email,
    subject: "You’re invited to join a BlockBusters Trivia team",
    html: `
      <div style="font-family:system-ui,Segoe UI,Arial">
        <h2>BlockBusters Trivia</h2>
        <p>You’ve been invited to join <b>${team.name}</b>.</p>
        <p><a href="${acceptUrl}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#111;color:#fff;text-decoration:none">Accept invite</a></p>
        <p style="color:#666;font-size:12px">If the button doesn't work, copy/paste:</p>
        <p style="font-size:12px">${acceptUrl}</p>
      </div>
    `,
  });

  if (emailErr) return json(500, { error: "Invite created but email failed", details: emailErr });

  return json(200, { ok: true, invite_id: invite.id });
};
