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
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null
    if (!token) return json(401, { error: "Missing bearer token" })

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token)
    if (userErr || !userData?.user) return json(401, { error: "Invalid session" })

    const user = userData.user
    const myEmail = normalizeEmail(user.email)

    const body = JSON.parse(event.body || "{}")
    const inviteToken = String(body.token || "").trim()
    if (!inviteToken) return json(400, { error: "Missing invite token" })

    // 1) Fetch invitation
    const { data: inv, error: invErr } = await supabaseAdmin
      .from("team_invitations")
      .select("*")
      .eq("token", inviteToken)
      .single()

    if (invErr || !inv) return json(404, { error: "Invite not found" })

    if (inv.status !== "pending") {
      return json(400, { error: `Invite is not pending (status: ${inv.status}).` })
    }

    // Optional expiry support
    if (inv.expires_at) {
      const exp = new Date(inv.expires_at).getTime()
      if (!Number.isNaN(exp) && Date.now() > exp) {
        // Mark expired (best effort)
        await supabaseAdmin
          .from("team_invitations")
          .update({ status: "expired" })
          .eq("id", inv.id)

        return json(400, { error: "Invite has expired." })
      }
    }

    const inviteEmail = normalizeEmail(inv.invitee_email)

    // Security/UX: user must be logged into the same email the invite was sent to
    if (inviteEmail && myEmail && inviteEmail !== myEmail) {
      return json(403, {
        error: `This invite was sent to ${inviteEmail}. You are signed in as ${myEmail}. Please sign in with the invited email.`,
      })
    }

    // 2) Strict rule: invitee can only be on one team per competition
    // (same rule you enforced for captains)
    const { data: existing, error: existingErr } = await supabaseAdmin
      .from("team_members")
      .select("team_id, teams!inner(competition_id)")
      .eq("user_id", user.id)
      .eq("teams.competition_id", inv.competition_id)

    if (existingErr) return json(400, { error: existingErr.message })
    if (existing && existing.length > 0) {
      return json(409, {
        error: "You’re already registered on a team for this competition.",
        team_id: existing[0].team_id,
      })
    }

    // 3) Claim roster row in team_members if it exists (team_id + member_email)
    // Your new register-team inserts a roster row with member_email for invited members.
    let claimedMemberId = null

    if (inviteEmail) {
      const { data: rosterRow, error: rosterErr } = await supabaseAdmin
        .from("team_members")
        .select("id, user_id, full_name, handle, phone")
        .eq("team_id", inv.team_id)
        .ilike("member_email", inviteEmail)
        .maybeSingle()

      if (rosterErr) return json(400, { error: rosterErr.message })

      if (rosterRow?.id) {
        // If already claimed, prevent weirdness
        if (rosterRow.user_id && rosterRow.user_id !== user.id) {
          return json(409, { error: "That roster spot has already been claimed by another account." })
        }

        const { error: claimErr } = await supabaseAdmin
          .from("team_members")
          .update({
            user_id: user.id,
            // keep role as member; do not overwrite full_name/dob unless you want to
          })
          .eq("id", rosterRow.id)

        if (claimErr) return json(400, { error: claimErr.message })
        claimedMemberId = rosterRow.id

        // Optional: bootstrap profiles from roster (NO DOB)
        // Only fill if missing.
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
          // profile missing: create minimal
          patch.full_name = rosterRow.full_name || null
          patch.handle = rosterRow.handle || null
          patch.phone = rosterRow.phone || null
        }

        // only write if we have something to write
        if (Object.keys(patch).length > 0) {
          await supabaseAdmin.from("profiles").upsert(
            { id: user.id, ...patch },
            { onConflict: "id" }
          )
        }
      }
    }

    // 4) If roster row didn't exist (edge case), insert team_members row
    // (This keeps the system resilient even if you ever change registration behavior.)
    if (!claimedMemberId) {
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from("team_members")
        .insert({
          team_id: inv.team_id,
          user_id: user.id,
          role: "member",
          member_email: inviteEmail || myEmail || null,
          full_name: null,       // unknown here; user can update later
          date_of_birth: null,   // NOT collected here per your policy
        })
        .select("id")
        .single()

      if (insertErr) return json(400, { error: insertErr.message })
      claimedMemberId = inserted?.id || null
    }

    // 5) Mark invite accepted
    const { error: updErr } = await supabaseAdmin
      .from("team_invitations")
      .update({
        status: "accepted",
        invitee_user_id: user.id,
        accepted_at: new Date().toISOString(), // only if column exists; harmless if not? (it will error)
      })
      .eq("id", inv.id)

    // If accepted_at column doesn't exist, retry without it
    if (updErr && String(updErr.message || "").toLowerCase().includes("accepted_at")) {
      const { error: updErr2 } = await supabaseAdmin
        .from("team_invitations")
        .update({
          status: "accepted",
          invitee_user_id: user.id,
        })
        .eq("id", inv.id)

      if (updErr2) return json(400, { error: updErr2.message })
    } else if (updErr) {
      return json(400, { error: updErr.message })
    }

    return json(200, {
      ok: true,
      team_id: inv.team_id,
      competition_id: inv.competition_id,
      team_member_id: claimedMemberId,
    })
  } catch (e) {
    return json(500, { error: e.message || "Server error" })
  }
}
