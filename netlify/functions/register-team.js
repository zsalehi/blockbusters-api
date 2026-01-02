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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true })
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" })

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null
    if (!token) return json(401, { error: "Missing bearer token" })

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token)
    if (userErr || !userData?.user) return json(401, { error: "Invalid session" })

    const captain = userData.user
    const captainEmail = captain.email || ""

    const body = JSON.parse(event.body || "{}")
    const competition_id = body.competition_id
    const team_name = (body.team_name || "").trim()
    const emails = Array.isArray(body.emails) ? body.emails : []

    if (!competition_id) return json(400, { error: "Missing competition_id" })
    if (!team_name) return json(400, { error: "Missing team_name" })
    if (emails.length < 1) return json(400, { error: "Add at least 1 teammate email" })

    // Normalize emails: lowercase, trim, remove blanks, remove duplicates, remove captain email
    const normalized = [...new Set(
      emails
        .map((e) => String(e || "").trim().toLowerCase())
        .filter(Boolean)
        .filter((e) => e !== captainEmail.toLowerCase())
    )]

    // STRICT RULE: user can only be on one team per competition (captain OR member)
    const { data: existingMemberRows, error: exErr } = await supabaseAdmin
        .from("team_members")
        .select("team_id, teams!inner(competition_id)")
        .eq("user_id", captain.id)
        .eq("teams.competition_id", competition_id)

    if (exErr) return json(400, { error: exErr.message })

    if (existingMemberRows && existingMemberRows.length > 0) {
    return json(409, {
        error: "You’re already registered on a team for this competition.",
        team_id: existingMemberRows[0].team_id,
    })
    }


    // Team size rules (including captain)
    const totalSize = 1 + normalized.length

    if (totalSize < 2) return json(400, { error: "Add at least 1 teammate email (min team size is 2 including you)." })
    if (totalSize > 4) return json(400, { error: "Too many teammates. Max team size is 4 including you (max 3 emails)." })

    // (Optional) sanity limit
    if (normalized.length > 10) return json(400, { error: "Too many invites" })



    // 1) Create team tied to competition
    const { data: team, error: teamErr } = await supabaseAdmin
      .from("teams")
      .insert({
        name: team_name,
        competition_id,
        captain_user_id: captain.id,
      })
      .select()
      .single()

    if (teamErr) return json(400, { error: teamErr.message })

    // 2) Add captain as team member
    const { error: memberErr } = await supabaseAdmin
      .from("team_members")
      .insert({ team_id: team.id, user_id: captain.id, role: "captain" })

    if (memberErr) return json(400, { error: memberErr.message })

    // 3) Create invitations + send emails
    const inviteRows = normalized.map((email) => ({
        team_id: team.id,
        competition_id,
        invitee_email: email,
        invited_by: captainEmail || "captain",
        inviter_user_id: captain.id,
        status: "pending",
        token: crypto.randomBytes(24).toString("hex"),
    }))


    const { data: invites, error: invErr } = await supabaseAdmin
      .from("team_invitations")
      .insert(inviteRows)
      .select()

    if (invErr) return json(400, { error: invErr.message })

    // send emails (best-effort)
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

    return json(200, { ok: true, team_id: team.id, invites_count: invites.length })
  } catch (e) {
    return json(500, { error: e.message || "Server error" })
  }
}
