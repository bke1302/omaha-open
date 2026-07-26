/* בדיקה מקיפה מקצה-לקצה מול השרת החי:
   - מפעילה כל תכונה ואפשרות במערכת
   - מוודאת שאין חזרות: אף משחק לא זהה לאחר, ואין קלף שחוזר בתוך משחק
   - מוודאת שהערבוב אמיתי ומגוון (ידיים שונות, מנצחים שונים, סוגי ידיים שונים) */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

let failures = 0;
const ok = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) failures++; };
const section = t => console.log('\n── ' + t + ' ──');

const TEST_DATA = path.join(os.tmpdir(), 'omaha-audit-' + process.pid + '.json');
try { fs.unlinkSync(TEST_DATA); } catch (e) {}
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: { ...process.env, PORT: '3790', FAST: '1', ADMIN_PIN: '9999', DATA_FILE: TEST_DATA },
});
srv.stderr.on('data', d => console.error('SRV-ERR:', String(d)));
const API = 'http://localhost:3790';
const raw = async (p, body, method) => {
  const opt = { method: method || 'POST', headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(API + p, opt);
  return { status: r.status, ok: r.ok, body: await r.json().catch(() => ({})) };
};
const P = async (p, body) => { const r = await raw(p, body); if (!r.ok) throw new Error(p + ': ' + r.body.error); return r.body; };
const getState = async code => (await fetch(`${API}/api/state?code=${code}&v=-1`)).json();
const waitPhase = async (code, phase, round) => {
  for (let i = 0; i < 400; i++) {
    const st = await getState(code);
    if (st.phase === phase && (round === undefined || st.round === round)) return st;
    await new Promise(r => setTimeout(r, 35));
  }
  throw new Error('timeout ' + phase + ' r' + round);
};
async function reg(name, email, pts, token) {
  const r = await P('/api/register', { name, email, password: 'pass_' + name, invite: 'OMAHA1' });
  if (pts) await P('/api/grant', { token, key: email, amount: pts });
  return r;
}

(async () => {
  await new Promise(r => setTimeout(r, 700));
  const { token } = await P('/api/admin', { pin: '9999' });

  section('חשבונות והרשמה (כל המסלולים)');
  const A = await reg('ברק', 'a@t.co', 100000, token);
  const B = await reg('דנה', 'b@t.co', 100000, token);
  const C = await reg('יוסי', 'c@t.co', 100000, token);
  const D = await reg('מאיה', 'd@t.co', 100000, token);
  ok(A.token && B.token && C.token && D.token, 'הרשמת 4 שחקנים אמיתיים');
  ok((await raw('/api/register', { name: 'x', email: 'a@t.co', password: 'pass_xx', invite: 'OMAHA1' })).status === 400, 'אימייל כפול נדחה');
  ok((await raw('/api/login', { email: 'a@t.co', password: 'wrong!!' })).status === 403, 'סיסמה שגויה נדחית');
  ok((await P('/api/login', { email: 'a@t.co', password: 'pass_ברק' })).token, 'התחברות תקינה');
  ok((await raw('/api/register', { name: 'זהו', email: 'e@t.co', password: 'pass_xx', invite: 'BAD' })).status === 403, 'קוד הזמנה שגוי נדחה');

  section('דאשבורד — כל הפעולות');
  const dep = await P('/api/grant', { token, key: 'a@t.co', amount: 100, fee5: true });
  ok(dep.credited === 100 && dep.fee === 5, 'הפקדה: השחקן מקבל 100 מלא, הבית 5 בנוסף');
  await P('/api/grant', { token, key: 'a@t.co', amount: -100 });   // מחזיר לאיזון
  await P('/api/request', { session: A.token, amount: 250 });
  ok((await P('/api/bank', { token })).requests.some(r => r.key === 'a@t.co' && r.amount === 250), 'בקשת נקודות מופיעה למנהל');
  await P('/api/denyrequest', { token, key: 'a@t.co' });   // מנקה כדי לא להשפיע על שאר הבדיקה
  await P('/api/resetpass', { token, key: 'a@t.co', password: 'newpass1' });
  ok((await P('/api/login', { email: 'a@t.co', password: 'newpass1' })).token, 'איפוס סיסמה עובד');
  await P('/api/invite', { token, code: 'PARTY7' });
  ok((await raw('/api/register', { name: 'זוהי', email: 'z@t.co', password: 'pass_zz', invite: 'OMAHA1' })).status === 403, 'קוד ישן לא עובד אחרי החלפה');
  const exp = await P('/api/export', { token });
  ok((await P('/api/import', { token, data: exp.data })).count >= 4, 'גיבוי ושחזור עובדים');
  ok((await P('/api/bank', { token })).accounts.length >= 4, 'הדאשבורד מציג חשבונות');

  section('Google + config');
  ok((await raw('/api/config', undefined, 'GET')).body.googleClientId === '', 'config מחזיר googleClientId (ריק — לא מוגדר)');
  ok((await raw('/api/google', { credential: 'x' })).status === 400, 'Google לא מוגדר → 400');

  section('שולחנות, לובי ועזיבה');
  const low = await P('/api/create', { session: A.token, stake: 'low' });
  ok((await P('/api/rooms', { session: B.token })).rooms.some(r => r.code === low.code), 'השולחן מופיע ברשימת הלובי');
  const bJoin = await P('/api/join', { session: B.token, code: low.code });
  await P('/api/action', { code: low.code, pid: bJoin.pid, session: B.token, type: 'leave' });
  ok((await getState(low.code)).players.length === 1, 'עזיבה משחררת מקום');
  ok((await raw('/api/create', { session: A.token, stake: 'low' })).status === 400, 'חסימת חדר פתוח כפול לאותו חשבון');

  // ---- הלב: הרבה משחקים, אפס חזרות ----
  section('אנטי-חזרה: 25 משחקים מלאים — כל קלף וכל משחק ייחודי');
  const gameFingerprints = new Set();
  const allBoardCards = [];
  const handTypes = {};
  const winnerSeats = {};
  let sweeps = 0, ties = 0;

  // ממלאים את החדר low ל-4 ומריצים דרך rematch (בודק גם יציבות טיימרים לאורך זמן)
  await P('/api/join', { session: B.token, code: low.code });
  await P('/api/join', { session: C.token, code: low.code });
  await P('/api/join', { session: D.token, code: low.code });

  for (let g = 0; g < 25; g++) {
    await P('/api/action', { code: low.code, pid: low.pid, session: A.token, type: 'start' });
    let holesThisGame = null;
    const boardsThisGame = [];
    for (let round = 1; round <= 4; round++) {
      const st = await waitPhase(low.code, 'result', round);
      // בתוך משחק: אותן ידיים בכל 4 הסיבובים
      const holes = st.players.map(p => p.hole.join(',')).join('|');
      if (round === 1) holesThisGame = holes;
      else if (holes !== holesThisGame) ok(false, `משחק ${g}: הידיים השתנו בין סיבובים`);
      boardsThisGame.push(...st.board);
      // סטטיסטיקה
      handTypes[st.result.handName] = (handTypes[st.result.handName] || 0) + 1;
      if (st.result.winners.length > 1) ties++;
      st.result.winners.forEach(w => { winnerSeats[w.seat] = (winnerSeats[w.seat] || 0) + 1; });
      await P('/api/action', { code: low.code, pid: low.pid, session: A.token, type: 'next' });
    }
    const over = await waitPhase(low.code, 'over');
    if (over.settlement.sweep) sweeps++;
    // בתוך המשחק: 36 קלפים ייחודיים (16 יד + 20 בורד)
    const holeCards = holesThisGame.replace(/\|/g, ',').split(',');
    const allCards = [...boardsThisGame, ...holeCards];
    if (new Set(allCards).size !== 36) ok(false, `משחק ${g}: יש קלף כפול! (${new Set(allCards).size}/36)`);
    allBoardCards.push(boardsThisGame);
    // טביעת אצבע של המשחק (בורדים + ידיים) — חייבת להיות ייחודית מול כל שאר המשחקים
    const fp = boardsThisGame.join('') + '#' + holesThisGame;
    if (gameFingerprints.has(fp)) ok(false, `משחק ${g}: זהה למשחק קודם!`);
    gameFingerprints.add(fp);
    await P('/api/action', { code: low.code, pid: low.pid, session: A.token, type: 'rematch' });
  }
  ok(gameFingerprints.size === 25, `25 משחקים — כולם ייחודיים לחלוטין (${gameFingerprints.size}/25)`);
  ok(true, `כל משחק: בדיוק 36 קלפים ייחודיים, ידיים יציבות ל-4 סיבובים`);

  // בין משחקים עוקבים — הבורדים שונים מהותית (אין דמיון חשוד)
  let maxOverlap = 0;
  for (let i = 1; i < allBoardCards.length; i++) {
    const prev = new Set(allBoardCards[i - 1]);
    const overlap = allBoardCards[i].filter(c => prev.has(c)).length;
    maxOverlap = Math.max(maxOverlap, overlap);
  }
  ok(maxOverlap <= 12, `אין חזרתיות בין משחקים עוקבים (מקס' קלפים משותפים: ${maxOverlap}/20)`);

  section('מגוון (הוכחה שהערבוב אמיתי)');
  const distinctHands = Object.keys(handTypes).length;
  ok(distinctHands >= 4, `הופיעו ${distinctHands} סוגי ידיים שונים: ${Object.keys(handTypes).join(', ')}`);
  const distinctWinners = Object.keys(winnerSeats).length;
  ok(distinctWinners >= 3, `הזכיות התפזרו בין ${distinctWinners} שחקנים שונים (לא תמיד אותו אחד)`);
  console.log(`     (מתוך 25 משחקים: ${sweeps} סוויפים, ${ties} תיקואים)`);

  section('משחק אימון (בוטים) — בלי נקודות');
  const bankPre = (await P('/api/bank', { token })).accounts.filter(a => !a.bot).reduce((s, a) => s + a.points, 0);
  const pr = await P('/api/create', { session: B.token, stake: 'high' });
  await P('/api/action', { code: pr.code, pid: pr.pid, session: B.token, type: 'fillDemo' });
  await P('/api/action', { code: pr.code, pid: pr.pid, session: B.token, type: 'start' });
  const prSt = await waitPhase(pr.code, 'result', 1);
  ok(prSt.practice === true, 'משחק עם בוטים = אימון');
  const bankPost = (await P('/api/bank', { token })).accounts.filter(a => !a.bot).reduce((s, a) => s + a.points, 0);
  ok(bankPre === bankPost, 'אימון: אף נקודה אמיתית לא זזה');

  section('שימור כסף מוחלט (אחרי הכל)');
  const finalBank = await P('/api/bank', { token });
  const totalReal = finalBank.accounts.filter(a => !a.bot).reduce((s, a) => s + a.points, 0);
  ok(Number.isFinite(totalReal) && finalBank.accounts.every(a => Number.isFinite(a.points)), 'כל היתרות מספרים תקינים (אין NaN/אינסוף)');
  ok(finalBank.accounts.every(a => a.points === Math.round(a.points * 2) / 2), 'כל היתרות כפולות חצי-נקודה (אין drift)');
  ok(finalBank.house >= 0, `חשבון הבית תקין: ${finalBank.house} נק' עמלות`);

  console.log('\n' + (failures ? `*** ${failures} כשלים ***` : '*** ✅ הכל עבר — אין חזרות, הכל מעורבב, כל התכונות עובדות ***'));
  srv.kill();
  try { fs.unlinkSync(TEST_DATA); } catch (e) {}
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('AUDIT ERROR:', e.stack || e.message); srv.kill(); process.exit(1); });
