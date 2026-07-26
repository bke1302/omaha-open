/* בדיקת אימות ה-JWT של Google (RS256) — עם מפתח עצמי, בלי רשת */
'use strict';
const crypto = require('crypto');
const { verifyJwtRS256 } = require('./server.js');

let failures = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failures++; };
const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

// מפתח RSA לבדיקה + ה-JWK הציבורי המתאים
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = 'test-kid-1'; jwk.kty = 'RSA';
const jwks = [jwk];

function makeToken(payload, kid = 'test-kid-1', key = privateKey) {
  const h = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const p = b64(payload);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), key).toString('base64url');
  return `${h}.${p}.${sig}`;
}
const AUD = 'my-client-id.apps.googleusercontent.com';
const ISS = ['https://accounts.google.com', 'accounts.google.com'];
const base = () => ({ aud: AUD, iss: 'https://accounts.google.com', email: 'a@b.co', email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600 });

console.log('--- Google JWT verify ---');

// תקין
let payload = verifyJwtRS256(makeToken(base()), jwks, { aud: AUD, iss: ISS });
ok(payload && payload.email === 'a@b.co', 'טוקן תקין מאומת ומחזיר email');

// חתימה מזויפת (מפתח אחר)
const { privateKey: evilKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
try { verifyJwtRS256(makeToken(base(), 'test-kid-1', evilKey), jwks, { aud: AUD, iss: ISS }); ok(false, 'חתימה מזויפת נדחית'); }
catch (e) { ok(e.message === 'jwt-sig', 'חתימה מזויפת נדחית (jwt-sig)'); }

// aud שגוי (client id אחר — התקפה קלאסית)
try { verifyJwtRS256(makeToken({ ...base(), aud: 'attacker-client-id' }), jwks, { aud: AUD, iss: ISS }); ok(false, 'aud שגוי נדחה'); }
catch (e) { ok(e.message === 'jwt-aud', 'aud שגוי (client id אחר) נדחה'); }

// iss שגוי
try { verifyJwtRS256(makeToken({ ...base(), iss: 'https://evil.com' }), jwks, { aud: AUD, iss: ISS }); ok(false, 'iss שגוי נדחה'); }
catch (e) { ok(e.message === 'jwt-iss', 'iss שגוי נדחה'); }

// פג תוקף
try { verifyJwtRS256(makeToken({ ...base(), exp: Math.floor(Date.now() / 1000) - 10 }), jwks, { aud: AUD, iss: ISS }); ok(false, 'טוקן שפג נדחה'); }
catch (e) { ok(e.message === 'jwt-exp', 'טוקן שפג תוקף נדחה'); }

// kid לא מוכר
try { verifyJwtRS256(makeToken(base(), 'unknown-kid'), jwks, { aud: AUD, iss: ISS }); ok(false, 'kid לא מוכר נדחה'); }
catch (e) { ok(e.message === 'jwt-kid', 'kid לא מוכר נדחה'); }

// פורמט שבור
try { verifyJwtRS256('not.a.jwt.token', jwks, { aud: AUD, iss: ISS }); ok(false, 'פורמט שבור נדחה'); }
catch (e) { ok(/jwt-/.test(e.message), 'פורמט שבור נדחה'); }

// tampered payload (שינוי אחרי חתימה)
const t = makeToken(base()).split('.');
t[1] = b64({ ...base(), email: 'hacker@evil.co' });
try { verifyJwtRS256(t.join('.'), jwks, { aud: AUD, iss: ISS }); ok(false, 'payload ששונה נדחה'); }
catch (e) { ok(e.message === 'jwt-sig', 'payload ששונה אחרי חתימה נדחה (jwt-sig)'); }

console.log(failures ? `\n*** ${failures} FAILURES ***` : '\n*** GOOGLE JWT VERIFY PASSED ***');
process.exit(failures ? 1 : 0);
