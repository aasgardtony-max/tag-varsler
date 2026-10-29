// TAG-varsler: sender pushvarsler via Firebase Cloud Messaging.
// Kjøres automatisk av GitHub Actions (se .github/workflows/tag-varsler.yml).
//
//   node send.js morgen    -> alle:            «Pingen er åpen»
//   node send.js paaminn   -> kun de som mangler: «Husk å pinge»
//   node send.js siste     -> kun de som mangler: «Siste sjanse»
//   node send.js test      -> alle:            testvarsel
//   node send.js tagsjekk  -> alle:            «Vi har en ny fag!» hvis taggen har byttet eier
//   node send.js start     -> alle:            starter sesongen, START_NICK får taggen
//   node send.js bot       -> kun de som mangler: «Du fikk bot» kl. 15

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
const osloHm = d => new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" }).format(d);

// ---------- Spillstart: gir taggen til startspilleren ved midnatt 1. november ----------
//   node send.js start   (START_NICK = navnet på den som starter som fag, standard «Isak»)
if (mode === "start") {
  if (!FIREBASE_SERVICE_ACCOUNT || !GAME_CODE) { console.error("Mangler FIREBASE_SERVICE_ACCOUNT eller GAME_CODE."); process.exit(1); }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
  const db = admin.firestore(), game = db.collection("games").doc(GAME_CODE);
  const want = (process.env.START_NICK || "Isak").trim().toLowerCase();
  const players = await game.collection("players").get();
  const match = players.docs.filter(d => (d.data().nick || "").trim().toLowerCase() === want)
    .sort((a, b) => ((b.data().pushToken ? 1 : 0) - (a.data().pushToken ? 1 : 0)) || (((b.data().latest || {}).at || 0) - ((a.data().latest || {}).at || 0)));
  if (!match.length) { console.error(`Fant ingen spiller som heter «${process.env.START_NICK || "Isak"}». Taggen ble ikke gitt.`); process.exit(1); }
  const it = match[0].id, nickName = match[0].data().nick, now = Date.now();
  await game.collection("state").doc("tag").set({ it, prev: null, since: now, notifiedAt: now, history: [{ from: null, to: it, at: now, byAdmin: true }] });
  console.log(`Spillet er startet. ${nickName} har taggen.`);
  const year = osloDay(new Date()).slice(0, 4);
  const list = players.docs.filter(d => d.data().pushToken).map(d => d.id === it
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
  const botSnap = await game.collection("state").doc(`botkassa-${year}`).get();
  const bot = botSnap.exists ? botSnap.data() : {};
  const players = await game.collection("players").get();
  const list = [];
  for (const d of players.docs) {
    const p = d.data(); if (!p.nick || !p.pushToken) continue;
    const okDays = new Set();
    for (const e of p.history || []) { const dt = new Date(e.at), t = osloHm(dt); if (t >= OPEN_TIME && t < DEADLINE) okDays.add(osloDay(dt)); }
    const forgiven = new Set(((bot.forgiven || {})[d.id]) || []);
    if (okDays.has(today) || forgiven.has(today)) continue;
    let missed = 0;
    for (let i = 1; i <= +today.slice(8, 10); i++) { const k = `${year}-${month}-${String(i).padStart(2, "0")}`; if (!okDays.has(k) && !forgiven.has(k)) missed++; }
    const left = Math.max(0, missed * BOT_AMOUNT - (((bot.paid || {})[d.id]) || 0));
    list.push({ id: d.id, token: p.pushToken, title: `Du fikk ${BOT_AMOUNT} kr i bot 💸`,
      body: `Du pinget ikke innen kl. ${DEADLINE} i dag. Du skylder nå ${left} kr i botkassa${bot.vipps ? ` (Vipps ${bot.vipps})` : ""}.` });
  }
  await sendAll(db, game, list);
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
  if (!tagSnap.exists) { console.log("Spillet har ikke startet."); process.exit(0); }
  const tag = tagSnap.data();
  const notifiedAt = tag.notifiedAt || 0;
  const fresh = (tag.history || []).filter(h => h.at > notifiedAt && h.from);
  if (!fresh.length || tag.since <= notifiedAt) { console.log("Ingen ny fag."); process.exit(0); }

  const players = await game.collection("players").get();
  const nick = id => (players.docs.find(d => d.id === id)?.data().nick) || "Noen";
  const last = fresh[0]; // nyeste først
  const extra = fresh.length > 1 ? ` (${fresh.length} bytter siden sist)` : "";

  const messages = [];
  for (const d of players.docs) {
    const p = d.data(); if (!p.pushToken) continue;
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

const targets = [];
for (const d of snap.docs) {
  const p = d.data();
  if (!p.pushToken) continue;
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
