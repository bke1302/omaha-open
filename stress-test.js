/* בדיקת עומס: הרבה שחקנים אמיתיים משחקים במקביל אחד נגד השני,
   כולל מרוצי-תנאי (race conditions) שמדמים לחיצות בו-זמניות */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

let failures = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failures++; };

const TEST_DATA = path.join(os.tmpdir(), 'omaha-stress-' + process.pid + '.json');
try { fs.unlinkSync(TEST_DATA); } catch (e) {}
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: { ...process.env, PORT: '3779', FAST: '1', ADMIN_PIN: '9999', DATA_FILE: TEST_DATA },
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', d => console.error('SRV-ERR:', String(d)));

const API = 'http://localhost:3779';
const post = async (p, body) => {
  const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body: j };
};
const P = async (p, body) => { const r = await post(p, body); if (!r.ok) throw new Error(p + ': ' + r.body.error); return r.body; };
const getState = async (code, v) => (await fetch(`${API}/api/state?code=${code}&v=${v ?? -1}`)).json();
const waitPhase = async (code, phase, round) => {
  for (let i = 0; i < 400; i++) {
    const st = await getState(code);
    if (st.phase === phase && (round === undefined || st.round === round)) return st;
    await new Promise(r => setTimeout(r, 40));
  }
  throw new Error('timeout ' + phase + ' r' + round);
};

async function makeUser(token, name, email, pts) {
  const r = await P('/api/register', { name, email, password: 'pass_' + name, invite: 'OMAHA1' });
  if (pts) await P('/api/grant', { token, key: email, amount: pts });
  return r;
}
// משחק מלא אוטומטי בין 4 שחקנים אמיתיים, מחזיר את הסיכום
async function playFullGame(host, others, stake) {
  const room = await P('/api/create', { session: host.token, stake });
  for (const o of others) await P('/api/join', { session: o.token, code: room.code });
  await P('/api/action', { code: room.code, pid: room.pid, session: host.token, type: 'start' });
  for (let round = 1; round <= 4; round++) {
    await waitPhase(room.code, 'result', round);
    await P('/api/action', { code: room.code, pid: room.pid, session: host.token, type: 'next' });
  }
  return { code: room.code, over: await waitPhase(room.code, 'over') };
}

(async () => {
  await new Promise(r => setTimeout(r, 700));
  const { token } = await P('/api/admin', { pin: '9999' });

  // ---- 1) 5 שולחנות (20 שחקנים) משחקים בו-זמנית ----
  console.log('--- 20 שחקנים, 5 שולחנות במקביל ---');
  const users = [];
  for (let i = 0; i < 20; i++) users.push(await makeUser(token, 'P' + i, `p${i}@t.co`, 500));
  const startBank = await P('/api/bank', { token });
  const startTotal = startBank.accounts.filter(a => !a.bot).reduce((s, a) => s + a.points, 0) + startBank.house;

  const games = [];
  for (let t = 0; t < 5; t++) {
    const four = users.slice(t * 4, t * 4 + 4);
    games.push(playFullGame(four[0], four.slice(1), t % 2 ? 'high' : 'low'));
  }
  const results = await Promise.all(games);
  ok(results.every(r => r.over.settlement && r.over.settlement.rows.length === 4), 'כל 5 המשחקים המקבילים הסתיימו תקין');

  // בדיקת שימור-כסף גלובלי: סך הנקודות + עמלות = ללא שינוי
  const endBank = await P('/api/bank', { token });
  const endTotal = endBank.accounts.filter(a => !a.bot).reduce((s, a) => s + a.points, 0) + endBank.house;
  ok(startTotal === endTotal, `שימור כסף מוחלט: התחלה ${startTotal} = סוף ${endTotal}`);
  // עמלות בית: 5 משחקים × (10 low / 20 high) = 3 low + 2 high = 30+40 = 70
  ok(endBank.house === 70, `עמלות בית מדויקות: ${endBank.house} (צפוי 70)`);

  // ---- 2) מרוץ: 5 שחקנים מנסים לתפוס מושב אחרון בו-זמנית ----
  console.log('--- race: תפיסת מושב אחרון ---');
  const rc = await makeUser(token, 'RaceHost', 'rh@t.co', 500);
  const racers = [];
  for (let i = 0; i < 5; i++) racers.push(await makeUser(token, 'R' + i, `r${i}@t.co`, 500));
  const raceRoom = await P('/api/create', { session: rc.token, stake: 'low' });
  const joins = await Promise.all(racers.map(r => post('/api/join', { session: r.token, code: raceRoom.code })));
  const okJoins = joins.filter(j => j.ok).length;
  const stRace = await getState(raceRoom.code);
  ok(stRace.players.length === 4, `בדיוק 4 שחקנים בחדר אחרי מרוץ (${stRace.players.length})`);
  ok(okJoins === 3, `בדיוק 3 הצטרפויות הצליחו, השאר נדחו (${okJoins})`);

  // ---- 3) מרוץ: המארח לוחץ start פעמיים במהירות ----
  console.log('--- race: start כפול ---');
  const dbl = await Promise.all([
    post('/api/action', { code: raceRoom.code, pid: raceRoom.pid, session: rc.token, type: 'start' }),
    post('/api/action', { code: raceRoom.code, pid: raceRoom.pid, session: rc.token, type: 'start' }),
  ]);
  ok(dbl.filter(r => r.ok).length === 1, 'start כפול — רק אחד הצליח');
  const balAfterStart = (await P('/api/bank', { token })).accounts.find(a => a.key === 'rh@t.co').points;
  ok(balAfterStart === 500 - 52.5, `כניסה נוכתה פעם אחת בלבד (${balAfterStart})`);

  // ---- 4) מרוץ: next כפול בסיבוב ----
  console.log('--- race: next כפול ---');
  await waitPhase(raceRoom.code, 'result', 1);
  const nx = await Promise.all([
    post('/api/action', { code: raceRoom.code, pid: raceRoom.pid, session: rc.token, type: 'next' }),
    post('/api/action', { code: raceRoom.code, pid: raceRoom.pid, session: rc.token, type: 'next' }),
  ]);
  ok(nx.filter(r => r.ok).length === 1, 'next כפול — רק אחד הצליח (אין דילוג סיבוב)');
  const stAfterNext = await getState(raceRoom.code);
  ok(stAfterNext.round === 2, `סיבוב התקדם ל-2 בדיוק, לא קפץ (${stAfterNext.round})`);

  // ---- 5) שחקן מנסה לעזוב באמצע משחק (התחמקות מסוויפ) ----
  console.log('--- שחקן עוזב באמצע משחק ---');
  await post('/api/action', { code: raceRoom.code, pid: raceRoom.pid, session: rc.token, type: 'leave' });
  // המארח מנסה לעזוב באמצע — צריך להיות no-op (phase=result/reveal)
  const stAfterLeave = await getState(raceRoom.code);
  ok(stAfterLeave.players.length === 4, `עזיבה באמצע משחק לא מסירה שחקן (${stAfterLeave.players.length})`);

  // ---- 6) 10 משחקים ברצף על אותו חדר (rematch) — יציבות טיימרים ----
  console.log('--- 10 משחקים ברצף (rematch) ---');
  const seq = await makeUser(token, 'SeqHost', 'sh@t.co', 5000);
  const seqOthers = [];
  for (let i = 0; i < 3; i++) seqOthers.push(await makeUser(token, 'SO' + i, `so${i}@t.co`, 5000));
  const seqRoom = await P('/api/create', { session: seq.token, stake: 'low' });
  for (const o of seqOthers) await P('/api/join', { session: o.token, code: seqRoom.code });
  let seqOk = true;
  for (let g = 0; g < 10; g++) {
    await P('/api/action', { code: seqRoom.code, pid: seqRoom.pid, session: seq.token, type: 'start' });
    for (let round = 1; round <= 4; round++) {
      const st = await waitPhase(seqRoom.code, 'result', round);
      if (st.board.length !== 5) seqOk = false;
      await P('/api/action', { code: seqRoom.code, pid: seqRoom.pid, session: seq.token, type: 'next' });
    }
    await waitPhase(seqRoom.code, 'over');
    await P('/api/action', { code: seqRoom.code, pid: seqRoom.pid, session: seq.token, type: 'rematch' });
  }
  ok(seqOk, '10 משחקים רצופים — כל הבורדים תקינים, אין דליפת טיימרים');
  const seqBankTotal = (await P('/api/bank', { token })).accounts
    .filter(a => ['sh@t.co','so0@t.co','so1@t.co','so2@t.co'].includes(a.key))
    .reduce((s, a) => s + a.points, 0);
  ok(seqBankTotal === 4 * 5000 - 10 * 4 * 2.5, `שימור כסף אחרי 10 משחקים: ${seqBankTotal} (צפוי ${4*5000 - 10*4*2.5})`);

  // ---- 7) מרוץ: שתי הרשמות בו-זמנית עם אותו שם ----
  console.log('--- race: הרשמה כפולה עם אותו שם ---');
  const nr = await Promise.all([
    post('/api/register', { name: 'Impostor', email: 'imp1@t.co', password: 'pass_imp', invite: 'OMAHA1' }),
    post('/api/register', { name: 'Impostor', email: 'imp2@t.co', password: 'pass_imp', invite: 'OMAHA1' }),
  ]);
  ok(nr.filter(r => r.ok).length === 1, `הרשמה כפולה עם אותו שם בו-זמנית — רק אחת עברה (${nr.filter(r => r.ok).length})`);

  console.log(failures ? `\n*** ${failures} FAILURES ***` : '\n*** STRESS TEST PASSED ***');
  srv.kill();
  try { fs.unlinkSync(TEST_DATA); } catch (e) {}
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('STRESS ERROR:', e.stack || e.message); srv.kill(); process.exit(1); });
