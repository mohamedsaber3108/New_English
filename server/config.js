// Production configuration check. Run at startup; each finding is logged once and shown to administrators in the
// operations overview. Never includes secret values. Fatal findings stop the process (unsafe to serve).
export function checkConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const out = [];
  const add = (level, key, message) => out.push({level, key, message});
  const origin = String(env.SITE_ORIGIN || '');
  if (prod && !origin) add('warn', 'SITE_ORIGIN', 'SITE_ORIGIN is not set: email links and payment callbacks cannot be built.');
  else if (prod && !origin.startsWith('https://')) add('fatal', 'SITE_ORIGIN', 'SITE_ORIGIN must start with https:// in production.');
  if (prod && String(env.ACCESS_ENFORCEMENT || 'auto').toLowerCase() === 'open') add('warn', 'ACCESS_ENFORCEMENT', 'ACCESS_ENFORCEMENT=open: paid learning content is served without a subscription.');
  if (prod && !env.DATABASE_URL) add('warn', 'DATABASE_URL', 'DATABASE_URL is not set: using the embedded single-process database (no horizontal scaling, no managed backups).');
  if (prod && (env.AUDIT_HMAC_KEY || '').length < 32) add('warn', 'AUDIT_HMAC_KEY', 'AUDIT_HMAC_KEY is missing or shorter than 32 characters: the audit log cannot resist deliberate tampering.');
  // E-10: in production the console must require two-factor authentication. Both settings are fatal: without
  // ADMIN_REQUIRE_MFA=true an admin could skip MFA; without ADMIN_MFA_KEY nobody could enrol, so the console would be unusable.
  // First-admin bootstrap (an admin without MFA can still sign in and enrol): docs/ADMIN_OPERATIONS.md.
  if (prod && (env.ADMIN_MFA_KEY || '').length < 32) add('fatal', 'ADMIN_MFA_KEY', 'ADMIN_MFA_KEY must be at least 32 characters in production: administrator two-factor authentication needs it. Generate one with: openssl rand -hex 32');
  if (prod && env.ADMIN_REQUIRE_MFA !== 'true') add('fatal', 'ADMIN_REQUIRE_MFA', 'ADMIN_REQUIRE_MFA=true is required in production: administrators must use two-factor authentication. Set it in the service environment (an administrator without MFA can still sign in once to enrol).');
  if (env.ADMIN_LEGACY_TOKEN === 'true') add('warn', 'ADMIN_LEGACY_TOKEN', 'The legacy shared admin token is enabled (read-only). Disable it once named administrators exist.');
  if (prod && env.METRICS_TOKEN && env.METRICS_TOKEN.length < 16) add('warn', 'METRICS_TOKEN', 'METRICS_TOKEN is shorter than 16 characters; the metrics endpoint stays disabled.');
  if (env.REQUIRE_VERIFIED_EMAIL === 'true' && !(env.RESEND_API_KEY && env.EMAIL_FROM)) add('warn', 'RESEND_API_KEY', 'REQUIRE_VERIFIED_EMAIL=true but email delivery is not configured: learners cannot verify their email and therefore cannot pay.');
  const paymob = ['PAYMOB_SECRET_KEY', 'PAYMOB_PUBLIC_KEY', 'PAYMOB_INTEGRATION_IDS', 'PAYMOB_HMAC_SECRET'].filter(k => env[k]);
  if (paymob.length && paymob.length < 4) add('warn', 'PAYMOB', 'Paymob is partially configured; online checkout stays disabled until all four PAYMOB_* values are set.');
  return out;
}
