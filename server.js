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
const DEFAULT_INVITE = 'OMAHA1';

/* ---------- בנק וחשבונות (נשמר לקובץ) ---------- */
let bank = { accounts: {}, settings: { invite: DEFAULT_INVITE }, house: 0 };
try {
  const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (loaded && loaded.accounts) bank = loaded;
} catch (e) { /* קובץ חדש */ }
let saveTimer = null;
function saveBank() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(DATA_FILE, JSON.stringify(bank, null, 2)), 150);
}
process.on('exit', () => { clearTimeout(saveTimer); try { fs.writeFileSync(DATA_FILE, JSON.stringify(bank, null, 2)); } catch (e) {} });

const emailKey = e => String(e || '').trim().toLowerCase();
function findByName(name) {
  const n = String(name || '').trim().toLowerCase();
  return Object.values(bank.accounts).find(a => a.name.trim().toLowerCase() === n);
}
function hashPass(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString('hex'); }
function safeEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function getBal(key) { const a = bank.accounts[key]; return a ? a.points : 0; }
function addBal(key, delta) {
  const a = bank.accounts[key];
  if (a) { a.points = Math.round((a.points + delta) * 2) / 2; saveBank(); }
}

/* ---------- סשנים ---------- */
const sessions = new Map();   // token -> accountKey
function newSession(key) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, key);
  return token;
}
function sessionAcct(token) {
  const key = sessions.get(token || '');
  return key ? { key, acct: bank.accounts[key] } : null;
}
const adminTokens = new Set();

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
    stake: STAKES[stake] ? stake : 'low', entry: s.entry, fee: s.fee,
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
  for (const p of room.players) addBal(p.acct, -(room.entry + room.fee));
  bank.house = Math.round((bank.house + room.fee * room.players.length) * 2) / 2;
  saveBank();
  room.pot = room.entry * room.players.length;
  room.deck = newDeck();
  for (const p of room.players) { p.hole = room.deck.splice(0, 4); p.wins = 0; p.delta = -(room.entry + room.fee); }
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
    addBal(w.p.acct, share);
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
}
function finishGame(room) {
  clearTimers(room);
  const sweeper = room.players.find(p => p.wins === ROUNDS);
  let sweep = null;
  if (sweeper) {
    let bonus = 0;
    for (const p of room.players) {
      if (p === sweeper) continue;
      addBal(p.acct, -room.entry); p.delta -= room.entry; bonus += room.entry;
    }
    addBal(sweeper.acct, bonus); sweeper.delta += bonus;
    sweep = { name: sweeper.name, bonus };
  }
  room.settlement = {
    sweep,
    feeTotal: room.fee * room.players.length,
    rows: room.players
      .map(p => ({ name: p.name, delta: p.delta, balance: getBal(p.acct), wins: p.wins }))
      .sort((a, b) => b.delta - a.delta),
  };
  room.phase = 'over';
  bump(room);
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
    stake: room.stake, seats: SEATS, game: room.game,
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
    req.on('data', c => { data += c; if (data.length > 2e5) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
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
  try {
    /* --- קבצים סטטיים (PWA) --- */
    if ((req.method === 'GET' || req.method === 'HEAD') && !u.pathname.startsWith('/api/')) {
      let rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
      const full = path.join(PUB, path.normalize(rel));
      const isHead = req.method === 'HEAD';
      if (full.startsWith(PUB) && fs.existsSync(full) && fs.statSync(full).isFile()) {
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
          json(res, 200, publicState(room, pid));
        }, 25000),
      };
      room.waiters.push(waiter);
      req.on('close', () => {
        clearTimeout(waiter.timer);
        room.waiters = room.waiters.filter(w => w !== waiter);
      });
      return;
    }

    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
    const body = await readBody(req);

    /* --- הרשמה והתחברות --- */
    if (u.pathname === '/api/register') {
      const name = String(body.name || '').trim();
      const email = emailKey(body.email);
      const password = String(body.password || '');
      const invite = String(body.invite || '').trim();
      if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'כתובת אימייל לא תקינה' });
      if (name.length < 2 || name.length > 16 || name.startsWith('__') || name.startsWith('bot:'))
        return json(res, 400, { error: 'שם תצוגה: 2 עד 16 תווים' });
      if (password.length < 6) return json(res, 400, { error: 'סיסמה: לפחות 6 תווים' });
      if (!safeEq(invite.toUpperCase(), String(bank.settings.invite).toUpperCase()))
        return json(res, 403, { error: 'קוד הזמנה שגוי — בקש קוד מהמנהל' });
      if (Object.keys(bank.accounts).length >= MAX_ACCOUNTS) return json(res, 400, { error: 'ההרשמה סגורה' });
      if (bank.accounts[email]) return json(res, 400, { error: 'האימייל כבר רשום — התחבר' });
      if (findByName(name)) return json(res, 400, { error: 'שם התצוגה תפוס' });
      const salt = crypto.randomBytes(16).toString('hex');
      bank.accounts[email] = { email, name, salt, pass: hashPass(password, salt), points: 0, bot: false, created: Date.now() };
      saveBank();
      return json(res, 200, { token: newSession(email), name, email });
    }

    if (u.pathname === '/api/login') {
      const email = emailKey(body.email);
      const acct = bank.accounts[email];
      if (!acct || acct.bot || !safeEq(hashPass(body.password || '', acct.salt), acct.pass))
        return json(res, 403, { error: 'אימייל או סיסמה שגויים' });
      return json(res, 200, { token: newSession(email), name: acct.name, email });
    }

    /* --- חדרים (דורש התחברות) --- */
    if (u.pathname === '/api/create' || u.pathname === '/api/join') {
      const s = sessionAcct(body.session);
      if (!s || !s.acct) return json(res, 401, { error: 'צריך להתחבר מחדש' });
      if (u.pathname === '/api/create') {
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
      if (!safeEq(body.pin || '', ADMIN_PIN)) return json(res, 403, { error: 'קוד שגוי' });
      const token = crypto.randomBytes(16).toString('hex');
      adminTokens.add(token);
      return json(res, 200, { token });
    }
    if (u.pathname === '/api/bank' || u.pathname === '/api/grant' || u.pathname === '/api/resetpass'
      || u.pathname === '/api/invite' || u.pathname === '/api/export' || u.pathname === '/api/import') {
      if (!adminTokens.has(body.token || '')) return json(res, 403, { error: 'אין הרשאת מנהל' });

      if (u.pathname === '/api/bank') {
        const accounts = Object.entries(bank.accounts)
          .map(([key, a]) => ({ key, name: a.name, email: a.email, points: a.points, bot: !!a.bot }))
          .sort((a, b) => (a.bot - b.bot) || b.points - a.points);
        return json(res, 200, { house: bank.house, invite: bank.settings.invite, accounts });
      }
      if (u.pathname === '/api/grant') {
        const a = bank.accounts[body.key || ''];
        const amount = Number(body.amount);
        if (!a || !Number.isFinite(amount) || amount === 0) return json(res, 400, { error: 'חשבון וסכום נדרשים' });
        addBal(body.key, Math.round(amount * 2) / 2);
        return json(res, 200, { name: a.name, balance: a.points });
      }
      if (u.pathname === '/api/resetpass') {
        const a = bank.accounts[body.key || ''];
        const password = String(body.password || '');
        if (!a || a.bot) return json(res, 404, { error: 'חשבון לא נמצא' });
        if (password.length < 6) return json(res, 400, { error: 'סיסמה: לפחות 6 תווים' });
        a.salt = crypto.randomBytes(16).toString('hex');
        a.pass = hashPass(password, a.salt);
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
        if (!d || typeof d.accounts !== 'object' || !d.settings) return json(res, 400, { error: 'קובץ גיבוי לא תקין' });
        bank = { accounts: d.accounts, settings: d.settings, house: Number(d.house) || 0 };
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
        const poor = room.players.filter(p => getBal(p.acct) < room.entry + room.fee);
        if (poor.length) return json(res, 400, { error: `אין מספיק נקודות (צריך ${room.entry + room.fee}) ל: ` + poor.map(p => p.name).join(', ') });
        startGame(room);
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
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`OMAHA OPEN רץ על http://localhost:${PORT}`);
    const os = require('os');
    for (const list of Object.values(os.networkInterfaces()))
      for (const ni of list)
        if (ni.family === 'IPv4' && !ni.internal)
          console.log(`ברשת המקומית: http://${ni.address}:${PORT}`);
  });
}
module.exports = { evaluate5, bestOmaha, cmpScore, newDeck };
