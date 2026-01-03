const ALLOWED_ORIGINS = new Set([
  "https://www.blockbusterstrivia.com",
  "https://blockbusterstrivia.com",
  // local dev (optional)
  "http://localhost:3000",
  "http://localhost:5173",
])

function corsHeaders(origin) {
  const o = String(origin || "")
  const allowOrigin = ALLOWED_ORIGINS.has(o)
    ? o
    : "https://www.blockbusterstrivia.com" // safe fallback (or "")

  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    // Only add this if you ever use cookies/session via browser:
    // "Access-Control-Allow-Credentials": "true",
  }
}

function json(event, statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders(event.headers.origin),
    body: JSON.stringify(body),
  }
}

module.exports = { json, corsHeaders }
