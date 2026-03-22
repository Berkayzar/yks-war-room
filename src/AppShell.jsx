import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  onUser, signInGoogle, signOutUser, fsLoadAll, fsSave, checkRedirect,
  checkIsAdmin, writeProfile, scheduleSummary, logActivity,
  adminGetUsers, adminGetUserData, getUserProfile,
  checkSyncStatus, forceSummarySync,
} from "./firebase.js";
import CounselorDashboard  from "./CounselorDashboard.jsx";
import AdminAssignPanel    from "./pages/AdminAssignPanel.jsx";

// ============================================================================
// Storage -- localStorage primary, Firestore sync when signed in
// ============================================================================
const KEYS = {
  trials:       "yks_trials",
  todos:        "yks_todos",
  brain:        "yks_brain",
  checkins:     "yks_checkins",
  dw:           "yks_dw",
  xp:           "yks_xp",
  plan:         "yks_plan",
  attn:         "yks_attn",
  challenge:    "yks_challenge",
  weeklyGoals:  "yks_weekly_goals",  // Plan V2
};

// Current signed-in uid -- set by App() once auth resolves
let _syncUid = null;
let _syncUser = null; // full user object for summary writes

const store = {
  load: (k, fb) => {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; }
  },
  save: (k, v) => {
    // 1. Always write localStorage first (instant, offline-safe)
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
    // 2. If signed in, sync to Firestore
    if (_syncUid) {
      fsSave(_syncUid, k, v);
      logActivity(_syncUid, k);
      // Build summary from current localStorage state
      _writeSummary(_syncUid, _syncUser);
    }
  },
};

function _writeSummary(uid, user) {
  if (!uid || !user) return;
  try {
    const xpData   = JSON.parse(localStorage.getItem("yks_xp")       || "{}");
    const todos    = JSON.parse(localStorage.getItem("yks_todos")     || "[]");
    const trials   = JSON.parse(localStorage.getItem("yks_trials")    || "[]");
    const checkins = JSON.parse(localStorage.getItem("yks_checkins")  || "[]");
    const plans    = JSON.parse(localStorage.getItem("yks_plan")      || "{}");

    const now  = Date.now();
    const last7 = Array.from({ length: 7 }, (_, i) =>
      new Date(now - i * 86400000).toISOString().slice(0, 10)
    );

    // Plan adherence -- valid sessions only, paused gets partial credit
    let totalTarget = 0, totalCompleted = 0;
    last7.forEach((d) => {
      (plans[d] || []).forEach((x) => {
        totalTarget    += x.durationMin || 0;
        totalCompleted += validWorkedMin(x);  // 0 for invalid sessions
      });
    });
    const adherenceRate = totalTarget > 0
      ? Math.round((totalCompleted / totalTarget) * 100)
      : 0;

    // Plan counts using itemStatus (not item.done)
    const planItems     = Object.values(plans).flat();
    const planCount     = planItems.length;
    const planDoneCount = planItems.filter((x) => itemStatus(x) === "done").length;

    // Todo type counts
    const academicTodos = todos.filter((t) => t.todoType === "academic").length;
    const trialTodos    = todos.filter((t) => t.todoType === "trial").length;
    const doneTodos     = todos.filter((t) => t.done).length;

    // Fix 13: weeklyGoals from localStorage -- sync to Firestore
    const weeklyGoals = JSON.parse(localStorage.getItem(KEYS.weeklyGoals) || "[]");
    const sortedTrials = [...trials].sort((a, b) => new Date(b.date) - new Date(a.date));
    const lastTrial    = sortedTrials[0] || null;
    const lastTrialDate = lastTrial?.date || null;
    const lastTrialNet  = lastTrial?.totalNet || 0;

    // Last checkin date
    const sortedCheckins = [...checkins].sort((a, b) => new Date(b.date) - new Date(a.date));
    const lastCheckinDate = sortedCheckins[0]?.date || null;

    // ----------------------------------------------------------------
    // Risk Engine -- Phase 3
    // ----------------------------------------------------------------
    const RISK_WEIGHTS = {
      no_checkin_3d: 30,
      plan_rate_low: 25,
      no_trial_7d:   20,
      streak_broken: 15,
      no_login_2d:   10,
    };

    const riskFlags = [];

    // no_login_2d: lastSeen is not available in localStorage,
    // so we use the current save as "just logged in" -- flag will be
    // set by counselor dashboard from Firestore lastSeen field.
    // We still calculate the rest here.

    // no_checkin_3d
    if (!lastCheckinDate || daysFromDate(lastCheckinDate) >= 3) {
      riskFlags.push("no_checkin_3d");
    }

    // plan_rate_low
    if (totalTarget > 0 && adherenceRate < 40) {
      riskFlags.push("plan_rate_low");
    }

    // no_trial_7d
    if (!lastTrialDate || daysFromDate(lastTrialDate) >= 7) {
      riskFlags.push("no_trial_7d");
    }

    // streak_broken
    if (!xpData.streak || xpData.streak === 0) {
      riskFlags.push("streak_broken");
    }

    const riskScore = riskFlags.reduce((s, f) => s + (RISK_WEIGHTS[f] || 0), 0);

    scheduleSummary(uid, {
      email:            user.email        || "",
      displayName:      user.displayName  || "",
      photoURL:         user.photoURL     || "",
      xp:               xpData.points     || 0,
      streak:           xpData.streak     || 0,
      weeklyActiveDays: xpData.weeklyActiveDays || 0,
      validBlocks:      xpData.validBlocks      || 0,
      todoCount:        todos.length,
      academicTodos,
      trialTodos,
      doneTodos,
      trialCount:       trials.length,
      lastTrialDate,
      lastTrialNet,
      checkinCount:     checkins.length,
      lastCheckinDate,
      planCount,
      planDoneCount,
      adherenceRate,
      riskFlags,
      riskScore,
      weeklyGoals,   // Fix 13: persist to Firestore
    });
  } catch { /* ignore */ }
}

// Helper: days from an ISO date string (not timestamp)
function daysFromDate(isoDate) {
  if (!isoDate) return 999;
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

// ============================================================================
// Plan V2 helpers
// ============================================================================

// Canonical status from item -- status is primary, done is legacy fallback
function itemStatus(item) {
  if (item.status) return item.status;
  // backward compat
  if (item.done)     return "done";
  if (item.pausedAt) return "paused";
  return "planned";
}

// Date relationship helpers
const isPast   = (dateStr) => dateStr < todayStr();
const isFuture = (dateStr) => dateStr > todayStr();
const isToday  = (dateStr) => dateStr === todayStr();

// Get week start (Monday) for a given date string
function weekMonday(dateStr) {
  const d   = new Date(dateStr);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

// Get 7 days of a week starting from Monday
function weekDays(mondayStr) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mondayStr);
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

// Create a plan item with V2 fields
function makePlanItem({ subject, startMin, durationMin, kind, trialType, note, date, createdBy = "student" }) {
  return {
    id:          uid(),
    date,
    subject,
    topic:       "",
    startMin,
    durationMin,
    kind:        kind || "study",
    trialType:   kind === "trial" ? trialType : null,
    note:        note || "",
    status:      "planned",    // V2 primary state
    createdBy,
    // runtime fields (null until used)
    actualMin:    null,
    pausedAt:     null,
    startedAt:    null,
    doneAt:       null,
    lateStartMin: null,
    sessionTopic: null,
    validSession: null,
    // legacy compat
    done:         false,
    doneAt_legacy: null,
    delayReason:  "",
  };
}

// validWorkedMin: minutes that count as real work for a plan item.
// RULE: done+validSession=true → actualMin (not durationMin fallback)
//       paused → pausedAt (partial work, counts but less)
//       anything else → 0
function validWorkedMin(item) {
  const st = itemStatus(item);
  if (st === "done") {
    if (item.validSession === false) return 0;   // invalid session -- no credit
    return item.actualMin != null ? item.actualMin : item.durationMin || 0;
  }
  if (st === "paused") return item.pausedAt || 0; // partial credit
  return 0;
}

// Same as validWorkedMin but for display purposes includes invalid sessions
// (so students can see what they did even if it didn't count)
function actualWorkedMin(item) {
  const st = itemStatus(item);
  if (st === "done")   return item.actualMin != null ? item.actualMin : item.durationMin || 0;
  if (st === "paused") return item.pausedAt || 0;
  return 0;
}
// Update item status -- keeps done in sync for backward compat
function applyStatus(item, status, extra = {}) {
  const legacyDone = status === "done";
  return {
    ...item,
    status,
    done:   legacyDone,
    doneAt: legacyDone ? new Date().toISOString() : item.doneAt,
    ...extra,
  };
}

// Weekly goals helpers
// Goal shape: { id, weekStart, subject, targetMin, createdBy, counselorUid }
function loadWeeklyGoals() {
  return store.load(KEYS.weeklyGoals, []);
}

function saveWeeklyGoals(goals) {
  store.save(KEYS.weeklyGoals, goals);
}

function getGoalsForWeek(weekStart) {
  return loadWeeklyGoals().filter((g) => g.weekStart === weekStart);
}

// Compute actual minutes worked per subject this week from plans
function subjectMinutesThisWeek(plans, weekStart) {
  const days = weekDays(weekStart);
  const map  = {};
  days.forEach((d) => {
    (plans[d] || []).forEach((item) => {
      const worked = validWorkedMin(item);
      if (worked > 0) map[item.subject] = (map[item.subject] || 0) + worked;
    });
  });
  return map;
}

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

// XP sadece anlam ifade eden ciktilar icin verilir
// - blok: minimum 10 dakika, maksimum 90 dakika gecerli
// - deneme: gercek deneme kaydedilince
// - todo: sadece academic veya trial tipindeki gorevler
// - checkin: gunden gune devamlilik
const XP_R = {
  block_valid:    50,  // gecerli calisma bloku (10-90dk)
  trial_added:    30,  // deneme kaydedildi
  todo_academic:  20,  // akademik gorev tamamlandi
  todo_trial:     20,  // deneme gorev tamamlandi
  checkin_4:     100,  // 4/4 checkin
  checkin_3:      60,  // 3/4 checkin
  plan_done:      80,  // gunluk plan %100 tamamlandi
  challenge_done: 120, // gunluk challenge tamamlandi
  streak_7:       200, // 7 gunluk seri
  streak_14:      500, // 14 gunluk seri
};

// Session validity kontrolu
const SESSION_MIN_MINUTES = 10;
const SESSION_MAX_MINUTES = 90;

function isValidSession(actualMin) {
  return actualMin >= SESSION_MIN_MINUTES && actualMin <= SESSION_MAX_MINUTES;
}

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
  weeklyActiveDays: 0,   // active days in current week (Mon-Sun)
  weekStart: "",         // ISO date of current week's Monday
  validBlocks: 0,        // blocks passing 10-90min validity check
});

function getWeekMonday(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function grantXP(type, opts = {}) {
  const xp  = loadXP();
  const pts = XP_R[type] || 0;
  const now = todayStr();

  if (type === "block_valid") {
    xp.totalBlocks++;
    xp.validBlocks = (xp.validBlocks || 0) + 1;
    // Streak (legacy)
    if (xp.lastDate !== now) {
      const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      xp.streak   = xp.lastDate === y ? xp.streak + 1 : 1;
      xp.lastDate = now;
    }
    // weeklyActiveDays
    const monday = getWeekMonday(now);
    if (xp.weekStart !== monday) {
      xp.weekStart        = monday;
      xp.weeklyActiveDays = 0;
      xp.weekActiveDates  = [];
    }
    if (!(xp.weekActiveDates || []).includes(now)) {
      xp.weekActiveDates  = [...(xp.weekActiveDates || []), now];
      xp.weeklyActiveDays = xp.weekActiveDates.length;
    }
  }

  if (type === "trial_added")    xp.totalTrials++;
  if (type === "checkin_4")      xp.perfect4++;
  if (type === "plan_done")      xp.plansDone      = (xp.plansDone      || 0) + 1;
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

// Plan adherence -- valid sessions only
// paused work gets partial credit via validWorkedMin
function getPlanAdherence(plans, dateStr) {
  const dayPlan = plans[dateStr] || [];
  if (!dayPlan.length) return { rate: 0, completedMin: 0, targetMin: 0, hasData: false };
  const targetMin    = dayPlan.reduce((s, x) => s + (x.durationMin || 0), 0);
  const completedMin = dayPlan.reduce((s, x) => s + validWorkedMin(x), 0);
  const rate = targetMin > 0 ? Math.round((completedMin / targetMin) * 100) : 0;
  return { rate, completedMin, targetMin, hasData: true };
}

// Per-subject adherence using itemStatus + validWorkedMin
function getSubjectAdherence(plans, dateStr) {
  const dayPlan = plans[dateStr] || [];
  const map = {};
  dayPlan.forEach((x) => {
    if (!map[x.subject]) map[x.subject] = { targetMin: 0, completedMin: 0 };
    map[x.subject].targetMin    += x.durationMin || 0;
    map[x.subject].completedMin += validWorkedMin(x);
  });
  return Object.entries(map).map(([subject, d]) => ({
    subject,
    targetMin:    d.targetMin,
    completedMin: d.completedMin,
    rate: d.targetMin > 0 ? Math.round((d.completedMin / d.targetMin) * 100) : 0,
  }));
}

// 7-gunluk ortalama adherence
function getWeeklyAdherence(plans) {
  const last7 = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
  );
  const days = last7.map((d) => getPlanAdherence(plans, d)).filter((d) => d.hasData);
  if (!days.length) return 0;
  return Math.round(days.reduce((s, d) => s + d.rate, 0) / days.length);
}

// Day score composite -- plan adherence artik dakika bazli
function getDayScore(plans, checkins, attn) {
  const today    = todayStr();
  const adherence = getPlanAdherence(plans, today);
  const planPct  = adherence.rate;
  const ci       = checkins.find((c) => c.date === today);
  const ciScore  = ci ? Math.round((ci.score / 4) * 100) : 0;
  const attnScore = calcAttentionScore(attn[today]?.breaks || []);
  const combined  = Math.round(planPct * 0.5 + ciScore * 0.3 + attnScore * 0.2);
  return {
    combined, planPct, ciScore, attnScore,
    completedMin: adherence.completedMin,
    targetMin:    adherence.targetMin,
    hasData: adherence.hasData || !!ci,
  };
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
    const dayPlan   = plans[date] || [];
    const targetMin = dayPlan.reduce((s, x) => s + (x.durationMin || 0), 0);
    const doneMin   = dayPlan.reduce((s, x) => s + validWorkedMin(x), 0);
    const pct = targetMin > 0 ? Math.round((doneMin / targetMin) * 100) : -1;
    return { date, label, pct, isToday: date === todayStr() };
  });

  const totalStudyMin = last7.reduce((s, { date }) =>
    s + (plans[date] || []).reduce((a, x) => a + validWorkedMin(x), 0)
  , 0);
  const avgCi = (() => {
    const relevant = checkins.filter((c) => last7.some((d) => d.date === c.date));
    return relevant.length ? relevant.reduce((s, c) => s + c.score, 0) / relevant.length : 0;
  })();
  const totalBlocks = last7.reduce((s, { date }) =>
    s + (plans[date] || []).filter((x) => itemStatus(x) === "done" && x.kind !== "trial").length, 0);
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
    // Fix 12: validWorkedMin -- invalid sessions don't count, itemStatus is primary
    Object.entries(plans || {}).forEach(([date, items]) => {
      const targetMin    = items.reduce((s, x) => s + (x.durationMin || 0), 0);
      const completedMin = items.reduce((s, x) => s + validWorkedMin(x), 0);
      if (targetMin > 0) {
        const rate = completedMin / targetMin;
        pMap[date] = Math.round(rate * 3);
      }
    });
    // legacy dw sessions fallback
    const dw = store.load(KEYS.dw, { sessions: [] });
    (dw.sessions || []).forEach((s) => {
      if (!pMap[s.date] && s.completedMin > 0) pMap[s.date] = Math.min(3, Math.floor(s.completedMin / 60));
    });
    (checkins || []).forEach((c) => { cMap[c.date] = c.score; });
    (trials  || []).forEach((t) => { tMap[t.date] = (tMap[t.date] || 0) + 1; });
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
  { key: "plan",       icon: "▦",  label: "Bugun" },
  { key: "week",       icon: "◫",  label: "Hafta" },
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
  const [timerPhase, setTimerPhase] = useState("idle"); // idle|run|warn|paused
  const [breakReason, setBreakReason] = useState("");
  const itvRef = useRef(null);

  // FIX 9: stable ticking nowMin instead of inline nowHHMM() call
  const [nowMin, setNowMin] = useState(nowHHMM());
  useEffect(() => {
    const id = setInterval(() => setNowMin(nowHHMM()), 30000);
    return () => clearInterval(id);
  }, []);

  // Dopamine state
  const [xpBurst, setXpBurst] = useState(null);
  const [focusChallenge, setFocusChallenge] = useState(false);
  const [lastChallengeAt, setLastChallengeAt] = useState(0);
  const [winBlockId, setWinBlockId] = useState(null);

  // Trial analysis after block done
  const [pendingTrialItem, setPendingTrialItem]   = useState(null);
  const [delayModal, setDelayModal]               = useState(null);
  const [sessionCloseItem, setSessionCloseItem]   = useState(null);

  // Add form
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

    // Record actual start time, late start delay, and status: running
    setPlans((p) => {
      const todayItems = p[todayStr()] || [];
      const item = todayItems.find((x) => x.id === id);
      if (!item) return p;
      const actualStartMin = nowHHMM();
      const lateMin = Math.max(0, actualStartMin - item.startMin);
      const updated = todayItems.map((x) =>
        x.id === id
          ? applyStatus(x, "running", {
              startedAt:    x.startedAt || new Date().toISOString(),
              actualStartMin,
              lateStartMin: lateMin > 0 ? lateMin : x.lateStartMin || null,
              pausedAt:     null,  // clear pause when resuming
            })
          : x
      );
      const next = { ...p, [todayStr()]: updated };
      store.save(KEYS.plan, next);
      return next;
    });
  }, []);

  const stopTimer = useCallback(() => {
    // Full stop -- clears everything (used after finishBlock)
    clearInterval(itvRef.current);
    setActiveId(null);
    setTimerPhase("idle");
    setElapsed(0);
  }, []);

  const cancelTimer = useCallback(() => {
    // Cancel without finishing (stop button while running)
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

    console.log("[finishBlock] triggered for:", id, "actualMin:", actualMin, "early:", early);

    // Session validity check
    const valid = isValidSession(actualMin);

    // ROOT CAUSE FIX: compute remaining INSIDE the functional setPlans update
    // so we always read the latest state, not a stale closure snapshot.
    // plan_done is derived here and passed out via ref so it can fire after state settles.
    let shouldGrantPlanDone = false;

    setPlans((p) => {
      const todayItems = p[today] || [];
      const updated = todayItems.map((x) => {
        if (x.id !== id) return x;
        return applyStatus(x, "done", {
          actualMin,
          validSession: valid,
          doneAt:       new Date().toISOString(),
          startedAt:    x.startedAt || null,
        });
      });

      // All-done check on FRESH state (inside functional update)
      const stillPending  = updated.filter((x) => itemStatus(x) !== "done").length;
      const hasEarlyBreak = updated.some((x) =>
        itemStatus(x) === "done" && x.actualMin != null && x.actualMin < x.durationMin
      );
      const isCurrentEarly = early;

      console.log(
        "[finishBlock] items after update:",
        updated.map((x) => ({ id: x.id, done: x.done, subject: x.subject })),
        "stillPending:", stillPending,
        "hasEarlyBreak:", hasEarlyBreak,
        "isCurrentEarly:", isCurrentEarly,
      );

      if (
        valid &&
        stillPending === 0 &&
        !isCurrentEarly &&
        !hasEarlyBreak &&
        updated.length > 0
      ) {
        shouldGrantPlanDone = true;
        console.log("[finishBlock] plan_done WILL fire");
      } else {
        console.log("[finishBlock] plan_done will NOT fire");
      }

      return { ...p, [today]: updated };
    });

    // Backward compat: write to dw sessions
    const dwPrev   = store.load(KEYS.dw, { sessions: [], goalMin: 180 });
    const prevSess = dwPrev.sessions.find((s) => s.date === today);
    const nb = { id: uid(), dur: actualMin, early, valid, at: new Date().toISOString(), planItemId: id, subject: item.subject };
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

    // XP -- sadece gecerli session'lar icin (10-90dk)
    if (valid) {
      const prevXP = loadXP();
      const prevLv = calcLevel(prevXP.points);
      const { pts } = grantXP("block_valid");
      const newXP  = loadXP();
      const newLv  = calcLevel(newXP.points);

      setWinBlockId(id);
      setTimeout(() => setWinBlockId(null), 600);

      if (newLv.name !== prevLv.name) {
        playSound("level_up");
        setXpBurst({ pts: pts + 100, label: `LEVEL UP: ${newLv.name}!` });
        setTimeout(() => toast(`LEVEL UP! ${newLv.name}`, newLv.color), 400);
      } else {
        playSound("block_win");
        setXpBurst({ pts, label: early ? "Erken bitti -- devam!" : "Blok tamam!" });
      }

      // Streak milestone
      if (newXP.streak === 7 || newXP.streak === 14) {
        playSound("streak");
        const bonusPts = newXP.streak >= 14 ? XP_R.streak_14 : XP_R.streak_7;
        const bonusXP  = loadXP();
        bonusXP.points += bonusPts;
        store.save(KEYS.xp, bonusXP);
        setTimeout(() => toast(`🔥 ${newXP.streak} gun serisi! +${bonusPts} XP`, "var(--ora)"), 800);
      }

      // plan_done -- computed inside setPlans above on fresh state
      if (shouldGrantPlanDone) {
        console.log("[plan_done] granting XP and showing toast");
        grantXP("plan_done");
        setTimeout(() => toast(`+${XP_R.plan_done} XP -- Gunluk plan TAMAM!`, "var(--grn)"), 1200);
      }
    } else {
      if (actualMin < SESSION_MIN_MINUTES) {
        toast(`${actualMin}dk -- En az ${SESSION_MIN_MINUTES}dk gerekli, XP kazanilmadi`, "var(--muted)");
      } else {
        toast(`${actualMin}dk -- ${SESSION_MAX_MINUTES}dk limiti asildi, XP kazanilmadi`, "var(--muted)");
      }
    }

    // Deneme ise analiz formunu ac
    if (item.kind === "trial") {
      setPendingTrialItem(item);
      stopTimer();
      return;
    }

    // FIX 11: only open session close modal for full, clean completions (not early/paused finishes)
    const isCleanFinish = valid && !early && item.kind === "study";
    if (isCleanFinish) {
      setSessionCloseItem({ id, subject: item.subject, actualMin });
      stopTimer();
      return;
    }

    stopTimer();
  };

  const requestEarlyBreak = () => {
    // FIX 1: pause timer, do NOT finish block
    clearInterval(itvRef.current);
    setTimerPhase("warn");
    playSound("warn");
  };

  const confirmBreak = () => {
    if (!breakReason) return;
    const elMin = Math.floor(elapsed / 60);
    // FIX 1: record break in attention log but do NOT call finishBlock
    // Block stays active (not done), timer is paused at current elapsed
    const bd = { type: "early", blockMin: elMin, reason: breakReason, at: new Date().toISOString() };
    setAttn((p) => {
      const prev = p[today] || { breaks: [] };
      return { ...p, [today]: { ...prev, breaks: [...prev.breaks, bd] } };
    });
    // Mark block as paused with elapsed so far
    setPlans((prev) => ({
      ...prev,
      [today]: (prev[today] || []).map((x) =>
        x.id === activeId
          ? applyStatus(x, "paused", { pausedAt: elMin, pauseReason: breakReason })
          : x
      ),
    }));
    setTimerPhase("paused");
    setBreakReason("");
    toast(`Mola kaydedildi. ${elMin}dk calistin.`, "var(--ora)");
  };

  const resumeFromWarn = () => {
    // Resume from warn screen without recording break
    setTimerPhase("run");
    setBreakReason("");
    itvRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);
    playSound("start");
  };

  const resumeFromPause = () => {
    // FIX 1: resume same block from paused elapsed time
    setTimerPhase("run");
    itvRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);
    playSound("start");
    toast("Devam et!", "var(--acc)");
  };

  const markDoneManual = (id) => {
    const item = todayPlan.find((x) => x.id === id);
    if (!item) return;
    // Sadece bu item'in timerı çalışırken "Bitir" ile çağrılabilir
    const isThisActive = activeId === id && timerPhase === "run";
    if (!isThisActive) {
      toast("Blok sadece kronometre çalışırken tamamlanabilir.", "var(--muted)");
      return;
    }
    const usedMin = elapsed > 0 ? Math.floor(elapsed / 60) : item.durationMin;
    finishBlock(id, usedMin, false, null);
  };
  const delItem = (id) => {
    console.log("[delItem] delete clicked for id:", id, "activeId:", activeId);
    if (activeId === id) {
      toast("Aktif blok silinemez.", "var(--red)");
      return;
    }
    const item = (plans[today] || []).find((x) => x.id === id);
    const st   = item ? itemStatus(item) : null;
    if (st === "done") {
      toast("Tamamlanmış blok silinemez.", "var(--red)");
      return;
    }
    if (st === "paused") {
      toast("Mola verilmiş blok silinemez.", "var(--red)");
      return;
    }
    console.log("[delItem] deleting item, finishBlock will NOT run");
    setPlans((p) => ({ ...p, [today]: (p[today] || []).filter((x) => x.id !== id) }));
  };

  const totalPlanned  = todayPlan.reduce((s, x) => s + (x.durationMin || 0), 0);
  const totalActual   = todayPlan.reduce((s, x) => s + validWorkedMin(x), 0);
  const completionPct = totalPlanned > 0
    ? Math.round((totalActual / totalPlanned) * 100)
    : 0;

  const addItem = () => {
    if (!form.subject.trim() && form.kind !== "trial") return;
    const subject = form.kind === "trial" ? `${form.trialType} Deneme` : form.subject.trim();
    const item = makePlanItem({
      subject,
      startMin:    hhmmToMins(form.startMin),
      durationMin: parseInt(form.dur, 10) || 75,
      kind:        form.kind,
      trialType:   form.trialType,
      note:        form.note,
      date:        today,
      createdBy:   "student",
    });
    setPlans((p) => ({
      ...p,
      [today]: [...(p[today] || []), item].sort((a, b) => a.startMin - b.startMin),
    }));
    setForm((f) => ({ ...f, subject: "", note: "" }));
    setAddOpen(false);
    toast(`Plan ogesi eklendi: ${subject}`, "var(--acc)");
  };

  const overdueItems = todayPlan.filter((p) =>
    itemStatus(p) === "planned" && p.id !== activeId && p.startMin + p.durationMin < nowMin
  );
  const attnScore = calcAttentionScore(attn[today]?.breaks || []);
  const { label: aLabel, color: aColor } = attentionLabel(attnScore);
  const activeItem = todayPlan.find((x) => x.id === activeId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>

      {/* Overlays */}
      {xpBurst && <XPBurst pts={xpBurst.pts} label={xpBurst.label} onDone={() => setXpBurst(null)} />}
      {sessionCloseItem && (
        <SessionCloseModal
          subject={sessionCloseItem.subject}
          actualMin={sessionCloseItem.actualMin}
          onSave={(topicData) => {
            // Save structured session data alongside the plan item
            setPlans((p) => ({
              ...p,
              [today]: (p[today] || []).map((x) =>
                x.id === sessionCloseItem.id
                  ? { ...x, sessionTopic: topicData }
                  : x
              ),
            }));
            setSessionCloseItem(null);
          }}
          onSkip={() => setSessionCloseItem(null)}
        />
      )}
      {focusChallenge && (
        <FocusChallengePopup
          elapsed={elapsed}
          onDismiss={() => setFocusChallenge(false)}
          onClaim={(bonus) => {
            if (bonus > 0) {
              // FIX 6: all XP through grantXP, not direct mutation
              const xpd = loadXP();
              xpd.points += bonus; // challenge_bonus type not in XP_R so direct add is safe
              // but we still save through store so Firestore sync happens
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

      {/* Paused block -- FIX 1: resume or finish after break */}
      {timerPhase === "paused" && activeItem && (
        <Card style={{ border: "1px solid var(--ora)44", background: "var(--ora)06" }} className="fi">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <div>
              <Label style={{ marginBottom: "2px", color: "var(--ora)" }}>Mola -- Duraklatildi</Label>
              <p style={{ fontSize: "13px", fontWeight: "600", color: "var(--txt)" }}>{activeItem.subject}</p>
              <p style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)", marginTop: "2px" }}>
                {fmtMMSS(elapsed)} calistin
              </p>
            </div>
            <PBar value={elapsed} max={activeItem.durationMin * 60} color="var(--ora)" h={5} />
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <Btn variant="primary" onClick={resumeFromPause} style={{ flex: 2 }}>
              Devam et
            </Btn>
            <Btn variant="success"
              disabled={elapsed < 30}
              onClick={() => { finishBlock(activeId, Math.floor(elapsed / 60), true, null); }}
              style={{ flex: 1 }}>
              Bitir ({fmtMMSS(elapsed)})
            </Btn>
          </div>
        </Card>
      )}

      {/* Active focus timer */}
      {activeItem && timerPhase === "run" && (
        <Card style={{ border: "1px solid var(--acc)33", background: "var(--s2)" }} className="fi glowBorder">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <div>
              <Label style={{ marginBottom: "2px" }}>Odak Modu</Label>
              <p style={{ fontSize: "13px", fontWeight: "600", color: "var(--acc)" }}>{activeItem.subject}</p>
              <p style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)", marginTop: "2px" }}>
                {fmtMMSS(elapsed)} gecti
              </p>
            </div>
            <div style={{ textAlign: "right" }}>
              <p style={{ fontFamily: "var(--mono)", fontSize: "28px", fontWeight: "900", color: "var(--acc)", textShadow: "0 0 12px #e8c54750", lineHeight: 1 }}>
                {fmtMMSS(Math.max(0, activeItem.durationMin * 60 - elapsed))}
              </p>
              <p style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)", marginTop: "3px" }}>kaliyor</p>
            </div>
          </div>
          <PBar value={elapsed} max={activeItem.durationMin * 60} color="var(--acc)" h={5} />
          <p style={{ fontSize: "11px", color: "var(--muted)", fontStyle: "italic", lineHeight: "1.6", margin: "10px 0" }}>"{quote}"</p>
          <div style={{ display: "flex", gap: "8px" }}>
            <Btn variant="ghost" onClick={requestEarlyBreak} style={{ flex: 1 }}>Mola iste</Btn>
            <Btn variant="success"
              disabled={elapsed < 30}
              onClick={() => { clearInterval(itvRef.current); finishBlock(activeId, Math.floor(elapsed / 60), false, null); }}
              style={{ flex: 1 }}>
              Bitir ({fmtMMSS(elapsed)})
            </Btn>
          </div>
        </Card>
      )}

      {/* Break reason picker */}
      {timerPhase === "warn" && activeItem && (
        <Card style={{ border: "1px solid var(--red)44", background: "var(--red)06" }} className="flashR fi">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <Label>Erken mola -- neden?</Label>
            <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--ora)" }}>
              {fmtMMSS(elapsed)} / {fmtMMSS(activeItem.durationMin * 60)} calistin
            </span>
          </div>
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
          {completionPct === 100 && todayPlan.length > 0 && todayPlan.every((x) => itemStatus(x) === "done") && (
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
            onStop={cancelTimer}
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
            const targetId = delayModal.id;
            let shouldPlanDone = false;
            setPlans((p) => {
              const updated = (p[today] || []).map((x) =>
                x.id === targetId
                  ? applyStatus(x, "done", {
                      delayReason:  r,
                      actualMin:    x.durationMin,
                      validSession: isValidSession(x.durationMin), // real check, not forced true
                    })
                  : x
              );
              // Check plan_done on fresh state
              const stillPending  = updated.filter((x) => itemStatus(x) !== "done").length;
              const hasEarlyBreak = updated.some((x) => itemStatus(x) === "done" && x.actualMin != null && x.actualMin < x.durationMin);
              if (stillPending === 0 && !hasEarlyBreak && updated.length > 0) {
                shouldPlanDone = true;
              }
              return { ...p, [today]: updated };
            });
            const item = todayPlan.find((x) => x.id === targetId);
            if (item?.kind === "trial") setPendingTrialItem(item);
            setDelayModal(null);
            playSound("done");
            toast("Plan ogesi tamamlandi", "var(--grn)");
            if (shouldPlanDone) {
              grantXP("plan_done");
              setTimeout(() => toast(`+${XP_R.plan_done} XP -- Gunluk plan TAMAM!`, "var(--grn)"), 1200);
            }
          }}
          onCancel={() => setDelayModal(null)}
        />
      )}
    </div>
  );
}

function PlanItemRow({ item, nowMin, activeId, elapsed, timerPhase, winBlockId, onStart, onStop, onDone, onDelete, isReadOnly }) {
  const isActive  = activeId === item.id;
  const isWin     = winBlockId === item.id;
  const st        = itemStatus(item); // V2: status is primary

  // Derive display states from canonical status
  const isPaused     = st === "paused"  && !isActive;
  const isEarlyBreak = st === "done"    && item.actualMin != null && item.actualMin < item.durationMin;
  const isFullDone   = st === "done"    && !isEarlyBreak;
  const isSkipped    = st === "skipped";

  const displayDone = st === "done"; // for legacy "done" styling

  const status = displayDone
    ? (isEarlyBreak ? "early" : "done")
    : isActive   ? "active"
    : isPaused   ? "paused"
    : isSkipped  ? "skipped"
    : nowMin > item.startMin + item.durationMin ? "late"
    : "upcoming";

  const colMap   = { done:"var(--grn)", early:"var(--ora)", active:"var(--acc)", late:"var(--red)", paused:"var(--ora)", upcoming:"var(--muted)", skipped:"var(--muted)" };
  const col      = colMap[status];
  const pct      = isActive   ? clamp(Math.round((elapsed / (item.durationMin * 60)) * 100), 0, 100)
                 : isFullDone ? 100
                 : isEarlyBreak ? Math.round((item.actualMin / item.durationMin) * 100)
                 : isPaused   ? Math.round(((item.pausedAt || 0) / item.durationMin) * 100)
                 : 0;
  const borderCss = status === "late"    ? "var(--red)33"
                  : status === "active"  ? "var(--acc)33"
                  : status === "done"    ? "var(--grn)22"
                  : status === "early"   ? "var(--ora)33"
                  : status === "paused"  ? "var(--ora)22"
                  : status === "skipped" ? "var(--muted)22"
                  : item.kind === "trial" ? "var(--blu)33"
                  : "var(--b2)";

  return (
    <div className={`sr${isWin ? " blockWin" : ""}`}
      style={{ padding: "11px 13px", borderRadius: "8px", background: "var(--s2)", border: `1px solid ${borderCss}`, transition: "border-color .3s" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: isActive ? 8 : 0 }}>
        <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: col, minWidth: "38px", marginTop: "1px" }}>{minsToHHMM(item.startMin)}</span>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {item.kind === "trial" && <Tag color="var(--blu)">{item.trialType || "TYT"}</Tag>}
              <p style={{ fontSize: "13px", fontWeight: "500", textDecoration: displayDone ? "line-through" : "none", color: displayDone ? "var(--muted)" : "var(--txt)" }}>{item.subject}</p>
            </div>
            <div style={{ display: "flex", gap: "6px", marginTop: "3px", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: "10px", color: "var(--muted)" }}>{fmtHHMM(item.durationMin)} hedef</span>
              {item.note && <span style={{ fontSize: "10px", color: "var(--muted)" }}>· {item.note}</span>}
              {status === "late" && <Tag color="var(--red)">Gecikmis</Tag>}
              {item.delayReason && <span style={{ fontSize: "10px", color: "var(--ora)" }}>· {item.delayReason}</span>}
              {item.lateStartMin > 0 && (
                <span style={{ fontSize: "9px", color: "var(--red)", fontFamily: "var(--mono)" }}>
                  {item.lateStartMin}dk gec basladi
                </span>
              )}
              {displayDone && item.actualMin != null && (
                item.actualMin < item.durationMin
                  ? <span style={{ fontSize: "9px", color: "var(--ora)" }}>
                      {fmtHHMM(item.actualMin)} calistin · {fmtHHMM(item.durationMin - item.actualMin)} eksik
                    </span>
                  : <span style={{ fontSize: "9px", color: "var(--grn)" }}>
                      {fmtHHMM(item.actualMin)} tamamlandi
                    </span>
              )}
              {displayDone && item.validSession === false && item.actualMin != null && item.actualMin < SESSION_MIN_MINUTES && (
                <Tag color="var(--muted)">gecersiz ({item.actualMin}dk)</Tag>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
          {!displayDone && !isPaused && !isActive && !isReadOnly && <Btn size="sm" variant="accent" onClick={onStart}>▶</Btn>}
          {isActive && timerPhase === "run" && elapsed > 30 && <Btn size="sm" variant="success" onClick={onDone}>Bitir</Btn>}
          {isActive && timerPhase === "run" && <Btn size="sm" variant="ghost" onClick={onStop} style={{ color: "var(--muted)" }}>◼</Btn>}
          {/* Tamamlanmış, aktif, paused veya readonly blok silinemez */}
          {!displayDone && !isPaused && !isReadOnly && (
            <Btn size="sm" variant="ghost" onClick={onDelete}
              disabled={isActive}
              style={{ color: isActive ? "var(--b2)" : "var(--red)", cursor: isActive ? "not-allowed" : "pointer" }}
              title={isActive ? "Aktif blok silinemez" : "Sil"}>×</Btn>
          )}
          {isReadOnly && (
            <span style={{ fontFamily: "var(--mono)", fontSize: "8px", color: "var(--muted)", padding: "2px 5px", border: "1px solid var(--b2)", borderRadius: "3px" }}>oku</span>
          )}
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
      {isEarlyBreak && (
        <div style={{ marginTop: "6px" }}>
          <PBar value={item.actualMin} max={item.durationMin} color="var(--ora)" h={3} />
        </div>
      )}
      {isPaused && (
        <div style={{ marginTop: "6px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--ora)" }}>
              {item.pausedAt}dk sonra duraklatildi · {item.pauseReason || ""}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)" }}>
              {item.durationMin - (item.pausedAt || 0)}dk kaliyor
            </span>
          </div>
          <PBar value={item.pausedAt || 0} max={item.durationMin} color="var(--ora)" h={3} />
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
// SESSION CLOSE MODAL -- ask what was studied for structured session data
// ============================================================================
function SessionCloseModal({ subject, actualMin, onSave, onSkip }) {
  const [topic, setTopic]       = useState("");
  const [feeling, setFeeling]   = useState(""); // "iyi" | "orta" | "zor"
  const [notes, setNotes]       = useState("");

  const handleSave = () => {
    onSave({
      subject,
      topic:    topic.trim() || subject,
      feeling,
      notes:    notes.trim(),
      actualMin,
      savedAt:  new Date().toISOString(),
    });
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 1000, padding: "0", backdropFilter: "blur(4px)" }}>
      <div className="pi" style={{ background: "var(--s1)", border: "1px solid var(--b1)", borderRadius: "14px 14px 0 0", padding: "22px", maxWidth: "540px", width: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <div>
            <p style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--grn)", fontWeight: "600", letterSpacing: "1px" }}>BLOK TAMAMLANDI</p>
            <p style={{ fontSize: "14px", fontWeight: "600", marginTop: "2px" }}>{subject} -- {actualMin}dk</p>
          </div>
          <button onClick={onSkip} style={{ background: "none", color: "var(--muted)", fontSize: "18px", cursor: "pointer" }}>×</button>
        </div>

        {/* Topic */}
        <div style={{ marginBottom: "12px" }}>
          <Label style={{ marginBottom: "5px" }}>Hangi konuyu calismadin?</Label>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={`${subject} -- konu (orn: Turev, Limit...)`}
            autoFocus
            style={{ width: "100%", padding: "9px 11px", fontSize: "13px", borderRadius: "7px" }}
          />
        </div>

        {/* Feeling */}
        <div style={{ marginBottom: "12px" }}>
          <Label style={{ marginBottom: "5px" }}>Nasil gitti?</Label>
          <div style={{ display: "flex", gap: "6px" }}>
            {[
              { key: "iyi",  label: "Iyi gitti",    color: "var(--grn)" },
              { key: "orta", label: "Idare eder",   color: "var(--acc)" },
              { key: "zor",  label: "Zorlandim",    color: "var(--red)" },
            ].map((f) => (
              <button key={f.key} onClick={() => setFeeling(f.key)}
                style={{ flex: 1, padding: "8px", borderRadius: "7px", fontSize: "12px", cursor: "pointer", border: `1px solid ${feeling === f.key ? f.color : "var(--b2)"}`, background: feeling === f.key ? `${f.color}20` : "transparent", color: feeling === f.key ? f.color : "var(--muted)" }}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Notes (optional) */}
        <div style={{ marginBottom: "16px" }}>
          <Label style={{ marginBottom: "5px" }}>Not (opsiyonel)</Label>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anlamadim, tekrar lazim, vs..."
            style={{ width: "100%", padding: "8px 11px", fontSize: "12px", borderRadius: "7px" }}
          />
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <Btn variant="ghost" onClick={onSkip} style={{ flex: 1 }}>Atla</Btn>
          <Btn variant="primary" onClick={handleSave} style={{ flex: 2 }} disabled={!feeling}>Kaydet</Btn>
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

// Todo tipleri -- rehberlikci academic ve trial'a odaklanir
const TODO_TYPES = {
  academic: { l: "Akademik", c: "var(--blu)",  icon: "▶" },
  trial:    { l: "Deneme",   c: "var(--pur)",  icon: "◉" },
  personal: { l: "Kisisel",  c: "var(--muted)", icon: "◻" },
};

// Legacy priority -> type mapping (eski veriler icin)
const PRIOS = {
  high:   { l: "Acil",  c: "var(--red)"   },
  medium: { l: "Orta",  c: "var(--acc)"   },
  low:    { l: "Dusuk", c: "var(--muted)" },
};

function TodosTab({ todos, setTodos }) {
  const [text, setText]       = useState("");
  const [prio, setPrio]       = useState("high");
  const [todoType, setTodoType] = useState("academic");
  const [filt, setFilt]       = useState("active");

  const overdue = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0);

  const add = () => {
    if (!text.trim()) return;
    const u = [{
      id: uid(), text: text.trim(), source: "Manuel",
      priority: prio,
      todoType,               // "academic" | "trial" | "personal"
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
    if (before && !before.done) {
      // XP sadece akademik ve deneme gorevleri icin
      const type = before.todoType || "personal";
      if (type === "academic") { grantXP("todo_academic"); toast(`+${XP_R.todo_academic} XP`, "var(--grn)"); }
      else if (type === "trial") { grantXP("todo_trial"); toast(`+${XP_R.todo_trial} XP`, "var(--grn)"); }
      // personal gorevler XP vermiyor
    }
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
        {/* Todo tipi sec */}
        <div style={{ display: "flex", gap: "4px", marginBottom: "6px" }}>
          {Object.entries(TODO_TYPES).map(([k, { l, c }]) => (
            <button key={k} onClick={() => setTodoType(k)}
              style={{ padding: "3px 8px", borderRadius: "4px", border: "1px solid", fontSize: "10px", cursor: "pointer", borderColor: todoType === k ? c : "var(--b2)", background: todoType === k ? `${c}22` : "transparent", color: todoType === k ? c : "var(--muted)" }}>
              {l}
            </button>
          ))}
        </div>
        {/* Oncelik sec */}
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
                  {t.todoType && TODO_TYPES[t.todoType] && (
                    <span style={{ fontFamily: "var(--mono)", fontSize: "9px", padding: "1px 5px", borderRadius: "3px", background: `${TODO_TYPES[t.todoType].c}18`, color: TODO_TYPES[t.todoType].c, border: `1px solid ${TODO_TYPES[t.todoType].c}33` }}>
                      {TODO_TYPES[t.todoType].l}
                    </span>
                  )}
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
  const planDone  = planItems.filter((p) => itemStatus(p) === "done").length;
  const planRatio = planItems.length > 0 ? planDone / planItems.length : 0;
  const planMin   = last7.reduce((s, d) =>
    s + (plans?.[d] || []).reduce((a, x) => a + validWorkedMin(x), 0), 0);
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
  const planLate     = todayPlan.filter((p) => itemStatus(p) === "planned" && p.startMin + p.durationMin < nowHHMM()).length;
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
  // Fix 11: minute-based planPct using itemStatus + validWorkedMin
  const planTarget = todayPlan.reduce((s, x) => s + (x.durationMin || 0), 0);
  const planWorked = todayPlan.reduce((s, x) => s + validWorkedMin(x), 0);
  const planPct    = planTarget > 0 ? Math.round((planWorked / planTarget) * 100) : 0;

  const todoOverdue   = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0).length;
  const planLate      = todayPlan.filter((p) => itemStatus(p) === "planned" && p.startMin + p.durationMin < nowHHMM()).length;
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

function AuthBanner({ user, onSignIn, onSignOut, syncing, isAdmin }) {
  const [signingIn, setSigningIn] = useState(false);
  const [err, setErr] = useState("");

  const handleSignIn = async () => {
    setErr("");
    setSigningIn(true);
    try {
      await onSignIn();
    } catch (e) {
      console.error("Sign in error:", e);
      setErr(e?.code || e?.message || String(e));
    } finally {
      setSigningIn(false);
    }
  };

  if (user) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px", background: "var(--s2)", borderRadius: "8px", border: "1px solid var(--b1)", marginBottom: "12px" }}>
        {user.photoURL && <img src={user.photoURL} alt="" style={{ width: "20px", height: "20px", borderRadius: "50%", flexShrink: 0 }} />}
        <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--grn)", flex: 1 }}>
          {syncing ? "syncing..." : user.displayName || user.email}
        </span>
        {isAdmin && <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--pur)", background: "var(--pur)18", border: "1px solid var(--pur)33", borderRadius: "4px", padding: "2px 7px" }}>ADMIN</span>}
        <button onClick={onSignOut} style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)", background: "none", border: "1px solid var(--b2)", borderRadius: "4px", padding: "3px 8px", cursor: "pointer" }}>
          Cikis
        </button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px", background: "var(--s2)", borderRadius: "8px", border: "1px solid var(--b1)" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)", flex: 1 }}>
          Yerel mod -- giris yap ve verileri buluta kaydet
        </span>
        <button
          onClick={handleSignIn}
          disabled={signingIn}
          style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--acc)", background: "var(--acc)15", border: "1px solid var(--acc)44", borderRadius: "4px", padding: "3px 10px", cursor: signingIn ? "wait" : "pointer", fontWeight: "600", opacity: signingIn ? 0.6 : 1 }}>
          {signingIn ? "Bekleniyor..." : "Google ile Giris"}
        </button>
      </div>
      {err && (
        <p style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--red)", padding: "4px 10px" }}>
          Hata: {err}
        </p>
      )}
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

  const [user, setUser]           = useState(undefined);
  const [syncing, setSyncing]     = useState(false);
  const [isAdmin, setIsAdmin]     = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [profile, setProfile]     = useState(null);
  const [profileLoading, setProfileLoading]   = useState(true);
  const [forceStudent, setForceStudent]       = useState(false);
  const [showAssignPanel, setShowAssignPanel] = useState(false);
  // Part 4: sync status tracking
  const [syncPending, setSyncPending] = useState(false);

  // Admin check -- uid degisince calis
  useEffect(() => {
    const uid = user?.uid;
    if (!uid) { setIsAdmin(false); return; }
    console.log("Running admin check for uid:", uid);
    checkIsAdmin(uid).then((result) => {
      console.log("Admin check FINAL result:", result);
      setIsAdmin(result);
    });
  }, [user?.uid]);

  useEffect(() => {
    // Handle Google redirect result on page load
    checkRedirect().then((result) => {
      if (result?.user) console.log("Redirect login success:", result.user.email);
    }).catch((e) => {
      console.error("checkRedirect error:", e?.code, e?.message);
    });

    const unsub = onUser(async (fbUser) => {
      setUser(fbUser);

      if (fbUser) {
        _syncUid  = fbUser.uid;
        _syncUser = fbUser;

        writeProfile(fbUser.uid, fbUser);

        // Fetch full profile (includes role, institutionId, groupId)
        // Await before setting profileLoading=false so routing waits
        getUserProfile(fbUser.uid).then((p) => {
          setProfile(p);
          setProfileLoading(false);
        });

        // Hemen summary yaz -- admin panelinde gorunsun
        scheduleSummary(fbUser.uid, {
          email:        fbUser.email || "",
          displayName:  fbUser.displayName || "",
          photoURL:     fbUser.photoURL || "",
          xp:           0,
          streak:       0,
          todoCount:    0,
          trialCount:   0,
          checkinCount: 0,
          planCount:    0,
        });

        // Pull cloud data and merge into localStorage
        setSyncing(true);
        try {
          const cloud = await fsLoadAll(fbUser.uid);
          let needsRefresh = false;
          Object.entries(cloud).forEach(([k, v]) => {
            const local = store.load(k, null);
            if (JSON.stringify(v) !== JSON.stringify(local)) {
              try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
              needsRefresh = true;
            }
          });
          if (needsRefresh) {
            setTrials(store.load(KEYS.trials, []));
            setTodos(store.load(KEYS.todos, []));
            setXp(loadXP());
          }
          // Write full summary after sync
          _writeSummary(fbUser.uid, fbUser);

          // Part 4: check if local data is newer than cloud -- force sync if so
          const syncStatus = await checkSyncStatus(fbUser.uid);
          if (syncStatus.stale) {
            console.log("[sync] Local data is newer than cloud -- force syncing...");
            setSyncPending(true);
            // Re-write all local keys to Firestore
            const SYNC_KEYS = ["yks_xp","yks_plan","yks_trials","yks_todos","yks_checkins","yks_dw","yks_attn"];
            SYNC_KEYS.forEach((k) => {
              const v = store.load(k, null);
              if (v !== null) fsSave(fbUser.uid, k, v);
            });
            // Force summary with fresh data
            _writeSummary(fbUser.uid, fbUser);
            setTimeout(() => setSyncPending(false), 4000);
          }
        } catch { /* offline -- keep localStorage */ }
        setSyncing(false);
      } else {
        _syncUid  = null;
        _syncUser = null;
        setIsAdmin(false);
        setShowAdmin(false);
        setProfile(null);
        setProfileLoading(false);
      }
    });
    return unsub;
  }, []);

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

  // checkins ve plans App() seviyesinde tab'a göre store'dan okunur.
  // PlanTab kendi setPlans/setAttn wrapper'larıyla store'a yazıp
  // kendi local state'ini günceller -- App()'teki bu memo sadece
  // diğer tab'lar ve header için kullanılır.
  const checkins = useMemo(() => store.load(KEYS.checkins, []), [tab]);
  const plans    = useMemo(() => store.load(KEYS.plan, {}),    [tab]);

  const alerts = useMemo(() => {
    const today       = todayStr();
    const todayPlan   = plans[today] || [];
    const planLate    = todayPlan.filter((p) => itemStatus(p) === "planned" && p.startMin + p.durationMin < nowHHMM()).length;
    const todoOverdue = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0).length;
    const missingCheckin = checkins.find((c) => c.date === today) ? 0 : 1;
    return { plan: planLate, brain: 0, trials: 0, todos: todoOverdue, discipline: missingCheckin };
  }, [todos, checkins, plans, tab]);

  if (user === undefined || (user && profileLoading)) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <style>{CSS}</style>
        <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--muted)", animation: "blink 1.5s ease infinite" }}>...</span>
      </div>
    );
  }

  // super_admin assignment panel -- Phase 2
  if ((isAdmin || profile?.role === "super_admin") && showAssignPanel) {
    return (
      <AdminAssignPanel onClose={() => setShowAssignPanel(false)} />
    );
  }

  // Counselor / institution_admin / super_admin --> dedicated dashboard
  const isCounselorRole = profile?.role === "counselor" ||
                          profile?.role === "institution_admin" ||
                          profile?.role === "super_admin";

  if (user && isCounselorRole && !showAdmin && !forceStudent) {
    return (
      <CounselorDashboard
        profile={profile}
        user={user}
        onSignOut={() => {
          signOutUser();
          _syncUid   = null;
          _syncUser  = null;
          setProfile(null);
          setProfileLoading(true);
          setForceStudent(false);
        }}
        onSwitchToStudent={
          profile?.role === "super_admin"
            ? () => setForceStudent(true)
            : null
        }
        onOpenAssign={
          (profile?.role === "super_admin" || isAdmin)
            ? () => setShowAssignPanel(true)
            : null
        }
      />
    );
  }

  // Admin panel view
  if (isAdmin && showAdmin) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: "var(--sans)", display: "flex", justifyContent: "center", padding: "24px 12px 80px" }}>
        <style>{CSS}</style>
        <div style={{ width: "100%", maxWidth: "700px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
            <h1 style={{ fontFamily: "var(--mono)", fontSize: "14px", fontWeight: "700", color: "var(--pur)" }}>ADMIN PANEL</h1>
            <button onClick={() => setShowAdmin(false)} style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)", background: "none", border: "1px solid var(--b2)", borderRadius: "6px", padding: "5px 12px", cursor: "pointer" }}>
              Uygulamaya Don
            </button>
          </div>
          <AdminPanel />
        </div>
        <ToastLayer toasts={toasts} />
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: "var(--sans)", display: "flex", justifyContent: "center", padding: "24px 12px 80px" }}>
      <style>{CSS}</style>
      <div style={{ width: "100%", maxWidth: "540px" }}>
        <Header onToggleHeat={() => setHeat((p) => !p)} heatOpen={heatOpen} alerts={alerts} xp={xp} />
        {forceStudent && (
          <div style={{ display: "flex", gap: "6px", marginBottom: "10px" }}>
            <button onClick={() => setForceStudent(false)} style={{ flex: 1, padding: "7px", fontFamily: "var(--mono)", fontSize: "9px", color: "var(--pur)", background: "var(--pur)10", border: "1px solid var(--pur)33", borderRadius: "7px", cursor: "pointer" }}>
              Danisma Paneline Don
            </button>
            {(isAdmin || profile?.role === "super_admin") && (
              <button onClick={() => setShowAssignPanel(true)} style={{ flex: 1, padding: "7px", fontFamily: "var(--mono)", fontSize: "9px", color: "var(--acc)", background: "var(--acc)10", border: "1px solid var(--acc)33", borderRadius: "7px", cursor: "pointer" }}>
                Kullanici Atama
              </button>
            )}
          </div>
        )}
        <AuthBanner
          user={user}
          syncing={syncing || syncPending}
          isAdmin={isAdmin}
          onSignIn={() => signInGoogle()}
          onSignOut={() => { signOutUser(); _syncUid = null; _syncUser = null; }}
        />
        {isAdmin && (
          <button
            onClick={() => setShowAdmin(true)}
            style={{ width: "100%", marginBottom: "12px", padding: "8px", fontFamily: "var(--mono)", fontSize: "10px", color: "var(--pur)", background: "var(--pur)10", border: "1px solid var(--pur)33", borderRadius: "8px", cursor: "pointer" }}>
            Admin Panelini Ac
          </button>
        )}
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
          {tab === "week"       && <WeekTab trials={trials} onPushTodos={pushTodos} />}
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

// ============================================================================
// WEEK TAB -- Plan V2: weekly view with date navigation, goals, readonly guards
// ============================================================================

// Subjects for quick-add
const SUBJECTS = ["Matematik", "Fizik", "Kimya", "Biyoloji", "Turkce", "Edebiyat", "Tarih", "Cografya", "Felsefe", "Diger"];

function WeeklyGoalsPanel({ weekStart, plans, onClose }) {
  const [goals, setGoals]     = useState(() => getGoalsForWeek(weekStart));
  const [subject, setSubject] = useState("");
  const [hours, setHours]     = useState("3");

  const worked = subjectMinutesThisWeek(plans, weekStart);

  const addGoal = () => {
    if (!subject.trim() || !hours) return;
    const newGoal = {
      id:          uid(),
      weekStart,
      subject:     subject.trim(),
      targetMin:   Math.round(parseFloat(hours) * 60),
      createdBy:   "student",
      counselorUid: null,
    };
    const updated = [...goals, newGoal];
    setGoals(updated);
    saveWeeklyGoals([...loadWeeklyGoals().filter((g) => g.weekStart !== weekStart || g.id !== newGoal.id), newGoal]);
    setSubject("");
  };

  const removeGoal = (id) => {
    const goal = goals.find((g) => g.id === id);
    if (goal?.locked || goal?.createdBy === "counselor") return; // counselor goals cannot be deleted by student
    const updated = goals.filter((g) => g.id !== id);
    setGoals(updated);
    saveWeeklyGoals(loadWeeklyGoals().filter((g) => g.id !== id));
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 300, backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--s1)", border: "1px solid var(--b1)", borderRadius: "14px 14px 0 0", padding: "20px", width: "100%", maxWidth: "540px", maxHeight: "70vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <Label>Haftalik Ders Hedefleri</Label>
          <button onClick={onClose} style={{ background: "none", color: "var(--muted)", fontSize: "18px", cursor: "pointer" }}>×</button>
        </div>

        {/* Add goal */}
        <div style={{ display: "flex", gap: "6px", marginBottom: "14px" }}>
          <select value={subject} onChange={(e) => setSubject(e.target.value)}
            style={{ flex: 2, padding: "7px 9px", fontSize: "12px", borderRadius: "6px" }}>
            <option value="">Ders sec...</option>
            {SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input value={hours} onChange={(e) => setHours(e.target.value)} type="number" min="0.5" max="20" step="0.5"
            placeholder="Saat" style={{ width: "60px", padding: "7px 8px", fontSize: "12px", textAlign: "center" }} />
          <Btn variant="primary" onClick={addGoal} disabled={!subject}>Ekle</Btn>
        </div>

        {/* Goals list with progress */}
        {goals.length === 0 && (
          <p style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)", textAlign: "center", padding: "16px" }}>
            Henuz haftalik hedef yok.
          </p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {goals.map((g) => {
            const workedMin = worked[g.subject] || 0;
            const pct       = g.targetMin > 0 ? Math.min(Math.round((workedMin / g.targetMin) * 100), 100) : 0;
            const color     = pct >= 100 ? "var(--grn)" : pct >= 60 ? "var(--acc)" : "var(--red)";
            return (
              <div key={g.id} style={{ padding: "10px 12px", background: "var(--s2)", borderRadius: "8px", border: "1px solid var(--b2)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <p style={{ fontSize: "13px", fontWeight: "500" }}>{g.subject}</p>
                    {g.createdBy === "counselor" && (
                      <span style={{ fontFamily: "var(--mono)", fontSize: "8px", color: "var(--pur)", background: "var(--pur)18", padding: "1px 5px", borderRadius: "3px" }}>rehber</span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color }}>
                      {fmtHHMM(workedMin)} / {fmtHHMM(g.targetMin)}
                    </span>
                    {g.createdBy !== "counselor" && (
                      <button onClick={() => removeGoal(g.id)} style={{ background: "none", color: "var(--muted)", cursor: "pointer", fontSize: "13px" }}>×</button>
                    )}
                  </div>
                </div>
                <PBar value={workedMin} max={g.targetMin} color={color} h={4} />
                <p style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)", marginTop: "4px" }}>%{pct} · {pct >= 100 ? "Hedef tamamlandi!" : `${fmtHHMM(g.targetMin - workedMin)} kaldi`}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function WeekTab({ trials, onPushTodos }) {
  const today     = todayStr();
  const [plans, setPlansRaw] = useState(() => store.load(KEYS.plan, {}));
  const setPlans = useCallback((fn) => {
    setPlansRaw((p) => { const n = typeof fn === "function" ? fn(p) : fn; store.save(KEYS.plan, n); return n; });
  }, []);

  // Week navigation
  const [viewWeekStart, setViewWeekStart] = useState(() => weekMonday(today));
  const days = weekDays(viewWeekStart);
  const [selectedDay, setSelectedDay]   = useState(today);
  const [showGoals,   setShowGoals]     = useState(false);
  const [addOpen,     setAddOpen]       = useState(false);
  const [form, setForm] = useState({ subject: "", topic: "", startMin: "09:00", dur: "75", kind: "study", trialType: "TYT" });

  const prevWeek = () => {
    const d = new Date(viewWeekStart);
    d.setDate(d.getDate() - 7);
    const w = d.toISOString().slice(0, 10);
    setViewWeekStart(w);
    setSelectedDay(w);
  };
  const nextWeek = () => {
    const d = new Date(viewWeekStart);
    d.setDate(d.getDate() + 7);
    const w = d.toISOString().slice(0, 10);
    setViewWeekStart(w);
    setSelectedDay(w);
  };
  const goToday = () => { setViewWeekStart(weekMonday(today)); setSelectedDay(today); };

  const selectedPlan = plans[selectedDay] || [];
  const isReadOnly   = isPast(selectedDay);
  const isFut        = isFuture(selectedDay);
  const isTod        = isToday(selectedDay);

  // Day summary: worked minutes per day for bar chart
  const daySummary = days.map((d) => {
    const items  = plans[d] || [];
    const target = items.reduce((s, x) => s + (x.durationMin || 0), 0);
    const worked = items.reduce((s, x) => s + validWorkedMin(x), 0);
    return { date: d, target, worked, items: items.length };
  });

  // Weekly totals
  const totalTarget = daySummary.reduce((s, d) => s + d.target, 0);
  const totalWorked = daySummary.reduce((s, d) => s + d.worked, 0);
  const weekPct     = totalTarget > 0 ? Math.round((totalWorked / totalTarget) * 100) : 0;

  // Goals progress
  const goals  = getGoalsForWeek(viewWeekStart);
  const worked = subjectMinutesThisWeek(plans, viewWeekStart);

  const addFutureItem = () => {
    if (!form.subject.trim() && form.kind !== "trial") return;
    const subject = form.kind === "trial" ? `${form.trialType} Deneme` : form.subject.trim();
    const item = makePlanItem({
      subject,
      topic:       form.topic,
      startMin:    hhmmToMins(form.startMin),
      durationMin: parseInt(form.dur, 10) || 75,
      kind:        form.kind,
      trialType:   form.trialType,
      note:        "",
      date:        selectedDay,
      createdBy:   "student",
    });
    setPlans((p) => ({
      ...p,
      [selectedDay]: [...(p[selectedDay] || []), item].sort((a, b) => a.startMin - b.startMin),
    }));
    setForm((f) => ({ ...f, subject: "", topic: "" }));
    setAddOpen(false);
    toast(`${selectedDay} icin eklendi: ${subject}`, "var(--acc)");
  };

  const delFutureItem = (id) => {
    if (isReadOnly) return;
    const item = selectedPlan.find((x) => x.id === id);
    const st   = item ? itemStatus(item) : null;
    if (st === "done" || st === "paused" || st === "running") return;
    setPlans((p) => ({ ...p, [selectedDay]: (p[selectedDay] || []).filter((x) => x.id !== id) }));
  };

  const DAY_LABELS = ["Pzt", "Sal", "Car", "Per", "Cum", "Cmt", "Paz"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>

      {/* Week header */}
      <Card style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <div style={{ display: "flex", gap: "6px" }}>
            <Btn variant="ghost" onClick={prevWeek} style={{ padding: "4px 10px", fontSize: "12px" }}>←</Btn>
            <Btn variant="ghost" onClick={nextWeek} style={{ padding: "4px 10px", fontSize: "12px" }}>→</Btn>
            {viewWeekStart !== weekMonday(today) && (
              <Btn variant="accent" onClick={goToday} style={{ padding: "4px 10px", fontSize: "10px" }}>Bugun</Btn>
            )}
          </div>
          <div style={{ textAlign: "right" }}>
            <p style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>
              {viewWeekStart} haftasi
            </p>
            <p style={{ fontFamily: "var(--mono)", fontSize: "11px", color: weekPct >= 70 ? "var(--grn)" : weekPct >= 40 ? "var(--acc)" : "var(--muted)" }}>
              {fmtHHMM(totalWorked)} / {fmtHHMM(totalTarget)} · %{weekPct}
            </p>
          </div>
        </div>

        {/* 7-day bar chart */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: "4px" }}>
          {daySummary.map((d, i) => {
            const barH    = d.target > 0 ? Math.max(4, Math.round((d.worked / d.target) * 44)) : 4;
            const barC    = d.target === 0 ? "var(--b2)"
                          : d.worked >= d.target ? "var(--grn)"
                          : d.worked > 0         ? "var(--acc)"
                          : "var(--b2)";
            const isSel   = d.date === selectedDay;
            const isTodD  = d.date === today;
            return (
              <button key={d.date} onClick={() => setSelectedDay(d.date)}
                style={{ padding: "6px 2px 4px", borderRadius: "7px", border: `1px solid ${isSel ? "var(--acc)" : "transparent"}`, background: isSel ? "var(--acc)15" : "transparent", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: "3px" }}>
                <div style={{ width: "100%", height: "44px", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
                  <div style={{ width: "14px", height: `${barH}px`, background: barC, borderRadius: "3px 3px 0 0", transition: "height .3s ease" }} />
                </div>
                <span style={{ fontFamily: "var(--mono)", fontSize: "8px", color: isTodD ? "var(--acc)" : isSel ? "var(--txt)" : "var(--muted)", fontWeight: isTodD ? "700" : "400" }}>
                  {DAY_LABELS[i]}
                </span>
                {d.items > 0 && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: "7px", color: "var(--muted)" }}>{d.items}</span>
                )}
              </button>
            );
          })}
        </div>
      </Card>

      {/* Weekly goals summary (compact) -- counselor goals shown prominently */}
      {goals.length > 0 && (() => {
        const counselorGoals = goals.filter((g) => g.createdBy === "counselor");
        const studentGoals   = goals.filter((g) => g.createdBy !== "counselor");
        return (
          <Card style={{ padding: "12px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <Label>Haftalik Hedefler</Label>
              <button onClick={() => setShowGoals(true)} style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--acc)", background: "none", cursor: "pointer" }}>
                Duzenle
              </button>
            </div>

            {/* Counselor goals -- highlighted */}
            {counselorGoals.length > 0 && (
              <div style={{ marginBottom: studentGoals.length > 0 ? "10px" : "0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "5px", marginBottom: "6px" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "8px", color: "var(--pur)", background: "var(--pur)18", border: "1px solid var(--pur)33", padding: "1px 6px", borderRadius: "3px" }}>REHBERLİK</span>
                  <span style={{ fontSize: "10px", color: "var(--muted)" }}>Rehberlikci tarafindan belirlendi</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {counselorGoals.map((g) => {
                    const w   = worked[g.subject] || 0;
                    const pct = g.targetMin > 0 ? Math.min(Math.round((w / g.targetMin) * 100), 100) : 0;
                    const c   = pct >= 100 ? "var(--grn)" : pct >= 60 ? "var(--acc)" : pct >= 30 ? "var(--ora)" : "var(--red)";
                    return (
                      <div key={g.id} style={{ padding: "8px 10px", background: "var(--s2)", borderRadius: "7px", border: "1px solid var(--pur)22" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                          <span style={{ fontSize: "12px", fontWeight: "500" }}>{g.subject}</span>
                          <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: c }}>
                            {fmtHHMM(w)} / {fmtHHMM(g.targetMin)}
                          </span>
                        </div>
                        <PBar value={w} max={g.targetMin} color={c} h={4} />
                        <p style={{ fontFamily: "var(--mono)", fontSize: "8px", color: "var(--muted)", marginTop: "3px" }}>
                          {pct >= 100 ? "Hedef tamamlandi!" : `%${pct} · ${fmtHHMM(g.targetMin - w)} kaldi`}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Student's own goals */}
            {studentGoals.length > 0 && (
              <div>
                {counselorGoals.length > 0 && (
                  <Label style={{ marginBottom: "6px", marginTop: "2px" }}>Kendi Hedeflerim</Label>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                  {studentGoals.slice(0, 3).map((g) => {
                    const w   = worked[g.subject] || 0;
                    const pct = g.targetMin > 0 ? Math.min(Math.round((w / g.targetMin) * 100), 100) : 0;
                    const c   = pct >= 100 ? "var(--grn)" : pct >= 60 ? "var(--acc)" : "var(--muted)";
                    return (
                      <div key={g.id}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
                          <span style={{ fontSize: "11px" }}>{g.subject}</span>
                          <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: c }}>{fmtHHMM(w)}/{fmtHHMM(g.targetMin)}</span>
                        </div>
                        <PBar value={w} max={g.targetMin} color={c} h={3} />
                      </div>
                    );
                  })}
                  {studentGoals.length > 3 && (
                    <p style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)" }}>+{studentGoals.length - 3} hedef daha</p>
                  )}
                </div>
              </div>
            )}
          </Card>
        );
      })()}

      {/* Selected day plan */}
      <Card style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <div>
            <Label>{new Date(selectedDay + "T12:00:00").toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" })}</Label>
            <div style={{ display: "flex", gap: "5px", marginTop: "3px" }}>
              {isTod && <span style={{ fontFamily: "var(--mono)", fontSize: "8px", color: "var(--acc)", background: "var(--acc)18", padding: "1px 6px", borderRadius: "3px" }}>BUGUN</span>}
              {isReadOnly && <span style={{ fontFamily: "var(--mono)", fontSize: "8px", color: "var(--muted)", background: "var(--b2)", padding: "1px 6px", borderRadius: "3px" }}>GECMIS - SALT OKUMA</span>}
              {isFut && <span style={{ fontFamily: "var(--mono)", fontSize: "8px", color: "var(--blu)", background: "var(--blu)18", padding: "1px 6px", borderRadius: "3px" }}>GELECEK - PLANLAMA</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: "5px" }}>
            {!isReadOnly && (
              <Btn variant="primary" onClick={() => setAddOpen((p) => !p)} style={{ padding: "5px 10px", fontSize: "11px" }}>
                {addOpen ? "Kapat" : "+ Ekle"}
              </Btn>
            )}
            <Btn variant="ghost" onClick={() => setShowGoals(true)} style={{ padding: "5px 10px", fontSize: "11px" }}>Hedefler</Btn>
          </div>
        </div>

        {/* Add form for future/today planning */}
        {addOpen && !isReadOnly && (
          <div className="fi" style={{ padding: "12px", background: "var(--s2)", borderRadius: "8px", marginBottom: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", gap: "6px" }}>
              <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
                style={{ padding: "6px 8px", fontSize: "12px", borderRadius: "6px", flex: "0 0 auto" }}>
                <option value="study">Ders</option>
                <option value="trial">Deneme</option>
              </select>
              {form.kind === "study" ? (
                <input value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                  placeholder="Ders adi" style={{ flex: 1, padding: "6px 9px", fontSize: "12px" }} />
              ) : (
                <select value={form.trialType} onChange={(e) => setForm((f) => ({ ...f, trialType: e.target.value }))}
                  style={{ flex: 1, padding: "6px 8px", fontSize: "12px", borderRadius: "6px" }}>
                  <option>TYT</option><option>AYT</option>
                </select>
              )}
            </div>
            {form.kind === "study" && (
              <input value={form.topic} onChange={(e) => setForm((f) => ({ ...f, topic: e.target.value }))}
                placeholder="Konu (opsiyonel)" style={{ padding: "6px 9px", fontSize: "12px" }} />
            )}
            <div style={{ display: "flex", gap: "6px" }}>
              <input value={form.startMin} onChange={(e) => setForm((f) => ({ ...f, startMin: e.target.value }))}
                type="time" style={{ flex: 1, padding: "6px 8px", fontSize: "12px" }} />
              <input value={form.dur} onChange={(e) => setForm((f) => ({ ...f, dur: e.target.value }))}
                type="number" min="10" max="180" placeholder="dk" style={{ width: "64px", padding: "6px 8px", fontSize: "12px" }} />
              <Btn variant="primary" onClick={addFutureItem}>Ekle</Btn>
            </div>
          </div>
        )}

        {/* Plan items for selected day (readonly for past) */}
        {selectedPlan.length === 0 ? (
          <EmptyState icon="◫" title={isReadOnly ? "Bu gun plan yok" : "Henuz plan eklenmemis"} desc={isReadOnly ? "Gecmis gun." : "Yukardaki + butonuyla ekleyebilirsin."} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {selectedPlan.map((item) => {
              const st = itemStatus(item);
              const stColor = st === "done" ? "var(--grn)" : st === "paused" ? "var(--ora)" : st === "skipped" ? "var(--muted)" : "var(--muted)";
              const stIcon  = st === "done" ? "●" : st === "paused" ? "◑" : st === "running" ? "▶" : "○";
              return (
                <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 11px", background: "var(--s2)", borderRadius: "7px", border: `1px solid ${st === "done" ? "var(--grn)22" : st === "paused" ? "var(--ora)22" : "var(--b2)"}` }}>
                  <div style={{ display: "flex", gap: "9px", alignItems: "flex-start", flex: 1, minWidth: 0 }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: stColor, marginTop: "1px", flexShrink: 0 }}>{stIcon}</span>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: "12px", fontWeight: "500", textDecoration: st === "done" ? "line-through" : "none", color: st === "done" ? "var(--muted)" : "var(--txt)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.subject}
                        {item.topic && <span style={{ color: "var(--muted)", fontWeight: "400" }}> · {item.topic}</span>}
                      </p>
                      <div style={{ display: "flex", gap: "6px", marginTop: "2px", flexWrap: "wrap" }}>
                        <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)" }}>{minsToHHMM(item.startMin)}</span>
                        <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)" }}>{fmtHHMM(item.durationMin)}</span>
                        {st === "done" && item.actualMin && item.actualMin !== item.durationMin && (
                          <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--ora)" }}>{fmtHHMM(item.actualMin)} gercek</span>
                        )}
                        {st === "paused" && (
                          <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--ora)" }}>{item.pausedAt}dk'da duraklatildi</span>
                        )}
                        {item.createdBy === "counselor" && (
                          <span style={{ fontFamily: "var(--mono)", fontSize: "8px", color: "var(--pur)", background: "var(--pur)18", padding: "0px 4px", borderRadius: "3px" }}>rehber</span>
                        )}
                        {item.lateStartMin > 0 && (
                          <span style={{ fontFamily: "var(--mono)", fontSize: "8px", color: "var(--red)" }}>{item.lateStartMin}dk gec</span>
                        )}
                      </div>
                    </div>
                  </div>
                  {!isReadOnly && st === "planned" && (
                    <button onClick={() => delFutureItem(item.id)} style={{ background: "none", color: "var(--muted)", cursor: "pointer", fontSize: "14px", padding: "0 4px", flexShrink: 0 }}>×</button>
                  )}
                  {isTod && (
                    <span style={{ fontFamily: "var(--mono)", fontSize: "8px", color: "var(--acc)", background: "var(--acc)10", padding: "2px 5px", borderRadius: "3px", flexShrink: 0, marginLeft: "6px" }}>bugun</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {showGoals && (
        <WeeklyGoalsPanel weekStart={viewWeekStart} plans={plans} onClose={() => setShowGoals(false)} />
      )}
    </div>
  );
}

// ============================================================================
// ADMIN PANEL
// ============================================================================
function AdminPanel() {
  const [users, setUsers]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [selected, setSelected]   = useState(null); // selected uid
  const [detail, setDetail]       = useState(null);  // { data, profile, activity }
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    adminGetUsers().then((u) => {
      // Sort by lastSeen desc
      const sorted = u.sort((a, b) => {
        const at = a.lastSeen?.seconds || 0;
        const bt = b.lastSeen?.seconds || 0;
        return bt - at;
      });
      setUsers(sorted);
      setLoading(false);
    });
  }, []);

  const selectUser = async (uid) => {
    setSelected(uid);
    setDetail(null);
    setDetailLoading(true);
    const d = await adminGetUserData(uid);
    setDetail(d);
    setDetailLoading(false);
  };

  const fmtTs = (ts) => {
    if (!ts) return "--";
    const d = ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts);
    return d.toLocaleString("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  if (loading) {
    return <p style={{ fontFamily: "var(--mono)", fontSize: "12px", color: "var(--muted)", textAlign: "center", padding: "40px" }}>Yukleniyor...</p>;
  }

  if (selected && detail) {
    const u = users.find((x) => x.uid === selected) || {};
    const xpData   = detail.data?.yks_xp     || {};
    const todos    = detail.data?.yks_todos   || [];
    const trials   = detail.data?.yks_trials  || [];
    const checkins = detail.data?.yks_checkins || [];
    const plans    = detail.data?.yks_plan    || {};
    const planItems = Object.values(plans).flat();

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <button onClick={() => { setSelected(null); setDetail(null); }}
          style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)", background: "none", border: "1px solid var(--b2)", borderRadius: "6px", padding: "5px 12px", cursor: "pointer", alignSelf: "flex-start" }}>
          Listeye Don
        </button>

        {/* User header */}
        <Card style={{ padding: "14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {u.photoURL && <img src={u.photoURL} alt="" style={{ width: "36px", height: "36px", borderRadius: "50%" }} />}
            <div style={{ flex: 1 }}>
              <p style={{ fontWeight: "600", fontSize: "14px" }}>{u.displayName || "--"}</p>
              <p style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>{u.email}</p>
              <p style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)", marginTop: "2px" }}>uid: {selected}</p>
            </div>
            <div style={{ textAlign: "right" }}>
              <p style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>Son giris</p>
              <p style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--acc)" }}>{fmtTs(u.lastSeen)}</p>
            </div>
          </div>
        </Card>

        {/* Stats grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px" }}>
          {[
            { l: "XP",      v: xpData.points  || 0, c: "var(--pur)" },
            { l: "Streak",  v: xpData.streak  || 0, c: "var(--acc)" },
            { l: "Blok",    v: xpData.totalBlocks || 0, c: "var(--blu)" },
            { l: "Plan",    v: planItems.length,    c: "var(--grn)" },
            { l: "Gorev",   v: todos.length,        c: "var(--acc)" },
            { l: "Deneme",  v: trials.length,       c: "var(--pur)" },
            { l: "Checkin", v: checkins.length,     c: "var(--grn)" },
            { l: "Plan Done", v: planItems.filter((x) => itemStatus(x) === "done").length, c: "var(--grn)" },
            { l: "Todo Done", v: todos.filter((t) => t.done).length, c: "var(--grn)" },
          ].map((x) => (
            <div key={x.l} style={{ padding: "10px", background: "var(--s2)", borderRadius: "8px", textAlign: "center" }}>
              <p style={{ fontFamily: "var(--mono)", fontSize: "18px", fontWeight: "700", color: x.c }}>{x.v}</p>
              <p style={{ fontSize: "9px", color: "var(--muted)", marginTop: "2px" }}>{x.l}</p>
            </div>
          ))}
        </div>

        {/* Activity log */}
        {detail.activity?.length > 0 && (
          <Card style={{ padding: "14px" }}>
            <Label style={{ marginBottom: "10px" }}>Son Aktivite (20)</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {detail.activity.map((a) => (
                <div key={a.id} style={{ display: "flex", justifyContent: "space-between", padding: "5px 8px", background: "var(--s2)", borderRadius: "5px" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--acc)" }}>
                    {a.key?.replace("yks_", "") || "--"}
                  </span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)" }}>
                    {fmtTs(a.at)}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Recent trials */}
        {trials.length > 0 && (
          <Card style={{ padding: "14px" }}>
            <Label style={{ marginBottom: "10px" }}>Denemeler ({trials.length})</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
              {trials.slice(0, 5).map((t, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 9px", background: "var(--s2)", borderRadius: "6px" }}>
                  <span style={{ fontSize: "12px" }}>{t.type} -- {t.date}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--acc)" }}>{t.totalNet} net</span>
                </div>
              ))}
              {trials.length > 5 && <p style={{ fontSize: "10px", color: "var(--muted)", textAlign: "center" }}>+{trials.length - 5} daha</p>}
            </div>
          </Card>
        )}

        {/* Recent checkins */}
        {checkins.length > 0 && (
          <Card style={{ padding: "14px" }}>
            <Label style={{ marginBottom: "10px" }}>Check-in ({checkins.length})</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {checkins.slice(0, 7).map((c, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 8px", background: "var(--s2)", borderRadius: "5px" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "10px" }}>{c.date}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: c.score >= 3 ? "var(--grn)" : "var(--acc)" }}>{c.score}/4</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    );
  }

  if (selected && detailLoading) {
    return (
      <div>
        <button onClick={() => setSelected(null)} style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)", background: "none", border: "1px solid var(--b2)", borderRadius: "6px", padding: "5px 12px", cursor: "pointer", marginBottom: "16px" }}>Listeye Don</button>
        <p style={{ fontFamily: "var(--mono)", fontSize: "12px", color: "var(--muted)", textAlign: "center", padding: "40px" }}>Veri yukleniyor...</p>
      </div>
    );
  }

  // User list
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <Card style={{ padding: "10px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Label>Toplam Kullanici</Label>
          <span style={{ fontFamily: "var(--mono)", fontSize: "20px", fontWeight: "700", color: "var(--acc)" }}>{users.length}</span>
        </div>
      </Card>

      {users.length === 0 && (
        <p style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--muted)", textAlign: "center", padding: "30px" }}>
          Henuz kullanici yok. Kullanicilar giris yapip bir islem yapinca burada gorünür.
        </p>
      )}

      {users.map((u) => (
        <div key={u.uid} onClick={() => selectUser(u.uid)}
          style={{ padding: "12px 14px", background: "var(--s1)", border: "1px solid var(--b1)", borderRadius: "10px", cursor: "pointer", display: "flex", alignItems: "center", gap: "12px" }}
          onMouseEnter={(e) => e.currentTarget.style.borderColor = "var(--acc)44"}
          onMouseLeave={(e) => e.currentTarget.style.borderColor = "var(--b1)"}>
          {u.photoURL
            ? <img src={u.photoURL} alt="" style={{ width: "32px", height: "32px", borderRadius: "50%", flexShrink: 0 }} />
            : <div style={{ width: "32px", height: "32px", borderRadius: "50%", background: "var(--b2)", flexShrink: 0 }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: "13px", fontWeight: "500" }}>{u.displayName || "--"}</p>
            <p style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)", marginTop: "1px" }}>{u.email}</p>
          </div>
          <div style={{ display: "flex", gap: "10px", flexShrink: 0 }}>
            {[
              { l: "XP",  v: u.xp      || 0, c: "var(--pur)" },
              { l: "🔥",  v: u.streak  || 0, c: "var(--acc)" },
              { l: "den", v: u.trialCount || 0, c: "var(--blu)" },
            ].map((x) => (
              <div key={x.l} style={{ textAlign: "center" }}>
                <p style={{ fontFamily: "var(--mono)", fontSize: "13px", fontWeight: "700", color: x.c }}>{x.v}</p>
                <p style={{ fontSize: "8px", color: "var(--muted)" }}>{x.l}</p>
              </div>
            ))}
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <p style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)" }}>{fmtTs(u.lastSeen)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
