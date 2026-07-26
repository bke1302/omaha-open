/*
  OMAHA OPEN — שרת פרטי למשחק אומהה פתוחה, עם מערכת חשבונות
  -----------------------------------------------------------
  הפעלה:  node server.js          (פורט 3777, או PORT מהסביבה)
  קוד מנהל (דאשבורד): ADMIN_PIN   |  קוד הזמנה להרשמה: מנוהל מהדאשבורד
*/
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3777;
const ADMIN_PIN = process.env.ADMIN_PIN || '1302';   // <<< שנה את הקוד הזה
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';   // התחברות עם Google (אופציונלי)
const FAST = !!process.env.FAST;                     // מצב בדיקות מהיר
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUB = path.join(__dirname, 'public');
// שתי רמות שולחן — העמלה תמיד 5% מהכניסה לקופה
const STAKES = {
  low:  { entry: 50,  fee: 2.5 },   // כניסה 52.5
  high: { entry: 100, fee: 5 },     // כניסה 105
};
const SEATS = 4;           // בדיוק 4 שחקנים
const ROUNDS = 4;          // 4 סיבובים בלי ערבוב
const MAX_ACCOUNTS = 200;  // בלם בטיחות
const MAX_ROOMS = 300;     // תקרת חדרים גלובלית
const AUTO_ADVANCE_MS = 40000;   // התקדמות סיבוב אוטומטית אם המארח לא לוחץ
const DEFAULT_INVITE = 'OMAHA1';

/* ---------- בנק וחשבונות (נשמר לקובץ) ---------- */
const BAK_FILE = DATA_FILE + '.bak';
let bank = { accounts: {}, settings: { invite: DEFAULT_INVITE }, house: 0 };
function tryLoad(file) {
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded && typeof loaded.accounts === 'object') return loaded;
  } catch (e) {}
  return null;
}
{
  const primary = tryLoad(DATA_FILE);
  if (primary) bank = primary;
  else if (fs.existsSync(DATA_FILE)) {
    // הקובץ קיים אך פגום — אל תמשיך עם בנק ריק! נסה גיבוי, אחרת עצור
    const backup = tryLoad(BAK_FILE);
    if (backup) { bank = backup; console.error('data.json פגום — שוחזר מגיבוי'); }
    else { console.error('data.json פגום ואין גיבוי — עצירה למניעת אובדן נתונים'); process.exit(1); }
  } else {
    const backup = tryLoad(BAK_FILE);
    if (backup) bank = backup;   // הקובץ הראשי חסר אך יש גיבוי
  }
}
if (!bank.settings) bank.settings = { invite: DEFAULT_INVITE };
if (typeof bank.house !== 'number') bank.house = 0;
if (!bank.requests) bank.requests = {};   // בקשות נקודות ממתינות (email -> {name, amount, at})
function writeBankSync() {
  const tmp = DATA_FILE + '.tmp';
  const json = JSON.stringify(bank, null, 2);
  fs.writeFileSync(tmp, json);          // כתיבה לקובץ זמני
  try { if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BAK_FILE); } catch (e) {}
  fs.renameSync(tmp, DATA_FILE);        // החלפה אטומית
}
let saveTimer = null, saveDirty = false;
function saveBank() {
  saveDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { writeBankSync(); saveDirty = false; } catch (e) { console.error('save failed', e); } }, 150);
}
function flushBank() {
  clearTimeout(saveTimer);
  if (saveDirty) { try { writeBankSync(); saveDirty = false; } catch (e) { console.error('flush failed', e); } }
}
function gracefulExit() {
  try { refundActiveGames(); } catch (e) { console.error('refund failed', e); }
  flushBank();
  process.exit(0);
}
process.on('exit', flushBank);
process.on('SIGTERM', gracefulExit);   // Render שולח SIGTERM בכל restart/deploy
process.on('SIGINT', gracefulExit);
process.on('uncaughtException', e => { console.error('uncaught', e); flushBank(); });
process.on('unhandledRejection', e => { console.error('unhandledRejection', e); });

const emailKey = e => String(e || '').trim().toLowerCase();
// נרמול שם תצוגה נגד התחזות (הומוגליפים/רווחים נסתרים)
const nameNorm = n => String(n || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
function findByName(name) {
  const n = nameNorm(name);
  return Object.values(bank.accounts).find(a => nameNorm(a.name) === n);
}
// גיבוב סיסמה אסינכרוני — לא חוסם את לולאת האירועים של השרת
function hashPass(pw, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(pw), salt, 64, (err, dk) => err ? reject(err) : resolve(dk.toString('hex'))));
}
function safeEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

/* ---------- אימות Google ID token (RS256 JWT, בלי ספריות) ---------- */
// אימות טהור וניתן-לבדיקה: חתימה + aud + iss + exp מול סט מפתחות נתון
function verifyJwtRS256(token, jwks, opts) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('jwt-format');
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const jwk = (jwks || []).find(k => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) throw new Error('jwt-kid');
  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), pub, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('jwt-sig');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const auds = Array.isArray(opts.aud) ? opts.aud : [opts.aud];
  if (!auds.includes(payload.aud)) throw new Error('jwt-aud');
  if (opts.iss && !opts.iss.includes(payload.iss)) throw new Error('jwt-iss');
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error('jwt-exp');
  return payload;
}
let googleKeys = { keys: [], exp: 0 };
async function getGoogleKeys() {
  if (Date.now() < googleKeys.exp && googleKeys.keys.length) return googleKeys.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  const data = await res.json();
  googleKeys = { keys: data.keys || [], exp: Date.now() + 3600 * 1000 };
  return googleKeys.keys;
}
async function verifyGoogleToken(idToken) {
  const keys = await getGoogleKeys();
  const payload = verifyJwtRS256(idToken, keys, {
    aud: GOOGLE_CLIENT_ID,
    iss: ['https://accounts.google.com', 'accounts.google.com'],
  });
  if (!payload.email || payload.email_verified === false) throw new Error('email');
  return payload;
}
function getBal(key) { const a = bank.accounts[key]; return a ? a.points : 0; }
function addBal(key, delta) {
  const a = bank.accounts[key];
  if (a) { a.points = Math.round((a.points + delta) * 2) / 2; saveBank(); }
}

/* ---------- מגביל קצב (נגד brute-force ו-DoS) ---------- */
// ה-IP האמיתי הוא הערך שהפרוקסי הנאמן (Render) מוסיף — הימני ב-XFF, לא השמאלי שהלקוח שולט בו
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (xff.length) return xff[xff.length - 1];
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
const rateBuckets = new Map();   // key -> { count, resetAt }
function rateLimit(key, max, windowMs) {
  if (FAST) return true;   // מצב בדיקות — בלי הגבלת קצב
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + windowMs }; rateBuckets.set(key, b); }
  b.count++;
  return b.count <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (now > b.resetAt) rateBuckets.delete(k);
}, 60 * 1000).unref();

/* ---------- סשנים (עם תפוגה) ---------- */
const SESSION_TTL = 30 * 24 * 3600 * 1000;   // 30 יום
const ADMIN_TTL = 6 * 3600 * 1000;           // 6 שעות
const sessions = new Map();       // token -> { key, exp }
const adminTokens = new Map();    // token -> exp
function newSession(key) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { key, exp: Date.now() + SESSION_TTL });
  return token;
}
function sessionAcct(token) {
  const s = sessions.get(token || '');
  if (!s) return null;
  if (Date.now() > s.exp) { sessions.delete(token); return null; }
  return bank.accounts[s.key] ? { key: s.key, acct: bank.accounts[s.key] } : null;
}
function isAdmin(token) {
  const exp = adminTokens.get(token || '');
  if (!exp) return false;
  if (Date.now() > exp) { adminTokens.delete(token); return false; }
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now > s.exp) sessions.delete(t);
  for (const [t, e] of adminTokens) if (now > e) adminTokens.delete(t);
}, 10 * 60 * 1000).unref();

/* ---------- קלפים ומנוע אומהה ---------- */
const SUITS = ['S', 'H', 'D', 'C'];
const RANK_CH = { 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'T',11:'J',12:'Q',13:'K',14:'A' };
function newDeck() {
  const d = [];
  for (let r = 2; r <= 14; r++) for (const s of SUITS) d.push({ r, s, id: RANK_CH[r] + s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
const HOLE2 = [];
for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) HOLE2.push([a, b]);
const BOARD3 = [];
for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) for (let c = b + 1; c < 5; c++) BOARD3.push([a, b, c]);

function evaluate5(cs) {
  const rs = cs.map(c => c.r).sort((a, b) => b - a);
  const isFlush = cs.every(c => c.s === cs[0].s);
  const cnt = {};
  for (const r of rs) cnt[r] = (cnt[r] || 0) + 1;
  const groups = Object.keys(cnt).map(r => [+r, cnt[r]])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const uniq = [...new Set(rs)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[1] - uniq[4] === 3) straightHigh = 5; // גלגל A-2-3-4-5
  }
  if (isFlush && straightHigh) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (isFlush) return [5, ...rs];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0][1] === 2) return [1, groups[0][0], groups[1][0], groups[2][0], groups[3][0]];
  return [0, ...rs];
}
function cmpScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}
const HAND_NAMES = ['קלף גבוה', 'זוג', 'שני זוגות', 'שלישייה', 'סטרייט', 'פלאש', 'פול האוס', 'רביעייה', 'סטרייט פלאש'];
function handName(score) {
  if (score[0] === 8 && score[1] === 14) return 'רויאל פלאש';
  return HAND_NAMES[score[0]];
}
function bestOmaha(hole, board) {
  let best = null;
  for (const [a, b] of HOLE2) {
    for (const [x, y, z] of BOARD3) {
      const five = [hole[a], hole[b], board[x], board[y], board[z]];
      const score = evaluate5(five);
      if (!best || cmpScore(score, best.score) > 0) best = { score, cards: five.map(c => c.id) };
    }
  }
  best.name = handName(best.score);
  return best;
}

/* ---------- חדרים ---------- */
const rooms = new Map();
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[crypto.randomInt(chars.length)];
  } while (rooms.has(code));
  return code;
}
function bump(room) {
  room.version++;
  room.touched = Date.now();
  const ws = room.waiters;
  room.waiters = [];
  for (const w of ws) { clearTimeout(w.timer); try { w.send(); } catch (e) { /* לקוח התנתק */ } }
}
// ניקוי חדרים נטושים (שעתיים ללא פעילות)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > 2 * 3600 * 1000) {
      clearTimers(room);
      for (const w of room.waiters) { clearTimeout(w.timer); try { w.send(); } catch (e) {} }
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

function schedule(room, ms, fn) {
  room.timers.push(setTimeout(() => { try { fn(); } catch (e) { console.error(e); } }, FAST ? Math.min(ms, 80) : ms));
}
function clearTimers(room) { room.timers.forEach(clearTimeout); room.timers = []; }

function createRoom(stake) {
  const s = STAKES[stake] || STAKES.low;
  const room = {
    code: makeCode(), version: 0, waiters: [], timers: [], game: 0, touched: Date.now(),
    stake: STAKES[stake] ? stake : 'low', entry: s.entry, fee: s.fee, practice: false,
    phase: 'waiting', round: 0, pot: 0,
    deck: [], board: [], revealed: 0,
    players: [], roundResult: null, results: [], settlement: null,
  };
  rooms.set(room.code, room);
  return room;
}
function addPlayer(room, acctKey, name, isBot) {
  const p = {
    id: crypto.randomBytes(8).toString('hex'),
    acct: acctKey, name, isBot: !!isBot,
    hole: [], wins: 0, delta: 0,
  };
  room.players.push(p);
  return p;
}
function ensureBot(name, need) {
  const key = 'bot:' + name;
  if (!bank.accounts[key]) {
    bank.accounts[key] = { email: null, name, points: 500, bot: true };
    saveBank();
  }
  if (bank.accounts[key].points < need) { bank.accounts[key].points = 500; saveBank(); }
  return key;
}

function startGame(room) {
  room.game++;
  if (!room.practice) {   // משחק אימון (עם דמו) — בלי נקודות ובלי עמלה
    for (const p of room.players) addBal(p.acct, -(room.entry + room.fee));
    bank.house = Math.round((bank.house + room.fee * room.players.length) * 2) / 2;
    saveBank();
  }
  room.pot = room.entry * room.players.length;
  room.deck = newDeck();
  for (const p of room.players) { p.hole = room.deck.splice(0, 4); p.wins = 0; p.delta = room.practice ? -room.entry : -(room.entry + room.fee); }
  room.round = 0; room.results = []; room.settlement = null;
  startRound(room);
}
function startRound(room) {
  clearTimers(room);   // כל טיימרי הסיבוב הקודם כבר ירו — ניקוי המערך
  room.round++;
  room.board = room.deck.splice(0, 5);   // הבורד הקודם נזרק — בלי ערבוב מחדש
  room.revealed = 0;
  room.phase = 'reveal';
  room.roundResult = null;
  bump(room);
  schedule(room, 900,  () => { room.revealed = 3; bump(room); });  // פלופ
  schedule(room, 2400, () => { room.revealed = 4; bump(room); });  // טרן
  schedule(room, 3900, () => { room.revealed = 5; bump(room); });  // ריבר
  schedule(room, 5300, () => resolveRound(room));
}
function resolveRound(room) {
  const evals = room.players.map(p => ({ p, best: bestOmaha(p.hole, room.board) }));
  let top = evals[0];
  for (const e of evals) if (cmpScore(e.best.score, top.best.score) > 0) top = e;
  const winners = evals.filter(e => cmpScore(e.best.score, top.best.score) === 0);
  const prize = room.pot / ROUNDS;                       // 50 נק' לסיבוב
  const base = Math.floor(prize / winners.length);
  winners.forEach((w, i) => {
    const share = base + (i < prize - base * winners.length ? 1 : 0);
    if (!room.practice) addBal(w.p.acct, share);
    w.p.delta += share;
    w.share = share;
  });
  if (winners.length === 1) winners[0].p.wins++;         // סוויפ נספר רק על ניצחון נקי
  room.roundResult = {
    winners: winners.map(w => ({ name: w.p.name, seat: room.players.indexOf(w.p), share: w.share })),
    handName: top.best.name,
    cards: winners.length === 1 ? top.best.cards : [],
  };
  room.results.push(room.roundResult);
  room.phase = 'result';
  bump(room);
  // התקדמות אוטומטית — כך שגם אם המארח ננטש/מתנתק, המשחק מסתיים ומשלם לכולם.
  // לחיצת "next" ידנית של המארח מקדימה את זה (startRound/finishGame מנקים את הטיימר).
  room.timers.push(setTimeout(() => {
    try { if (room.phase === 'result') advanceRound(room); } catch (e) { console.error(e); }
  }, FAST ? 60000 : AUTO_ADVANCE_MS));
}
function advanceRound(room) {
  if (room.round < ROUNDS) startRound(room); else finishGame(room);
}
function finishGame(room) {
  clearTimers(room);
  const sweeper = room.players.find(p => p.wins === ROUNDS);
  let sweep = null;
  if (sweeper) {
    let bonus = 0;
    for (const p of room.players) {
      if (p === sweeper) continue;
      // רצפת-אפס: לא לוקחים יותר ממה שיש לשחקן — אף אחד לא "גומר את עצמו" למינוס
      const take = room.practice ? room.entry : Math.min(room.entry, Math.max(0, getBal(p.acct)));
      if (!room.practice) addBal(p.acct, -take);
      p.delta -= take; bonus += take;
    }
    if (!room.practice) addBal(sweeper.acct, bonus);
    sweeper.delta += bonus;
    sweep = { name: sweeper.name, bonus };
  }
  room.settlement = {
    sweep,
    feeTotal: room.practice ? 0 : room.fee * room.players.length,
    rows: room.players
      .map(p => ({ name: p.name, delta: p.delta, balance: getBal(p.acct), wins: p.wins }))
      .sort((a, b) => b.delta - a.delta),
  };
  room.phase = 'over';
  bump(room);
}
// החזר את חלק-הקופה שלא חולק לשחקנים במשחקים שנקטעו (נקרא בכיבוי מסודר)
function refundActiveGames() {
  for (const room of rooms.values()) {
    if (room.practice) continue;
    if (room.phase !== 'reveal' && room.phase !== 'result') continue;
    const distributed = room.phase === 'result' ? room.round : room.round - 1;
    const remaining = ROUNDS - distributed;
    if (remaining <= 0) continue;
    const share = (room.pot / ROUNDS) * remaining / room.players.length;
    for (const p of room.players) addBal(p.acct, share);
    room.phase = 'over';   // מונע החזר כפול
  }
}
function rematch(room) {
  clearTimers(room);
  room.phase = 'waiting'; room.round = 0; room.pot = 0;
  room.board = []; room.revealed = 0; room.roundResult = null;
  room.results = []; room.settlement = null;
  for (const p of room.players) { p.hole = []; p.wins = 0; p.delta = 0; }
  bump(room);
}

function publicState(room, pid) {
  return {
    v: room.version, code: room.code, phase: room.phase,
    round: room.round, rounds: ROUNDS, pot: room.pot, entry: room.entry, fee: room.fee,
    stake: room.stake, seats: SEATS, game: room.game, practice: room.practice,
    board: room.board.slice(0, room.revealed).map(c => c.id),
    players: room.players.map((p, i) => ({
      seat: i, name: p.name, isBot: p.isBot,
      isHost: i === 0, me: p.id === pid,
      points: getBal(p.acct), wins: p.wins, delta: p.delta,
      hole: room.phase === 'waiting' ? [] : p.hole.map(c => c.id),
    })),
    result: room.roundResult,
    settlement: room.settlement,
  };
}

/* ---------- HTTP ---------- */
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', c => {
      if (tooBig) return;
      data += c;
      if (data.length > 2e5) { tooBig = true; const e = new Error('גוף גדול מדי'); e.tooBig = true; reject(e); req.destroy(); }
    });
    req.on('end', () => { if (tooBig) return; try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', e => { if (!tooBig) reject(e); });
  });
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data: https://*.googleusercontent.com; " +
    "connect-src 'self' https://accounts.google.com/gsi/; " +
    "frame-src https://accounts.google.com/gsi/; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  try {
    /* --- קבצים סטטיים (PWA) --- */
    if ((req.method === 'GET' || req.method === 'HEAD') && !u.pathname.startsWith('/api/')) {
      let rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
      const full = path.join(PUB, path.normalize(rel));
      const isHead = req.method === 'HEAD';
      const inside = full === PUB || full.startsWith(PUB + path.sep);
      if (inside && fs.existsSync(full) && fs.statSync(full).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
        return res.end(isHead ? undefined : fs.readFileSync(full));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(isHead ? undefined : fs.readFileSync(path.join(PUB, 'index.html')));
    }

    if (req.method === 'GET' && u.pathname === '/api/state') {
      const room = rooms.get((u.searchParams.get('code') || '').toUpperCase());
      if (!room) return json(res, 404, { error: 'החדר לא נמצא' });
      const pid = u.searchParams.get('pid') || '';
      const v = parseInt(u.searchParams.get('v') || '-1', 10);
      if (room.version > v) return json(res, 200, publicState(room, pid));
      const waiter = {
        send: () => json(res, 200, publicState(room, pid)),
        timer: setTimeout(() => {
          room.waiters = room.waiters.filter(w => w !== waiter);
          try { json(res, 200, publicState(room, pid)); } catch (e) { /* לקוח התנתק */ }
        }, 25000),
      };
      room.waiters.push(waiter);
      req.on('close', () => {
        clearTimeout(waiter.timer);
        room.waiters = room.waiters.filter(w => w !== waiter);
      });
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/config') {
      return json(res, 200, { googleClientId: GOOGLE_CLIENT_ID });   // מה זמין ללקוח
    }

    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
    let body;
    try { body = await readBody(req); }
    catch (e) {
      if (e.tooBig) return json(res, 413, { error: 'בקשה גדולה מדי' });
      return json(res, 400, { error: 'בקשה לא תקינה' });
    }
    const ip = clientIp(req);

    /* --- התחברות עם Google --- */
    if (u.pathname === '/api/google') {
      if (!GOOGLE_CLIENT_ID) return json(res, 400, { error: 'התחברות Google לא מוגדרת בשרת' });
      if (!rateLimit('google:' + ip, 30, 15 * 60 * 1000)) return json(res, 429, { error: 'יותר מדי נסיונות — נסה מאוחר יותר' });
      let payload;
      try { payload = await verifyGoogleToken(body.credential); }
      catch (e) { return json(res, 403, { error: 'אימות Google נכשל' }); }
      const email = emailKey(payload.email);
      let acct = bank.accounts[email];
      if (!acct) {
        // חשבון חדש דרך Google — עדיין דורש קוד הזמנה
        const invite = String(body.invite || '').trim();
        if (!safeEq(invite.toUpperCase(), String(bank.settings.invite).toUpperCase()))
          return json(res, 403, { error: 'הזדהית עם Google — עכשיו הקלד קוד הזמנה מהמנהל', needInvite: true });
        if (Object.keys(bank.accounts).length >= MAX_ACCOUNTS) return json(res, 400, { error: 'ההרשמה סגורה' });
        // שם תצוגה מ-Google, מקוצר וייחודי
        let base = String(payload.name || payload.email.split('@')[0]).replace(/\s+/g, ' ').trim().slice(0, 16) || 'שחקן';
        let name = base, n = 2;
        while (findByName(name)) { name = (base.slice(0, 13) + ' ' + n).slice(0, 16); n++; }
        acct = bank.accounts[email] = { email, name, google: true, points: 0, bot: false, created: Date.now() };
        saveBank();
      }
      return json(res, 200, { token: newSession(email), name: acct.name, email });
    }

    /* --- הרשמה והתחברות --- */
    if (u.pathname === '/api/register') {
      if (!rateLimit('reg:' + ip, 10, 3600 * 1000)) return json(res, 429, { error: 'יותר מדי נסיונות הרשמה — נסה מאוחר יותר' });
      const name = String(body.name || '').trim();
      const email = emailKey(body.email);
      const password = String(body.password || '');
      const invite = String(body.invite || '').trim();
      if (!EMAIL_RE.test(email) || email.length > 120) return json(res, 400, { error: 'כתובת אימייל לא תקינה' });
      if (name.length < 2 || name.length > 16 || name.startsWith('__') || name.startsWith('bot:'))
        return json(res, 400, { error: 'שם תצוגה: 2 עד 16 תווים' });
      if (password.length < 6 || password.length > 200) return json(res, 400, { error: 'סיסמה: 6 עד 200 תווים' });
      if (!safeEq(invite.toUpperCase(), String(bank.settings.invite).toUpperCase()))
        return json(res, 403, { error: 'קוד הזמנה שגוי — בקש קוד מהמנהל' });
      if (Object.keys(bank.accounts).length >= MAX_ACCOUNTS) return json(res, 400, { error: 'ההרשמה סגורה' });
      if (bank.accounts[email]) return json(res, 400, { error: 'האימייל כבר רשום — התחבר' });
      if (findByName(name)) return json(res, 400, { error: 'שם התצוגה תפוס' });
      const salt = crypto.randomBytes(16).toString('hex');
      const pass = await hashPass(password, salt);
      // בדיקה חוזרת אחרי ה-await (מונע כפילות במרוץ בין שתי הרשמות בו-זמנית)
      if (bank.accounts[email]) return json(res, 400, { error: 'האימייל כבר רשום — התחבר' });
      if (findByName(name)) return json(res, 400, { error: 'שם התצוגה תפוס' });
      bank.accounts[email] = { email, name, salt, pass, points: 0, bot: false, created: Date.now() };
      saveBank();
      return json(res, 200, { token: newSession(email), name, email });
    }

    if (u.pathname === '/api/login') {
      if (!rateLimit('login:' + ip, 20, 15 * 60 * 1000)) return json(res, 429, { error: 'יותר מדי נסיונות כניסה — המתן 15 דקות' });
      const email = emailKey(body.email);
      const acct = bank.accounts[email];
      const salt = acct && !acct.bot ? acct.salt : 'dummysaltdummysalt';
      const hash = await hashPass(body.password || '', salt);   // תמיד מחשב (מונע דליפת-תזמון)
      if (!acct || acct.bot || !safeEq(hash, acct.pass))
        return json(res, 403, { error: 'אימייל או סיסמה שגויים' });
      return json(res, 200, { token: newSession(email), name: acct.name, email });
    }

    /* --- חדרים (דורש התחברות) --- */
    if (u.pathname === '/api/create' || u.pathname === '/api/join' || u.pathname === '/api/rooms'
      || u.pathname === '/api/me' || u.pathname === '/api/request' || u.pathname === '/api/cancelrequest') {
      const s = sessionAcct(body.session);
      if (!s || !s.acct) return json(res, 401, { error: 'צריך להתחבר מחדש' });
      if (u.pathname === '/api/me') {
        const req = bank.requests[s.key];
        return json(res, 200, { name: s.acct.name, points: s.acct.points, email: s.acct.email, pendingRequest: req ? req.amount : 0 });
      }
      if (u.pathname === '/api/request') {   // שחקן מבקש נקודות מהמנהל
        if (!rateLimit('req:' + s.key, 5, 60 * 1000)) return json(res, 429, { error: 'רגע — כבר שלחת בקשה' });
        const amount = Math.round(Number(body.amount));
        if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) return json(res, 400, { error: 'סכום לא תקין' });
        bank.requests[s.key] = { name: s.acct.name, amount, at: Date.now() };
        saveBank();
        return json(res, 200, { ok: 1, amount });
      }
      if (u.pathname === '/api/cancelrequest') {
        if (bank.requests[s.key]) { delete bank.requests[s.key]; saveBank(); }
        return json(res, 200, { ok: 1 });
      }
      if (u.pathname === '/api/rooms') {   // שולחנות פתוחים ללובי
        const open = [];
        for (const room of rooms.values())
          if (room.phase === 'waiting' && room.players.length > 0 && room.players.length < SEATS)
            open.push({
              code: room.code, stake: room.stake, entry: room.entry, fee: room.fee,
              count: room.players.length, seats: SEATS,
              host: room.players[0].name, hasBots: room.players.some(p => p.isBot),
              t: room.touched,
            });
        open.sort((a, b) => b.t - a.t);
        return json(res, 200, { rooms: open.slice(0, 20).map(({ t, ...r }) => r) });
      }
      if (u.pathname === '/api/create') {
        if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'השרת עמוס — נסה שוב מאוחר יותר' });
        // מניעת הצפת חדרים: חשבון יכול לארח חדר פתוח אחד בו-זמנית
        for (const r of rooms.values())
          if (r.phase === 'waiting' && r.players[0] && r.players[0].acct === s.key)
            return json(res, 400, { error: 'כבר יש לך חדר פתוח' });
        const room = createRoom(body.stake);
        const p = addPlayer(room, s.key, s.acct.name);
        bump(room);
        return json(res, 200, { code: room.code, pid: p.id, name: s.acct.name });
      }
      const room = rooms.get(String(body.code || '').toUpperCase().trim());
      if (!room) return json(res, 404, { error: 'קוד חדר לא קיים' });
      if (room.phase !== 'waiting') return json(res, 400, { error: 'המשחק כבר התחיל' });
      if (room.players.length >= SEATS) return json(res, 400, { error: 'החדר מלא' });
      if (room.players.some(p => p.acct === s.key)) return json(res, 400, { error: 'אתה כבר בחדר הזה' });
      const p = addPlayer(room, s.key, s.acct.name);
      bump(room);
      return json(res, 200, { code: room.code, pid: p.id, name: s.acct.name });
    }

    /* --- ניהול --- */
    if (u.pathname === '/api/admin') {
      // הגנה כפולה: מגבלה לפי IP + מגבלה גלובלית (נגד עקיפה ע"י זיוף IP)
      if (!rateLimit('admin:' + ip, 5, 15 * 60 * 1000) || !rateLimit('admin:global', 30, 15 * 60 * 1000))
        return json(res, 429, { error: 'יותר מדי נסיונות — המתן 15 דקות' });
      if (!safeEq(body.pin || '', ADMIN_PIN)) return json(res, 403, { error: 'קוד שגוי' });
      const token = crypto.randomBytes(24).toString('hex');
      adminTokens.set(token, Date.now() + ADMIN_TTL);
      return json(res, 200, { token });
    }
    if (u.pathname === '/api/bank' || u.pathname === '/api/grant' || u.pathname === '/api/resetpass'
      || u.pathname === '/api/invite' || u.pathname === '/api/export' || u.pathname === '/api/import'
      || u.pathname === '/api/denyrequest') {
      if (!isAdmin(body.token)) return json(res, 403, { error: 'אין הרשאת מנהל' });

      if (u.pathname === '/api/bank') {
        const accounts = Object.entries(bank.accounts)
          .map(([key, a]) => ({ key, name: a.name, email: a.email, points: a.points, bot: !!a.bot }))
          .sort((a, b) => (a.bot - b.bot) || b.points - a.points);
        const requests = Object.entries(bank.requests)
          .map(([key, r]) => ({ key, name: r.name, amount: r.amount, at: r.at }))
          .sort((a, b) => a.at - b.at);
        return json(res, 200, { house: bank.house, invite: bank.settings.invite, accounts, requests });
      }
      if (u.pathname === '/api/denyrequest') {
        if (bank.requests[body.key || '']) { delete bank.requests[body.key]; saveBank(); }
        return json(res, 200, { ok: 1 });
      }
      if (u.pathname === '/api/grant') {
        const a = bank.accounts[body.key || ''];
        const amount = Math.round(Number(body.amount) * 2) / 2;
        if (!a || !Number.isFinite(amount) || amount === 0) return json(res, 400, { error: 'חשבון וסכום נדרשים' });
        if (body.fee5 && amount > 0) {
          // הפקדה: השחקן מקבל את הסכום המלא (עגול), והבית מרוויח 5% בנוסף
          const fee = Math.round(amount * 0.05 * 2) / 2;
          addBal(body.key, amount);
          bank.house = Math.round((bank.house + fee) * 2) / 2;
          if (bank.requests[body.key]) { delete bank.requests[body.key]; }   // מנקה בקשה ממתינה אם יש
          saveBank();
          return json(res, 200, { name: a.name, balance: a.points, credited: amount, fee });
        }
        addBal(body.key, amount);
        if (bank.requests[body.key]) { delete bank.requests[body.key]; saveBank(); }
        return json(res, 200, { name: a.name, balance: a.points });
      }
      if (u.pathname === '/api/resetpass') {
        const a = bank.accounts[body.key || ''];
        const password = String(body.password || '');
        if (!a || a.bot) return json(res, 404, { error: 'חשבון לא נמצא' });
        if (password.length < 6 || password.length > 200) return json(res, 400, { error: 'סיסמה: 6 עד 200 תווים' });
        a.salt = crypto.randomBytes(16).toString('hex');
        a.pass = await hashPass(password, a.salt);
        saveBank();
        return json(res, 200, { ok: 1, name: a.name });
      }
      if (u.pathname === '/api/invite') {
        const code = String(body.code || '').trim();
        if (code.length < 4 || code.length > 20) return json(res, 400, { error: 'קוד הזמנה: 4 עד 20 תווים' });
        bank.settings.invite = code;
        saveBank();
        return json(res, 200, { invite: code });
      }
      if (u.pathname === '/api/export') return json(res, 200, { data: bank });
      if (u.pathname === '/api/import') {
        const d = body.data;
        if (!d || typeof d.accounts !== 'object' || d.accounts === null || !d.settings)
          return json(res, 400, { error: 'קובץ גיבוי לא תקין' });
        // ולידציה קשיחה: כל חשבון חייב מבנה תקין ונקודות מספריות סופיות
        const clean = {};
        for (const [key, a] of Object.entries(d.accounts)) {
          if (!a || typeof a !== 'object') return json(res, 400, { error: 'חשבון פגום בגיבוי' });
          const points = Math.round(Number(a.points) * 2) / 2;   // עיגול לחצי-נקודה
          if (!Number.isFinite(points)) return json(res, 400, { error: 'יתרה לא תקינה בגיבוי' });
          if (typeof a.name !== 'string' || !a.name.trim()) return json(res, 400, { error: 'שם חסר בגיבוי' });
          clean[key] = a.bot
            ? { email: null, name: a.name, points, bot: true }
            : { email: a.email || null, name: a.name, salt: String(a.salt || ''), pass: String(a.pass || ''),
                points, bot: false, created: a.created || Date.now() };
        }
        const invite = String((d.settings && d.settings.invite) || DEFAULT_INVITE);
        const house = Number(d.house);
        bank = { accounts: clean, settings: { invite }, house: Number.isFinite(house) && house >= 0 ? house : 0, requests: {} };
        saveBank();
        return json(res, 200, { ok: 1, count: Object.keys(bank.accounts).length });
      }
    }

    /* --- פעולות משחק --- */
    if (u.pathname === '/api/action') {
      const room = rooms.get(String(body.code || '').toUpperCase());
      if (!room) return json(res, 404, { error: 'החדר לא נמצא' });
      const player = room.players.find(p => p.id === body.pid);
      if (!player) return json(res, 403, { error: 'שחקן לא מזוהה' });
      // קשירת סשן: הפעולה חייבת להגיע מהחשבון שיושב במושב הזה
      const s = sessionAcct(body.session);
      if (!s || s.key !== player.acct) return json(res, 403, { error: 'צריך להתחבר מחדש' });
      const isHost = room.players[0] === player;
      const t = body.type;

      if (t === 'fillDemo') {
        if (!isHost || room.phase !== 'waiting') return json(res, 400, { error: 'לא זמין' });
        for (const n of ['רוני (דמו)', 'מאיה (דמו)', 'עומר (דמו)']) {
          if (room.players.length >= SEATS) break;
          const key = ensureBot(n, room.entry + room.fee);
          if (!room.players.some(p => p.acct === key)) addPlayer(room, key, n, true);
        }
        bump(room);
        return json(res, 200, { ok: 1 });
      }
      if (t === 'start') {
        if (!isHost || room.phase !== 'waiting') return json(res, 400, { error: 'לא זמין' });
        if (room.players.length !== SEATS) return json(res, 400, { error: `צריך בדיוק ${SEATS} שחקנים` });
        room.practice = room.players.some(p => p.isBot);   // דמו בשולחן = משחק אימון בלי נקודות
        if (!room.practice) {
          const poor = room.players.filter(p => getBal(p.acct) < room.entry + room.fee);
          if (poor.length) return json(res, 400, { error: `אין מספיק נקודות (צריך ${room.entry + room.fee}) ל: ` + poor.map(p => p.name).join(', ') });
        }
        startGame(room);
        return json(res, 200, { ok: 1 });
      }
      if (t === 'leave') {
        if (room.phase === 'waiting' || room.phase === 'over') {
          room.players = room.players.filter(p => p !== player);
          if (!room.players.length || room.players.every(p => p.isBot)) {
            clearTimers(room);
            bump(room);
            rooms.delete(room.code);
          } else bump(room);
        }
        return json(res, 200, { ok: 1 });
      }
      if (t === 'next') {
        if (!isHost || room.phase !== 'result') return json(res, 400, { error: 'לא זמין' });
        if (room.round < ROUNDS) startRound(room); else finishGame(room);
        return json(res, 200, { ok: 1 });
      }
      if (t === 'rematch') {
        if (!isHost || room.phase !== 'over') return json(res, 400, { error: 'לא זמין' });
        rematch(room);
        return json(res, 200, { ok: 1 });
      }
      return json(res, 400, { error: 'פעולה לא מוכרת' });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: 'שגיאת שרת' });
  }
});

if (require.main === module) {
  if (ADMIN_PIN === '1302' && process.env.NODE_ENV === 'production')
    console.warn('⚠️  אזהרה: ADMIN_PIN הוא ברירת המחדל! הגדר ADMIN_PIN חזק במשתני הסביבה.');
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`OMAHA OPEN רץ על http://localhost:${PORT}`);
    const os = require('os');
    for (const list of Object.values(os.networkInterfaces()))
      for (const ni of list)
        if (ni.family === 'IPv4' && !ni.internal)
          console.log(`ברשת המקומית: http://${ni.address}:${PORT}`);
  });
}
module.exports = { evaluate5, bestOmaha, cmpScore, newDeck, verifyJwtRS256 };
