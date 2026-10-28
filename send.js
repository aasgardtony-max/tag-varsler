// TAG-varsler: sender pushvarsler via Firebase Cloud Messaging.
// Kjøres automatisk av GitHub Actions (se .github/workflows/tag-varsler.yml).
//
//   node send.js morgen    -> alle:            «Pingen er åpen»
//   node send.js paaminn   -> kun de som mangler: «Husk å pinge»
//   node send.js siste     -> kun de som mangler: «Siste sjanse»
//   node send.js test      -> alle:            testvarsel
//   node send.js tagsjekk  -> alle:            «Vi har en ny fag!» hvis taggen har byttet eier

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
