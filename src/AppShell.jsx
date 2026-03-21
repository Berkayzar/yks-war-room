import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onUser, signInGoogle, signOutUser, fsLoadAll, fsSave } from "./firebase.js";

// ============================================================================
// Storage -- localStorage primary, Firestore sync when signed in
// ============================================================================
const KEYS = {
  trials: "yks_trials",
  todos: "yks_todos",
  brain: "yks_brain",
  checkins: "yks_checkins",
  dw: "yks_dw",
  xp: "yks_xp",
  plan: "yks_plan",
  attn: "yks_attn",
  challenge: "yks_challenge",
};

// Current signed-in uid -- set by App() once auth resolves
let _syncUid = null;

const store = {
  load: (k, fb) => {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; }
  },
  save: (k, v) => {
    // 1. Always write localStorage first (instant, offline-safe)
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
    // 2. If signed in, also sync to Firestore (fire-and-forget)
    if (_syncUid) fsSave(_syncUid, k, v);
  },
};

// ============================================================================
// Utils
// ============================================================================
const YKS_DATE = new Date("2026-06-21T09:00:00");
const todayStr = () => new Date().toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const daysFrom = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
const fmtMMSS = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const fmtHHMM = (m) => { const h = Math.floor(m / 60); const r = m % 60; if (h > 0) return `${h}s${r > 0 ? ` ${r}dk` : ""}`; return r > 0 ? `${r}dk` : "0dk"; };
const fmtDate = (iso) => new Date(iso).toLocaleDateString("tr-TR", { day: "2-digit", month: "short" });
const nowHHMM = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const minsToHHMM = (mins) => { const h = Math.floor(mins / 60) % 24; const m = mins % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`; };
const hhmmToMins = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const calcNet = (d, y) => Math.max(0, parseFloat(d || 0) - parseFloat(y || 0) / 4);

const TYT_SUBS = ["Turkce", "Matematik", "Fizik", "Kimya", "Biyoloji", "Tarih", "Cografya", "Felsefe", "Din"];
const AYT_SUBS = ["Matematik", "Fizik", "Kimya", "Biyoloji", "Edebiyat", "Tarih", "Cografya", "Felsefe"];

function yksCountdown() {
  const diff = YKS_DATE.getTime() - Date.now();
  if (diff <= 0) return { days: 0, hours: 0, passed: true };
  return { days: Math.floor(diff / 86400000), hours: Math.floor((diff % 86400000) / 3600000), passed: false };
}

// ============================================================================
// Sound
// ============================================================================
function playSound(type) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const g = ctx.createGain();
    g.connect(ctx.destination);
    if (type === "start") {
      const o = ctx.createOscillator(); o.connect(g);
      o.frequency.setValueAtTime(880, ctx.currentTime);
      o.frequency.setValueAtTime(1100, ctx.currentTime + 0.12);
      g.gain.setValueAtTime(0.3, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      o.start(); o.stop(ctx.currentTime + 0.35);
    } else if (type === "done") {
      [0, 0.15, 0.3].forEach((t, i) => {
        const o = ctx.createOscillator(); o.connect(g);
        o.frequency.value = [660, 880, 1100][i];
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.12);
      });
      g.gain.setValueAtTime(0.25, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    } else if (type === "block_win") {
      [0, 0.1, 0.2, 0.32].forEach((t, i) => {
        const o = ctx.createOscillator(); o.connect(g);
        o.frequency.value = [523, 659, 784, 1047][i];
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.18);
      });
      g.gain.setValueAtTime(0.28, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
    } else if (type === "level_up") {
      [0, 0.05, 0.18, 0.32, 0.46].forEach((t, i) => {
        const o = ctx.createOscillator(); o.connect(g);
        o.type = "square";
        o.frequency.value = [392, 494, 587, 740, 880][i];
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.22);
      });
      g.gain.setValueAtTime(0.18, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.9);
    } else if (type === "warn") {
      const o = ctx.createOscillator(); o.connect(g);
      o.frequency.value = 300;
      g.gain.setValueAtTime(0.4, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      o.start(); o.stop(ctx.currentTime + 0.4);
    } else if (type === "streak") {
      const o = ctx.createOscillator(); o.connect(g);
      o.frequency.setValueAtTime(440, ctx.currentTime);
      o.frequency.linearRampToValueAtTime(1320, ctx.currentTime + 0.4);
      g.gain.setValueAtTime(0.22, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      o.start(); o.stop(ctx.currentTime + 0.45);
    }
  } catch { /* ignore */ }
}

// ============================================================================
// XP / Gamification
// ============================================================================
const XP_R = {
  block_done: 50, trial_added: 30, todo_done: 15,
  checkin_4: 100, checkin_3: 60, plan_done: 80,
  challenge_done: 120, streak_7: 200, streak_14: 500,
};

const BADGES = [
  { id: "first_block", label: "Ilk Blok", icon: "▶", req: (x) => x.totalBlocks >= 1 },
  { id: "week_streak", label: "7 Gun Seri", icon: "🔥", req: (x) => x.streak >= 7 },
  { id: "trial_ace", label: "Deneme Ustu", icon: "◉", req: (x) => x.totalTrials >= 5 },
  { id: "discipline", label: "Demir Irade", icon: "◆", req: (x) => x.perfect4 >= 3 },
  { id: "centurion", label: "100 Blok", icon: "⬛", req: (x) => x.totalBlocks >= 100 },
  { id: "planner", label: "Planci", icon: "▦", req: (x) => x.plansDone >= 7 },
  { id: "challenger", label: "Challenger", icon: "✦", req: (x) => (x.challengesDone || 0) >= 7 },
  { id: "streak_14", label: "2 Hafta", icon: "🔥", req: (x) => x.streak >= 14 },
  { id: "block_10", label: "10 Blok", icon: "▶▶", req: (x) => x.totalBlocks >= 10 },
  { id: "trial_10", label: "10 Deneme", icon: "◉◉", req: (x) => x.totalTrials >= 10 },
];

const LEVELS = [
  { name: "Acemi",    min: 0,    color: "var(--muted)" },
  { name: "Calisan",  min: 200,  color: "var(--blu)" },
  { name: "Kararli",  min: 600,  color: "var(--acc)" },
  { name: "Uzman",    min: 1200, color: "var(--ora)" },
  { name: "Usta",     min: 2500, color: "var(--pur)" },
  { name: "Efsane",   min: 5000, color: "var(--grn)" },
];

function calcLevel(points) {
  let lvl = LEVELS[0];
  for (const l of LEVELS) { if (points >= l.min) lvl = l; }
  const idx = LEVELS.indexOf(lvl);
  const next = LEVELS[idx + 1];
  const pct = next ? Math.round(((points - lvl.min) / (next.min - lvl.min)) * 100) : 100;
  return { ...lvl, idx, next, pct };
}

const loadXP = () => store.load(KEYS.xp, {
  points: 0, streak: 0, totalBlocks: 0, totalTrials: 0,
  perfect4: 0, plansDone: 0, challengesDone: 0, badges: [], lastDate: "",
});

function grantXP(type) {
  const xp = loadXP();
  const pts = XP_R[type] || 0;
  const now = todayStr();
  if (type === "block_done") {
    xp.totalBlocks++;
    if (xp.lastDate !== now) {
      const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      xp.streak = xp.lastDate === y ? xp.streak + 1 : 1;
      xp.lastDate = now;
    }
  }
  if (type === "trial_added") xp.totalTrials++;
  if (type === "checkin_4") xp.perfect4++;
  if (type === "plan_done") xp.plansDone = (xp.plansDone || 0) + 1;
  if (type === "challenge_done") xp.challengesDone = (xp.challengesDone || 0) + 1;
  xp.points += pts;
  BADGES.forEach((b) => { if (!xp.badges.includes(b.id) && b.req(xp)) xp.badges.push(b.id); });
  store.save(KEYS.xp, xp);
  return { pts, xp };
}

// ============================================================================
// Attention
// ============================================================================
const BREAK_REASONS = [
  "Dikkat dagildi", "Yorgun hissettim", "Telefon kontrolu",
  "Su/Yiyecek", "Tuvalet", "Planli mola", "Diger",
];

function calcAttentionScore(breaks) {
  if (!breaks || !breaks.length) return 100;
  const early = breaks.filter((b) => b.type === "early").length;
  const ratio = early / breaks.length;
  const avgBlock = breaks.reduce((s, b) => s + (b.blockMin || 0), 0) / breaks.length;
  return Math.round(clamp(100 - ratio * 40 - Math.max(0, 60 - avgBlock) * 0.5, 0, 100));
}

function attentionLabel(score) {
  if (score >= 85) return { label: "Yuksek Dikkat", color: "var(--grn)" };
  if (score >= 60) return { label: "Orta Dikkat", color: "var(--acc)" };
  return { label: "Dusuk Dikkat", color: "var(--red)" };
}

// ============================================================================
// Trial helpers
// ============================================================================
function buildSubjectWeakness(trials) {
  const map = {};
  trials.forEach((t) => {
    (t.nets || []).forEach((n) => {
      if (!map[n.subject]) map[n.subject] = { sum: 0, count: 0, target: n.target || 0 };
      map[n.subject].sum += n.net;
      map[n.subject].count += 1;
      if (n.target > 0) map[n.subject].target = n.target;
    });
  });
  return Object.entries(map)
    .map(([subject, d]) => ({
      subject,
      avg: d.count > 0 ? parseFloat((d.sum / d.count).toFixed(1)) : 0,
      target: d.target,
      gap: d.target > 0 ? parseFloat((d.target - d.sum / d.count).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.gap - a.gap);
}

function buildWeeklyPlan(trials, goalHoursPerDay = 4) {
  const weak = buildSubjectWeakness(trials);
  if (!weak.length) return [];
  const totalWeight = weak.reduce((s, w) => s + Math.max(0.5, w.gap + 1), 0);
  const dayMins = goalHoursPerDay * 60;
  return weak
    .map((w) => ({
      subject: w.subject,
      dailyMin: Math.round((Math.max(0.5, w.gap + 1) / totalWeight) * dayMins),
      avg: w.avg,
      gap: w.gap,
      priority: w.gap > 2 ? "high" : w.gap > 0 ? "medium" : "low",
    }))
    .filter((w) => w.dailyMin >= 10);
}

function buildTrialTodos(trialData) {
  const todos = [];
  (trialData.wrongTopics || []).forEach((wt) => {
    if (wt.topic && wt.topic.trim()) {
      todos.push({
        text: `${wt.subject} - ${wt.topic.trim()} tekrar`,
        source: `${trialData.type} Deneme (${fmtDate(trialData.date)})`,
        priority: "high",
        meta: { kind: "trial_wrong", subject: wt.subject, topic: wt.topic, trialId: trialData.id },
      });
    }
  });
  (trialData.todos || []).forEach((text) => {
    todos.push({
      text,
      source: `${trialData.type} (${fmtDate(trialData.date)})`,
      priority: "high",
      meta: { kind: "trial", trialId: trialData.id },
    });
  });
  return todos;
}

// Day score composite
function getDayScore(plans, checkins, attn) {
  const today = todayStr();
  const todayPlan = plans[today] || [];
  const planPct = todayPlan.length > 0
    ? Math.round((todayPlan.filter((x) => x.done).length / todayPlan.length) * 100)
    : 0;
  const ci = checkins.find((c) => c.date === today);
  const ciScore = ci ? Math.round((ci.score / 4) * 100) : 0;
  const attnScore = calcAttentionScore(attn[today]?.breaks || []);
  const combined = Math.round(planPct * 0.5 + ciScore * 0.3 + attnScore * 0.2);
  return { combined, planPct, ciScore, attnScore, hasData: todayPlan.length > 0 || !!ci };
}

// ============================================================================
// CSS
// ============================================================================
const CSS = `@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
--bg:#060606;--s1:#0e0e0e;--s2:#151515;--s3:#1c1c1c;
--b1:#1e1e1e;--b2:#282828;--b3:#333;
--txt:#e6e6e6;--muted:#4a4a4a;
--acc:#e8c547;--red:#e05252;--grn:#4caf7d;--blu:#5b9cf6;--pur:#a78bfa;--ora:#f59e0b;
--mono:'IBM Plex Mono',monospace;--sans:'IBM Plex Sans',sans-serif;
}
html,body{background:var(--bg);color:var(--txt);font-family:var(--sans);-webkit-font-smoothing:antialiased}
button{cursor:pointer;font-family:var(--sans);transition:all .12s ease;border:none}
button:hover:not(:disabled){filter:brightness(1.15)}
button:active:not(:disabled){transform:scale(.97)}
input,textarea,select{font-family:var(--sans);background:var(--s2);border:1px solid var(--b2);color:var(--txt);border-radius:6px;transition:border-color .15s}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--acc)}
input::placeholder,textarea::placeholder{color:var(--muted)}
select option{background:var(--s2)}
::-webkit-scrollbar{width:3px}
::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes flashY{0%{box-shadow:0 0 0 0 #e8c54760}60%{box-shadow:0 0 0 16px transparent}100%{box-shadow:0 0 0 0 transparent}}
@keyframes flashR{0%{box-shadow:0 0 0 0 #e0525260}60%{box-shadow:0 0 0 16px transparent}100%{box-shadow:0 0 0 0 transparent}}
@keyframes popIn{0%{transform:scale(.6);opacity:0}70%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}}
@keyframes slideR{from{transform:translateX(-8px);opacity:0}to{transform:none;opacity:1}}
@keyframes countdown{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes blockWin{0%{transform:scale(1)}20%{transform:scale(1.04)}60%{transform:scale(.98)}100%{transform:scale(1)}}
@keyframes levelUp{0%{transform:translateY(20px) scale(.8);opacity:0}50%{transform:translateY(-6px) scale(1.08);opacity:1}100%{transform:translateY(0) scale(1);opacity:1}}
@keyframes streakFire{0%,100%{filter:brightness(1) drop-shadow(0 0 2px #e8c547)}50%{filter:brightness(1.35) drop-shadow(0 0 8px #e8c547)}}
@keyframes alarmShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}
@keyframes glowBorder{0%,100%{box-shadow:0 0 0 0 #e8c54730}50%{box-shadow:0 0 0 4px #e8c54718}}
@keyframes particleFly{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(var(--dx,20px),var(--dy,-40px)) scale(0);opacity:0}}
@keyframes xpFloat{0%{transform:translateY(0) scale(1);opacity:1}100%{transform:translateY(-60px) scale(1.3);opacity:0}}
.fu{animation:fadeUp .2s ease both}
.fi{animation:fadeIn .15s ease both}
.sr{animation:slideR .18s ease both}
.pi{animation:popIn .28s cubic-bezier(.34,1.56,.64,1) both}
.flashY{animation:flashY .6s ease}
.flashR{animation:flashR .6s ease}
.blockWin{animation:blockWin .5s cubic-bezier(.34,1.56,.64,1)}
.levelUp{animation:levelUp .6s cubic-bezier(.34,1.56,.64,1) both}
.streakFire{animation:streakFire 1.5s ease infinite}
.alarmShake{animation:alarmShake .4s ease}
.glowBorder{animation:glowBorder 2s ease infinite}`;

// ============================================================================
// Toast
// ============================================================================
let _setToast = null;
function useToastSystem() {
  const [toasts, setToasts] = useState([]);
  _setToast = (msg, color = "var(--acc)") => {
    const id = uid();
    setToasts((p) => [...p.slice(-2), { id, msg, color }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 2800);
  };
  return toasts;
}
const toast = (msg, color) => _setToast?.(msg, color);

function ToastLayer({ toasts }) {
  return (
    <div style={{ position: "fixed", bottom: "24px", right: "16px", display: "flex", flexDirection: "column", gap: "6px", zIndex: 9999, pointerEvents: "none" }}>
      {toasts.map((t) => (
        <div key={t.id} className="pi" style={{ background: "var(--s1)", border: `1px solid ${t.color}55`, borderLeft: `3px solid ${t.color}`, padding: "10px 14px", borderRadius: "8px", fontSize: "12px", color: t.color, fontFamily: "var(--mono)", maxWidth: "260px", lineHeight: "1.4", boxShadow: "0 8px 24px rgba(0,0,0,.5)" }}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// UI Primitives
// ============================================================================
const Card = ({ children, style, className }) => (
  <div className={className} style={{ background: "var(--s1)", border: "1px solid var(--b1)", borderRadius: "10px", padding: "16px", ...style }}>
    {children}
  </div>
);

const Label = ({ children, style }) => (
  <p style={{ fontFamily: "var(--mono)", fontSize: "10px", fontWeight: "600", color: "var(--muted)", letterSpacing: "1.5px", textTransform: "uppercase", ...style }}>
    {children}
  </p>
);

const Btn = ({ children, onClick, variant = "default", size = "md", disabled, style, title }) => {
  const V = {
    default: { background: "var(--s2)", color: "var(--txt)", border: "1px solid var(--b2)" },
    primary: { background: "var(--acc)", color: "#000", fontWeight: "600" },
    danger:  { background: "transparent", color: "var(--red)", border: "1px solid var(--red)44" },
    ghost:   { background: "transparent", color: "var(--muted)" },
    success: { background: "transparent", color: "var(--grn)", border: "1px solid var(--grn)44" },
    accent:  { background: "var(--acc)18", color: "var(--acc)", border: "1px solid var(--acc)33" },
    blue:    { background: "var(--blu)18", color: "var(--blu)", border: "1px solid var(--blu)33" },
  };
  const S = {
    sm: { padding: "4px 10px", fontSize: "11px", borderRadius: "5px" },
    md: { padding: "8px 15px", fontSize: "13px", borderRadius: "7px" },
    lg: { padding: "12px 22px", fontSize: "14px", borderRadius: "8px", fontWeight: "600" },
  };
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      style={{ ...V[variant], ...S[size], opacity: disabled ? 0.4 : 1, cursor: disabled ? "not-allowed" : "pointer", ...style }}>
      {children}
    </button>
  );
};

const Tag = ({ children, color = "var(--acc)" }) => (
  <span style={{ fontFamily: "var(--mono)", fontSize: "10px", fontWeight: "600", padding: "2px 7px", borderRadius: "4px", background: `${color}18`, color, letterSpacing: "0.5px", whiteSpace: "nowrap" }}>
    {children}
  </span>
);

const PBar = ({ value, max, color = "var(--acc)", h = 5 }) => {
  const pct = max > 0 ? clamp((value / max) * 100, 0, 100) : 0;
  return (
    <div style={{ height: h, background: "var(--b1)", borderRadius: "999px", overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: "999px", transition: "width .8s ease" }} />
    </div>
  );
};

function EmptyState({ icon, title, desc }) {
  return (
    <div style={{ textAlign: "center", padding: "40px 16px" }}>
      <p style={{ fontFamily: "var(--mono)", fontSize: "26px", color: "var(--b2)", marginBottom: "10px" }}>{icon}</p>
      <p style={{ fontSize: "13px", fontWeight: "500", color: "var(--muted)", marginBottom: "4px" }}>{title}</p>
      <p style={{ fontSize: "10px", color: "var(--b3)", lineHeight: "1.6", maxWidth: "200px", margin: "0 auto" }}>{desc}</p>
    </div>
  );
}

// ============================================================================
// Dopamine Components
// ============================================================================
function XPBurst({ pts, label, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2200);
    return () => clearTimeout(t);
  }, [onDone]);

  const particles = Array.from({ length: 10 }, (_, i) => ({
    id: i,
    dx: (Math.random() - 0.5) * 140,
    dy: -30 - Math.random() * 90,
    delay: Math.random() * 0.35,
    size: 4 + Math.random() * 7,
    color: ["var(--acc)", "var(--grn)", "var(--pur)", "var(--blu)"][i % 4],
  }));

  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 8000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {particles.map((p) => (
        <div key={p.id} style={{
          position: "absolute",
          width: `${p.size}px`, height: `${p.size}px`,
          borderRadius: "50%",
          background: p.color,
          animation: `particleFly 1.2s ease ${p.delay}s both`,
          "--dx": `${p.dx}px`,
          "--dy": `${p.dy}px`,
        }} />
      ))}
      <div className="levelUp" style={{ textAlign: "center" }}>
        <p style={{ fontFamily: "var(--mono)", fontSize: "40px", fontWeight: "900", color: "var(--acc)", textShadow: "0 0 24px #e8c54790", lineHeight: 1 }}>+{pts}</p>
        <p style={{ fontFamily: "var(--mono)", fontSize: "13px", color: "var(--acc)", marginTop: "4px", letterSpacing: "3px" }}>XP</p>
        {label && <p style={{ fontSize: "12px", color: "var(--grn)", marginTop: "10px", fontFamily: "var(--mono)", fontWeight: "600" }}>{label}</p>}
      </div>
    </div>
  );
}

function DayScoreBar({ plans, checkins, attn }) {
  const ds = useMemo(() => getDayScore(plans, checkins, attn), [plans, checkins, attn]);
  if (!ds.hasData) return null;
  const color = ds.combined >= 80 ? "var(--grn)" : ds.combined >= 50 ? "var(--acc)" : "var(--red)";
  const msg = ds.combined >= 80 ? "Muhtesem gun!" : ds.combined >= 60 ? "Iyi gidiyorsun." : ds.combined >= 40 ? "Daha fazlasi mumkun." : "Aksiyona gec.";
  return (
    <Card style={{ padding: "10px 14px" }} className="fi">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
        <Label>Bugunun Skoru</Label>
        <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: "22px", fontWeight: "900", color }}>{ds.combined}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>/100</span>
        </div>
      </div>
      <PBar value={ds.combined} max={100} color={color} h={6} />
      <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
        {[
          { l: "Plan", v: ds.planPct, c: "var(--acc)" },
          { l: "Checkin", v: ds.ciScore, c: "var(--blu)" },
          { l: "Dikkat", v: ds.attnScore, c: "var(--grn)" },
        ].map((x) => (
          <div key={x.l} style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
              <span style={{ fontSize: "9px", color: "var(--muted)" }}>{x.l}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: x.c }}>{x.v}</span>
            </div>
            <PBar value={x.v} max={100} color={x.c} h={3} />
          </div>
        ))}
      </div>
      <p style={{ fontSize: "10px", color, fontFamily: "var(--mono)", marginTop: "8px", textAlign: "center" }}>{msg}</p>
    </Card>
  );
}

const FOCUS_CHALLENGES = [
  { id: "fc1", title: "Kac dakika kaldi?",    desc: "Zamani kontrol et. Kalan sureyi kafanda canlandir ve devam et.",   reward: 10 },
  { id: "fc2", title: "30 sn mola",           desc: "Gozlerini kapat, 3 derin nefes al. Sonra devam et.",              reward: 5 },
  { id: "fc3", title: "1 cumle yaz",          desc: "Bu konuda en zor buldugunu 1 cumle yaz. Odagi tazele.",           reward: 10 },
  { id: "fc4", title: "Rakibini dusun",       desc: "Simdi rakibin calisiyor. Ama sen de buradasin. Devam et.",        reward: 0 },
  { id: "fc5", title: "+50 XP ganimet!",      desc: "Bu bloku bitirirsen +50 XP bonus kazanacaksin. Devam et.",        reward: 50 },
  { id: "fc6", title: "1 soru coz",           desc: "Hemen 1 tane soru coz. Kucuk adim, buyuk kazanim.",               reward: 15 },
  { id: "fc7", title: "Neden buradasin?",     desc: "YKS'ye kac gun kaldi? Bu blogu tamamla ve o hedefe bir adim at.", reward: 0 },
];

function FocusChallengePopup({ elapsed, onDismiss, onClaim }) {
  const ch = useMemo(() => FOCUS_CHALLENGES[Math.floor(Math.random() * FOCUS_CHALLENGES.length)], []);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 900, padding: "0 0 90px" }}>
      <div className="pi" style={{ background: "var(--s1)", border: "1px solid var(--acc)44", borderRadius: "14px", padding: "20px", maxWidth: "380px", width: "calc(100% - 24px)", boxShadow: "0 0 40px #e8c54720" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <Tag color="var(--acc)">ODAK MOLASI</Tag>
          <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>{Math.floor(elapsed / 60)}dk gecti</span>
        </div>
        <p style={{ fontSize: "15px", fontWeight: "700", color: "var(--acc)", marginBottom: "6px" }}>{ch.title}</p>
        <p style={{ fontSize: "12px", color: "var(--muted)", lineHeight: "1.6", marginBottom: "14px" }}>{ch.desc}</p>
        {ch.reward > 0 && <p style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--grn)", marginBottom: "12px" }}>+{ch.reward} XP kazanacaksin</p>}
        <div style={{ display: "flex", gap: "8px" }}>
          <Btn variant="ghost" onClick={onDismiss} style={{ flex: 1 }}>Atla</Btn>
          <Btn variant="primary" onClick={() => onClaim(ch.reward)} style={{ flex: 2 }}>Tamam, devam!</Btn>
        </div>
      </div>
    </div>
  );
}

function WeeklyReviewCard({ plans, trials, todos, checkins }) {
  const last7 = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - i * 86400000);
    return { date: d.toISOString().slice(0, 10), label: d.toLocaleDateString("tr-TR", { weekday: "short" }).slice(0, 2) };
  }).reverse(), []);

  const dayData = last7.map(({ date, label }) => {
    const dayPlan = plans[date] || [];
    const pct = dayPlan.length > 0
      ? Math.round((dayPlan.filter((x) => x.done).length / dayPlan.length) * 100)
      : -1;
    return { date, label, pct, isToday: date === todayStr() };
  });

  const totalStudyMin = last7.reduce((s, { date }) =>
    s + (plans[date] || []).filter((x) => x.done).reduce((a, x) => a + (x.actualMin || x.durationMin), 0), 0);
  const avgCi = (() => {
    const relevant = checkins.filter((c) => last7.some((d) => d.date === c.date));
    return relevant.length ? relevant.reduce((s, c) => s + c.score, 0) / relevant.length : 0;
  })();
  const totalBlocks = last7.reduce((s, { date }) =>
    s + (plans[date] || []).filter((x) => x.done && x.kind !== "trial").length, 0);
  const trialCount = trials.filter((t) => last7.some((d) => d.date === t.date)).length;

  const filled = dayData.filter((d) => d.pct >= 0);
  const bestDay  = filled.length ? [...filled].sort((a, b) => b.pct - a.pct)[0]  : null;
  const worstDay = filled.length ? [...filled].sort((a, b) => a.pct - b.pct)[0]  : null;

  return (
    <Card style={{ padding: "14px" }}>
      <Label style={{ marginBottom: "10px" }}>Haftalik Ozet</Label>
      <div style={{ display: "flex", gap: "4px", alignItems: "flex-end", height: "50px", marginBottom: "10px" }}>
        {dayData.map((d) => {
          const h = d.pct >= 0 ? Math.max(8, (d.pct / 100) * 44) : 4;
          const c = d.pct >= 80 ? "var(--grn)" : d.pct >= 50 ? "var(--acc)" : d.pct >= 0 ? "var(--red)" : "var(--b2)";
          return (
            <div key={d.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: "3px" }}>
              <div style={{ width: "100%", height: `${h}px`, background: c, borderRadius: "3px 3px 0 0", transition: "height .5s ease", outline: d.isToday ? `2px solid ${c}` : "none", outlineOffset: "2px" }} />
              <span style={{ fontSize: "8px", color: d.isToday ? "var(--txt)" : "var(--muted)", fontFamily: "var(--mono)" }}>{d.label}</span>
            </div>
          );
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "6px", marginBottom: "10px" }}>
        {[
          { l: "Calisma",  v: fmtHHMM(totalStudyMin), c: "var(--blu)" },
          { l: "Blok",     v: totalBlocks,             c: "var(--acc)" },
          { l: "Deneme",   v: trialCount,              c: "var(--pur)" },
          { l: "CI Ort",   v: avgCi ? avgCi.toFixed(1) : "--", c: avgCi >= 3 ? "var(--grn)" : "var(--acc)" },
        ].map((x) => (
          <div key={x.l} style={{ textAlign: "center", padding: "7px 4px", background: "var(--s2)", borderRadius: "6px" }}>
            <p style={{ fontFamily: "var(--mono)", fontSize: "14px", fontWeight: "700", color: x.c }}>{x.v}</p>
            <p style={{ fontSize: "8px", color: "var(--muted)", marginTop: "2px" }}>{x.l}</p>
          </div>
        ))}
      </div>
      {bestDay && worstDay && bestDay.date !== worstDay.date && (
        <div style={{ display: "flex", gap: "6px" }}>
          <div style={{ flex: 1, padding: "6px 8px", background: "var(--grn)08", borderRadius: "6px", border: "1px solid var(--grn)22" }}>
            <p style={{ fontSize: "9px", color: "var(--grn)", fontFamily: "var(--mono)", marginBottom: "2px" }}>EN IYI</p>
            <p style={{ fontSize: "11px" }}>{bestDay.label} -- %{bestDay.pct}</p>
          </div>
          <div style={{ flex: 1, padding: "6px 8px", background: "var(--red)08", borderRadius: "6px", border: "1px solid var(--red)22" }}>
            <p style={{ fontSize: "9px", color: "var(--red)", fontFamily: "var(--mono)", marginBottom: "2px" }}>ODAKLAN</p>
            <p style={{ fontSize: "11px" }}>{worstDay.label} -- %{worstDay.pct}</p>
          </div>
        </div>
      )}
    </Card>
  );
}

// ============================================================================
// Widgets: Countdown + Heatmap + Header + TabBar
// ============================================================================
function YKSCountdown() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((p) => p + 1), 60000);
    return () => clearInterval(id);
  }, []);
  const { days, hours, passed } = yksCountdown();
  if (passed) return <Tag color="var(--grn)">YKS GECTI</Tag>;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--red)", animation: "countdown 2s ease infinite", fontWeight: "700" }}>{days}G</span>
      <span style={{ fontSize: "10px", color: "var(--muted)" }}>{hours}s</span>
    </div>
  );
}

function Heatmap({ plans, trials, checkins }) {
  const cells = useMemo(() => {
    const pMap = {};
    const cMap = {};
    const tMap = {};
    Object.entries(plans || {}).forEach(([date, items]) => {
      const done = items.filter((x) => x.done).length;
      const total = items.length;
      if (total > 0) pMap[date] = Math.round((done / total) * 3);
    });
    // also read legacy dw sessions for backward compat
    const dw = store.load(KEYS.dw, { sessions: [] });
    (dw.sessions || []).forEach((s) => {
      if (!pMap[s.date] && s.completedMin > 0) pMap[s.date] = Math.min(3, Math.floor(s.completedMin / 60));
    });
    (checkins || []).forEach((c) => { cMap[c.date] = c.score; });
    (trials || []).forEach((t) => { tMap[t.date] = (tMap[t.date] || 0) + 1; });
    return Array.from({ length: 84 }, (_, i) => {
      const key = new Date(Date.now() - (83 - i) * 86400000).toISOString().slice(0, 10);
      const score = clamp((pMap[key] || 0) + ((cMap[key] ?? -1) >= 3 ? 1 : 0) + (tMap[key] || 0), 0, 4);
      return { key, score, isToday: key === todayStr() };
    });
  }, [plans, trials, checkins]);

  const colors = ["var(--b2)", "#1a3a2a", "#2a5a3a", "#3a8a5a", "var(--grn)"];
  return (
    <div>
      <Label style={{ marginBottom: "8px" }}>12 Haftalik Aktivite</Label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(84,1fr)", gap: "2px" }}>
        {cells.map((c) => (
          <div key={c.key} title={c.key} style={{ aspectRatio: "1", borderRadius: "2px", background: colors[c.score], outline: c.isToday ? "1px solid var(--acc)" : "none", outlineOffset: "1px" }} />
        ))}
      </div>
      <div style={{ display: "flex", gap: "5px", alignItems: "center", marginTop: "6px", justifyContent: "flex-end" }}>
        <span style={{ fontSize: "9px", color: "var(--muted)" }}>az</span>
        {colors.map((c, i) => <div key={i} style={{ width: "9px", height: "9px", background: c, borderRadius: "2px" }} />)}
        <span style={{ fontSize: "9px", color: "var(--muted)" }}>cok</span>
      </div>
    </div>
  );
}

function Header({ onToggleHeat, heatOpen, alerts, xp }) {
  const today = todayStr();
  const checkins = store.load(KEYS.checkins, []);
  const todayCI = checkins.find((c) => c.date === today);
  const lv = calcLevel(xp.points);
  const totalAlerts = Object.values(alerts).reduce((s, n) => s + (n || 0), 0);

  return (
    <div style={{ marginBottom: "18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
        <div>
          <h1 style={{ fontFamily: "var(--mono)", fontSize: "16px", fontWeight: "700", letterSpacing: "-0.5px" }}>YKS · SAVAS ODASI</h1>
          <p style={{ fontSize: "10px", color: "var(--muted)", marginTop: "2px", fontFamily: "var(--mono)" }}>
            {new Date().toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" })}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
          <YKSCountdown />
          <button onClick={onToggleHeat} title="Heatmap" style={{ padding: "4px 8px", fontSize: "9px", fontFamily: "var(--mono)", background: "var(--s1)", border: "1px solid var(--b2)", borderRadius: "4px", color: heatOpen ? "var(--acc)" : "var(--muted)", cursor: "pointer" }}>▦</button>
          {!todayCI
            ? <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: "var(--red)", display: "inline-block", animation: "blink 1.5s ease infinite" }} />
                <span style={{ fontSize: "9px", color: "var(--red)", fontFamily: "var(--mono)" }}>check-in</span>
              </div>
            : <Tag color={todayCI.score >= 3 ? "var(--grn)" : "var(--acc)"}>{todayCI.score}/4</Tag>}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "6px" }}>
        <div style={{ padding: "8px 9px", background: totalAlerts > 0 ? "var(--red)10" : "var(--s1)", border: `1px solid ${totalAlerts > 0 ? "var(--red)33" : "var(--b1)"}`, borderRadius: "7px", textAlign: "center" }}>
          <p style={{ fontFamily: "var(--mono)", fontSize: "16px", fontWeight: "700", color: "var(--red)", lineHeight: 1, animation: totalAlerts > 0 ? "blink 2s ease infinite" : "none" }}>{totalAlerts}</p>
          <p style={{ fontSize: "9px", color: "var(--muted)", marginTop: "2px" }}>Uyari</p>
        </div>
        <div style={{ padding: "8px 9px", background: "var(--s1)", border: "1px solid var(--b1)", borderRadius: "7px", textAlign: "center" }}>
          <p className={xp.streak >= 7 ? "streakFire" : ""} style={{ fontFamily: "var(--mono)", fontSize: "16px", fontWeight: "700", color: xp.streak >= 7 ? "var(--ora)" : "var(--acc)", lineHeight: 1 }}>
            {xp.streak >= 3 ? "🔥" : ""}{xp.streak || 0}
          </p>
          <p style={{ fontSize: "9px", color: "var(--muted)", marginTop: "2px" }}>Streak</p>
        </div>
        <div style={{ padding: "8px 9px", background: "var(--s1)", border: `1px solid ${lv.color}33`, borderRadius: "7px", textAlign: "center" }}>
          <p style={{ fontFamily: "var(--mono)", fontSize: "12px", fontWeight: "700", color: lv.color, lineHeight: 1 }}>{lv.name}</p>
          {lv.next
            ? <div style={{ width: "100%", height: "2px", background: "var(--b2)", borderRadius: "99px", marginTop: "4px", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${lv.pct}%`, background: lv.color, borderRadius: "99px" }} />
              </div>
            : <p style={{ fontSize: "8px", color: lv.color, marginTop: "3px" }}>MAX</p>}
        </div>
        <div style={{ padding: "8px 9px", background: "var(--s1)", border: "1px solid var(--b1)", borderRadius: "7px", textAlign: "center" }}>
          <p style={{ fontFamily: "var(--mono)", fontSize: "16px", fontWeight: "700", color: "var(--pur)", lineHeight: 1 }}>{xp.points}</p>
          <p style={{ fontSize: "9px", color: "var(--muted)", marginTop: "2px" }}>XP</p>
        </div>
      </div>
    </div>
  );
}

const TABS = [
  { key: "plan",       icon: "▦",  label: "Plan" },
  { key: "brain",      icon: "◈",  label: "Dump" },
  { key: "trials",     icon: "◉",  label: "Denemeler" },
  { key: "todos",      icon: "◻",  label: "Gorevler" },
  { key: "discipline", icon: "◆",  label: "Disiplin" },
];

function TabBar({ active, onChange, alerts }) {
  return (
    <div style={{ display: "flex", gap: "2px", padding: "4px", background: "var(--s1)", borderRadius: "10px", border: "1px solid var(--b1)", marginBottom: "20px" }}>
      {TABS.map((t) => (
        <button key={t.key} onClick={() => onChange(t.key)}
          style={{ flex: 1, padding: "7px 2px", borderRadius: "7px", fontFamily: "var(--sans)", fontSize: "9px", fontWeight: "600", letterSpacing: "0.3px", background: active === t.key ? "var(--acc)" : "transparent", color: active === t.key ? "#000" : "var(--muted)", position: "relative", transition: "all .15s" }}>
          <span style={{ display: "block", fontFamily: "var(--mono)", fontSize: "12px", marginBottom: "2px" }}>{t.icon}</span>
          {t.label}
          {(alerts?.[t.key] || 0) > 0 && (
            <span style={{ position: "absolute", top: "4px", right: "5px", width: "5px", height: "5px", borderRadius: "50%", background: "var(--red)", display: "block", animation: "blink 1.5s ease infinite" }} />
          )}
        </button>
      ))}
    </div>
  );
}

// ============================================================================
// PLAN TAB
// ============================================================================
const DELAY_REASONS = ["Dikkat dagildi", "Konu zor", "Teknoloji", "Yorgunluk", "Diger"];

function PlanTab({ trials, setTrials, todos, onPushTodos }) {
  const today = todayStr();
  const [plans, setPlansRaw] = useState(() => store.load(KEYS.plan, {}));
  const [attn, setAttnRaw] = useState(() => store.load(KEYS.attn, {}));
  const checkins = useMemo(() => store.load(KEYS.checkins, []), []);

  const setPlans = useCallback((fn) => {
    setPlansRaw((p) => { const n = typeof fn === "function" ? fn(p) : fn; store.save(KEYS.plan, n); return n; });
  }, []);
  const setAttn = useCallback((fn) => {
    setAttnRaw((p) => { const n = typeof fn === "function" ? fn(p) : fn; store.save(KEYS.attn, n); return n; });
  }, []);

  const todayPlan = plans[today] || [];
  const weeklyRec = useMemo(() => buildWeeklyPlan(trials, 4), [trials]);

  // Timer state
  const [activeId, setActiveId] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [timerPhase, setTimerPhase] = useState("idle"); // idle|run|warn
  const [breakReason, setBreakReason] = useState("");
  const itvRef = useRef(null);

  // Dopamine state
  const [xpBurst, setXpBurst] = useState(null);
  const [focusChallenge, setFocusChallenge] = useState(false);
  const [lastChallengeAt, setLastChallengeAt] = useState(0);
  const [winBlockId, setWinBlockId] = useState(null);

  // Trial analysis after block done
  const [pendingTrialItem, setPendingTrialItem] = useState(null);
  const [delayModal, setDelayModal] = useState(null);

  // Add form
  const nowMin = nowHHMM();
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({
    startMin: minsToHHMM(Math.ceil(nowMin / 30) * 30),
    dur: "75", subject: "", note: "", kind: "study", trialType: "TYT",
  });

  const FOCUS_QUOTES = [
    "Rakibin simdi calisiyor. Sen ne yapiyorsun?",
    "Bu blok bitince mola hakkin var. Henuz degil.",
    "Disiplin, motivasyon olmadigi zamanlarda ne yaptigindir.",
    "Flow state esigindeydin. Devam et.",
    "60 dakikanin icinde bir omur degisebilir.",
    "Yorgunluk gecici, YKS kalici. Devam.",
    "Simdi calistiklarin, haziran sana geri donecek.",
  ];
  const [quote, setQuote] = useState(() => FOCUS_QUOTES[Math.floor(Math.random() * FOCUS_QUOTES.length)]);

  // Timer controls
  const startTimer = useCallback((id) => {
    clearInterval(itvRef.current);
    setActiveId(id);
    setElapsed(0);
    setTimerPhase("run");
    setBreakReason("");
    playSound("start");
    itvRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);
  }, []);

  const stopTimer = useCallback(() => {
    clearInterval(itvRef.current);
    setActiveId(null);
    setTimerPhase("idle");
    setElapsed(0);
  }, []);

  useEffect(() => () => clearInterval(itvRef.current), []);

  // Auto-complete when timer hits duration
  useEffect(() => {
    if (timerPhase !== "run" || !activeId) return;
    const item = (plans[today] || []).find((x) => x.id === activeId);
    if (!item) return;
    if (elapsed >= item.durationMin * 60) {
      clearInterval(itvRef.current);
      setTimerPhase("idle");
      finishBlock(activeId, item.durationMin, false, null);
    }
  }, [elapsed, timerPhase, activeId]);

  // Rotate quote every 15 min
  useEffect(() => {
    if (timerPhase === "run" && elapsed > 0 && elapsed % (15 * 60) === 0) {
      setQuote(FOCUS_QUOTES[Math.floor(Math.random() * FOCUS_QUOTES.length)]);
    }
  }, [elapsed, timerPhase]);

  // Focus challenge every 20 min
  useEffect(() => {
    if (timerPhase !== "run" || focusChallenge) return;
    if (elapsed > 0 && elapsed % (20 * 60) === 0 && elapsed !== lastChallengeAt) {
      setLastChallengeAt(elapsed);
      setFocusChallenge(true);
    }
  }, [elapsed, timerPhase, focusChallenge, lastChallengeAt]);

  const finishBlock = (id, actualMin, early, breakData) => {
    const item = (plans[today] || []).find((x) => x.id === id);
    if (!item) return;

    setPlans((p) => ({
      ...p,
      [today]: (p[today] || []).map((x) =>
        x.id === id ? { ...x, done: true, doneAt: new Date().toISOString(), actualMin } : x
      ),
    }));

    // Backward compat: write to dw sessions
    const dwPrev = store.load(KEYS.dw, { sessions: [], goalMin: 180 });
    const prevSess = dwPrev.sessions.find((s) => s.date === today);
    const nb = { id: uid(), dur: actualMin, early, at: new Date().toISOString(), planItemId: id, subject: item.subject };
    const upd = prevSess
      ? { ...prevSess, blocks: [...(prevSess.blocks || []), nb], completedMin: (prevSess.completedMin || 0) + actualMin, earlyBreaks: (prevSess.earlyBreaks || 0) + (early ? 1 : 0) }
      : { date: today, goalMin: 180, blocks: [nb], completedMin: actualMin, earlyBreaks: early ? 1 : 0 };
    store.save(KEYS.dw, { ...dwPrev, sessions: [upd, ...dwPrev.sessions.filter((s) => s.date !== today)] });

    // Attention
    if (breakData) {
      setAttn((p) => {
        const prev = p[today] || { breaks: [] };
        return { ...p, [today]: { ...prev, breaks: [...prev.breaks, breakData] } };
      });
    }

    // XP + level check
    const prevXP = loadXP();
    const prevLv = calcLevel(prevXP.points);
    const { pts } = grantXP("block_done");
    const newXP = loadXP();
    const newLv = calcLevel(newXP.points);
    const didLevelUp = newLv.name !== prevLv.name;

    setWinBlockId(id);
    setTimeout(() => setWinBlockId(null), 600);

    if (didLevelUp) {
      playSound("level_up");
      setXpBurst({ pts: pts + 100, label: `LEVEL UP: ${newLv.name}!` });
      setTimeout(() => toast(`LEVEL UP! ${newLv.name}`, newLv.color), 400);
    } else {
      playSound("block_win");
      setXpBurst({ pts, label: early ? "Erken bitti -- devam!" : "Blok tamam!" });
    }

    // Streak milestone
    if (newXP.streak === 7 || newXP.streak === 14 || newXP.streak === 30) {
      playSound("streak");
      const bonusPts = newXP.streak >= 14 ? XP_R.streak_14 : XP_R.streak_7;
      const bonusKey = newXP.streak >= 14 ? "streak_14" : "streak_7";
      const bonusXP = loadXP();
      bonusXP.points += bonusPts;
      store.save(KEYS.xp, bonusXP);
      setTimeout(() => toast(`🔥 ${newXP.streak} gun serisi! +${bonusPts} XP`, "var(--ora)"), 800);
    }

    // All done?
    const remaining = (plans[today] || []).filter((x) => !x.done && x.id !== id).length;
    if (remaining === 0 && (plans[today] || []).length > 0) {
      grantXP("plan_done");
      setTimeout(() => toast(`+${XP_R.plan_done} XP -- Gunluk plan TAMAM!`, "var(--grn)"), 1200);
    }

    if (item.kind === "trial") {
      setPendingTrialItem(item);
    }
    stopTimer();
  };

  const requestEarlyBreak = () => {
    clearInterval(itvRef.current);
    setTimerPhase("warn");
    playSound("warn");
  };

  const confirmBreak = () => {
    if (!breakReason) return;
    const elMin = Math.floor(elapsed / 60);
    const bd = { type: "early", blockMin: elMin, reason: breakReason, at: new Date().toISOString() };
    finishBlock(activeId, elMin, true, bd);
  };

  const resumeFromWarn = () => {
    setTimerPhase("run");
    setBreakReason("");
    itvRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);
    playSound("start");
  };

  const markDoneManual = (id) => {
    const item = todayPlan.find((x) => x.id === id);
    if (!item) return;
    const expectedEnd = item.startMin + item.durationMin;
    const delayedMin = Math.max(0, nowMin - expectedEnd);
    if (delayedMin > 15 && !item.done) {
      setDelayModal({ id, delayedMin });
      return;
    }
    finishBlock(id, item.durationMin, false, null);
  };

  const addItem = () => {
    if (!form.subject.trim() && form.kind !== "trial") return;
    const subject = form.kind === "trial" ? `${form.trialType} Deneme` : form.subject.trim();
    const item = {
      id: uid(),
      startMin: hhmmToMins(form.startMin),
      durationMin: parseInt(form.dur, 10) || 75,
      subject,
      note: form.note,
      kind: form.kind,
      trialType: form.kind === "trial" ? form.trialType : undefined,
      done: false, doneAt: null, delayReason: "", actualMin: null,
    };
    setPlans((p) => ({
      ...p,
      [today]: [...(p[today] || []), item].sort((a, b) => a.startMin - b.startMin),
    }));
    setForm((f) => ({ ...f, subject: "", note: "" }));
    setAddOpen(false);
    toast(`Plan ogesi eklendi: ${subject}`, "var(--acc)");
  };

  const delItem = (id) => {
    if (activeId === id) stopTimer();
    setPlans((p) => ({ ...p, [today]: (p[today] || []).filter((x) => x.id !== id) }));
  };

  const totalPlanned = todayPlan.reduce((s, x) => s + x.durationMin, 0);
  const totalActual  = todayPlan.filter((x) => x.done).reduce((s, x) => s + (x.actualMin || x.durationMin), 0);
  const completionPct = todayPlan.length > 0
    ? Math.round((todayPlan.filter((x) => x.done).length / todayPlan.length) * 100)
    : 0;
  const overdueItems = todayPlan.filter((p) => !p.done && p.startMin + p.durationMin < nowMin);
  const attnScore = calcAttentionScore(attn[today]?.breaks || []);
  const { label: aLabel, color: aColor } = attentionLabel(attnScore);
  const activeItem = todayPlan.find((x) => x.id === activeId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>

      {/* Overlays */}
      {xpBurst && <XPBurst pts={xpBurst.pts} label={xpBurst.label} onDone={() => setXpBurst(null)} />}
      {focusChallenge && (
        <FocusChallengePopup
          elapsed={elapsed}
          onDismiss={() => setFocusChallenge(false)}
          onClaim={(bonus) => {
            if (bonus > 0) {
              const xpd = loadXP();
              xpd.points += bonus;
              store.save(KEYS.xp, xpd);
              toast(`+${bonus} XP odak bonusu!`, "var(--acc)");
            }
            setFocusChallenge(false);
          }}
        />
      )}

      {/* Day score */}
      <DayScoreBar plans={plans} checkins={checkins} attn={attn} />

      {/* Overdue alert */}
      {overdueItems.length > 0 && (
        <div className="flashR alarmShake" style={{ padding: "11px 13px", background: "var(--red)08", border: "1px solid var(--red)44", borderRadius: "8px", display: "flex", gap: "10px", alignItems: "center" }}>
          <span style={{ fontSize: "16px" }}>⚡</span>
          <div>
            <p style={{ fontSize: "12px", fontWeight: "600", color: "var(--red)" }}>{overdueItems.length} plan ogesi gecikti</p>
            <p style={{ fontSize: "11px", color: "var(--muted)", marginTop: "1px" }}>{overdueItems.map((x) => x.subject).join(", ")}</p>
          </div>
        </div>
      )}

      {/* Active focus timer */}
      {activeItem && timerPhase === "run" && (
        <Card style={{ border: "1px solid var(--acc)33", background: "var(--s2)" }} className="fi glowBorder">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <div>
              <Label style={{ marginBottom: "2px" }}>Odak Modu</Label>
              <p style={{ fontSize: "13px", fontWeight: "600", color: "var(--acc)" }}>{activeItem.subject}</p>
            </div>
            <p style={{ fontFamily: "var(--mono)", fontSize: "30px", fontWeight: "900", color: "var(--acc)", textShadow: "0 0 12px #e8c54750" }}>
              {fmtMMSS(Math.max(0, activeItem.durationMin * 60 - elapsed))}
            </p>
          </div>
          <PBar value={elapsed} max={activeItem.durationMin * 60} color="var(--acc)" h={5} />
          <p style={{ fontSize: "11px", color: "var(--muted)", fontStyle: "italic", lineHeight: "1.6", margin: "10px 0" }}>"{quote}"</p>
          <div style={{ display: "flex", gap: "8px" }}>
            <Btn variant="ghost" onClick={requestEarlyBreak} style={{ flex: 1 }}>Mola iste</Btn>
            <Btn variant="success"
              onClick={() => { clearInterval(itvRef.current); finishBlock(activeId, Math.floor(elapsed / 60), false, null); }}
              style={{ flex: 1 }}>Bitir</Btn>
          </div>
        </Card>
      )}

      {/* Break reason picker */}
      {timerPhase === "warn" && activeItem && (
        <Card style={{ border: "1px solid var(--red)44", background: "var(--red)06" }} className="flashR fi">
          <Label style={{ marginBottom: "6px" }}>Erken mola -- neden?</Label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginBottom: "10px" }}>
            {BREAK_REASONS.map((r) => (
              <button key={r} onClick={() => setBreakReason(r)}
                style={{ padding: "4px 9px", borderRadius: "5px", border: `1px solid ${breakReason === r ? "var(--acc)" : "var(--b2)"}`, background: breakReason === r ? "var(--acc)22" : "transparent", color: breakReason === r ? "var(--acc)" : "var(--muted)", fontSize: "11px", cursor: "pointer" }}>
                {r}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <Btn variant="primary" style={{ flex: 2 }} onClick={resumeFromWarn}>Devam et</Btn>
            <Btn variant="danger" style={{ flex: 1 }} disabled={!breakReason} onClick={confirmBreak}>Mola al</Btn>
          </div>
        </Card>
      )}

      {/* Trial analysis inline */}
      {pendingTrialItem && (
        <Card style={{ border: "1px solid var(--blu)33" }} className="pi">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <p style={{ fontWeight: "600", fontSize: "13px", color: "var(--blu)" }}>Deneme Analizi -- {pendingTrialItem.subject}</p>
            <Btn size="sm" variant="ghost" onClick={() => setPendingTrialItem(null)}>Sonra</Btn>
          </div>
          <TrialForm
            defaultType={pendingTrialItem.trialType || "TYT"}
            defaultDate={today}
            onSave={(t) => {
              const updated = [t, ...trials];
              setTrials(updated);
              store.save(KEYS.trials, updated);
              grantXP("trial_added");
              toast(`Deneme kaydedildi -- ${t.totalNet} net`, "var(--blu)");
              const todoItems = buildTrialTodos(t);
              if (todoItems.length) {
                onPushTodos(todoItems);
                toast(`${todoItems.length} gorev otomatik eklendi`, "var(--acc)");
              }
              setPendingTrialItem(null);
            }}
            onCancel={() => setPendingTrialItem(null)}
          />
        </Card>
      )}

      {/* Progress summary */}
      {todayPlan.length > 0 && (
        <Card style={{ padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
            <Label>Bugunun Plani</Label>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>{fmtHHMM(totalActual)}/{fmtHHMM(totalPlanned)}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: completionPct === 100 ? "var(--grn)" : "var(--acc)" }}>{completionPct}%</span>
            </div>
          </div>
          <PBar value={completionPct} max={100} color={completionPct === 100 ? "var(--grn)" : "var(--acc)"} />
          {completionPct === 100 && (
            <div className="blockWin" style={{ marginTop: "8px", textAlign: "center", padding: "6px", background: "var(--grn)08", borderRadius: "6px" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--grn)", fontWeight: "700" }}>PLAN TAMAM -- harika is!</span>
            </div>
          )}
          {(attn[today]?.breaks || []).length > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "8px" }}>
              <Tag color={aColor}>{aLabel}</Tag>
              <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>{attnScore}/100</span>
            </div>
          )}
        </Card>
      )}

      {/* Weekly rec when empty */}
      {weeklyRec.length > 0 && todayPlan.length === 0 && (
        <Card style={{ padding: "12px 14px" }}>
          <Label style={{ marginBottom: "8px" }}>Bugunku Oncelikler (deneme bazli)</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            {weeklyRec.slice(0, 4).map((w) => (
              <div key={w.subject} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", background: "var(--s2)", borderRadius: "6px" }}>
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: w.priority === "high" ? "var(--red)" : w.priority === "medium" ? "var(--acc)" : "var(--grn)" }} />
                  <span style={{ fontSize: "12px" }}>{w.subject}</span>
                </div>
                <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>{fmtHHMM(w.dailyMin)}/gun</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Plan list */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {todayPlan.length === 0 && !addOpen && <EmptyState icon="▦" title="Bugun icin plan yok" desc="Plan yap, zamana sahip cik." />}
        {todayPlan.map((item) => (
          <PlanItemRow
            key={item.id}
            item={item}
            nowMin={nowMin}
            activeId={activeId}
            elapsed={elapsed}
            timerPhase={timerPhase}
            winBlockId={winBlockId}
            onStart={() => startTimer(item.id)}
            onStop={stopTimer}
            onDone={() => markDoneManual(item.id)}
            onDelete={() => delItem(item.id)}
          />
        ))}
      </div>

      {/* Add form */}
      {addOpen ? (
        <Card style={{ padding: "14px" }}>
          <Label style={{ marginBottom: "10px" }}>Yeni Plan Ogesi</Label>
          <div style={{ display: "flex", gap: "6px", marginBottom: "10px" }}>
            {[["study", "Ders"], ["trial", "Deneme"]].map(([k, l]) => (
              <button key={k} onClick={() => setForm((f) => ({ ...f, kind: k }))}
                style={{ flex: 1, padding: "7px", borderRadius: "6px", border: `1px solid ${form.kind === k ? "var(--acc)" : "var(--b2)"}`, background: form.kind === k ? "var(--acc)18" : "transparent", color: form.kind === k ? "var(--acc)" : "var(--muted)", fontSize: "12px", fontWeight: "600", cursor: "pointer" }}>
                {l}
              </button>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "8px" }}>
            <div>
              <Label style={{ marginBottom: "4px" }}>Saat</Label>
              <input type="time" value={form.startMin} onChange={(e) => setForm((f) => ({ ...f, startMin: e.target.value }))} style={{ padding: "7px 10px", fontSize: "13px", width: "100%", borderRadius: "6px" }} />
            </div>
            <div>
              <Label style={{ marginBottom: "4px" }}>Sure (dk)</Label>
              <select value={form.dur} onChange={(e) => setForm((f) => ({ ...f, dur: e.target.value }))} style={{ padding: "7px 10px", fontSize: "13px", width: "100%", borderRadius: "6px" }}>
                {[30, 45, 60, 75, 90, 120, 150, 180].map((d) => <option key={d}>{d}</option>)}
              </select>
            </div>
          </div>
          {form.kind === "trial" ? (
            <div style={{ marginBottom: "8px" }}>
              <Label style={{ marginBottom: "4px" }}>Deneme Turu</Label>
              <div style={{ display: "flex", gap: "6px" }}>
                {["TYT", "AYT"].map((t) => (
                  <button key={t} onClick={() => setForm((f) => ({ ...f, trialType: t }))}
                    style={{ flex: 1, padding: "7px", borderRadius: "6px", border: `1px solid ${form.trialType === t ? "var(--blu)" : "var(--b2)"}`, background: form.trialType === t ? "var(--blu)18" : "transparent", color: form.trialType === t ? "var(--blu)" : "var(--muted)", fontSize: "12px", cursor: "pointer" }}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: "8px" }}>
                <Label style={{ marginBottom: "4px" }}>Ders / Konu</Label>
                <input value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && addItem()} placeholder="Matematik - Turev" style={{ padding: "8px 10px", fontSize: "13px", width: "100%", borderRadius: "6px" }} />
              </div>
              <div style={{ marginBottom: "12px" }}>
                <Label style={{ marginBottom: "4px" }}>Not (opsiyonel)</Label>
                <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="Konu detayi..." style={{ padding: "8px 10px", fontSize: "13px", width: "100%", borderRadius: "6px" }} />
              </div>
            </>
          )}
          <div style={{ display: "flex", gap: "8px" }}>
            <Btn variant="ghost" onClick={() => setAddOpen(false)} style={{ flex: 1 }}>Iptal</Btn>
            <Btn variant="primary" onClick={addItem} style={{ flex: 2 }}>Planla</Btn>
          </div>
        </Card>
      ) : (
        <Btn variant="primary" onClick={() => setAddOpen(true)} style={{ width: "100%", padding: "11px" }}>+ Plan Ogesi Ekle</Btn>
      )}

      {delayModal && (
        <DelayModal
          delayedMin={delayModal.delayedMin}
          onConfirm={(r) => {
            setPlans((p) => ({ ...p, [today]: (p[today] || []).map((x) => x.id === delayModal.id ? { ...x, done: true, doneAt: new Date().toISOString(), delayReason: r, actualMin: x.durationMin } : x) }));
            const item = todayPlan.find((x) => x.id === delayModal.id);
            if (item?.kind === "trial") setPendingTrialItem(item);
            setDelayModal(null);
            playSound("done");
            toast("Plan ogesi tamamlandi", "var(--grn)");
          }}
          onCancel={() => setDelayModal(null)}
        />
      )}
    </div>
  );
}

function PlanItemRow({ item, nowMin, activeId, elapsed, timerPhase, winBlockId, onStart, onStop, onDone, onDelete }) {
  const isActive = activeId === item.id;
  const isWin    = winBlockId === item.id;
  const status = item.done ? "done" : isActive ? "active" : nowMin > item.startMin + item.durationMin ? "late" : "upcoming";
  const colMap = { done: "var(--grn)", active: "var(--acc)", late: "var(--red)", upcoming: "var(--muted)" };
  const col = colMap[status];
  const pct = isActive ? clamp(Math.round((elapsed / (item.durationMin * 60)) * 100), 0, 100) : item.done ? 100 : 0;
  const borderCss = status === "late" ? "var(--red)33" : status === "active" ? "var(--acc)33" : status === "done" ? "var(--grn)22" : item.kind === "trial" ? "var(--blu)33" : "var(--b2)";

  return (
    <div className={`sr${isWin ? " blockWin" : ""}`}
      style={{ padding: "11px 13px", borderRadius: "8px", background: "var(--s2)", border: `1px solid ${borderCss}`, transition: "border-color .3s" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: isActive ? 8 : 0 }}>
        <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: col, minWidth: "38px", marginTop: "1px" }}>{minsToHHMM(item.startMin)}</span>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {item.kind === "trial" && <Tag color="var(--blu)">{item.trialType || "TYT"}</Tag>}
              <p style={{ fontSize: "13px", fontWeight: "500", textDecoration: item.done ? "line-through" : "none", color: item.done ? "var(--muted)" : "var(--txt)" }}>{item.subject}</p>
            </div>
            <div style={{ display: "flex", gap: "6px", marginTop: "3px", alignItems: "center" }}>
              <span style={{ fontSize: "10px", color: "var(--muted)" }}>{fmtHHMM(item.durationMin)}</span>
              {item.note && <span style={{ fontSize: "10px", color: "var(--muted)" }}>· {item.note}</span>}
              {status === "late" && <Tag color="var(--red)">Gecikmis</Tag>}
              {item.delayReason && <span style={{ fontSize: "10px", color: "var(--ora)" }}>· {item.delayReason}</span>}
              {item.done && item.actualMin && item.actualMin !== item.durationMin && (
                <span style={{ fontSize: "9px", color: "var(--acc)" }}>{fmtHHMM(item.actualMin)} gercek</span>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
          {!item.done && !isActive && <Btn size="sm" variant="accent" onClick={onStart}>▶</Btn>}
          {isActive && timerPhase === "run" && <Btn size="sm" variant="success" onClick={onDone}>✓</Btn>}
          {isActive && <Btn size="sm" variant="ghost" onClick={onStop} style={{ color: "var(--muted)" }}>◼</Btn>}
          {!item.done && !isActive && <Btn size="sm" variant="ghost" onClick={onDone} style={{ color: "var(--grn)" }}>✓</Btn>}
          <Btn size="sm" variant="ghost" onClick={onDelete} style={{ color: "var(--red)" }}>×</Btn>
        </div>
      </div>
      {isActive && timerPhase === "run" && (
        <div className="fi">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--acc)" }}>{fmtMMSS(elapsed)}</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>{pct}%</span>
          </div>
          <PBar value={elapsed} max={item.durationMin * 60} color="var(--acc)" h={3} />
        </div>
      )}
    </div>
  );
}

function DelayModal({ delayedMin, onConfirm, onCancel }) {
  const [reason, setReason] = useState("");
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px", backdropFilter: "blur(4px)" }}>
      <div className="pi" style={{ background: "var(--s1)", border: "1px solid var(--b2)", borderRadius: "12px", padding: "24px", maxWidth: "340px", width: "100%" }}>
        <p style={{ fontFamily: "var(--mono)", fontSize: "14px", color: "var(--acc)", fontWeight: "700", marginBottom: "8px" }}>⚡ {delayedMin} DK GECIKTIN</p>
        <p style={{ fontSize: "13px", color: "var(--muted)", lineHeight: "1.5", marginBottom: "16px" }}>Neden geciktin?</p>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "14px" }}>
          {DELAY_REASONS.map((r) => (
            <button key={r} onClick={() => setReason(r)}
              style={{ padding: "8px 11px", borderRadius: "6px", border: `1px solid ${reason === r ? "var(--acc)" : "var(--b2)"}`, background: reason === r ? "var(--acc)18" : "transparent", color: reason === r ? "var(--acc)" : "var(--muted)", fontSize: "12px", textAlign: "left", cursor: "pointer" }}>
              {r}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <Btn variant="ghost" onClick={onCancel} style={{ flex: 1 }}>Iptal</Btn>
          <Btn variant="primary" onClick={() => onConfirm(reason || "Belirtilmedi")} style={{ flex: 2 }} disabled={!reason}>Kaydet</Btn>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// TRIAL FORM -- structured per-subject wrong-topic input
// ============================================================================
function TrialForm({ onSave, onCancel, defaultType = "TYT", defaultDate }) {
  const [date, setDate]     = useState(defaultDate || todayStr());
  const [type, setType]     = useState(defaultType);
  const [nets, setNets]     = useState({});
  const [targets, setTargets] = useState({});
  const [wrongTopics, setWrongTopics] = useState([]);
  const [wtSubject, setWtSubject] = useState("");
  const [wtTopic, setWtTopic]     = useState("");

  const subs = type === "TYT" ? TYT_SUBS : AYT_SUBS;
  const setN = (s, f, v) => setNets((p) => ({ ...p, [s]: { ...(p[s] || {}), [f]: v } }));
  const totalNet = subs.reduce((sum, s) => sum + calcNet(nets[s]?.d, nets[s]?.y), 0);

  const addWrongTopic = () => {
    if (!wtSubject || !wtTopic.trim()) return;
    setWrongTopics((p) => [...p, { subject: wtSubject, topic: wtTopic.trim(), id: uid() }]);
    setWtTopic("");
  };

  const handleSave = () => {
    const list = subs
      .map((s) => ({ subject: s, correct: parseFloat(nets[s]?.d || 0), wrong: parseFloat(nets[s]?.y || 0), net: calcNet(nets[s]?.d, nets[s]?.y), target: parseFloat(targets[s] || 0) }))
      .filter((n) => n.correct > 0 || n.wrong > 0);
    if (!list.length) { toast("En az bir ders gir", "var(--red)"); return; }
    onSave({ id: uid(), date, type, nets: list, totalNet: parseFloat(totalNet.toFixed(2)), wrongTopics, todos: [], createdAt: new Date().toISOString() });
  };

  const subsWithWrong = subs.filter((s) => parseFloat(nets[s]?.y || 0) > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", gap: "9px" }}>
        <div style={{ flex: 1 }}>
          <Label style={{ marginBottom: "4px" }}>Tarih</Label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ padding: "7px 9px", fontSize: "12px", width: "100%", borderRadius: "6px" }} />
        </div>
        <div style={{ flex: 1 }}>
          <Label style={{ marginBottom: "4px" }}>Tur</Label>
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ padding: "7px 9px", fontSize: "12px", width: "100%", borderRadius: "6px" }}>
            <option>TYT</option><option>AYT</option>
          </select>
        </div>
        <div style={{ textAlign: "right", paddingTop: "16px" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: "18px", fontWeight: "700", color: "var(--acc)" }}>{totalNet.toFixed(1)}</span>
          <p style={{ fontSize: "9px", color: "var(--muted)" }}>net</p>
        </div>
      </div>

      <div>
        <Label style={{ marginBottom: "7px" }}>Netler D / Y + Hedef</Label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: "5px" }}>
          {subs.map((s) => {
            const n = calcNet(nets[s]?.d, nets[s]?.y);
            const tgt = parseFloat(targets[s] || 0);
            const hit = tgt > 0 && n >= tgt;
            const miss = tgt > 0 && n < tgt;
            return (
              <div key={s} style={{ background: "var(--s2)", borderRadius: "6px", padding: "8px 9px", border: `1px solid ${hit ? "var(--grn)33" : miss ? "var(--red)33" : "var(--b2)"}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                  <span style={{ fontSize: "11px" }}>{s}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: hit ? "var(--grn)" : miss ? "var(--red)" : "var(--acc)" }}>{n.toFixed(1)}</span>
                </div>
                <div style={{ display: "flex", gap: "3px" }}>
                  <input type="number" min="0" placeholder="D" value={nets[s]?.d || ""} onChange={(e) => setN(s, "d", e.target.value)} style={{ flex: 1, padding: "3px 5px", fontSize: "10px", textAlign: "center", color: "var(--grn)" }} />
                  <input type="number" min="0" placeholder="Y" value={nets[s]?.y || ""} onChange={(e) => setN(s, "y", e.target.value)} style={{ flex: 1, padding: "3px 5px", fontSize: "10px", textAlign: "center", color: "var(--red)" }} />
                  <input type="number" min="0" placeholder="H" value={targets[s] || ""} onChange={(e) => setTargets((p) => ({ ...p, [s]: e.target.value }))} style={{ flex: 1, padding: "3px 5px", fontSize: "10px", textAlign: "center", color: "var(--muted)" }} />
                </div>
              </div>
            );
          })}
        </div>
        <p style={{ fontSize: "9px", color: "var(--muted)", marginTop: "4px" }}>D=Dogru · Y=Yanlis · H=Hedef</p>
      </div>

      <div>
        <Label style={{ marginBottom: "7px" }}>Yanlis Konular</Label>
        <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
          <select value={wtSubject} onChange={(e) => setWtSubject(e.target.value)} style={{ flex: 1, padding: "6px 8px", fontSize: "12px" }}>
            <option value="">Ders sec...</option>
            {subs.map((s) => <option key={s}>{s}</option>)}
          </select>
          <input
            value={wtTopic}
            onChange={(e) => setWtTopic(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addWrongTopic()}
            placeholder="Konu (Turev, Elektrik...)"
            style={{ flex: 2, padding: "6px 8px", fontSize: "12px" }}
          />
          <Btn size="sm" variant="accent" onClick={addWrongTopic} disabled={!wtSubject || !wtTopic.trim()}>+</Btn>
        </div>
        {subsWithWrong.length > 0 && wrongTopics.length === 0 && (
          <p style={{ fontSize: "10px", color: "var(--acc)", marginBottom: "6px" }}>
            Yanlislar var: {subsWithWrong.join(", ")} -- yukaridan konularini ekle
          </p>
        )}
        {wrongTopics.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {wrongTopics.map((wt) => (
              <div key={wt.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 9px", background: "var(--s2)", borderRadius: "6px", border: "1px solid var(--red)22" }}>
                <div style={{ display: "flex", gap: "7px", alignItems: "center" }}>
                  <Tag color="var(--red)">{wt.subject}</Tag>
                  <span style={{ fontSize: "11px" }}>{wt.topic}</span>
                </div>
                <button onClick={() => setWrongTopics((p) => p.filter((x) => x.id !== wt.id))} style={{ background: "none", color: "var(--muted)", fontSize: "14px", cursor: "pointer" }}>×</button>
              </div>
            ))}
          </div>
        )}
        {wrongTopics.length > 0 && (
          <p style={{ fontSize: "10px", color: "var(--muted)", marginTop: "6px", lineHeight: "1.5" }}>
            {wrongTopics.length} konu -- kaydettiginizde otomatik gorev olusacak
          </p>
        )}
      </div>

      <div style={{ display: "flex", gap: "7px", justifyContent: "flex-end" }}>
        {onCancel && <Btn variant="ghost" onClick={onCancel}>Iptal</Btn>}
        <Btn variant="primary" onClick={handleSave}>Kaydet</Btn>
      </div>
    </div>
  );
}

// ============================================================================
// TRIALS TAB
// ============================================================================
function TrialsTab({ trials, setTrials, onPushTodos }) {
  const [adding, setAdding]   = useState(false);
  const [showOpt, setShowOpt] = useState(false);

  const save = (t) => {
    const updated = [t, ...trials];
    setTrials(updated);
    store.save(KEYS.trials, updated);
    grantXP("trial_added");
    toast(`Deneme kaydedildi -- ${t.totalNet} net`, "var(--blu)");
    const todoItems = buildTrialTodos(t);
    if (todoItems.length) {
      onPushTodos(todoItems);
      toast(`${todoItems.length} gorev otomatik eklendi`, "var(--acc)");
    }
    setAdding(false);
  };

  const del = (id) => {
    const u = trials.filter((t) => t.id !== id);
    setTrials(u);
    store.save(KEYS.trials, u);
  };

  const trend = useMemo(() => {
    const m = {};
    [...trials].reverse().forEach((t) => {
      if (!m[t.type]) m[t.type] = [];
      m[t.type].push({ net: t.totalNet, date: t.date });
    });
    return m;
  }, [trials]);

  const weekPlan  = useMemo(() => buildWeeklyPlan(trials, 4), [trials]);
  const weakness  = useMemo(() => buildSubjectWeakness(trials).filter((w) => w.gap > 0), [trials]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "13px" }}>
      {Object.keys(trend).length > 0 && (
        <div style={{ display: "flex", gap: "9px" }}>
          {Object.entries(trend).map(([type, arr]) => {
            const last = arr[arr.length - 1]?.net;
            const prev = arr[arr.length - 2]?.net;
            const d = prev !== undefined ? last - prev : null;
            return (
              <Card key={type} style={{ flex: 1, textAlign: "center", padding: "11px" }}>
                <Tag color={type === "TYT" ? "var(--blu)" : "var(--acc)"}>{type}</Tag>
                <p style={{ fontFamily: "var(--mono)", fontSize: "24px", fontWeight: "700", color: "var(--acc)", margin: "5px 0 2px" }}>{last?.toFixed(1)}</p>
                <p style={{ fontSize: "9px", color: "var(--muted)" }}>son net</p>
                {d !== null && <p style={{ fontFamily: "var(--mono)", fontSize: "10px", marginTop: "2px", color: d >= 0 ? "var(--grn)" : "var(--red)" }}>{d >= 0 ? "▲" : "▼"} {Math.abs(d).toFixed(1)}</p>}
              </Card>
            );
          })}
        </div>
      )}

      {weakness.length > 0 && (
        <Card style={{ padding: "12px 14px" }}>
          <Label style={{ marginBottom: "8px", color: "var(--red)" }}>Acil Konular</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            {weakness.slice(0, 5).map((w) => (
              <div key={w.subject} style={{ display: "flex", justifyContent: "space-between", padding: "5px 8px", background: "var(--s2)", borderRadius: "6px", border: "1px solid var(--red)22" }}>
                <span style={{ fontSize: "12px" }}>{w.subject}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--red)" }}>+{w.gap.toFixed(1)} acik</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {weekPlan.length > 0 && (
        <div>
          <button onClick={() => setShowOpt((p) => !p)} style={{ fontSize: "11px", color: "var(--acc)", background: "none", border: "none", cursor: "pointer", marginBottom: "6px", display: "flex", alignItems: "center", gap: "5px" }}>
            <span style={{ fontFamily: "var(--mono)" }}>◈</span> {showOpt ? "Haftalik plani gizle" : "Haftalik plan optimizasyonu goster"}
          </button>
          {showOpt && (
            <Card style={{ padding: "13px" }} className="fi">
              <Label style={{ marginBottom: "8px" }}>Deneme Sonucuna Gore Haftalik Plan</Label>
              <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                {weekPlan.map((w) => (
                  <div key={w.subject} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 9px", background: "var(--s2)", borderRadius: "6px", border: `1px solid ${w.priority === "high" ? "var(--red)33" : w.priority === "medium" ? "var(--acc)33" : "var(--grn)33"}` }}>
                    <div style={{ display: "flex", gap: "7px", alignItems: "center" }}>
                      <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: w.priority === "high" ? "var(--red)" : w.priority === "medium" ? "var(--acc)" : "var(--grn)", flexShrink: 0 }} />
                      <span style={{ fontSize: "12px" }}>{w.subject}</span>
                    </div>
                    <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>{fmtHHMM(w.dailyMin)}/gun</span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: w.gap > 0 ? "var(--red)" : "var(--grn)" }}>{w.avg} ort</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {adding ? (
        <Card>
          <p style={{ fontWeight: "600", fontSize: "13px", marginBottom: "14px" }}>Yeni Deneme</p>
          <TrialForm onSave={save} onCancel={() => setAdding(false)} />
        </Card>
      ) : (
        <Btn variant="primary" onClick={() => setAdding(true)} style={{ width: "100%", padding: "11px" }}>+ Deneme Ekle</Btn>
      )}

      {!adding && trials.length === 0 && <EmptyState icon="◉" title="Henuz deneme yok" desc="Ilk denemeyi ekle ve analiz et." />}
      {!adding && trials.map((t) => <TrialCard key={t.id} trial={t} onDelete={del} onPushTodos={onPushTodos} />)}
    </div>
  );
}

function TrialCard({ trial, onDelete, onPushTodos }) {
  const [exp, setExp] = useState(false);
  const top  = [...trial.nets].sort((a, b) => b.net - a.net).slice(0, 3);
  const weak = [...trial.nets].sort((a, b) => a.net - b.net).slice(0, 2);
  const maxN = Math.max(...trial.nets.map((n) => n.net), 1);

  return (
    <Card className="sr" style={{ padding: "0", overflow: "hidden" }}>
      <div onClick={() => setExp((p) => !p)} style={{ padding: "11px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", background: exp ? "var(--s2)" : "transparent" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Tag color={trial.type === "TYT" ? "var(--blu)" : "var(--acc)"}>{trial.type}</Tag>
          <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--muted)" }}>{fmtDate(trial.date)}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: "18px", fontWeight: "700", color: "var(--acc)" }}>{trial.totalNet}</span>
        </div>
        <div style={{ display: "flex", gap: "7px", alignItems: "center" }}>
          {(trial.wrongTopics?.length || 0) > 0 && <Tag color="var(--red)">{trial.wrongTopics.length} konu</Tag>}
          <span style={{ color: "var(--muted)", fontSize: "10px", transform: exp ? "rotate(180deg)" : "none", transition: "transform .2s" }}>▼</span>
        </div>
      </div>
      {exp && (
        <div className="fi" style={{ padding: "12px 14px", borderTop: "1px solid var(--b1)", display: "flex", flexDirection: "column", gap: "12px" }}>
          <div>
            <Label style={{ marginBottom: "7px" }}>Ders Dagilimi</Label>
            {trial.nets.map((n) => {
              const hit = n.target > 0 && n.net >= n.target;
              const miss = n.target > 0 && n.net < n.target;
              return (
                <div key={n.subject} style={{ marginBottom: "5px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
                    <span style={{ fontSize: "10px", color: "var(--muted)" }}>{n.subject}</span>
                    <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
                      {n.target > 0 && <span style={{ fontSize: "9px", color: "var(--muted)" }}>/{n.target}</span>}
                      <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: hit ? "var(--grn)" : miss ? "var(--red)" : "var(--acc)" }}>{n.net.toFixed(1)}</span>
                    </div>
                  </div>
                  <div style={{ height: "4px", background: "var(--b2)", borderRadius: "999px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(n.net / maxN) * 100}%`, background: hit ? "var(--grn)" : miss ? "var(--red)" : "var(--acc)", borderRadius: "999px", transition: "width .5s ease" }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: "9px" }}>
            <div style={{ flex: 1, padding: "9px", background: "var(--s2)", borderRadius: "7px", border: "1px solid var(--grn)22" }}>
              <Label style={{ color: "var(--grn)", marginBottom: "5px" }}>En Guclu</Label>
              {top.map((n) => <p key={n.subject} style={{ fontSize: "10px", marginBottom: "2px" }}>{n.subject} <span style={{ fontFamily: "var(--mono)", color: "var(--grn)" }}>{n.net.toFixed(1)}</span></p>)}
            </div>
            <div style={{ flex: 1, padding: "9px", background: "var(--s2)", borderRadius: "7px", border: "1px solid var(--red)22" }}>
              <Label style={{ color: "var(--red)", marginBottom: "5px" }}>En Zayif</Label>
              {weak.map((n) => <p key={n.subject} style={{ fontSize: "10px", marginBottom: "2px" }}>{n.subject} <span style={{ fontFamily: "var(--mono)", color: "var(--red)" }}>{n.net.toFixed(1)}</span></p>)}
            </div>
          </div>
          {(trial.wrongTopics?.length || 0) > 0 && (
            <div>
              <Label style={{ marginBottom: "5px", color: "var(--red)" }}>Yanlis Konular</Label>
              <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                {trial.wrongTopics.map((wt) => (
                  <div key={wt.id || wt.topic} style={{ display: "flex", gap: "7px", padding: "5px 8px", background: "var(--s2)", borderRadius: "5px" }}>
                    <Tag color="var(--red)">{wt.subject}</Tag>
                    <span style={{ fontSize: "11px" }}>{wt.topic}</span>
                  </div>
                ))}
              </div>
              <Btn variant="accent" size="sm"
                onClick={() => { const items = buildTrialTodos(trial); if (!items.length) return; onPushTodos(items); toast(`${items.length} gorev akti`, "var(--grn)"); }}
                style={{ marginTop: "8px" }}>Gorevlere aktar</Btn>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn variant="danger" size="sm" onClick={() => onDelete(trial.id)}>Sil</Btn>
          </div>
        </div>
      )}
    </Card>
  );
}

// ============================================================================
// BRAIN DUMP TAB
// ============================================================================
function BrainDumpTab({ todos, onPushTodos }) {
  const today = todayStr();
  const [brain, setBrainRaw] = useState(() => store.load(KEYS.brain, {}));
  const [attn]               = useState(() => store.load(KEYS.attn, {}));

  const setBrain = useCallback((fn) => {
    setBrainRaw((p) => { const n = typeof fn === "function" ? fn(p) : fn; store.save(KEYS.brain, n); return n; });
  }, []);

  const brainText = brain?.[today]?.text || "";
  const setBrainText = (text) =>
    setBrain((p) => ({ ...(p || {}), [today]: { ...(p?.[today] || {}), text, updatedAt: new Date().toISOString() } }));

  const pushBrainDumpToTodos = () => {
    const lines = brainText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    onPushTodos(lines.map((text) => ({ text, source: `BrainDump (${fmtDate(today)})`, priority: "medium", meta: { kind: "brain", date: today } })));
    setBrainText("");
    toast(`${lines.length} madde gorevlere akti`, "var(--grn)");
  };

  const todayBreaks = attn[today]?.breaks || [];
  const attnScore   = calcAttentionScore(todayBreaks);
  const { label: aLabel, color: aColor } = attentionLabel(attnScore);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <Card style={{ padding: "13px 14px" }}>
        <Label style={{ marginBottom: "8px" }}>Brain Dump</Label>
        <textarea
          value={brainText}
          onChange={(e) => setBrainText(e.target.value)}
          rows={5}
          placeholder="Aklindaki her seyi dok... Her satir bir gorev olabilir."
          style={{ padding: "10px 12px", fontSize: "12px", width: "100%", resize: "vertical", lineHeight: "1.6", borderRadius: "8px" }}
        />
        <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
          <Btn variant="accent" onClick={pushBrainDumpToTodos} style={{ flex: 2 }} disabled={!brainText.trim()}>Goreve cevir</Btn>
          <Btn variant="ghost"  onClick={() => setBrainText("")} style={{ flex: 1 }} disabled={!brainText.trim()}>Temizle</Btn>
        </div>
      </Card>

      {todayBreaks.length > 0 && (
        <Card style={{ padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <Label>Dikkat Durumu (bugun)</Label>
            <Tag color={aColor}>{aLabel} · {attnScore}/100</Tag>
          </div>
          <PBar value={attnScore} max={100} color={aColor} h={5} />
          <div style={{ marginTop: "10px" }}>
            <Label style={{ marginBottom: "6px" }}>Mola Gecmisi</Label>
            {todayBreaks.slice(0, 5).map((b, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 8px", background: "var(--s2)", borderRadius: "5px", marginBottom: "3px" }}>
                <span style={{ fontSize: "10px", color: b.type === "early" ? "var(--red)" : "var(--muted)" }}>{b.reason || "--"}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)" }}>{b.blockMin || 0}dk</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card style={{ padding: "12px 14px" }}>
        <Label style={{ marginBottom: "8px" }}>Hizli Gorev Ekle</Label>
        <QuickTodoAdd todos={todos} onPushTodos={onPushTodos} />
      </Card>
    </div>
  );
}

function QuickTodoAdd({ todos, onPushTodos }) {
  const [text, setText] = useState("");
  const add = () => {
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    onPushTodos(lines.map((t) => ({ text: t, source: `Hizli (${fmtDate(todayStr())})`, priority: "medium", meta: { kind: "brain_quick", date: todayStr() } })));
    setText("");
    toast(`${lines.length} gorev eklendi`, "var(--grn)");
  };
  return (
    <div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Her satir bir gorev..." style={{ padding: "8px 10px", fontSize: "12px", width: "100%", resize: "vertical", lineHeight: "1.6" }} />
      <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
        <Btn variant="primary" onClick={add} disabled={!text.trim()} style={{ flex: 2 }}>Gorev ekle</Btn>
        <Btn variant="ghost"   onClick={() => setText("")} disabled={!text.trim()} style={{ flex: 1 }}>Temizle</Btn>
      </div>
      <p style={{ fontSize: "10px", color: "var(--muted)", marginTop: "8px" }}>
        Aktif gorev: <span style={{ fontFamily: "var(--mono)", color: "var(--acc)" }}>{todos.filter((t) => !t.done).length}</span>
      </p>
    </div>
  );
}

// ============================================================================
// TODOS TAB
// ============================================================================
const PRIOS = {
  high:   { l: "Acil",  c: "var(--red)"   },
  medium: { l: "Orta",  c: "var(--acc)"   },
  low:    { l: "Dusuk", c: "var(--muted)" },
};

function TodosTab({ todos, setTodos }) {
  const [text, setText] = useState("");
  const [prio, setPrio] = useState("high");
  const [filt, setFilt] = useState("active");

  const overdue = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0);

  const add = () => {
    if (!text.trim()) return;
    const u = [{
      id: uid(), text: text.trim(), source: "Manuel", priority: prio,
      done: false, reviewed: false,
      createdAt: new Date().toISOString(),
      reviewAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    }, ...todos];
    setTodos(u);
    store.save(KEYS.todos, u);
    setText("");
  };

  const toggle = (id) => {
    const before = todos.find((x) => x.id === id);
    const u = todos.map((t) => (t.id === id ? { ...t, done: !t.done, reviewed: true } : t));
    setTodos(u);
    store.save(KEYS.todos, u);
    if (before && !before.done) { grantXP("todo_done"); toast(`+${XP_R.todo_done} XP`, "var(--grn)"); }
  };

  const del = (id) => {
    const u = todos.filter((t) => t.id !== id);
    setTodos(u);
    store.save(KEYS.todos, u);
  };

  const snooze = (id) => {
    const u = todos.map((t) => t.id === id ? { ...t, reviewAt: new Date(Date.now() + 7 * 86400000).toISOString(), reviewed: true } : t);
    setTodos(u);
    store.save(KEYS.todos, u);
  };

  const list = useMemo(() => {
    if (filt === "active") return todos.filter((t) => !t.done);
    if (filt === "done")   return todos.filter((t) => t.done);
    if (filt === "review") return overdue;
    return todos;
  }, [todos, filt, overdue]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "11px" }}>
      {overdue.length > 0 && (
        <div className="flashY" style={{ padding: "10px 12px", background: "var(--acc)08", border: "1px solid var(--acc)44", borderRadius: "7px", display: "flex", alignItems: "center", gap: "9px" }}>
          <span>⚡</span>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: "11px", fontWeight: "600", color: "var(--acc)" }}>{overdue.length} gorev 7. gununu doldurdu</p>
            <p style={{ fontSize: "10px", color: "var(--muted)", marginTop: "1px" }}>Yaptin mi? Kontrol et.</p>
          </div>
          <Btn size="sm" variant="accent" onClick={() => setFilt("review")}>Goster</Btn>
        </div>
      )}

      <Card style={{ padding: "11px" }}>
        <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Yeni gorev..." style={{ flex: 1, padding: "7px 10px", fontSize: "12px" }} />
          <Btn variant="primary" onClick={add}>Ekle</Btn>
        </div>
        <div style={{ display: "flex", gap: "4px" }}>
          {Object.entries(PRIOS).map(([k, { l, c }]) => (
            <button key={k} onClick={() => setPrio(k)}
              style={{ padding: "3px 8px", borderRadius: "4px", border: "1px solid", fontSize: "10px", cursor: "pointer", borderColor: prio === k ? c : "var(--b2)", background: prio === k ? `${c}22` : "transparent", color: prio === k ? c : "var(--muted)" }}>
              {l}
            </button>
          ))}
        </div>
      </Card>

      <div style={{ display: "flex", gap: "4px" }}>
        {[["active", "Aktif"], ["review", "⚡"], ["done", "Tamam"], ["all", "Tumu"]].map(([k, l]) => (
          <button key={k} onClick={() => setFilt(k)}
            style={{ padding: "4px 9px", borderRadius: "5px", border: "1px solid", fontSize: "10px", cursor: "pointer", borderColor: filt === k ? "var(--acc)" : "var(--b2)", background: filt === k ? "var(--acc)18" : "transparent", color: filt === k ? "var(--acc)" : "var(--muted)" }}>
            {l}
            {k === "review" && overdue.length > 0 && (
              <span style={{ marginLeft: "3px", background: "var(--red)", borderRadius: "50%", width: "12px", height: "12px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "8px", color: "#fff" }}>
                {overdue.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {list.length === 0 ? <EmptyState icon="◻" title="Gorev yok" desc="Temiz liste, net zihin." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          {list.map((t) => (
            <div key={t.id} className="sr" style={{ display: "flex", alignItems: "flex-start", gap: "9px", padding: "9px 11px", borderRadius: "7px", background: "var(--s2)", border: `1px solid ${t.reviewAt && daysFrom(t.reviewAt) >= 0 && !t.done && !t.reviewed ? "var(--acc)44" : "var(--b2)"}` }}>
              <button onClick={() => toggle(t.id)}
                style={{ width: "15px", height: "15px", borderRadius: "3px", flexShrink: 0, marginTop: "2px", background: t.done ? "var(--grn)" : "transparent", border: `2px solid ${t.done ? "var(--grn)" : "var(--b2)"}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {t.done && <span style={{ color: "#000", fontSize: "9px", fontWeight: "700" }}>✓</span>}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: "12px", lineHeight: "1.4", textDecoration: t.done ? "line-through" : "none", color: t.done ? "var(--muted)" : "var(--txt)" }}>{t.text}</p>
                <div style={{ display: "flex", gap: "5px", marginTop: "3px", flexWrap: "wrap" }}>
                  <Tag color={PRIOS[t.priority]?.c}>{PRIOS[t.priority]?.l}</Tag>
                  {t.source && <span style={{ fontSize: "9px", color: "var(--muted)" }}>← {t.source}</span>}
                  {t.reviewAt && daysFrom(t.reviewAt) >= 0 && !t.done && !t.reviewed && (
                    <span style={{ fontSize: "9px", color: "var(--acc)", animation: "pulse 2s ease infinite" }}>⚡ 7. Gun</span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: "3px" }}>
                {t.reviewAt && daysFrom(t.reviewAt) >= 0 && !t.done && !t.reviewed && (
                  <Btn size="sm" variant="ghost" onClick={() => snooze(t.id)} style={{ color: "var(--acc)" }} title="Ertele">↻</Btn>
                )}
                <Btn size="sm" variant="ghost" onClick={() => del(t.id)} style={{ color: "var(--red)" }}>×</Btn>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// DISCIPLINE TAB
// ============================================================================
const QS = [
  { id: "q1", text: "Bugun deneme analizi yaptin mi?",       yes: "Analiz yaptin.",       no: "Bu aksam analiz yap." },
  { id: "q2", text: "Bugun yanlislarini cozdun mu?",         yes: "Iyi.",                 no: "Yanlis cozmeden ilerleme." },
  { id: "q3", text: "Bugun hedefledigin kadar calistin mi?", yes: "Plana sadik kaldin.",  no: "Yarin net hedef koy." },
  { id: "q4", text: "Bugun zayif konuya zaman ayirdin mi?",  yes: "Cesaret.",             no: "Zayiflikla yuzles." },
];

const overallMsg = (s) => {
  if (s === 4) return { msg: "4/4. Mukemmel.", c: "var(--grn)" };
  if (s === 3) return { msg: "3/4. Iyi.", c: "var(--acc)" };
  if (s === 2) return { msg: "2/4. Orta.", c: "var(--acc)" };
  if (s === 1) return { msg: "1/4. Dusuk.", c: "var(--red)" };
  return { msg: "0/4. Kotu gun.", c: "var(--red)" };
};

function calcBenchmark({ xp, plans, checkins }) {
  const last7 = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const planItems = last7.flatMap((d) => plans?.[d] || []);
  const planDone  = planItems.filter((p) => p.done).length;
  const planRatio = planItems.length > 0 ? planDone / planItems.length : 0;
  const planMin   = last7.reduce((s, d) =>
    s + (plans?.[d] || []).filter((x) => x.done).reduce((a, x) => a + (x.actualMin || x.durationMin), 0), 0);
  const ci    = (checkins || []).filter((c) => last7.includes(c.date));
  const ciAvg = ci.length ? ci.reduce((s, c) => s + (c.score || 0), 0) / ci.length : 0;
  const xpScore = clamp((xp.points || 0) / 5000, 0, 1);
  const score = Math.round((xpScore * 35 + planRatio * 45 + (ciAvg / 4) * 20) * 100);
  const level = score >= 85 ? { name: "S", color: "var(--grn)" }
    : score >= 70 ? { name: "A", color: "var(--acc)" }
    : score >= 55 ? { name: "B", color: "var(--blu)" }
    : score >= 40 ? { name: "C", color: "var(--ora)" }
    : { name: "D", color: "var(--red)" };
  return { score, level, planMin, planRatio, ciAvg };
}

function generateDailyChallenge({ date, trials, todos, plans }) {
  const seed = parseInt(date.split("-").join("").slice(-3), 10) || 0;
  const weekPlan = buildWeeklyPlan(trials, 4);
  const topWeak  = weekPlan[0]?.subject;
  const overdueTodos = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0).length;
  const todayPlan    = plans[date] || [];
  const planLate     = todayPlan.filter((p) => !p.done && p.startMin + p.durationMin < nowHHMM()).length;
  const pool = [
    { id: `c_${date}_review`, title: "15dk Gorev Review", desc: "7 gun uyarili gorevleri bitir veya ertele." },
    { id: `c_${date}_plan`,   title: "1 plan ogesi tamamla", desc: "En kucuk plan ogesini sec ve bitir." },
    { id: `c_${date}_block`,  title: "1 calisma bloku basla", desc: "Plan tabinden bir blok baslat." },
    { id: `c_${date}_weak`,   title: `${topWeak || "Zayif ders"} mini tekrar`, desc: `${topWeak || "Zayif ders"} icin 20dk mini tekrar.` },
  ];
  let pick = pool[seed % pool.length];
  if (overdueTodos > 0) pick = pool[0];
  else if (planLate > 0) pick = pool[1];
  return pick;
}

function DisciplineTab({ trials, todos }) {
  const today = todayStr();
  const [checkins, setCheckins] = useState(() => store.load(KEYS.checkins, []));
  const [ans, setAns]           = useState(() => checkins.find((c) => c.date === today)?.answers || {});
  const [submitted, setSubmitted] = useState(() => !!checkins.find((c) => c.date === today));
  const [xpData, setXpData]     = useState(loadXP);
  const startRef = useRef(Date.now());

  const attn     = store.load(KEYS.attn, {});
  const plans    = store.load(KEYS.plan, {});
  const todayAttn = attn[today];
  const attnScore = useMemo(() => calcAttentionScore(todayAttn?.breaks || []), [todayAttn]);
  const todayPlan = plans[today] || [];
  const planPct   = todayPlan.length > 0
    ? Math.round((todayPlan.filter((p) => p.done).length / todayPlan.length) * 100)
    : 0;

  const todoOverdue   = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0).length;
  const planLate      = todayPlan.filter((p) => !p.done && p.startMin + p.durationMin < nowHHMM()).length;
  const missingCheckin = checkins.find((c) => c.date === today) ? 0 : 1;

  const submit = () => {
    const elapsed = Math.round((Date.now() - startRef.current) / 1000);
    const score   = QS.filter((q) => ans[q.id] === true).length;
    const entry   = { date: today, answers: ans, score, elapsed, at: new Date().toISOString() };
    const updated = [entry, ...checkins.filter((c) => c.date !== today)];
    setCheckins(updated);
    store.save(KEYS.checkins, updated);
    setSubmitted(true);
    const t = score === 4 ? "checkin_4" : score >= 3 ? "checkin_3" : null;
    if (t) { const { pts } = grantXP(t); toast(`+${pts} XP -- ${score}/4`, "var(--acc)"); setXpData(loadXP()); }
  };

  const score = QS.filter((q) => ans[q.id] === true).length;
  const all   = QS.every((q) => ans[q.id] !== undefined);
  const om    = overallMsg(score);
  const lv    = calcLevel(xpData.points);

  const [challenge, setChallengeRaw] = useState(() => store.load(KEYS.challenge, {}));
  const setChallenge = useCallback((fn) => {
    setChallengeRaw((p) => { const n = typeof fn === "function" ? fn(p) : fn; store.save(KEYS.challenge, n); return n; });
  }, []);

  const todaysChallenge = useMemo(() => {
    const existing = challenge?.[today];
    if (existing?.id) return existing;
    const gen  = generateDailyChallenge({ date: today, trials, todos, plans });
    const next = { ...gen, date: today, done: false, doneAt: null };
    setChallenge((p) => ({ ...(p || {}), [today]: next }));
    return next;
  }, [challenge, today, trials, todos, plans, setChallenge]);

  const completeChallenge = () => {
    if (todaysChallenge.done) return;
    setChallenge((p) => ({ ...(p || {}), [today]: { ...(p?.[today] || todaysChallenge), done: true, doneAt: new Date().toISOString() } }));
    const { pts } = grantXP("challenge_done");
    playSound("done");
    toast(`Challenge tamam! +${pts} XP`, "var(--acc)");
    setXpData(loadXP());
  };

  const bench = useMemo(() => calcBenchmark({ xp: xpData, plans, checkins }), [xpData, plans, checkins]);

  const coach = (() => {
    if (todoOverdue) return `Once gorev review: ${todoOverdue} gorev -- erteleme birikmekte.`;
    if (planLate)    return `${planLate} plan ogesi gecikmis. Simdi Plan tabini ac ve basla.`;
    if (attnScore < 60) return "Dikkat dusuk. Telefonu odadan cikar, 10 nefes al, tekrar bas.";
    if (planPct < 50)   return "Plan uyumu dusuk. Yarin bloklari kisalt, sayiyi artir.";
    if (xpData.streak >= 7) return `${xpData.streak} gunluk seri! Zinciri kirma, yarin da burda ol.`;
    return "Tek bir seyi iyilestir. Bugunku en kucuk adim atildi mi?";
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>

      {/* XP + Level card */}
      <Card style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
          <div>
            <Label style={{ marginBottom: "2px" }}>Disiplin Puani</Label>
            <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: "22px", fontWeight: "700", color: "var(--acc)" }}>{xpData.points} XP</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: lv.color, fontWeight: "700" }}>{lv.name}</span>
            </div>
            {lv.next && (
              <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "5px" }}>
                <div style={{ flex: 1, height: "4px", background: "var(--b2)", borderRadius: "99px", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${lv.pct}%`, background: lv.color, borderRadius: "99px", transition: "width 1s ease" }} />
                </div>
                <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)" }}>{lv.pct}% - {lv.next.name}</span>
              </div>
            )}
          </div>
          <div style={{ textAlign: "right" }}>
            {xpData.streak > 0 && (
              <p className={xpData.streak >= 7 ? "streakFire" : ""}
                style={{ fontFamily: "var(--mono)", fontSize: "13px", color: xpData.streak >= 7 ? "var(--ora)" : "var(--acc)" }}>
                🔥 {xpData.streak}g
              </p>
            )}
            <p style={{ fontSize: "9px", color: "var(--muted)", marginTop: "1px" }}>{xpData.totalBlocks} blok · {xpData.totalTrials} deneme</p>
          </div>
        </div>
        {xpData.badges.length > 0 && (
          <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
            {BADGES.filter((b) => xpData.badges.includes(b.id)).map((b) => (
              <div key={b.id} className="pi" style={{ padding: "3px 8px", background: "var(--acc)15", borderRadius: "4px", border: "1px solid var(--acc)33", display: "flex", gap: "3px", alignItems: "center" }}>
                <span style={{ fontSize: "11px" }}>{b.icon}</span>
                <span style={{ fontSize: "9px", color: "var(--acc)", fontFamily: "var(--mono)", fontWeight: "600" }}>{b.label}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Alerts */}
      {(todoOverdue + planLate + missingCheckin) > 0 && (
        <Card style={{ padding: "12px 14px", border: "1px solid var(--red)22" }}>
          <Label style={{ marginBottom: "8px" }}>Cross-Module Uyarilar</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {todoOverdue > 0 && <div style={{ display: "flex", justifyContent: "space-between", background: "var(--s2)", borderRadius: "6px", padding: "8px 10px" }}><span style={{ fontSize: "12px" }}>⚡ Gorev review</span><Tag color="var(--acc)">{todoOverdue}</Tag></div>}
            {planLate > 0   && <div style={{ display: "flex", justifyContent: "space-between", background: "var(--s2)", borderRadius: "6px", padding: "8px 10px" }}><span style={{ fontSize: "12px" }}>⚡ Plan gecikmesi</span><Tag color="var(--red)">{planLate}</Tag></div>}
            {missingCheckin > 0 && <div style={{ display: "flex", justifyContent: "space-between", background: "var(--s2)", borderRadius: "6px", padding: "8px 10px" }}><span style={{ fontSize: "12px" }}>⚡ Check-in eksik</span><Tag color="var(--red)">bugun</Tag></div>}
          </div>
        </Card>
      )}

      {/* Weekly review */}
      <WeeklyReviewCard plans={plans} trials={trials} todos={todos} checkins={checkins} />

      {/* Daily challenge */}
      <Card style={{ padding: "12px 14px" }}>
        <Label style={{ marginBottom: "8px" }}>Gunluk Mini Challenge</Label>
        <div style={{ padding: "10px 12px", background: "var(--s2)", borderRadius: "8px", border: `1px solid ${todaysChallenge.done ? "var(--grn)55" : "var(--b2)"}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
            <p style={{ fontSize: "13px", fontWeight: "600", color: todaysChallenge.done ? "var(--grn)" : "var(--acc)" }}>{todaysChallenge.title}</p>
            {todaysChallenge.done ? <Tag color="var(--grn)">tamam</Tag> : <Tag color="var(--acc)">bugun</Tag>}
          </div>
          <p style={{ fontSize: "11px", color: "var(--muted)", lineHeight: "1.5" }}>{todaysChallenge.desc}</p>
          <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
            <Btn variant="primary" onClick={completeChallenge} disabled={todaysChallenge.done} style={{ flex: 2 }}>
              {todaysChallenge.done ? "Tamamlandi" : "Tamamladim"}
            </Btn>
            <Btn variant="ghost" onClick={() => (playSound("start"), toast("Challenge modu: 15 dk odak!", "var(--acc)"))} style={{ flex: 1 }}>Basla</Btn>
          </div>
        </div>
      </Card>

      {/* Benchmark */}
      <Card style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <Label>Offline Benchmark</Label>
          <Tag color={bench.level.color}>Seviye {bench.level.name}</Tag>
        </div>
        <PBar value={bench.score} max={100} color={bench.level.color} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "7px", marginTop: "10px" }}>
          {[
            { l: "Plan 7g",  v: `%${Math.round(bench.planRatio * 100)}`, c: bench.planRatio >= 0.7 ? "var(--grn)" : "var(--acc)" },
            { l: "Calisma",  v: fmtHHMM(bench.planMin), c: "var(--blu)" },
            { l: "CI",       v: bench.ciAvg ? `${bench.ciAvg.toFixed(1)}/4` : "--", c: bench.ciAvg >= 3 ? "var(--grn)" : "var(--acc)" },
          ].map((x) => (
            <Card key={x.l} style={{ padding: "10px", textAlign: "center" }}>
              <p style={{ fontFamily: "var(--mono)", fontSize: "16px", fontWeight: "700", color: x.c, lineHeight: 1 }}>{x.v}</p>
              <p style={{ fontSize: "9px", color: "var(--muted)", marginTop: "3px" }}>{x.l}</p>
            </Card>
          ))}
        </div>
        <p style={{ fontSize: "11px", color: "var(--muted)", marginTop: "10px" }}>
          Coach: <span style={{ color: "var(--acc)", fontFamily: "var(--mono)" }}>{coach}</span>
        </p>
      </Card>

      {/* Check-in */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <p style={{ fontWeight: "600", fontSize: "13px" }}>Check-in <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)", marginLeft: "5px" }}>{today}</span></p>
          {submitted && <Tag color={om.c}>{score}/4</Tag>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {QS.map((q) => {
            const a = ans[q.id];
            return (
              <div key={q.id} style={{ padding: "10px 12px", borderRadius: "7px", background: "var(--s2)", border: "1px solid var(--b2)" }}>
                <p style={{ fontSize: "12px", fontWeight: "500", marginBottom: "8px", lineHeight: "1.4" }}>{q.text}</p>
                <div style={{ display: "flex", gap: "6px" }}>
                  {[true, false].map((v) => {
                    const sel = a === v;
                    const c   = v ? "var(--grn)" : "var(--red)";
                    return (
                      <button key={String(v)}
                        onClick={() => !submitted && setAns((p) => ({ ...p, [q.id]: v }))}
                        disabled={submitted}
                        style={{ flex: 1, padding: "6px", borderRadius: "5px", border: `1px solid ${sel ? c : "var(--b2)"}`, background: sel ? `${c}22` : "transparent", color: sel ? c : "var(--muted)", fontSize: "12px", fontWeight: "600", cursor: submitted ? "default" : "pointer" }}>
                        {v ? "Evet" : "Hayir"}
                      </button>
                    );
                  })}
                </div>
                {a !== undefined && (
                  <p className="fi" style={{ fontSize: "10px", color: a ? "var(--grn)" : "var(--red)", marginTop: "6px", lineHeight: "1.5", fontStyle: "italic" }}>
                    - {a ? q.yes : q.no}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        {!submitted ? (
          <Btn variant="primary" onClick={submit} disabled={!all} style={{ width: "100%", marginTop: "12px", padding: "10px" }}>
            {all ? "Gunu Degerlendir" : `${QS.filter((q) => ans[q.id] !== undefined).length}/${QS.length} cevaplandi`}
          </Btn>
        ) : (
          <div className="pi" style={{ marginTop: "12px", padding: "12px 13px", background: `${om.c}08`, border: `1px solid ${om.c}33`, borderRadius: "7px" }}>
            <p style={{ fontFamily: "var(--mono)", fontSize: "12px", fontWeight: "700", color: om.c, marginBottom: "6px" }}>{om.msg}</p>
          </div>
        )}
      </Card>
    </div>
  );
}

// ============================================================================
// APP
// ============================================================================

// Small auth banner shown inside the existing header area
function AuthBanner({ user, onSignIn, onSignOut, syncing }) {
  if (user) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px", background: "var(--s2)", borderRadius: "8px", border: "1px solid var(--b1)", marginBottom: "12px" }}>
        {user.photoURL && <img src={user.photoURL} alt="" style={{ width: "20px", height: "20px", borderRadius: "50%", flexShrink: 0 }} />}
        <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--grn)", flex: 1 }}>
          {syncing ? "syncing..." : user.displayName || user.email}
        </span>
        <button onClick={onSignOut} style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)", background: "none", border: "1px solid var(--b2)", borderRadius: "4px", padding: "3px 8px", cursor: "pointer" }}>
          Cikis
        </button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px", background: "var(--s2)", borderRadius: "8px", border: "1px solid var(--b1)", marginBottom: "12px" }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)", flex: 1 }}>
        Yerel mod -- giris yap ve verileri buluta kaydet
      </span>
      <button onClick={onSignIn} style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--acc)", background: "var(--acc)15", border: "1px solid var(--acc)44", borderRadius: "4px", padding: "3px 10px", cursor: "pointer", fontWeight: "600" }}>
        Google ile Giris
      </button>
    </div>
  );
}

export default function App() {
  const [tab, setTab]       = useState("plan");
  const [trials, setTrials] = useState(() => store.load(KEYS.trials, []));
  const [todos, setTodos]   = useState(() => store.load(KEYS.todos, []));
  const [heatOpen, setHeat] = useState(false);
  const [xp, setXp]         = useState(loadXP);
  const toasts              = useToastSystem();

  // Auth state: undefined=loading, null=signed-out, object=signed-in
  const [user, setUser]     = useState(undefined);
  const [syncing, setSyncing] = useState(false);

  // Listen to Firebase auth state
  useEffect(() => {
    const unsub = onUser(async (fbUser) => {
      setUser(fbUser);

      if (fbUser) {
        // Set uid so store.save() starts syncing
        _syncUid = fbUser.uid;

        // Pull cloud data and merge into localStorage (cloud wins on conflict)
        setSyncing(true);
        try {
          const cloud = await fsLoadAll(fbUser.uid);
          let needsRefresh = false;
          Object.entries(cloud).forEach(([k, v]) => {
            // Only overwrite if cloud version is newer/different
            const local = store.load(k, null);
            const localStr = JSON.stringify(local);
            const cloudStr = JSON.stringify(v);
            if (cloudStr !== localStr) {
              try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
              needsRefresh = true;
            }
          });
          // Refresh React state if cloud had newer data
          if (needsRefresh) {
            setTrials(store.load(KEYS.trials, []));
            setTodos(store.load(KEYS.todos, []));
            setXp(loadXP());
          }
        } catch { /* offline or Firestore error -- keep localStorage */ }
        setSyncing(false);
      } else {
        _syncUid = null;
      }
    });
    return unsub;
  }, []);

  // XP polling
  useEffect(() => {
    const id = setInterval(() => setXp(loadXP()), 4000);
    return () => clearInterval(id);
  }, []);

  const pushTodos = useCallback((items) => {
    const now = new Date().toISOString();
    const mapped = (items || [])
      .map((i) => ({
        id: uid(), text: i.text, source: i.source || "Import",
        priority: i.priority || "medium", done: false, reviewed: false,
        createdAt: now, reviewAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        meta: i.meta || {},
      }))
      .filter((x) => x.text && x.text.trim());
    if (!mapped.length) return;
    setTodos((prev) => { const next = [...mapped, ...prev]; store.save(KEYS.todos, next); return next; });
  }, []);

  const checkins = useMemo(() => store.load(KEYS.checkins, []), [tab]);
  const plans    = useMemo(() => store.load(KEYS.plan, {}),    [tab]);

  const alerts = useMemo(() => {
    const today      = todayStr();
    const todayPlan  = plans[today] || [];
    const planLate   = todayPlan.filter((p) => !p.done && p.startMin + p.durationMin < nowHHMM()).length;
    const todoOverdue = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0).length;
    const missingCheckin = checkins.find((c) => c.date === today) ? 0 : 1;
    return { plan: planLate, brain: 0, trials: 0, todos: todoOverdue, discipline: missingCheckin };
  }, [todos, checkins, plans, tab]);

  // While auth state is resolving, show nothing (avoids flash)
  if (user === undefined) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <style>{CSS}</style>
        <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--muted)", animation: "blink 1.5s ease infinite" }}>...</span>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: "var(--sans)", display: "flex", justifyContent: "center", padding: "24px 12px 80px" }}>
      <style>{CSS}</style>
      <div style={{ width: "100%", maxWidth: "540px" }}>
        <Header onToggleHeat={() => setHeat((p) => !p)} heatOpen={heatOpen} alerts={alerts} xp={xp} />
        <AuthBanner
          user={user}
          syncing={syncing}
          onSignIn={() => signInGoogle().catch(() => {})}
          onSignOut={() => { signOutUser(); _syncUid = null; }}
        />
        {heatOpen && (
          <div className="fi" style={{ marginBottom: "14px" }}>
            <Card style={{ padding: "13px 14px" }}>
              <Heatmap plans={plans} trials={trials} checkins={checkins} />
            </Card>
          </div>
        )}
        <TabBar active={tab} onChange={setTab} alerts={alerts} />
        <div className="fu" key={tab}>
          {tab === "plan"       && <PlanTab trials={trials} setTrials={setTrials} todos={todos} onPushTodos={pushTodos} />}
          {tab === "brain"      && <BrainDumpTab todos={todos} onPushTodos={pushTodos} />}
          {tab === "trials"     && <TrialsTab trials={trials} setTrials={setTrials} onPushTodos={pushTodos} />}
          {tab === "todos"      && <TodosTab todos={todos} setTodos={setTodos} />}
          {tab === "discipline" && <DisciplineTab trials={trials} todos={todos} />}
        </div>
      </div>
      <ToastLayer toasts={toasts} />
    </div>
  );
}
