const { createClient } = require("@supabase/supabase-js")
const { json } = require("./_cors")

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase()
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(event, 200, { ok: true })
  if (event.httpMethod !== "POST") return json(event, 405, { error: "Method not allowed" })

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null
    if (!token) return json(event, 401, { error: "Missing bearer token" })

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token)
    if (userErr || !userData?.user) return json(event, 401, { error: "Invalid session" })

    const user = userData.user
    const myEmail = normalizeEmail(user.email)

    const body = JSON.parse(event.body || "{}")
    const inviteToken = String(body.token || "").trim()
    if (!inviteToken) return json(event, 400, { error: "Missing invite token" })

    // 1) Fetch invitation
    const { data: inv, error: invErr } = await supabaseAdmin
      .from("team_invitations")
      .select("*")
      .eq("token", inviteToken)
      .single()

    if (invErr || !inv) return json(event, 404, { error: "Invite not found" })

    if (inv.status !== "pending") {
      return json(event, 400, { error: `Invite is not pending (status: ${inv.status}).` })
    }

    // Expiry (optional)
    if (inv.expires_at) {
      const exp = new Date(inv.expires_at).getTime()
      if (!Number.isNaN(exp) && Date.now() > exp) {
        await supabaseAdmin.from("team_invitations").update({ status: "expired" }).eq("id", inv.id)
        return json(event, 400, { error: "Invite has expired." })
      }
    }

    const inviteEmail = normalizeEmail(inv.invitee_email)

    // Must be logged in as invited email
    if (inviteEmail && myEmail && inviteEmail !== myEmail) {
      return json(event, 403, {
        error: `This invite was sent to ${inviteEmail}. You are signed in as ${myEmail}. Please sign in with the invited email.`,
      })
    }

    // 2) Enforce: one team per competition for this user
    const { data: existing, error: existingErr } = await supabaseAdmin
      .from("team_members")
      .select("team_id, teams!inner(competition_id)")
      .eq("user_id", user.id)
      .eq("teams.competition_id", inv.competition_id)

    if (existingErr) return json(event, 400, { error: existingErr.message })
    if (existing && existing.length > 0) {
      return json(event, 409, {
        error: "You’re already registered on a team for this competition.",
        team_id: existing[0].team_id,
      })
    }

    // 3) Claim the roster row that matches this invite (BEST: team_member_id)
    let claimedMemberId = null

    if (inv.team_member_id) {
      const { data: rosterRow, error: rosterErr } = await supabaseAdmin
        .from("team_members")
        .select("id, user_id, full_name, handle, phone")
        .eq("id", inv.team_member_id)
        .eq("team_id", inv.team_id)
        .maybeSingle()

      if (rosterErr) return json(event, 400, { error: rosterErr.message })
      if (!rosterRow) return json(event, 400, { error: "Roster row not found for this invite." })

      if (rosterRow.user_id && rosterRow.user_id !== user.id) {
        return json(event, 409, { error: "That roster spot has already been claimed by another account." })
      }

      const { error: claimErr } = await supabaseAdmin
        .from("team_members")
        .update({ user_id: user.id })
        .eq("id", rosterRow.id)

      if (claimErr) return json(event, 400, { error: claimErr.message })
      claimedMemberId = rosterRow.id

      // Optional: bootstrap profile fields if missing
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

      if (Object.keys(patch).length) {
        await supabaseAdmin.from("profiles").upsert({ id: user.id, ...patch }, { onConflict: "id" })
      }
    } else {
      // Fallback: claim by email match (older invites)
      if (inviteEmail) {
        const { data: rosterRow, error: rosterErr } = await supabaseAdmin
          .from("team_members")
          .select("id, user_id")
          .eq("team_id", inv.team_id)
          .ilike("member_email", inviteEmail)
          .maybeSingle()

        if (rosterErr) return json(event, 400, { error: rosterErr.message })

        if (rosterRow?.id) {
          if (rosterRow.user_id && rosterRow.user_id !== user.id) {
            return json(event, 409, { error: "That roster spot has already been claimed by another account." })
          }

          const { error: claimErr } = await supabaseAdmin
            .from("team_members")
            .update({ user_id: user.id })
            .eq("id", rosterRow.id)

          if (claimErr) return json(event, 400, { error: claimErr.message })
          claimedMemberId = rosterRow.id
        }
      }

      // If still not claimed, create a row (edge-case resilience)
      if (!claimedMemberId) {
        const { data: inserted, error: insertErr } = await supabaseAdmin
          .from("team_members")
          .insert({
            team_id: inv.team_id,
            user_id: user.id,
            role: "member",
            member_email: inviteEmail || myEmail || null,
          })
          .select("id")
          .single()

        if (insertErr) return json(event, 400, { error: insertErr.message })
        claimedMemberId = inserted?.id || null
      }
    }

    // 4) Mark invite accepted
    // (Only update columns that exist. If you haven’t added accepted_at, this won’t break.)
    const patch = { status: "accepted", invitee_user_id: user.id }
    if ("accepted_at" in inv) patch.accepted_at = new Date().toISOString()

    const { error: updErr } = await supabaseAdmin
      .from("team_invitations")
      .update(patch)
      .eq("id", inv.id)

    if (updErr) {
      // If accepted_at doesn’t exist, retry without it
      if (String(updErr.message || "").toLowerCase().includes("accepted_at")) {
        const { error: updErr2 } = await supabaseAdmin
          .from("team_invitations")
          .update({ status: "accepted", invitee_user_id: user.id })
          .eq("id", inv.id)

        if (updErr2) return json(event, 400, { error: updErr2.message })
      } else {
        return json(event, 400, { error: updErr.message })
      }
    }

    return json(event, 200, {
      ok: true,
      team_id: inv.team_id,
      competition_id: inv.competition_id,
      team_member_id: claimedMemberId,
    })
  } catch (e) {
    return json(event, 500, { error: e.message || "Server error" })
  }
}
