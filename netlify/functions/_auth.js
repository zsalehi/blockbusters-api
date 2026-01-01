const jwt = require("jsonwebtoken");

// Supabase JWT secret is in Supabase project settings -> API -> JWT Settings.
// But fastest approach: call Supabase to validate token by fetching user via Admin API.
// We'll do that in the handlers using supabaseAdmin.auth.getUser(token).
module.exports = {};
