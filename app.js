"use strict";
const CFG = window.CHAT_CONFIG;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

let me = null;
let conv = null;
let channel = null;
let onceMode = false;
let rec = null;
let viewerUrl = null;

function show(screen) {
  for (const s of ["auth", "home", "chat"]) $(s).classList.toggle("hidden", s !== screen);
}
function setMsg(el, text, isErr) { el.textContent = text || ""; el.classList.toggle("err", !!isErr); }
function status(text, isErr, pct) {
  const el = $("status");
  el.classList.toggle("hidden", !text);
  el.classList.toggle("err", !!isErr);
  el.textContent = text || "";
  if (pct != null) {
    const bar = document.createElement("div"); bar.className = "progress";
    const i = document.createElement("i"); i.style.width = Math.round(pct * 100) + "%";
    bar.appendChild(i); el.appendChild(bar);
  }
}
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDur = (ms) => { const s = Math.round((ms || 0) / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

async function login() {
  const msg = $("auth-msg"); setMsg(msg, "Signing in…");
  const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
  if (error) return setMsg(msg, "Could not sign in: " + error.message, true);
  await enterHome();
}
async function signup() {
  const msg = $("auth-msg");
  if ($("password").value.length < 8) return setMsg(msg, "Use a password of at least 8 characters.", true);
  setMsg(msg, "Creating account…");
  const { data, error } = await sb.auth.signUp({ email: $("email").value.trim(), password: $("password").value });
  if (error) {
    const invited = /database error|not been invited/i.test(error.message);
    return setMsg(msg, invited ? "That email is not on the invite list." : error.message, true);
  }
  if (!data.session) return setMsg(msg, "Account created. Check your email to confirm, then sign in.");
  await enterHome();
}
async function enterHome() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return show("auth");
  const { data, error } = await sb.from("profiles").select("id,username").eq("id", user.id).single();
  if (error || !data) { await sb.auth.signOut(); show("auth"); return setMsg($("auth-msg"), "No profile found for this account.", true); }
  me = data; $("me-name").textContent = "Hi, " + me.username + " 🌸";
  show("home");
}
async function logout() { await leaveChat(); await sb.auth.signOut(); me = null; show("auth"); }

async function startChat() {
  const msg = $("home-msg"); const name = $("friend").value.trim();
  if (!name) return setMsg(msg, "Type a username.", true);
  setMsg(msg, "Opening…");
  const { data, error } = await sb.rpc("start_chat", { p_username: name });
  if (error) return setMsg(msg, error.message, true);
  setMsg(msg, ""); await openChat(data, name.toLowerCase());
}
async function openChat(id, other) {
  conv = { id, other }; $("chat-title").textContent = other; $("messages").replaceChildren(); status("");
  show("chat");
  const { data, error } = await sb.from("messages").select("*").eq("conversation_id", id)
    .order("created_at", { ascending: true }).limit(200);
  if (error) return status("Could not load messages: " + error.message, true);
  data.forEach(upsertBubble); scrollDown();
  channel = sb.channel("chat:" + id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: "conversation_id=eq." + id },
      (p) => { upsertBubble(p.new); scrollDown(); })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages", filter: "conversation_id=eq." + id },
      (p) => upsertBubble(p.new))
    .subscribe((s) => { if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") status("Live updates lost. Reopen the chat.", true); });
}
async function leaveChat() {
  cancelRecording();
  if (channel) { await sb.removeChannel(channel); channel = null; }
  conv = null;
}
function scrollDown() { const m = $("messages"); m.scrollTop = m.scrollHeight; }

function upsertBubble(m) {
  const list = $("messages");
  const old = list.querySelector('[data-id="' + m.id + '"]');
  const el = buildBubble(m);
  if (old) old.replaceWith(el); else list.appendChild(el);
}
function buildBubble(m) {
  const mine = m.sender_id === me.id;
  const el = document.createElement("div");
  el.className = "bubble " + (mine ? "me" : "them"); el.dataset.id = m.id;
  if (m.kind === "text") {
    const t = document.createElement("span"); t.textContent = m.body; el.appendChild(t);
  } else if (m.kind === "voice") {
    const a = document.createElement("audio"); a.controls = true; a.preload = "none";
    let retried = false;
    const load = async () => { const u = await signedUrl("chat-media", m.media_path, 600); if (u) a.src = u; };
    a.addEventListener("play", () => { if (!a.src) load(); }, { once: true });
    a.addEventListener("error", async () => { if (!retried) { retried = true; await load(); a.play().catch(() => {}); } });
    load();
    const d = document.createElement("div"); d.textContent = "🎤 " + fmtDur(m.duration_ms);
    el.append(d, a);
  } else if (m.kind === "image") {
    const img = document.createElement("img"); img.alt = "Photo"; img.loading = "lazy";
    signedUrl("chat-media", m.media_path, 300).then((u) => { if (u) img.src = u; });
    el.appendChild(img);
  } else if (m.kind === "view_once") {
    if (mine) {
      el.textContent = "👁️ View-once photo — " + (m.viewed_at ? "opened" : "not opened yet");
    } else if (m.viewed_at) {
      el.textContent = "👁️ View-once photo — already opened";
    } else {
      const b = document.createElement("button"); b.textContent = "👁️ Tap to view once";
      b.onclick = () => openOnce(m, b); el.appendChild(b);
    }
  }
  const t = document.createElement("time"); t.textContent = fmtTime(m.created_at); el.appendChild(t);
  return el;
}
async function signedUrl(bucket, path, secs) {
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, secs);
  if (error) { status("Could not load media: " + error.message, true); return null; }
  return data.signedUrl;
}

async function sendText() {
  const input = $("text"); const body = input.value.trim();
  if (!body || !conv) return;
  input.value = "";
  const { data, error } = await sb.from("messages")
    .insert({ conversation_id: conv.id, sender_id: me.id, kind: "text", body }).select().single();
  if (error) { input.value = body; return status("Message not sent: " + error.message, true); }
  upsertBubble(data); scrollDown(); status("");
}

async function upload(bucket, path, blob, contentType) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("You are signed out.");
  await new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", CFG.SUPABASE_URL + "/storage/v1/object/" + bucket + "/" + path);
    x.setRequestHeader("Authorization", "Bearer " + session.access_token);
    x.setRequestHeader("apikey", CFG.SUPABASE_ANON_KEY);
    x.setRequestHeader("Content-Type", contentType);
    x.setRequestHeader("x-upsert", "false");
    x.timeout = 120000;
    x.upload.onprogress = (e) => { if (e.lengthComputable) status("Uploading… " + Math.round((e.loaded / e.total) * 100) + "%", false, e.loaded / e.total); };
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve();
      let m = "Upload failed (" + x.status + ")"; try { m = JSON.parse(x.responseText).message || m; } catch (_) {}
      reject(new Error(m));
    };
    x.onerror = () => reject(new Error("Network error during upload."));
    x.ontimeout = () => reject(new Error("Upload timed out."));
    x.send(blob);
  });
}
async function sendMedia({ bucket, kind, blob, contentType, ext, duration }) {
  const path = conv.id + "/" + crypto.randomUUID() + "." + ext;
  status("Uploading… 0%", false, 0);
  try {
    await upload(bucket, path, blob, contentType);
    const { error } = await sb.from("messages").insert({
      conversation_id: conv.id, sender_id: me.id, kind, media_path: path, duration_ms: duration || null });
    if (error) throw error;
    status("");
  } catch (e) { status("Not sent: " + (e.message || e), true); }
}

async function shrinkImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (_) { throw new Error("This photo format is not supported. Try a JPG or PNG."); }
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((res, rej) => c.toBlob((b) => b ? res(b) : rej(new Error("Could not process photo.")), "image/jpeg", 0.85));
}
async function onPhoto(e) {
  const file = e.target.files[0]; e.target.value = "";
  if (!file || !conv) return;
  if (file.size > 25 * 1024 * 1024) return status("That photo is too large (max 25 MB).", true);
  try {
    status("Preparing photo…");
    const blob = await shrinkImage(file);
    await sendMedia({ bucket: onceMode ? "viewonce" : "chat-media", kind: onceMode ? "view_once" : "image",
      blob, contentType: "image/jpeg", ext: "jpg" });
  } catch (err) { status(err.message, true); }
}

async function openOnce(m, btn) {
  if (!confirm("Open now? You can only see it once.")) return;
  btn.disabled = true; status("Opening…");
  try {
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch(CFG.SUPABASE_URL + "/functions/v1/rapid-responder", {
      method: "POST",
      headers: { Authorization: "Bearer " + session.access_token, apikey: CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ message_id: m.id }), cache: "no-store" });
    if (!r.ok) {
      let msg = "Could not open this photo."; try { msg = (await r.json()).error || msg; } catch (_) {}
      status(msg, true); return;
    }
    viewerUrl = URL.createObjectURL(await r.blob());
    $("viewer-img").src = viewerUrl; $("viewer").classList.remove("hidden"); status("");
  } catch (e) { status("Network error: " + e.message, true); }
}
function closeViewer() {
  $("viewer").classList.add("hidden"); $("viewer-img").removeAttribute("src");
  if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
}
document.addEventListener("visibilitychange", () => { if (document.hidden && viewerUrl) closeViewer(); });

function pickMime() {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"])
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  return "";
}
async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder)
    return status("Voice recording is not supported in this browser. Try Chrome.", true);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) {
    const m = { NotAllowedError: "Microphone blocked. Tap the lock icon in the address bar, allow Microphone, then try again.",
      NotFoundError: "No microphone found on this device.", NotReadableError: "The microphone is busy in another app." };
    return status(m[e.name] || "Could not start the microphone: " + e.message, true);
  }
  const mime = pickMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  rec = { recorder, stream, chunks: [], started: Date.now(), mime: recorder.mimeType || mime || "audio/webm", send: false };
  recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
  recorder.onstop = finishRecording;
  recorder.start();
  $("compose-row").classList.add("hidden"); $("rec-bar").classList.remove("hidden");
  rec.timer = setInterval(() => {
    const ms = Date.now() - rec.started; $("rec-time").textContent = fmtDur(ms);
    if (ms >= 120000) stopRecording(true);
  }, 250);
}
function stopRecording(send) { if (rec && rec.recorder.state !== "inactive") { rec.send = send; rec.recorder.stop(); } }
function cancelRecording() { if (rec) stopRecording(false); }
async function finishRecording() {
  const r = rec; rec = null; clearInterval(r.timer);
  r.stream.getTracks().forEach((t) => t.stop());
  $("rec-bar").classList.add("hidden"); $("compose-row").classList.remove("hidden");
  if (!r.send || !conv) return;
  const duration = Date.now() - r.started;
  if (duration < 500) return status("Recording too short.", true);
  const base = r.mime.split(";")[0];
  const ext = base === "audio/mp4" ? "m4a" : base === "audio/ogg" ? "ogg" : "webm";
  const blob = new Blob(r.chunks, { type: base });
  if (blob.size > 10 * 1024 * 1024) return status("Recording is too large.", true);
  await sendMedia({ bucket: "chat-media", kind: "voice", blob, contentType: base, ext, duration });
}

$("btn-login").onclick = login;
$("btn-signup").onclick = signup;
$("btn-logout").onclick = logout;
$("btn-start").onclick = startChat;
$("btn-back").onclick = async () => { await leaveChat(); show("home"); };
$("btn-send").onclick = sendText;
$("text").addEventListener("keydown", (e) => { if (e.key === "Enter") sendText(); });
$("photo").addEventListener("change", onPhoto);
$("btn-once").onclick = () => { onceMode = !onceMode; $("btn-once").setAttribute("aria-pressed", String(onceMode));
  status(onceMode ? "View Once is ON: your next photo can be opened one time." : ""); };
$("btn-mic").onclick = startRecording;
$("rec-send").onclick = () => stopRecording(true);
$("rec-cancel").onclick = () => stopRecording(false);
$("viewer-close").onclick = closeViewer;

(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) await enterHome(); else show("auth");
})();
