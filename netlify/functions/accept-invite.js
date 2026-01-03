const { createClient } = require("@supabase/supabase-js")

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true })
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" })

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null
    if (!bearer) return json(401, { error: "Missing bearer token" })

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(bearer)
    if (userErr || !userData?.user) return json(401, { error: "Invalid session" })

    const user = userData.user
    const myEmail = normalizeEmail(user.email)

    const body = JSON.parse(event.body || "{}")
    const inviteToken = String(body.token || "").trim()
    if (!inviteToken) return json(400, { error: "Missing invite token" })

    // 1) Fetch invitation (select only what we need + team_member_id)
    const { data: inv, error: invErr } = await supabaseAdmin
      .from("team_invitations")
      .select("id, team_id, token, status, expires_at, invitee_email, invitee_user_id, role, team_member_id")
      .eq("token", inviteToken)
      .single()

    if (invErr || !inv) return json(404, { error: "Invite not found" })
    if (inv.status !== "pending") {
      return json(400, { error: `Invite is not pending (status: ${inv.status}).` })
    }

    // Optional expiry
    if (inv.expires_at) {
      const exp = new Date(inv.expires_at).getTime()
      if (!Number.isNaN(exp) && Date.now() > exp) {
        await supabaseAdmin
          .from("team_invitations")
          .update({ status: "expired" })
          .eq("id", inv.id)

        return json(400, { error: "Invite has expired." })
      }
    }

    const inviteEmail = normalizeEmail(inv.invitee_email)

    // Security/UX: must match invited email
    if (inviteEmail && myEmail && inviteEmail !== myEmail) {
      return json(403, {
        error: `This invite was sent to ${inviteEmail}. You are signed in as ${myEmail}. Please sign in with the invited email.`,
      })
    }

    // ✅ Source of truth for competition_id is TEAMS (not team_invitations)
    const { data: teamRow, error: teamErr } = await supabaseAdmin
      .from("teams")
      .select("id, competition_id")
      .eq("id", inv.team_id)
      .single()

    if (teamErr || !teamRow) {
      return json(404, { error: "Team not found for this invite." })
    }

    const effectiveCompetitionId = teamRow.competition_id

    // 2) One-team-per-competition enforcement
    const { data: existing, error: existingErr } = await supabaseAdmin
      .from("team_members")
      .select("team_id, teams!inner(competition_id)")
      .eq("user_id", user.id)
      .eq("teams.competition_id", effectiveCompetitionId)

    if (existingErr) return json(400, { error: existingErr.message })
    if (existing && existing.length > 0) {
      return json(409, {
        error: "You’re already registered on a team for this competition.",
        team_id: existing[0].team_id,
        competition_id: effectiveCompetitionId,
      })
    }

    // 3) Claim roster row deterministically via team_member_id if present
    let claimedMemberId = null

    if (inv.team_member_id) {
      const { data: rosterRow, error: rosterErr } = await supabaseAdmin
        .from("team_members")
        .select("id, user_id, full_name, handle, phone")
        .eq("id", inv.team_member_id)
        .eq("team_id", inv.team_id)
        .maybeSingle()

      if (rosterErr) return json(400, { error: rosterErr.message })

      if (rosterRow?.id) {
        if (rosterRow.user_id && rosterRow.user_id !== user.id) {
          return json(409, { error: "That roster spot has already been claimed by another account." })
        }

        const { error: claimErr } = await supabaseAdmin
          .from("team_members")
          .update({ user_id: user.id })
          .eq("id", rosterRow.id)

        if (claimErr) return json(400, { error: claimErr.message })

        claimedMemberId = rosterRow.id

        // Optional: bootstrap profiles from roster (NO DOB)
        const { data: prof } = await supabaseAdmin
          .from("profiles")
          .select("full_name, handle, phone")
          .eq("id", user.id)
          .maybeSingle()

        const patch = {}
        if (prof) {
          if (!prof.full_name && rosterRow.full_name) patch.full_name = rosterRow.full_name
          if (!prof.handle && rosterRow.handle) patch.handle = rosterRow.handle
          if (!prof.phone && rosterRow.phone) patch.phone = rosterRow.phone
        } else {
          patch.full_name = rosterRow.full_name || null
          patch.handle = rosterRow.handle || null
          patch.phone = rosterRow.phone || null
        }

        if (Object.keys(patch).length > 0) {
          await supabaseAdmin.from("profiles").upsert(
            { id: user.id, ...patch },
            { onConflict: "id" }
          )
        }
      }
    }

    // Fallback: claim by email if team_member_id missing (older invites)
    if (!claimedMemberId && inviteEmail) {
      const { data: rosterRow, error: rosterErr } = await supabaseAdmin
        .from("team_members")
        .select("id, user_id, full_name, handle, phone")
        .eq("team_id", inv.team_id)
        .ilike("member_email", inviteEmail)
        .maybeSingle()

      if (rosterErr) return json(400, { error: rosterErr.message })

      if (rosterRow?.id) {
        if (rosterRow.user_id && rosterRow.user_id !== user.id) {
          return json(409, { error: "That roster spot has already been claimed by another account." })
        }

        const { error: claimErr } = await supabaseAdmin
          .from("team_members")
          .update({ user_id: user.id })
          .eq("id", rosterRow.id)

        if (claimErr) return json(400, { error: claimErr.m
