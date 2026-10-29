// TAG-varsler: sender pushvarsler via Firebase Cloud Messaging.
// Kjøres automatisk av GitHub Actions (se .github/workflows/tag-varsler.yml).
//
//   node send.js morgen    -> alle:            «Pingen er åpen»
//   node send.js paaminn   -> kun de som mangler: «Husk å pinge»
//   node send.js siste     -> kun de som mangler: «Siste sjanse»
//   node send.js test      -> alle:            testvarsel
//   node send.js tagsjekk  -> alle:            «Vi har en ny fag!» hvis taggen har byttet eier,
//                             og varsel til faggen om nye pinger
//   node send.js start     -> alle:            starter sesongen, START_NICK får taggen
//   node send.js bot       -> kun de som mangler: «Du fikk bot» kl. 15
//   node send.js uke       -> alle:            ukesoppsummering (søndager fra 8. november)

import admin from "firebase-admin";

const { FIREBASE_SERVICE_ACCOUNT, GAME_CODE, APP_URL } = process.env;
const DEADLINE = process.env.DEADLINE || "15:00";
const TZ = "Europe/Oslo";
const mode = process.argv[2];

const MESSAGES = {
  morgen:  { onlyMissing: false, title: "God morgen! Pingen er åpen 📍", body: `Du kan pinge nå. Frist kl. ${DEADLINE}.` },
  paaminn: { onlyMissing: true,  title: "Husk å pinge!",                body: `Du har ikke pinget i dag. Frist kl. ${DEADLINE}.` },
  siste:   { onlyMissing: true,  title: "Siste sjanse! ⏰",              body: `Du må pinge før kl. ${DEADLINE}. Det er ikke lenge igjen.` },
  test:    { onlyMissing: false, title: "TAG test ✅",                   body: "Varslene fungerer!" }
};

const OPEN_TIME = process.env.OPEN_TIME || "08:00";
const BOT_AMOUNT = +(process.env.BOT_AMOUNT || 100);
const osloDay = d => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
// Hadde spilleren taggen en gang i pingvinduet (OPEN_TIME–DEADLINE) den dagen? Da er dagen fritatt.
const heldDuring = (hist, id, k) => {
  const a = new Date(`${k}T${OPEN_TIME}:00+01:00`).getTime(), b = new Date(`${k}T${DEADLINE}:00+01:00`).getTime();
  for (let i = 0; i < hist.length; i++) { const st = hist[i].at, en = i === 0 ? Infinity : hist[i - 1].at; if (hist[i].to === id && st < b && en > a) return true; }
  return false;
};
const osloHm = d => new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" }).format(d);
// Første botdag: dagen man ble med, eller dagen etter hvis man ble med etter fristen
const joinKey = p => { if (!p.joinedAt) return ""; const d = new Date(p.joinedAt); return osloHm(d) < DEADLINE ? osloDay(d) : osloDay(new Date(p.joinedAt + 864e5)); };
// Innstillinger fra appen (Meg → Innstillinger). Mangler de, er alt på.
const prefs = p => (p && p.prefs) || {};
const quietNow = () => { const h = +osloHm(new Date()).slice(0, 2); return h >= 23 || h < 7; };
const muted = p => prefs(p).quiet === true && quietNow(); // stille timer 23–07

// ---------- Spillstart: gir taggen til startspilleren ved midnatt 1. november ----------
//   node send.js start   (START_NICK = navnet på den som starter som fag, standard «Isak»)
if (mode === "start") {
  if (!FIREBASE_SERVICE_ACCOUNT || !GAME_CODE) { console.error("Mangler FIREBASE_SERVICE_ACCOUNT eller GAME_CODE."); process.exit(1); }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
  const db = admin.firestore(), game = db.collection("games").doc(GAME_CODE);
  const want = (process.env.START_NICK || "Isak").trim().toLowerCase();
  const players = await game.collection("players").get();
  const match = players.docs.filter(d => !d.data().claim && (d.data().nick || "").trim().toLowerCase() === want)
    .sort((a, b) => ((b.data().pushToken ? 1 : 0) - (a.data().pushToken ? 1 : 0)) || (((b.data().latest || {}).at || 0) - ((a.data().latest || {}).at || 0)));
  if (!match.length) { console.error(`Fant ingen spiller som heter «${process.env.START_NICK || "Isak"}». Taggen ble ikke gitt.`); process.exit(1); }
  const it = match[0].id, nickName = match[0].data().nick, now = Date.now();
  const today = osloDay(new Date()), year = today.slice(0, 4), month = String(process.env.GAME_MONTH || 11).padStart(2, "0");
  const seasonStart = new Date(`${year}-${month}-01T00:00:00+01:00`).getTime();
  const tagRef = game.collection("state").doc("tag"), old = await tagRef.get();
  // Reservekjøringene (00:15 og 00:40) gjør ingenting hvis sesongen allerede er startet
  if (old.exists && old.data().seasonStart === year && (old.data().since || 0) >= seasonStart) { console.log("Sesongen er allerede startet. Ingenting gjort."); process.exit(0); }
  const real = now >= seasonStart; // en manuell testkjøring før 1. november rydder ikke
  if (real) {
    // Blank start: fjern testpinger, testbetalinger og ettergitte dager. Navn, varsler, Vipps og regler beholdes.
    const batch = db.batch();
    for (const d of players.docs) batch.update(d.ref, { history: [], latest: admin.firestore.FieldValue.delete() });
    await batch.commit();
    const botRef = game.collection("state").doc(`botkassa-${year}`), bot = await botRef.get();
    await botRef.set({ paid: {}, forgiven: {}, ...(bot.exists && bot.data().vipps ? { vipps: bot.data().vipps } : {}) });
    console.log("Ryddet bort testdata.");
  }
  await tagRef.set({ it, prev: null, since: now, notifiedAt: now, seasonStart: real ? year : null, history: [{ from: null, to: it, at: now, byAdmin: true }] });
  console.log(`Spillet er startet. ${nickName} har taggen.`);
  // Startvarselet kommer én gang, så det sendes også til de som har stille timer
  const list = players.docs.filter(d => d.data().pushToken && !d.data().claim).map(d => d.id === it
    ? { id: d.id, token: d.data().pushToken, title: "Du starter som faggen! 🏁", body: `TAG ${year} er i gang. Lykke til med jakten!` }
    : { id: d.id, token: d.data().pushToken, title: `🏁 TAG ${year} er i gang!`, body: `${nickName} starter som faggen. Pass på!` });
  await sendAll(db, game, list);
  process.exit(0);
}

// ---------- Bot-varsel kl. 15: til de som ikke pinget i tide i dag ----------
if (mode === "bot") {
  if (!FIREBASE_SERVICE_ACCOUNT || !GAME_CODE) { console.error("Mangler FIREBASE_SERVICE_ACCOUNT eller GAME_CODE."); process.exit(1); }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
  const db = admin.firestore(), game = db.collection("games").doc(GAME_CODE);
  const today = osloDay(new Date()), year = today.slice(0, 4), month = today.slice(5, 7);
  if (month !== String(process.env.GAME_MONTH || 11).padStart(2, "0")) { console.log("Ikke sesong nå. Ingen bot sendt."); process.exit(0); }
  const botSnap = await game.collection("state").doc(`botkassa-${year}`).get();
  const bot = botSnap.exists ? botSnap.data() : {};
  const tagSnap = await game.collection("state").doc("tag").get();
  const hist = tagSnap.exists ? (tagSnap.data().history || []) : [];
  const players = await game.collection("players").get();
  const list = [];
  for (const d of players.docs) {
    const p = d.data(); if (!p.nick || !p.pushToken || p.claim) continue; // claim = venter på å overta en spiller
    const okDays = new Set();
    for (const e of p.history || []) { const dt = new Date(e.at), t = osloHm(dt); if (t >= OPEN_TIME && t < DEADLINE) okDays.add(osloDay(dt)); }
    const forgiven = new Set(((bot.forgiven || {})[d.id]) || []);
    const joined = joinKey(p); // bot telles fra dagen man ble med
    if (today < joined || okDays.has(today) || forgiven.has(today) || heldDuring(hist, d.id, today)) continue;
    let missed = 0;
    for (let i = 1; i <= +today.slice(8, 10); i++) { const k = `${year}-${month}-${String(i).padStart(2, "0")}`; if (k >= joined && !okDays.has(k) && !forgiven.has(k) && !heldDuring(hist, d.id, k)) missed++; }
    const left = Math.max(0, missed * BOT_AMOUNT - (((bot.paid || {})[d.id]) || 0));
    list.push({ id: d.id, token: p.pushToken, title: `Du fikk ${BOT_AMOUNT} kr i bot 💸`,
      body: `Du pinget ikke innen kl. ${DEADLINE} i dag. Du skylder nå ${left} kr i botkassa${bot.vipps ? ` (Vipps ${bot.vipps})` : ""}.` });
  }
  await sendAll(db, game, list);
  process.exit(0);
}

// ---------- Ukesoppsummering (søndager kl. 20) ----------
if (mode === "uke") {
  if (!FIREBASE_SERVICE_ACCOUNT || !GAME_CODE) { console.error("Mangler FIREBASE_SERVICE_ACCOUNT eller GAME_CODE."); process.exit(1); }
  const today = osloDay(new Date()), year = today.slice(0, 4), month = String(process.env.GAME_MONTH || 11).padStart(2, "0"), day = +today.slice(8, 10);
  if (today.slice(5, 7) !== month || day < 7) { console.log("Ingen ukesoppsummering i dag."); process.exit(0); }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
  const db = admin.firestore(), game = db.collection("games").doc(GAME_CODE);
  const start = new Date(`${year}-${month}-01T00:00:00+01:00`).getTime(), now = Date.now();
  const players = (await game.collection("players").get()).docs.filter(d => d.data().nick && !d.data().claim);
  const tagSnap = await game.collection("state").doc("tag").get(), hist = tagSnap.exists ? (tagSnap.data().history || []) : [];
  const botSnap = await game.collection("state").doc(`botkassa-${year}`).get(), bot = botSnap.exists ? botSnap.data() : {};
  const held = {}, made = {};
  hist.forEach((e, i) => {
    const a = Math.max(e.at, start), b = Math.min(i === 0 ? now : hist[i - 1].at, now);
    if (b > a) held[e.to] = (held[e.to] || 0) + (b - a);
    if (e.from && e.at >= start) made[e.from] = (made[e.from] || 0) + 1;
  });
  const keys = []; for (let i = 1; i <= day; i++) keys.push(`${year}-${month}-${String(i).padStart(2, "0")}`);
  let botTotal = 0; const streak = {};
  for (const d of players) {
    const p = d.data(), ok = new Set(), forgiven = new Set(((bot.forgiven || {})[d.id]) || []), joined = joinKey(p);
    for (const e of p.history || []) { const dt = new Date(e.at), t = osloHm(dt); if (t >= OPEN_TIME && t < DEADLINE) ok.add(osloDay(dt)); }
    let run = 0;
    for (const k of keys) {
      const good = ok.has(k) || forgiven.has(k) || heldDuring(hist, d.id, k);
      if (good) run++; else run = 0;           // kl. 20 er dagens frist ute, så alle dager telles
      if (k >= joined && !good) botTotal += BOT_AMOUNT;
    }
    streak[d.id] = run;
  }
  const nickOf = id => (players.find(d => d.id === id)?.data().nick) || "Noen";
  const top = obj => { let k = null, v = 0; for (const [a, b] of Object.entries(obj)) if (b > v && players.some(d => d.id === a)) { k = a; v = b; } return k ? { k, v } : null; };
  const dur = ms => { const h = Math.floor(ms / 36e5), d = Math.floor(h / 24); return d ? `${d} d ${h % 24} t` : `${h} t`; };
  const hHeld = top(held), hMade = top(made), hStreak = top(streak);
  const parts = [];
  if (hHeld) parts.push(`Lengst fag: ${nickOf(hHeld.k)} (${dur(hHeld.v)})`);
  if (hMade) parts.push(`Flest tatt: ${nickOf(hMade.k)} (${hMade.v})`);
  if (hStreak && hStreak.v >= 2) parts.push(`Lengst rekke: ${nickOf(hStreak.k)} 🔥${hStreak.v}`);
  parts.push(`Totalt i bot: ${botTotal} kr`);
  const title = `📊 Uke ${Math.ceil(day / 7)} i TAG`, body = parts.join(" · ");
  console.log(title, "|", body);
  await sendAll(db, game, players.filter(d => d.data().pushToken && !muted(d.data())).map(d => ({ id: d.id, token: d.data().pushToken, title, body })));
  process.exit(0);
}

// ---------- Ny fag: sjekk om taggen har byttet eier ----------
if (mode === "tagsjekk") {
  if (!FIREBASE_SERVICE_ACCOUNT || !GAME_CODE) { console.error("Mangler FIREBASE_SERVICE_ACCOUNT eller GAME_CODE."); process.exit(1); }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
  const db = admin.firestore();
  const game = db.collection("games").doc(GAME_CODE);
  const tagRef = game.collection("state").doc("tag");
  const tagSnap = await tagRef.get();
  if (!tagSnap.exists || !tagSnap.data().it) { console.log("Spillet har ikke startet."); process.exit(0); }
  const tag = tagSnap.data();
  const players = await game.collection("players").get();
  const nick = id => (players.docs.find(d => d.id === id)?.data().nick) || "Noen";
  const update = {};

  // 1) Ny fag?
  const notifiedAt = tag.notifiedAt || 0;
  const fresh = (tag.history || []).filter(h => h.at > notifiedAt && h.from);
  if (fresh.length && tag.since > notifiedAt) {
    const last = fresh[0]; // nyeste først
    const extra = fresh.length > 1 ? ` (${fresh.length} bytter siden sist)` : "";
    const messages = [];
    for (const d of players.docs) {
      const p = d.data(); if (!p.pushToken || p.claim || muted(p)) continue;
      const isNew = d.id === tag.it;
      const title = isNew ? "Du har taggen! 🏁" : "🏁 Vi har en ny fag!";
      const body = isNew
        ? `${nick(last.from)} tok deg. Nå er det din tur.`
        : d.id === last.from ? `Du tok ${nick(tag.it)}. Løp!` : `${nick(last.from)} tok ${nick(tag.it)}. ${nick(tag.it)} har taggen nå${extra}.`;
      messages.push({ id: d.id, token: p.pushToken, title, body });
    }
    // Marker som varslet FØR sending, så samme bytte aldri varsles to ganger
    await tagRef.update({ notifiedAt: tag.since });
    await sendAll(db, game, messages);
  } else console.log("Ingen ny fag.");

  // 2) Nye pinger siden sist -> varsel til faggen
  const fagDoc = players.docs.find(d => d.id === tag.it);
  const lower = Math.max(tag.pingsNotifiedAt || 0, tag.since || 0);
  const newPings = players.docs
    .filter(d => d.id !== tag.it && d.data().nick && !d.data().claim && d.data().latest && d.data().latest.at > lower)
    .sort((a, b) => a.data().latest.at - b.data().latest.at);
  if (!newPings.length) { console.log("Ingen nye pinger."); process.exit(0); }
  const newest = Math.max(...newPings.map(d => d.data().latest.at));
  await tagRef.update({ pingsNotifiedAt: newest });
  if (!fagDoc || !fagDoc.data().pushToken) { console.log("Faggen har ikke varsler på."); process.exit(0); }
  if (prefs(fagDoc.data()).fagPing === false || muted(fagDoc.data())) { console.log("Faggen har skrudd av ping-varsler (eller stille timer)."); process.exit(0); }
  const names = newPings.map(d => d.data().nick);
  const list = names.length === 1
    ? `${names[0]} pinget kl. ${osloHm(new Date(newPings[0].data().latest.at))}`
    : `${names.slice(0, -1).join(", ")} og ${names[names.length - 1]} har pinget`;
  await sendAll(db, game, [{ id: fagDoc.id, token: fagDoc.data().pushToken,
    title: names.length === 1 ? `📍 ${names[0]} pinget nå` : `📍 ${names.length} nye pinger`,
    body: `${list}. Se hvor på kartet.` }]);
  process.exit(0);
}

async function sendAll(db, game, list) {
  console.log(`Mottakere: ${list.length}`);
  if (!list.length) return;
  const link = APP_URL || undefined;
  const res = await admin.messaging().sendEach(list.map(t => ({
    token: t.token,
    data: { title: t.title, body: t.body },
    webpush: {
      headers: { Urgency: "high", TTL: "3600" },
      notification: { title: t.title, body: t.body, icon: link ? new URL("icon-192.png", link).href : undefined, tag: "tag-varsel", renotify: true },
      fcmOptions: link ? { link } : undefined
    }
  })));
  let sent = 0;
  await Promise.all(res.responses.map(async (r, i) => {
    if (r.success) { sent++; return; }
    const code = r.error && r.error.code;
    console.log(`Feil for spiller ${list[i].id}: ${code}`);
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
      await game.collection("players").doc(list[i].id).update({ pushToken: admin.firestore.FieldValue.delete() });
    }
  }));
  console.log(`Sendt: ${sent} av ${list.length}`);
}

if (!MESSAGES[mode]) { console.error(`Ukjent modus "${mode}". Bruk: morgen, paaminn, siste eller test.`); process.exit(1); }
if (!FIREBASE_SERVICE_ACCOUNT || !GAME_CODE) { console.error("Mangler FIREBASE_SERVICE_ACCOUNT eller GAME_CODE."); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

const dayKey = d => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const today = dayKey(new Date());

const msg = MESSAGES[mode];
const snap = await db.collection("games").doc(GAME_CODE).collection("players").get();
const tagDoc = await db.collection("games").doc(GAME_CODE).collection("state").doc("tag").get();
const fagId = tagDoc.exists ? tagDoc.data().it : null; // faggen slipper å pinge
const tagHist = tagDoc.exists ? (tagDoc.data().history || []) : [];

const targets = [];
for (const d of snap.docs) {
  const p = d.data();
  if (!p.pushToken) continue;
  if (mode !== "test" && p.claim) continue;
  if (mode !== "test" && d.id === fagId) continue;
  if (mode !== "test" && (prefs(p).ping === false || muted(p))) continue; // har skrudd av ping-varsler
  if (msg.onlyMissing && heldDuring(tagHist, d.id, today)) continue; // har hatt taggen i dag = fritatt
  const pinged = p.latest && dayKey(new Date(p.latest.at)) === today;
  if (msg.onlyMissing && pinged) continue;
  targets.push({ id: d.id, nick: p.nick, token: p.pushToken });
}

console.log(`Modus: ${mode} · spillere: ${snap.size} · mottakere: ${targets.length}`);
if (!targets.length) process.exit(0);

const link = APP_URL || undefined;
const res = await admin.messaging().sendEach(targets.map(t => ({
  token: t.token,
  data: { title: msg.title, body: msg.body },
  webpush: {
    headers: { Urgency: "high", TTL: "3600" },
    notification: { title: msg.title, body: msg.body, icon: link ? new URL("icon-192.png", link).href : undefined, tag: "tag-ping", renotify: true },
    fcmOptions: link ? { link } : undefined
  }
})));

// Rydd bort ugyldige tokens (appen slettet, varsler skrudd av)
let sent = 0;
await Promise.all(res.responses.map(async (r, i) => {
  if (r.success) { sent++; return; }
  const code = r.error && r.error.code;
  console.log(`Feil for spiller ${targets[i].id}: ${code}`);
  if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
    await db.collection("games").doc(GAME_CODE).collection("players").doc(targets[i].id)
      .update({ pushToken: admin.firestore.FieldValue.delete() });
  }
}));
console.log(`Sendt: ${sent} av ${targets.length}`);
