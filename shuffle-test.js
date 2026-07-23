/* בדיקה סטטיסטית לערבוב: אחידות, אי-חזרתיות, אי-תלות בין משחקים */
'use strict';
const { newDeck } = require('./server.js');

const N = 52000;
let failures = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failures++; };

// 1) אחידות: כל קלף צריך להופיע בכל מיקום בהסתברות שווה (~1000 פעמים ב-52K)
const posCount = {};       // כמה פעמים כל קלף הופיע בראש החפיסה
const pos25Count = {};     // ובמיקום אמצעי
for (let i = 0; i < N; i++) {
  const d = newDeck();
  posCount[d[0].id] = (posCount[d[0].id] || 0) + 1;
  pos25Count[d[25].id] = (pos25Count[d[25].id] || 0) + 1;
}
const exp = N / 52;
// חי-בריבוע עם 51 דרגות חופש: סף 95 הוא רחב ובטוח (p≈0.00002 לכשל שווא)
const chi = counts => Object.values(counts).reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
const chi0 = chi(posCount), chi25 = chi(pos25Count);
ok(Object.keys(posCount).length === 52 && chi0 < 95, `אחידות מיקום ראשון: chi2=${chi0.toFixed(1)} (סף 95)`);
ok(Object.keys(pos25Count).length === 52 && chi25 < 95, `אחידות מיקום אמצעי: chi2=${chi25.toFixed(1)} (סף 95)`);

// 2) אי-חזרתיות: אלף חפיסות עוקבות — אף שתיים לא זהות, ואין מתאם בין עוקבות
const seen = new Set();
let maxSamePos = 0;
let prev = null;
for (let i = 0; i < 1000; i++) {
  const d = newDeck();
  const key = d.map(c => c.id).join('');
  ok2: if (seen.has(key)) { ok(false, 'חפיסה חזרה על עצמה!'); break ok2; }
  seen.add(key);
  if (prev) {
    let same = 0;
    for (let j = 0; j < 52; j++) if (d[j].id === prev[j]) same++;
    maxSamePos = Math.max(maxSamePos, same);
  }
  prev = d.map(c => c.id);
}
ok(seen.size === 1000, 'אלף חפיסות עוקבות — כולן שונות');
// בין שתי חפיסות אקראיות, מספר ההתאמות במיקום ~פואסון(1); מעל 8 כמעט בלתי אפשרי
ok(maxSamePos <= 8, `אין מתאם בין משחקים עוקבים (מקס' התאמות מיקום: ${maxSamePos})`);

// 3) שלמות: תמיד 52 קלפים ייחודיים
const d = newDeck();
ok(new Set(d.map(c => c.id)).size === 52, 'תמיד 52 קלפים ייחודיים');

console.log(failures ? `\n*** ${failures} FAILURES ***` : '\n*** SHUFFLE PERFECT ***');
process.exit(failures ? 1 : 0);
