import { useEffect, useMemo, useState } from "react";
import { getGroupStudents, addCounselorNote, getCounselorNotes, counselorGetUserData, getCounselorWeeklyGoals, setCounselorWeeklyGoals } from "./firebase.js";

// ============================================================================
// Plan V2 helpers (mirrored from AppShell -- keep in sync)
// ============================================================================
function itemStatus(item) {
  if (item.status) return item.status;
  if (item.done)     return "done";
  if (item.pausedAt) return "paused";
  return "planned";
}

function validWorkedMin(item) {
  const st = itemStatus(item);
  if (st === "done") {
    if (item.validSession === false) return 0;
    return item.actualMin != null ? item.actualMin : item.durationMin || 0;
  }
  if (st === "paused") return item.pausedAt || 0;
  return 0;
}

// ============================================================================
// Business logic -- UNCHANGED
// ============================================================================
const RISK_WEIGHTS = {
  no_checkin_3d: 30,
  plan_rate_low: 25,
  no_trial_7d:   20,
  streak_broken: 15,
  no_login_2d:   10,
};

const FLAG_META = {
  no_login_2d:   { label: "2g giris yok",   desc: "Son 2 gundur uygulama acilmadi." },
  no_checkin_3d: { label: "3g check-in yok", desc: "Son 3 gundur gunluk check-in yok." },
  plan_rate_low: { label: "Plan dusuk",      desc: "7 gunluk plan uyumu %40 altinda." },
  no_trial_7d:   { label: "7g deneme yok",   desc: "Son 7 gundur deneme kaydedilmedi." },
  streak_broken: { label: "Streak sifir",    desc: "Calisma serisi kopmus." },
};

const fmtTs = (ts) => {
  if (!ts) return "--";
  const d = ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts);
  const diff = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diff < 2)    return "az once";
  if (diff < 60)   return `${diff}dk once`;
  if (diff < 1440) return `${Math.floor(diff / 60)}s once`;
  return `${Math.floor(diff / 1440)}g once`;
};

const fmtDate = (iso) => {
  if (!iso) return "--";
  const d = new Date(iso);
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diff === 0) return "bugun";
  if (diff === 1) return "dun";
  if (diff < 7)  return `${diff}g once`;
  if (diff < 30) return `${Math.floor(diff / 7)}h once`;
  return d.toLocaleDateString("tr-TR", { day: "2-digit", month: "short" });
};

function isSyncStale(student) {
  if (!student.syncedAt) return true;
  const ms = student.syncedAt?.seconds
    ? student.syncedAt.seconds * 1000
    : new Date(student.syncedAt).getTime();
  return (Date.now() - ms) > 3 * 86400000;
}

function computeRisk(student) {
  const storedFlags = student.riskFlags || [];
  const lastSeenMs  = student.lastSeen?.seconds
    ? student.lastSeen.seconds * 1000
    : student.lastSeen ? new Date(student.lastSeen).getTime() : 0;
  const loginStale = lastSeenMs > 0 && (Date.now() - lastSeenMs) > 2 * 86400000;
  const flags = [...storedFlags];
  if (loginStale && !flags.includes("no_login_2d")) flags.push("no_login_2d");
  const score = flags.reduce((s, f) => s + (RISK_WEIGHTS[f] || 0), 0);
  const adherenceRate = typeof student.adherenceRate === "number" ? student.adherenceRate : 0;
  return {
    flags,
    score,
    level: score >= 61 ? "high" : score >= 31 ? "mid" : "low",
    adherenceRate,
  };
}

const _planDataCache = {};

// ============================================================================
// Design tokens
// ============================================================================
const T = {
  bg:      "#0A0A0F",
  card:    "#12121A",
  cardHov: "#16161F",
  border:  "#1E1E2E",
  borderL: "#252538",
  acc:     "#6C63FF",
  txt:     "#E8E8F0",
  sub:     "#8888A0",
  muted:   "#444458",
  high:    "#FF4444",
  mid:     "#FFB800",
  low:     "#00C896",
  sans:    "'Inter', 'Geist', system-ui, sans-serif",
  mono:    "'JetBrains Mono', 'Fira Code', monospace",
};

const riskColor = (level) => ({ high: T.high, mid: T.mid, low: T.low }[level] || T.sub);
const adherColor = (r) => r >= 70 ? T.low : r >= 40 ? T.mid : T.high;

// ============================================================================
// CSS
// ============================================================================
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: ${T.bg};
    color: ${T.txt};
    font-family: ${T.sans};
    -webkit-font-smoothing: antialiased;
    font-size: 14px;
  }
  button { cursor: pointer; font-family: inherit; border: none; background: none; }
  button:disabled { cursor: not-allowed; opacity: 0.4; }
  input, textarea {
    font-family: inherit;
    background: #0E0E16;
    border: 1px solid ${T.border};
    color: ${T.txt};
    border-radius: 8px;
    font-size: 13px;
    transition: border-color .15s;
  }
  input:focus, textarea:focus { outline: none; border-color: ${T.acc}; }
  input::placeholder, textarea::placeholder { color: ${T.muted}; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 4px; }
  @keyframes fadeUp  { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
  @keyframes fadeIn  { from { opacity:0; } to { opacity:1; } }
  @keyframes spin    { to { transform: rotate(360deg); } }
  @keyframes blink   { 0%,100%{opacity:1} 50%{opacity:.3} }
  .card-enter { animation: fadeUp .18s ease both; }
  .fade-in    { animation: fadeIn .15s ease both; }
`;

// ============================================================================
// Primitives
// ============================================================================
const Divider = ({ style }) => (
  <div style={{ height: "1px", background: T.border, ...style }} />
);

const Spinner = () => (
  <div style={{
    width: "16px", height: "16px",
    border: `2px solid ${T.border}`,
    borderTopColor: T.acc,
    borderRadius: "50%",
    animation: "spin .7s linear infinite",
    display: "inline-block",
  }} />
);

const PBar = ({ value, max, color, h = 5 }) => {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ height: h, background: T.border, borderRadius: 999, overflow: "hidden" }}>
      <div style={{
        height: "100%", width: `${pct}%`,
        background: color,
        borderRadius: 999,
        transition: "width .5s cubic-bezier(.4,0,.2,1)",
      }} />
    </div>
  );
};

const Chip = ({ label, color }) => (
  <span style={{
    display: "inline-flex", alignItems: "center",
    fontSize: "11px", fontWeight: 500,
    padding: "3px 8px", borderRadius: "6px",
    background: `${color}18`,
    color,
    border: `1px solid ${color}30`,
    whiteSpace: "nowrap",
    letterSpacing: ".01em",
  }}>
    {label}
  </span>
);

const Btn = ({ children, onClick, variant = "ghost", disabled, style }) => {
  const styles = {
    ghost:   { background: "transparent", color: T.sub, border: `1px solid ${T.border}` },
    primary: { background: T.acc, color: "#fff", fontWeight: 600 },
    subtle:  { background: T.card, color: T.txt, border: `1px solid ${T.border}` },
  };
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        ...styles[variant],
        padding: "7px 14px", borderRadius: "8px", fontSize: "13px",
        transition: "all .12s", display: "inline-flex", alignItems: "center", gap: "6px",
        ...style,
      }}
      onMouseOver={(e) => { if (!disabled) e.currentTarget.style.opacity = ".82"; }}
      onMouseOut={(e)  => { e.currentTarget.style.opacity = "1"; }}>
      {children}
    </button>
  );
};

// ============================================================================
// StudentCard
// ============================================================================
function StudentCard({ student, onClick }) {
  const risk  = computeRisk(student);
  const color = riskColor(risk.level);
  const stale = isSyncStale(student);

  // Last trial display
  const lastTrialText = student.lastTrialDate
    ? `${student.lastTrialNet ?? "--"} net · ${fmtDate(student.lastTrialDate)}`
    : "Deneme yok";

  return (
    <div className="card-enter"
      onClick={onClick}
      style={{
        display: "flex",
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: "12px",
        overflow: "hidden",
        cursor: "pointer",
        transition: "transform .12s, border-color .12s, box-shadow .12s",
        position: "relative",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-1px)";
        e.currentTarget.style.borderColor = `${T.acc}55`;
        e.currentTarget.style.boxShadow = `0 4px 24px rgba(108,99,255,.08)`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "none";
        e.currentTarget.style.borderColor = T.border;
        e.currentTarget.style.boxShadow = "none";
      }}>

      {/* Left color bar */}
      <div style={{ width: "3px", background: color, flexShrink: 0 }} />

      {/* Content */}
      <div style={{ flex: 1, padding: "16px 18px", minWidth: 0 }}>
        {/* Top row */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "12px", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
            {/* Avatar */}
            {student.photoURL
              ? <img src={student.photoURL} alt="" style={{ width: 36, height: 36, borderRadius: "50%", flexShrink: 0, border: `2px solid ${T.border}` }} />
              : <div style={{
                  width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
                  background: `${color}20`, border: `2px solid ${color}40`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "14px", fontWeight: 700, color,
                }}>
                  {(student.displayName || "?")[0].toUpperCase()}
                </div>
            }
            <div style={{ minWidth: 0 }}>
              <p style={{ fontWeight: 600, fontSize: "14px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: T.txt }}>
                {student.displayName || student.email || "Isimsiz"}
              </p>
              <p style={{ fontSize: "12px", color: T.sub, marginTop: "2px" }}>
                {student.groupId ? `Grup: ${student.groupId}` : "Grup atanmadi"}
                {" · "}
                {fmtTs(student.lastSeen)}
              </p>
            </div>
          </div>
          {/* Risk badge */}
          <span style={{
            fontSize: "11px", fontWeight: 600,
            padding: "4px 10px", borderRadius: "20px",
            background: `${color}15`, color, border: `1px solid ${color}30`,
            flexShrink: 0, letterSpacing: ".02em",
          }}>
            {risk.level === "high" ? "Riskli" : risk.level === "mid" ? "Dikkat" : "Iyi"}
          </span>
        </div>

        {/* Middle: trial + plan */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
          {/* Last trial */}
          <div>
            <p style={{ fontSize: "11px", color: T.muted, marginBottom: "3px", textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600 }}>Son Deneme</p>
            <p style={{ fontSize: "13px", color: student.lastTrialDate ? T.txt : T.muted, fontWeight: student.lastTrialDate ? 500 : 400 }}>
              {lastTrialText}
            </p>
          </div>
          {/* Weekly activity */}
          <div>
            <p style={{ fontSize: "11px", color: T.muted, marginBottom: "3px", textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600 }}>Hafta Aktif</p>
            <p style={{ fontSize: "13px", color: T.txt, fontWeight: 500 }}>
              {student.weeklyActiveDays ?? 0}
              <span style={{ color: T.muted, fontWeight: 400 }}>/7 gun</span>
            </p>
          </div>
        </div>

        {/* Plan adherence bar */}
        <div style={{ marginBottom: "10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "5px" }}>
            <p style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600 }}>Plan Uyumu</p>
            <p style={{ fontSize: "12px", fontWeight: 600, color: adherColor(risk.adherenceRate) }}>
              %{risk.adherenceRate}
            </p>
          </div>
          <PBar value={risk.adherenceRate} max={100} color={adherColor(risk.adherenceRate)} h={4} />
        </div>

        {/* Bottom: flags */}
        {(risk.flags.length > 0 || stale) && (
          <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
            {risk.flags.map((f) => {
              const meta  = FLAG_META[f] || { label: f };
              const fc    = f === "plan_rate_low" || f === "no_checkin_3d" ? T.high
                          : f === "no_trial_7d"   || f === "no_login_2d"  ? T.mid
                          : T.muted;
              return <Chip key={f} label={meta.label} color={fc} />;
            })}
            {stale && <Chip label="Veri eski" color={T.muted} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// CounselorNotes
// ============================================================================
function CounselorNotes({ studentUid, counselorUid }) {
  const [notes,   setNotes]   = useState([]);
  const [text,    setText]    = useState("");
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);

  useEffect(() => {
    setLoading(true);
    getCounselorNotes(studentUid).then((n) => { setNotes(n); setLoading(false); });
  }, [studentUid]);

  const handleAdd = async () => {
    if (!text.trim()) return;
    setSaving(true);
    const id = await addCounselorNote(counselorUid, studentUid, text);
    if (id) {
      setNotes((p) => [{ id, counselorUid, text: text.trim(), createdAt: { seconds: Math.floor(Date.now() / 1000) } }, ...p]);
      setText("");
    }
    setSaving(false);
  };

  return (
    <div>
      <p style={{ fontSize: "13px", fontWeight: 600, color: T.txt, marginBottom: "12px" }}>Notlar</p>
      <div style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ogrenci icin not ekle..."
          rows={2}
          style={{ flex: 1, padding: "10px 12px", resize: "none", lineHeight: 1.5, borderRadius: "8px" }}
          onKeyDown={(e) => { if (e.key === "Enter" && e.metaKey) handleAdd(); }}
        />
        <Btn variant="primary" onClick={handleAdd} disabled={saving || !text.trim()}
          style={{ alignSelf: "flex-end", padding: "10px 16px" }}>
          {saving ? <Spinner /> : "Ekle"}
        </Btn>
      </div>
      {loading && <div style={{ display: "flex", justifyContent: "center", padding: "12px" }}><Spinner /></div>}
      {!loading && notes.length === 0 && (
        <p style={{ fontSize: "13px", color: T.muted, textAlign: "center", padding: "12px 0" }}>Henuz not eklenmemis.</p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {notes.map((n) => (
          <div key={n.id} style={{ padding: "12px 14px", background: "#0E0E16", border: `1px solid ${T.border}`, borderRadius: "10px" }}>
            <p style={{ fontSize: "13px", lineHeight: 1.6, color: T.txt, marginBottom: "6px" }}>{n.text}</p>
            <p style={{ fontSize: "11px", color: T.muted }}>{fmtTs(n.createdAt)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// WeeklyPlanBreakdown
// ============================================================================
function WeeklyPlanBreakdown({ studentUid }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const cached = _planDataCache[studentUid];
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
      setData(cached.data); setLoading(false); return;
    }
    setLoading(true);
    counselorGetUserData(studentUid).then((d) => {
      _planDataCache[studentUid] = { data: d, ts: Date.now() };
      setData(d); setLoading(false);
    });
  }, [studentUid]);

  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - i * 86400000);
    return { date: d.toISOString().slice(0, 10), label: d.toLocaleDateString("tr-TR", { weekday: "short", day: "numeric" }) };
  }).reverse();

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: "20px" }}><Spinner /></div>;

  const plans = data?.data?.yks_plan || {};
  const totalStudyMin = last7.reduce((s, { date }) =>
    s + (plans[date] || []).reduce((a, x) => a + validWorkedMin(x), 0), 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
        <p style={{ fontSize: "13px", fontWeight: 600, color: T.txt }}>Son 7 Gun</p>
        <span style={{ fontSize: "12px", color: T.acc, fontWeight: 600 }}>
          {Math.floor(totalStudyMin / 60)}s {totalStudyMin % 60}dk toplam
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {last7.map(({ date, label }) => {
          const items    = plans[date] || [];
          const totalMin = items.reduce((s, x) => s + (x.durationMin || 0), 0);
          const doneMin  = items.reduce((a, x) => a + validWorkedMin(x), 0);
          const rate    = totalMin > 0 ? Math.round((doneMin / totalMin) * 100) : null;
          const isToday = date === new Date().toISOString().slice(0, 10);
          const dc      = rate === null ? T.muted : adherColor(rate);

          return (
            <div key={date} style={{
              padding: "10px 14px",
              background: isToday ? `${T.acc}08` : "#0E0E16",
              border: `1px solid ${isToday ? `${T.acc}30` : T.border}`,
              borderRadius: "9px",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: items.length > 0 ? "8px" : 0 }}>
                <span style={{ fontSize: "12px", color: isToday ? T.acc : T.sub, fontWeight: isToday ? 600 : 400 }}>
                  {label}{isToday ? " · bugun" : ""}
                </span>
                {rate !== null
                  ? <span style={{ fontSize: "12px", fontWeight: 600, color: dc }}>{doneMin}dk / {totalMin}dk · %{rate}</span>
                  : <span style={{ fontSize: "12px", color: T.muted }}>plan yok</span>
                }
              </div>
              {items.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                {items.map((item, i) => {
                    const st      = itemStatus(item);
                    const isDone  = st === "done";
                    const isPaused = st === "paused";
                    const isEarly = isDone && item.actualMin != null && item.actualMin < item.durationMin;
                    const ic   = !isDone && !isPaused ? T.muted : isEarly || isPaused ? T.mid : T.low;
                    const icon = !isDone && !isPaused ? "○" : isPaused ? "◔" : isEarly ? "◑" : "●";
                    return (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0" }}>
                        <div style={{ display: "flex", gap: "8px", alignItems: "center", minWidth: 0 }}>
                          <span style={{ fontSize: "12px", color: ic, flexShrink: 0 }}>{icon}</span>
                          <span style={{ fontSize: "12px", color: isDone ? T.txt : T.sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {item.subject}
                          </span>
                          {item.kind === "trial" && (
                            <span style={{ fontSize: "10px", color: "#5b9cf6", background: "#5b9cf615", padding: "1px 6px", borderRadius: "4px", flexShrink: 0 }}>
                              {item.trialType || "TYT"}
                            </span>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: "5px", alignItems: "center", flexShrink: 0 }}>
                          <span style={{ fontSize: "11px", color: T.muted }}>
                            {isDone && item.actualMin != null && item.actualMin !== item.durationMin
                              ? `${item.actualMin}/${item.durationMin}dk`
                              : isPaused
                              ? `${item.pausedAt || 0}/${item.durationMin}dk`
                              : `${item.durationMin}dk`}
                          </span>
                          {isEarly    && <Chip label="erken" color={T.mid} />}
                          {isPaused   && <Chip label="mola" color={T.mid} />}
                          {item.lateStartMin > 0 && <Chip label={`${item.lateStartMin}dk gec`} color={T.high} />}
                          {item.sessionTopic?.feeling && (
                            <Chip label={item.sessionTopic.feeling}
                              color={item.sessionTopic.feeling === "iyi" ? T.low : item.sessionTopic.feeling === "zor" ? T.high : T.mid} />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// StudentDetailModal
// ============================================================================
// ============================================================================
// CounselorWeeklyGoals -- counselor sets weekly subject goals for a student
// ============================================================================
const SUBJECTS_LIST = ["Matematik","Fizik","Kimya","Biyoloji","Turkce","Edebiyat","Tarih","Cografya","Felsefe","Diger"];

function CounselorWeeklyGoals({ studentUid, counselorUid, studentSummary }) {
  const [goals,    setGoals]   = useState([]);
  const [loading,  setLoading] = useState(true);
  const [saving,   setSaving]  = useState(false);
  const [saved,    setSaved]   = useState(false);
  const [err,      setErr]     = useState("");

  // Week navigation: default to current week
  const [weekStart, setWeekStart] = useState(() => {
    const d = new Date();
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
  });

  // New goal form
  const [subject,  setSubject]  = useState("");
  const [hours,    setHours]    = useState("3");

  const getMonday = (offset) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + offset * 7);
    return d.toISOString().slice(0, 10);
  };

  useEffect(() => {
    setLoading(true);
    setGoals([]);
    getCounselorWeeklyGoals(studentUid).then((all) => {
      setGoals(all.filter((g) => g.weekStart === weekStart && g.createdBy === "counselor"));
      setLoading(false);
    });
  }, [studentUid, weekStart]);

  const addGoal = () => {
    if (!subject || !hours) return;
    const targetMin = Math.round(parseFloat(hours) * 60);
    if (isNaN(targetMin) || targetMin <= 0) return;
    // Prevent duplicate subject for same week
    if (goals.some((g) => g.subject === subject)) {
      setErr(`${subject} bu hafta icin zaten var. Oncelikleri kaldirin.`);
      return;
    }
    setErr("");
    setGoals((p) => [...p, {
      id:           `cg_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      weekStart,
      subject,
      targetMin,
      createdBy:    "counselor",
      counselorUid,
      locked:       true,
    }]);
    setSubject("");
    setHours("3");
    setSaved(false);
  };

  const removeGoal = (id) => {
    setGoals((p) => p.filter((g) => g.id !== id));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setErr("");
    const ok = await setCounselorWeeklyGoals(counselorUid, studentUid, goals);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } else {
      setErr("Kaydedilemedi. Firestore rules kontrol et.");
    }
    setSaving(false);
  };

  const weekLabel = new Date(weekStart + "T12:00:00").toLocaleDateString("tr-TR", { day: "numeric", month: "long" });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

      {/* Week navigation */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={() => setWeekStart(getMonday(-1))}
          style={{ color: T.sub, fontSize: "18px", cursor: "pointer", background: "none", padding: "4px 8px" }}>‹</button>
        <div style={{ textAlign: "center" }}>
          <p style={{ fontSize: "13px", fontWeight: 600, color: T.txt }}>{weekLabel} haftasi</p>
          <p style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>{weekStart}</p>
        </div>
        <button onClick={() => setWeekStart(getMonday(1))}
          style={{ color: T.sub, fontSize: "18px", cursor: "pointer", background: "none", padding: "4px 8px" }}>›</button>
      </div>

      {/* Current goals list */}
      {loading && (
        <div style={{ display: "flex", justifyContent: "center", padding: "16px" }}><Spinner /></div>
      )}

      {!loading && goals.length === 0 && (
        <div style={{ padding: "16px", background: "#0E0E16", borderRadius: "10px", border: `1px solid ${T.border}`, textAlign: "center" }}>
          <p style={{ fontSize: "13px", color: T.muted }}>Bu hafta icin hedef belirlenmemis.</p>
        </div>
      )}

      {!loading && goals.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {goals.map((g) => (
            <div key={g.id} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "10px 14px", background: "#0E0E16", borderRadius: "10px", border: `1px solid ${T.border}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: "13px", fontWeight: 500, color: T.txt }}>{g.subject}</p>
                <p style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>
                  Hedef: {Math.floor(g.targetMin / 60)}s {g.targetMin % 60}dk
                </p>
              </div>
              <button onClick={() => removeGoal(g.id)}
                style={{ color: T.muted, fontSize: "18px", cursor: "pointer", background: "none", flexShrink: 0 }}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* Add goal form */}
      <div style={{ padding: "14px 16px", background: "#0E0E16", borderRadius: "12px", border: `1px solid ${T.border}` }}>
        <p style={{ fontSize: "12px", fontWeight: 600, color: T.txt, marginBottom: "10px", textTransform: "uppercase", letterSpacing: ".04em" }}>
          Hedef Ekle
        </p>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <select value={subject} onChange={(e) => setSubject(e.target.value)}
            style={{ flex: 2, padding: "8px 10px", fontSize: "13px", borderRadius: "8px" }}>
            <option value="">Ders sec...</option>
            {SUBJECTS_LIST.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flex: 1 }}>
            <input value={hours} onChange={(e) => setHours(e.target.value)}
              type="number" min="0.5" max="20" step="0.5"
              style={{ width: "60px", padding: "8px 8px", fontSize: "13px", textAlign: "center", borderRadius: "8px" }} />
            <span style={{ fontSize: "12px", color: T.muted, flexShrink: 0 }}>saat</span>
          </div>
        </div>
        <button onClick={addGoal} disabled={!subject || !hours}
          style={{
            width: "100%", padding: "9px", borderRadius: "8px", fontSize: "13px", fontWeight: 600,
            background: subject && hours ? T.acc : T.border,
            color: subject && hours ? "#fff" : T.muted,
            cursor: subject && hours ? "pointer" : "not-allowed",
            transition: "background .15s",
          }}>
          + Hedef Ekle
        </button>
      </div>

      {err && (
        <p style={{ fontSize: "12px", color: T.high, padding: "8px 12px", background: `${T.high}10`, borderRadius: "8px" }}>
          {err}
        </p>
      )}

      {/* Save button */}
      {goals.length > 0 && (
        <button onClick={handleSave} disabled={saving}
          style={{
            width: "100%", padding: "11px", borderRadius: "10px", fontSize: "14px", fontWeight: 700,
            background: saved ? T.low : T.acc,
            color: "#fff",
            cursor: saving ? "not-allowed" : "pointer",
            transition: "background .2s",
            opacity: saving ? 0.7 : 1,
          }}>
          {saving ? "Kaydediliyor..." : saved ? "Kaydedildi ✓" : "Hedefleri Kaydet"}
        </button>
      )}

      <p style={{ fontSize: "11px", color: T.muted, textAlign: "center", lineHeight: 1.5 }}>
        Kaydedilen hedefler ogrenci WeekTab'inda goruntulenir.<br />
        Ogrenci bu hedefleri silemez.
      </p>
    </div>
  );
}

function StudentDetailModal({ student, counselorUid, onClose }) {
  const risk  = computeRisk(student);
  const color = riskColor(risk.level);
  const stale = isSyncStale(student);
  const [tab, setTab] = useState("overview"); // overview | plan | notes

  const TABS = [
    { key: "overview", label: "Genel" },
    { key: "goals",    label: "Hedefler" },
    { key: "plan",     label: "Plan Detayi" },
    { key: "notes",    label: "Notlar" },
  ];

  const stats = [
    { label: "Plan Uyumu",  value: `%${risk.adherenceRate}`, color: adherColor(risk.adherenceRate) },
    { label: "Hafta Aktif", value: `${student.weeklyActiveDays ?? 0}/7`, color: T.txt },
    { label: "Deneme",      value: student.trialCount || 0,  color: T.txt },
    { label: "Check-in",    value: student.checkinCount || 0, color: T.txt },
  ];

  return (
    <div className="fade-in"
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 500, padding: "16px" }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "16px", width: "100%", maxWidth: "560px", maxHeight: "88vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 24px 80px rgba(0,0,0,.6)" }}>

        {/* Modal header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: `1px solid ${T.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
            {student.photoURL
              ? <img src={student.photoURL} alt="" style={{ width: 44, height: 44, borderRadius: "50%", border: `2px solid ${T.border}` }} />
              : <div style={{ width: 44, height: 44, borderRadius: "50%", background: `${color}20`, border: `2px solid ${color}40`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px", fontWeight: 700, color, flexShrink: 0 }}>
                  {(student.displayName || "?")[0].toUpperCase()}
                </div>
            }
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: "16px", fontWeight: 700, color: T.txt }}>{student.displayName || "Isimsiz"}</p>
              <p style={{ fontSize: "12px", color: T.sub, marginTop: "2px" }}>
                {student.email} · Son giris: {fmtTs(student.lastSeen)}
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "12px", fontWeight: 600, padding: "5px 12px", borderRadius: "20px", background: `${color}15`, color, border: `1px solid ${color}30` }}>
                {risk.level === "high" ? "Riskli" : risk.level === "mid" ? "Dikkat" : "Iyi"}
              </span>
              <button onClick={onClose} style={{ color: T.muted, fontSize: "22px", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "6px", transition: "background .1s" }}
                onMouseOver={(e) => e.currentTarget.style.background = T.border}
                onMouseOut={(e)  => e.currentTarget.style.background = "none"}>
                ×
              </button>
            </div>
          </div>

          {/* Stats row */}
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${stats.length}, 1fr)`, gap: "8px", marginBottom: "14px" }}>
            {stats.map((s) => (
              <div key={s.label} style={{ padding: "10px", background: "#0E0E16", borderRadius: "10px", border: `1px solid ${T.border}` }}>
                <p style={{ fontSize: "18px", fontWeight: 700, color: s.color, lineHeight: 1 }}>{s.value}</p>
                <p style={{ fontSize: "11px", color: T.muted, marginTop: "4px" }}>{s.label}</p>
              </div>
            ))}
          </div>

          {/* Plan adherence bar */}
          <div style={{ marginBottom: "4px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
              <span style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600 }}>Plan Uyumu (7g)</span>
              <span style={{ fontSize: "12px", fontWeight: 600, color: adherColor(risk.adherenceRate) }}>%{risk.adherenceRate}</span>
            </div>
            <PBar value={risk.adherenceRate} max={100} color={adherColor(risk.adherenceRate)} h={5} />
          </div>

          {/* Tab bar */}
          <div style={{ display: "flex", gap: "4px", marginTop: "14px" }}>
            {TABS.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)}
                style={{
                  padding: "6px 14px", borderRadius: "8px", fontSize: "12px", fontWeight: 500,
                  background: tab === t.key ? `${T.acc}20` : "transparent",
                  color:      tab === t.key ? T.acc : T.sub,
                  border: `1px solid ${tab === t.key ? `${T.acc}40` : "transparent"}`,
                  transition: "all .12s",
                }}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>

          {tab === "overview" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {/* Last trial */}
              {student.lastTrialDate ? (
                <div style={{ padding: "14px 16px", background: "#0E0E16", border: `1px solid ${T.border}`, borderRadius: "10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <p style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600, marginBottom: "4px" }}>Son Deneme</p>
                    <p style={{ fontSize: "13px", color: T.sub }}>{fmtDate(student.lastTrialDate)}</p>
                  </div>
                  <p style={{ fontSize: "28px", fontWeight: 700, color: T.acc }}>{student.lastTrialNet ?? "--"}<span style={{ fontSize: "14px", color: T.sub, fontWeight: 400 }}> net</span></p>
                </div>
              ) : (
                <div style={{ padding: "14px 16px", background: "#0E0E16", border: `1px solid ${T.border}`, borderRadius: "10px", textAlign: "center" }}>
                  <p style={{ fontSize: "13px", color: T.muted }}>Henuz deneme kaydedilmemis.</p>
                </div>
              )}

              {/* Risk flags */}
              {risk.flags.length > 0 && (
                <div>
                  <p style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600, marginBottom: "8px" }}>Risk Detayi</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {risk.flags.map((f) => {
                      const meta = FLAG_META[f] || { label: f, desc: "" };
                      const fc   = f === "plan_rate_low" || f === "no_checkin_3d" ? T.high
                                 : f === "no_trial_7d"   || f === "no_login_2d"  ? T.mid : T.muted;
                      return (
                        <div key={f} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: `${fc}08`, border: `1px solid ${fc}25`, borderRadius: "9px" }}>
                          <div>
                            <p style={{ fontSize: "12px", fontWeight: 600, color: fc, marginBottom: "2px" }}>{meta.label}</p>
                            <p style={{ fontSize: "11px", color: T.sub }}>{meta.desc}</p>
                          </div>
                          <span style={{ fontSize: "12px", fontWeight: 700, color: fc }}>+{RISK_WEIGHTS[f] ?? 0}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Stale warning */}
              {stale && (
                <div style={{ padding: "10px 14px", background: `${T.muted}10`, border: `1px solid ${T.muted}25`, borderRadius: "9px" }}>
                  <p style={{ fontSize: "12px", color: T.muted }}>Veriler guncel olmayabilir. Ogrenci uygulamaya giris yapinca bilgiler guncellenir.</p>
                </div>
              )}
            </div>
          )}

          {tab === "goals" && (
            <CounselorWeeklyGoals
              studentUid={student.uid}
              counselorUid={counselorUid}
              studentSummary={student}
            />
          )}

          {tab === "plan" && <WeeklyPlanBreakdown studentUid={student.uid} />}

          {tab === "notes" && <CounselorNotes studentUid={student.uid} counselorUid={counselorUid} />}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main CounselorDashboard
// ============================================================================
export default function CounselorDashboard({ profile, user, onSignOut, onSwitchToStudent, onOpenAssign }) {
  const [students, setStudents] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [selected, setSelected] = useState(null);
  const [filter,   setFilter]   = useState("all");
  const [search,   setSearch]   = useState("");

  const institutionId = profile?.institutionId;
  const groupId       = profile?.groupId;
  const role          = profile?.role;

  useEffect(() => {
    if (!institutionId) { setLoading(false); return; }
    getGroupStudents(institutionId, role === "institution_admin" ? null : groupId)
      .then((data) => { setStudents(data); setLoading(false); });
  }, [institutionId, groupId, role]);

  const withRisk = useMemo(() => students.map((s) => ({ ...s, _risk: computeRisk(s) })), [students]);

  const counts = useMemo(() => ({
    high: withRisk.filter((s) => s._risk.level === "high").length,
    mid:  withRisk.filter((s) => s._risk.level === "mid").length,
    low:  withRisk.filter((s) => s._risk.level === "low").length,
  }), [withRisk]);

  const sorted = useMemo(() => {
    let list = filter === "all" ? withRisk : withRisk.filter((s) => s._risk.level === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((s) =>
        (s.displayName || "").toLowerCase().includes(q) ||
        (s.email       || "").toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) =>
      b._risk.score !== a._risk.score
        ? b._risk.score - a._risk.score
        : a._risk.adherenceRate - b._risk.adherenceRate
    );
  }, [withRisk, filter, search]);

  const roleLabel = role === "institution_admin" ? "Kurum Yoneticisi"
                  : role === "super_admin"        ? "Super Admin"
                  : "Rehberlikci";

  const today = new Date().toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" });

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: T.sans, color: T.txt }}>
      <style>{CSS}</style>

      {/* Top nav */}
      <div style={{ borderBottom: `1px solid ${T.border}`, padding: "0 32px" }}>
        <div style={{ maxWidth: "900px", margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: "56px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.acc }} />
            <span style={{ fontSize: "14px", fontWeight: 700, color: T.txt, letterSpacing: "-.01em" }}>YKS Savas Odasi</span>
            <span style={{ fontSize: "12px", color: T.muted }}>/ {roleLabel}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {onOpenAssign && (
              <Btn variant="ghost" onClick={onOpenAssign} style={{ fontSize: "12px", padding: "6px 12px" }}>
                Kullanici Atama
              </Btn>
            )}
            {onSwitchToStudent && (
              <Btn variant="ghost" onClick={onSwitchToStudent} style={{ fontSize: "12px", padding: "6px 12px" }}>
                Ogrenci Modu
              </Btn>
            )}
            <Btn variant="ghost" onClick={onSignOut} style={{ fontSize: "12px", padding: "6px 12px" }}>
              Cikis
            </Btn>
          </div>
        </div>
      </div>

      {/* Page content */}
      <div style={{ maxWidth: "900px", margin: "0 auto", padding: "32px 32px 80px" }}>

        {/* Page header */}
        <div style={{ marginBottom: "28px" }}>
          <p style={{ fontSize: "12px", color: T.muted, marginBottom: "4px" }}>{today}</p>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
            <div>
              <h1 style={{ fontSize: "24px", fontWeight: 700, color: T.txt, letterSpacing: "-.02em" }}>
                Ogrenci Paneli
              </h1>
              {user?.displayName && (
                <p style={{ fontSize: "13px", color: T.sub, marginTop: "4px" }}>{user.displayName}</p>
              )}
            </div>
            <p style={{ fontSize: "13px", color: T.muted }}>
              {students.length} ogrenci
            </p>
          </div>
        </div>

        {/* No institution */}
        {!institutionId && !loading && (
          <div style={{ textAlign: "center", padding: "80px 20px" }}>
            <div style={{ fontSize: "40px", marginBottom: "16px" }}>◈</div>
            <p style={{ fontSize: "16px", fontWeight: 600, color: T.txt, marginBottom: "8px" }}>Kuruma atanmamissiniz</p>
            <p style={{ fontSize: "13px", color: T.muted, maxWidth: "260px", margin: "0 auto", lineHeight: 1.6 }}>Kurum yoneticisinden kuruma eklemenizi isteyin.</p>
          </div>
        )}

        {loading && (
          <div style={{ display: "flex", justifyContent: "center", padding: "80px" }}>
            <Spinner />
          </div>
        )}

        {!loading && institutionId && (
          <>
            {/* Summary cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "12px", marginBottom: "28px" }}>
              {[
                { key: "high", label: "Riskli", color: T.high },
                { key: "mid",  label: "Dikkat", color: T.mid  },
                { key: "low",  label: "Iyi",    color: T.low  },
              ].map((x) => (
                <button key={x.key}
                  onClick={() => setFilter(filter === x.key ? "all" : x.key)}
                  style={{
                    padding: "20px",
                    background: filter === x.key ? `${x.color}12` : T.card,
                    border: `1px solid ${filter === x.key ? `${x.color}40` : T.border}`,
                    borderRadius: "12px",
                    textAlign: "left",
                    transition: "all .15s",
                    cursor: "pointer",
                  }}>
                  <p style={{ fontSize: "32px", fontWeight: 800, color: x.color, lineHeight: 1, marginBottom: "6px" }}>
                    {counts[x.key]}
                  </p>
                  <p style={{ fontSize: "13px", color: T.sub, fontWeight: 500 }}>{x.label}</p>
                </button>
              ))}
            </div>

            {/* Filter + search bar */}
            <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "20px", flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: "4px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "4px" }}>
                {["all", "high", "mid", "low"].map((f) => {
                  const labels = { all: "Tumü", high: "Riskli", mid: "Dikkat", low: "Iyi" };
                  return (
                    <button key={f} onClick={() => setFilter(f)}
                      style={{
                        padding: "6px 14px", borderRadius: "7px", fontSize: "12px", fontWeight: 500,
                        background: filter === f ? `${T.acc}20` : "transparent",
                        color:      filter === f ? T.acc : T.sub,
                        border:     `1px solid ${filter === f ? `${T.acc}40` : "transparent"}`,
                        transition: "all .12s",
                        cursor: "pointer",
                      }}>
                      {labels[f]}
                    </button>
                  );
                })}
              </div>
              <div style={{ flex: 1, minWidth: "180px", position: "relative" }}>
                <span style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", color: T.muted, fontSize: "14px", pointerEvents: "none" }}>⌕</span>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Ogrenci ara..."
                  style={{ width: "100%", padding: "8px 12px 8px 34px", borderRadius: "9px", fontSize: "13px" }}
                />
              </div>
              {(filter !== "all" || search) && (
                <button onClick={() => { setFilter("all"); setSearch(""); }}
                  style={{ fontSize: "12px", color: T.muted, textDecoration: "underline", cursor: "pointer" }}>
                  Temizle
                </button>
              )}
            </div>

            {/* List label */}
            <p style={{ fontSize: "12px", color: T.muted, marginBottom: "12px", textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600 }}>
              {sorted.length} ogrenci
              {filter !== "all" && ` · ${filter === "high" ? "Riskli" : filter === "mid" ? "Dikkat" : "Iyi"} filtresi`}
              {search && ` · "${search}"`}
            </p>

            {/* Empty */}
            {sorted.length === 0 && (
              <div style={{ textAlign: "center", padding: "60px 20px" }}>
                <p style={{ fontSize: "32px", marginBottom: "12px" }}>◻</p>
                <p style={{ fontSize: "14px", color: T.muted }}>
                  {students.length === 0
                    ? "Henuz ogrenci yok."
                    : "Bu filtrede ogrenci bulunamadi."}
                </p>
              </div>
            )}

            {/* Student list */}
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {sorted.map((s) => (
                <StudentCard key={s.uid} student={s} onClick={() => setSelected(s)} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Modal */}
      {selected && (
        <StudentDetailModal
          student={selected}
          counselorUid={user?.uid}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
