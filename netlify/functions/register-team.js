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
  // must be in the past
  return dt < new Date()
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

    const captainUser = userData.user
    const captainEmail = normalizeEmail(captainUser.email)

    const body = JSON.parse(event.body || "{}")
    const competition_id = String(body.competition_id || "").trim()
    const team_name = String(body.team_name || "").trim()
    const members = Array.isArray(body.members) ? body.members : []

    if (!competition_id) return json(400, { error: "Missing competition_id" })
    if (!team_name) return json(400, { error: "Missing team_name" })
    if (members.length < 2) return json(400, { error: "Team must have at least 2 members." })
    if (members.length > 4) return json(400, { error: "Team max size is 4." })

    const captainPayload = members.find((m) => m.role === "captain")
    if (!captainPayload) return json(400, { error: "Missing captain in members[] payload." })

    // Validate competition exists (optional but safer)
    const { data: comp, error: compErr } = await supabaseAdmin
      .from("competitions")
      .select("id")
      .eq("id", competition_id)
      .single()

    if (compErr || !comp) return json(404, { error: "Competition not found." })

    // Strict: captain cannot already be on a team in this competition
    const { data: existingMemberRows, error: exErr } = await supabaseAdmin
      .from("team_members")
      .select("team_id, teams!inner(competition_id)")
      .eq("user_id", captainUser.id)
      .eq("teams.competition_id", competition_id)

    if (exErr) return json(400, { error: exErr.message })
    if (existingMemberRows && existingMemberRows.length > 0) {
      return json(409, {
        error: "You’re already registered on a team for this competition.",
        team_id: existingMemberRows[0].team_id,
      })
    }

    // Clean + validate roster (full_name + dob required for ALL members)
    const cleanedMembers = members.map((m) => ({
      role: m.role === "captain" ? "captain" : "member",
      full_name: String(m.full_name || "").trim(),
      date_of_birth: String(m.date_of_birth || "").trim(),
      email: normalizeEmail(m.email),
      handle: String(m.handle || "").trim(),
      phone: String(m.phone || "").trim(),
    }))

    for (let i = 0; i < cleanedMembers.length; i++) {
      const r = cleanedMembers[i]
      if (!r.full_name) return json(400, { error: `Member ${i + 1}: full_name is required.` })
      if (!isValidDOB(r.date_of_birth)) return json(400, { error: `Member ${i + 1}: valid date_of_birth is required.` })
    }

    // Create team
    const { data: team, error: teamErr } = await supabaseAdmin
      .from("teams")
      .insert({
        name: team_name,
        competition_id,
        captain_user_id: captainUser.id,
        created_by: captainUser.id,
      })
      .select("id, name, competition_id")
      .single()

    if (teamErr) return json(400, { error: teamErr.message })

    // Insert team_members roster rows
    const nowIso = new Date().toISOString()

    const rosterRows = cleanedMembers.map((m) => ({
      team_id: team.id,
      user_id: m.role === "captain" ? captainUser.id : null,
      role: m.role,
      full_name: m.full_name,
      date_of_birth: m.date_of_birth || null,
      handle: m.handle || null,
      phone: m.phone || null,
      member_email: m.email || null, // optional; used for invites if present
      created_at: nowIso,
    }))

    const { data: insertedMembers, error: memberErr } = await supabaseAdmin
      .from("team_members")
      .insert(rosterRows)
      .select("id, user_id, member_email, role")

    if (memberErr) return json(400, { error: memberErr.message })

    // Create invitations for non-user members that have an email
    const inviteTargets = (insertedMembers || []).filter((m) => !m.user_id && m.member_email)

    let invites = []
    if (inviteTargets.length) {
      const inviteRows = inviteTargets.map((m) => ({
        team_id: team.id,
        competition_id: team.competition_id, // source of truth = team
        inviter_user_id: captainUser.id,
        invitee_email: normalizeEmail(m.member_email),
        invitee_user_id: null,
        role: "member",
        status: "pending",
        token: crypto.randomBytes(24).toString("hex"),
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        created_at: nowIso,
        team_member_id: m.id, // ✅ deterministic linking later
      }))

      const { data: invData, error: invErr } = await supabaseAdmin
        .from("team_invitations")
        .insert(inviteRows)
        .select("invitee_email, token")

      if (invErr) return json(400, { error: invErr.message })
      invites = invData || []
    }

    // Send emails via Resend (best-effort)
    const siteUrl = process.env.SITE_URL || "https://blockbusterstrivia.com"
    const from = process.env.RESEND_FROM || "BlockBusters Trivia <noreply@blockbusterstrivia.com>"

    await Promise.all(
      invites.map((inv) => {
        const link = `${siteUrl}/invite?token=${inv.token}`
        return resend.emails.send({
          from,
          to: inv.invitee_email,
          subject: `You’ve been invited to join ${team.name}`,
          html: `
            <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto">
              <h2>You’re invited to join a team</h2>
              <p><b>${captainEmail || "A team captain"}</b> invited you to join <b>${team.name}</b>.</p>
              <p><a href="${link}">Accept Invite</a></p>
              <p style="color:#666">If the button doesn’t work, copy/paste this link:<br/>${link}</p>
            </div>
          `,
        })
      })
    )

    return json(200, {
      ok: true,
      team_id: team.id,
      invites_count: invites.length,
    })
  } catch (e) {
    return json(500, { error: e.message || "Server error" })
  }
}
