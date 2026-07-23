/* בדיקות מנוע + חשבונות + סימולציית משחק מלא מול השרת (FAST, קובץ נתונים נפרד) */
'use strict';
const { evaluate5, bestOmaha, cmpScore } = require('./server.js');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.log('  FAIL', msg); }
}
const C = (id) => {
  const RM = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
  return { r: RM[id[0]] || +id[0], s: id[1], id };
};
const hand = (...ids) => ids.map(C);

console.log('--- unit: evaluate5 ---');
ok(evaluate5(hand('AS', 'KS', 'QS', 'JS', 'TS'))[0] === 8, 'רויאל = סטרייט פלאש');
ok(evaluate5(hand('AS', '2S', '3S', '4S', '5S'))[1] === 5, 'גלגל סטרייט פלאש גבוה-5');
ok(evaluate5(hand('AH', '2S', '3C', '4D', '5H'))[0] === 4 && evaluate5(hand('AH', '2S', '3C', '4D', '5H'))[1] === 5, 'גלגל סטרייט');
ok(evaluate5(hand('9S', '9H', '9C', '9D', '2S'))[0] === 7, 'רביעייה');
ok(evaluate5(hand('9S', '9H', '9C', '2D', '2S'))[0] === 6, 'פול האוס');
ok(evaluate5(hand('AS', '8S', '6S', '4S', '2S'))[0] === 5, 'פלאש');
ok(evaluate5(hand('AS', 'AH', 'KC', 'KD', '2S'))[0] === 2, 'שני זוגות');
ok(cmpScore(evaluate5(hand('2S', '3S', '4S', '5S', '6S')), evaluate5(hand('AS', 'AH', 'AC', 'AD', 'KS'))) > 0, 'סטרייט פלאש נמוך > רביעיית אסים');
ok(cmpScore(evaluate5(hand('2S', '3S', '4S', '5S', '7S')), evaluate5(hand('AS', 'AH', 'AC', 'AD', 'KS'))) < 0, '2-3-4-5-7 באותו צבע = רק פלאש, מפסיד לרביעייה');
ok(cmpScore(evaluate5(hand('AH', 'KH', 'QH', 'JH', '9H')), evaluate5(hand('AS', 'KC', 'QD', 'JS', 'TS'))) > 0, 'פלאש > סטרייט (אורכי מערך שונים)');
ok(cmpScore(evaluate5(hand('6H', '7H', '8H', '9H', 'TH')), evaluate5(hand('AS', 'AH', 'AC', '2D', '2S'))) > 0, 'סטרייט פלאש > פול האוס');
ok(cmpScore(evaluate5(hand('AS', 'KS', '9C', '5D', '3H')), evaluate5(hand('AH', 'KH', '8C', '5S', '3D'))) > 0, 'קלף גבוה — קיקר שלישי מכריע');

console.log('--- unit: bestOmaha (חוק 2+3) ---');
let b = bestOmaha(hand('AH', '2S', '3C', '4D'), hand('KH', 'QH', 'JH', 'TH', '2C'));
ok(b.score[0] === 1, 'אין פלאש עם לב אחד ביד (יצא: ' + b.name + ')');
b = bestOmaha(hand('2S', '3C', '4D', '6H'), hand('AS', 'KC', 'QD', 'JS', 'TS'));
ok(b.score[0] < 4, 'אין סטרייט מהבורד בלבד (יצא: ' + b.name + ')');
b = bestOmaha(hand('AH', '9H', '3C', '4D'), hand('KH', 'QH', '2H', 'TS', '2C'));
ok(b.score[0] === 5, 'פלאש חוקי עם 2 ביד + 3 בבורד');

console.log('--- סימולציה: חשבונות + משחק מלא מול שרת FAST ---');
const TEST_DATA = path.join(os.tmpdir(), 'omaha-test-data-' + process.pid + '.json');
try { fs.unlinkSync(TEST_DATA); } catch (e) {}
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: { ...process.env, PORT: '3778', FAST: '1', ADMIN_PIN: '9999', DATA_FILE: TEST_DATA },
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', d => console.error('SRV-ERR:', String(d)));

const API = 'http://localhost:3778';
const post = async (p, body) => {
  const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { const e = new Error(p + ': ' + j.error); e.status = r.status; throw e; }
  return j;
};
const fails = async (p, body) => { try { await post(p, body); return false; } catch (e) { return true; } };
const getState = async (code, v) => (await fetch(`${API}/api/state?code=${code}&v=${v ?? -1}`)).json();
const waitPhase = async (code, phase, round) => {
  for (let i = 0; i < 200; i++) {
    const st = await getState(code);
    if (st.phase === phase && (round === undefined || st.round === round)) return st;
    await new Promise(r => setTimeout(r, 60));
  }
  throw new Error('timeout waiting for ' + phase);
};

(async () => {
  await new Promise(r => setTimeout(r, 600));

  // הרשמה והתחברות
  ok(await fails('/api/register', { name: 'ברק', email: 'barak@test.co', password: 'secret1', invite: 'WRONG' }), 'הרשמה עם קוד הזמנה שגוי — נדחית');
  const reg = await post('/api/register', { name: 'ברק', email: 'barak@test.co', password: 'secret1', invite: 'OMAHA1' });
  ok(!!reg.token && reg.name === 'ברק', 'הרשמה תקינה מחזירה סשן');
  ok(await fails('/api/register', { name: 'אחר', email: 'barak@test.co', password: 'secret2', invite: 'OMAHA1' }), 'אימייל כפול — נדחה');
  ok(await fails('/api/register', { name: 'ברק', email: 'other@test.co', password: 'secret2', invite: 'OMAHA1' }), 'שם תצוגה כפול — נדחה');
  ok(await fails('/api/login', { email: 'barak@test.co', password: 'wrong!' }), 'התחברות עם סיסמה שגויה — נדחית');
  const login = await post('/api/login', { email: 'barak@test.co', password: 'secret1' });
  ok(!!login.token, 'התחברות תקינה');
  ok(await fails('/api/create', { session: 'fake', stake: 'low' }), 'יצירת חדר בלי סשן — נדחית');

  // מנהל
  const { token } = await post('/api/admin', { pin: '9999' });
  ok(await fails('/api/grant', { token: 'fake', key: 'barak@test.co', amount: 9999 }), 'grant בלי טוקן מנהל — נדחה');
  await post('/api/grant', { token, key: 'barak@test.co', amount: 500 });

  // משחק מלא — שולחן רגיל
  const host = await post('/api/create', { session: login.token, stake: 'low' });
  await post('/api/action', { code: host.code, pid: host.pid, type: 'fillDemo' });
  await post('/api/action', { code: host.code, pid: host.pid, type: 'start' });

  const boardsSeen = [];
  let holesR1 = null;
  for (let round = 1; round <= 4; round++) {
    const st = await waitPhase(host.code, 'result', round);
    boardsSeen.push(...st.board);
    ok(st.board.length === 5, `סיבוב ${round}: בורד מלא`);
    const holes = st.players.map(p => p.hole.join(','));
    if (round === 1) holesR1 = holes;
    ok(JSON.stringify(holes) === JSON.stringify(holesR1), `סיבוב ${round}: אותן ידיים`);
    ok(st.result && st.result.winners.length >= 1, `סיבוב ${round}: יש מנצח (${st.result.handName})`);
    const totalShare = st.result.winners.reduce((s, w) => s + w.share, 0);
    ok(totalShare === 50, `סיבוב ${round}: חולקו בדיוק 50 נק' (${totalShare})`);
    await post('/api/action', { code: host.code, pid: host.pid, type: 'next' });
  }
  const over = await waitPhase(host.code, 'over');
  const allCards = [...boardsSeen, ...holesR1.flatMap(h => h.split(','))];
  ok(new Set(allCards).size === 36, `36 קלפים ייחודיים — אין כפילויות ואין ערבוב (${new Set(allCards).size})`);
  const deltaSum = over.settlement.rows.reduce((s, r) => s + r.delta, 0);
  ok(deltaSum === -10, `סכום רווח/הפסד = ‎-10 (עמלות הבית) (${deltaSum})`);
  ok(over.settlement.feeTotal === 10, `עמלת בית לשולחן רגיל = 10 (${over.settlement.feeTotal})`);
  if (over.settlement.sweep) console.log('  (יצא סוויפ בסימולציה!)', over.settlement.sweep);

  // דאשבורד
  const bankRes = await post('/api/bank', { token });
  ok(bankRes.house >= 10, `חשבון הבית קיבל את העמלות (${bankRes.house})`);
  ok(bankRes.accounts.some(a => a.name === 'ברק'), 'הדאשבורד מציג את החשבונות');
  ok(bankRes.invite === 'OMAHA1', 'הדאשבורד מציג את קוד ההזמנה');
  await post('/api/invite', { token, code: 'NEWCODE9' });
  ok(await fails('/api/register', { name: 'חדש', email: 'new@test.co', password: 'secret3', invite: 'OMAHA1' }), 'קוד הזמנה ישן לא עובד אחרי החלפה');
  await post('/api/resetpass', { token, key: 'barak@test.co', password: 'newpass9' });
  ok(await fails('/api/login', { email: 'barak@test.co', password: 'secret1' }), 'סיסמה ישנה לא עובדת אחרי איפוס');
  const relog = await post('/api/login', { email: 'barak@test.co', password: 'newpass9' });
  ok(!!relog.token, 'התחברות עם הסיסמה החדשה');
  const exp = await post('/api/export', { token });
  ok(exp.data && exp.data.accounts, 'ייצוא גיבוי עובד');
  const imp = await post('/api/import', { token, data: exp.data });
  ok(imp.count >= 1, 'שחזור מגיבוי עובד');

  // rematch
  await post('/api/action', { code: host.code, pid: host.pid, type: 'rematch' });
  const wait2 = await waitPhase(host.code, 'waiting');
  ok(wait2.players.length === 4 && wait2.players.every(p => p.hole.length === 0), 'rematch: חזרה לחדר המתנה נקי');

  // שולחן גבוה — 105
  await post('/api/grant', { token, key: 'barak@test.co', amount: 500 });
  const hi = await post('/api/create', { session: relog.token, stake: 'high' });
  await post('/api/action', { code: hi.code, pid: hi.pid, type: 'fillDemo' });
  await post('/api/action', { code: hi.code, pid: hi.pid, type: 'start' });
  const hiSt = await waitPhase(hi.code, 'result', 1);
  ok(hiSt.pot === 400, `שולחן גבוה: קופה 400 (${hiSt.pot})`);
  ok(hiSt.entry === 100 && hiSt.fee === 5, `שולחן גבוה: כניסה 100 + עמלה 5`);
  const hiShare = hiSt.result.winners.reduce((s, w) => s + w.share, 0);
  ok(hiShare === 100, `שולחן גבוה: סיבוב שווה 100 נק' (${hiShare})`);
  const bank2 = await post('/api/bank', { token });
  ok(bank2.house >= 30, `עמלות: 10 (שולחן רגיל) + 20 (שולחן גבוה) — סה"כ ${bank2.house}`);

  console.log(failures ? `\n*** ${failures} FAILURES ***` : '\n*** ALL TESTS PASSED ***');
  srv.kill();
  try { fs.unlinkSync(TEST_DATA); } catch (e) {}
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e.message); srv.kill(); process.exit(1); });
