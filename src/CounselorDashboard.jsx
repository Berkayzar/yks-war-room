import { useEffect, useMemo, useState } from "react";
import { getGroupStudents, addCounselorNote, getCounselorNotes, counselorGetUserData } from "./firebase.js";

// ============================================================================
// Constants
// ============================================================================
const RISK_WEIGHTS = {
  no_checkin_3d: 30,
  plan_rate_low: 25,
  no_trial_7d:   20,
  streak_broken: 15,
  no_login_2d:   10,
};

const FLAG_META = {
  no_login_2d:   { label: "2g giris yok",    color: "var(--ora)", desc: "Son 2 gundur uygulamaya giris yapilmadi." },
  no_checkin_3d: { label: "3g checkin yok",  color: "var(--red)", desc: "Son 3 gundur gunluk check-in yapilmadi." },
  plan_rate_low: { label: "Plan dusuk",       color: "var(--red)", desc: "Son 7 gunluk plan uyumu %40 altinda." },
  no_trial_7d:   { label: "7g deneme yok",   color: "var(--ora)", desc: "Son 7 gundur deneme eklenmedi." },
  streak_broken: { label: "Streak sifir",    color: "var(--muted)", desc: "Calisma serisi sifirlanmis." },
};

// ============================================================================
// Utils
// ============================================================================
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
  return new Date(iso).toLocaleDateString("tr-TR", { day: "2-digit", month: "short" });
};

// Compute risk from summary fields
// FIX 11: only use reliable minute-based adherenceRate, no task-count fallback
function computeRisk(student) {
  const storedFlags = student.riskFlags || [];

  // Add no_login_2d from lastSeen (only available in counselor context via Firestore)
  const lastSeenMs = student.lastSeen?.seconds
    ? student.lastSeen.seconds * 1000
    : student.lastSeen ? new Date(student.lastSeen).getTime() : 0;
  const loginStale = lastSeenMs > 0 && (Date.now() - lastSeenMs) > 2 * 86400000;

  const flags = [...storedFlags];
  if (loginStale && !flags.includes("no_login_2d")) flags.push("no_login_2d");

  const score = flags.reduce((s, f) => s + (RISK_WEIGHTS[f] || 0), 0);

  // FIX 11: only use adherenceRate (minute-based), never task-count fallback
  const adherenceRate = typeof student.adherenceRate === "number"
    ? student.adherenceRate
    : 0; // safe zero -- never fabricate from task count

  return {
    flags,
    score,
    level:        score >= 61 ? "high" : score >= 31 ? "mid" : "low",
    adherenceRate,
  };
}

const RISK_COLOR = { high: "var(--red)", mid: "var(--ora)", low: "var(--grn)" };
const RISK_LABEL = { high: "Riskli",     mid: "Dikkat",     low: "Iyi"       };

// ============================================================================
// CSS
// ============================================================================
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:#060606; --s1:#0e0e0e; --s2:#151515;
    --b1:#1e1e1e; --b2:#282828;
    --txt:#e6e6e6; --muted:#4a4a4a;
    --acc:#e8c547; --red:#e05252; --grn:#4caf7d;
    --blu:#5b9cf6; --pur:#a78bfa; --ora:#f59e0b;
    --mono:'IBM Plex Mono',monospace;
    --sans:'IBM Plex Sans',sans-serif;
  }
  html, body { background:var(--bg); color:var(--txt); font-family:var(--sans); -webkit-font-smoothing:antialiased; }
  button { cursor:pointer; font-family:var(--sans); border:none; transition:all .12s; }
  button:hover:not(:disabled) { filter:brightness(1.12); }
  input, textarea { font-family:var(--sans); background:var(--s2); border:1px solid var(--b2); color:var(--txt); border-radius:6px; }
  input:focus, textarea:focus { outline:none; border-color:var(--acc); }
  input::placeholder, textarea::placeholder { color:var(--muted); }
  ::-webkit-scrollbar { width:3px; }
  ::-webkit-scrollbar-thumb { background:var(--b2); border-radius:2px; }
  @keyframes fadeUp  { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }
  @keyframes fadeIn  { from{opacity:0} to{opacity:1} }
  @keyframes blink   { 0%,100%{opacity:1} 50%{opacity:.3} }
  @keyframes slideUp { from{transform:translateY(100%);opacity:0} to{transform:none;opacity:1} }
  .fu { animation:fadeUp .2s ease both; }
  .fi { animation:fadeIn .15s ease both; }
  .su { animation:slideUp .25s cubic-bezier(.34,1.1,.64,1) both; }
`;

// ============================================================================
// Primitives
// ============================================================================
const Card = ({ children, style, className, onClick }) => (
  <div className={className} onClick={onClick} style={{ background:"var(--s1)", border:"1px solid var(--b1)", borderRadius:"10px", padding:"14px", ...style }}>
    {children}
  </div>
);

const Label = ({ children, style }) => (
  <p style={{ fontFamily:"var(--mono)", fontSize:"10px", fontWeight:"600", color:"var(--muted)", letterSpacing:"1.4px", textTransform:"uppercase", ...style }}>
    {children}
  </p>
);

const PBar = ({ value, max, color = "var(--acc)", h = 4 }) => {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ height:h, background:"var(--b1)", borderRadius:"999px", overflow:"hidden" }}>
      <div style={{ height:"100%", width:`${pct}%`, background:color, borderRadius:"999px", transition:"width .6s ease" }} />
    </div>
  );
};

const RiskBadge = ({ level, score }) => {
  const c = RISK_COLOR[level];
  return (
    <span style={{ fontFamily:"var(--mono)", fontSize:"9px", fontWeight:"700", padding:"2px 8px", borderRadius:"4px", background:`${c}18`, color:c, border:`1px solid ${c}44`, whiteSpace:"nowrap" }}>
      {RISK_LABEL[level]} {score > 0 ? `· ${score}` : ""}
    </span>
  );
};

const FlagChip = ({ flag, size = "sm" }) => {
  const meta  = FLAG_META[flag] || { label: flag, color: "var(--muted)", desc: "" };
  const fsize = size === "sm" ? "8px" : "10px";
  return (
    <span title={meta.desc} style={{ fontFamily:"var(--mono)", fontSize:fsize, padding:"2px 6px", borderRadius:"3px", background:`${meta.color}14`, color:meta.color, border:`1px solid ${meta.color}33`, whiteSpace:"nowrap", cursor:"help" }}>
      {meta.label}
    </span>
  );
};

// ============================================================================
// Student card
// ============================================================================
function StudentCard({ student, onClick }) {
  const risk = computeRisk(student);
  const borderColor = risk.level === "high" ? "var(--red)33" : risk.level === "mid" ? "var(--ora)22" : "var(--b1)";

  return (
    <div className="fu" onClick={onClick}
      style={{ padding:"13px 14px", background:"var(--s1)", border:`1px solid ${borderColor}`, borderRadius:"10px", cursor:"pointer", transition:"border-color .2s" }}
      onMouseEnter={(e) => e.currentTarget.style.borderColor = "var(--acc)55"}
      onMouseLeave={(e) => e.currentTarget.style.borderColor = borderColor}>

      {/* Top */}
      <div style={{ display:"flex", alignItems:"center", gap:"10px", marginBottom:"10px" }}>
        {student.photoURL
          ? <img src={student.photoURL} alt="" style={{ width:"32px", height:"32px", borderRadius:"50%", flexShrink:0 }} />
          : <div style={{ width:"32px", height:"32px", borderRadius:"50%", background:"var(--b2)", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:"13px", color:"var(--muted)", fontWeight:"600" }}>{(student.displayName||"?")[0].toUpperCase()}</div>
        }
        <div style={{ flex:1, minWidth:0 }}>
          <p style={{ fontSize:"13px", fontWeight:"500", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {student.displayName || student.email || "Isimsiz"}
          </p>
          <p style={{ fontFamily:"var(--mono)", fontSize:"9px", color:"var(--muted)", marginTop:"1px" }}>
            {fmtTs(student.lastSeen)}
          </p>
        </div>
        <RiskBadge level={risk.level} score={risk.score} />
      </div>

      {/* Stats */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:"5px", marginBottom:"8px" }}>
        {[
          // FIX 10: weeklyActiveDays more useful than XP for counselor
          { l:"Haf.Gun", v: student.weeklyActiveDays ?? "--",        c: (student.weeklyActiveDays||0) >= 5 ? "var(--grn)" : (student.weeklyActiveDays||0) >= 3 ? "var(--acc)" : "var(--red)" },
          { l:"Streak",  v: `🔥${student.streak || 0}`,             c: student.streak > 0 ? "var(--acc)" : "var(--muted)" },
          { l:"Deneme",  v: student.trialCount || 0,                 c:"var(--blu)" },
          { l:"Plan%",   v: `${risk.adherenceRate}%`,                c: risk.adherenceRate >= 70 ? "var(--grn)" : risk.adherenceRate >= 40 ? "var(--acc)" : "var(--red)" },
        ].map((x) => (
          <div key={x.l} style={{ textAlign:"center", padding:"5px 3px", background:"var(--s2)", borderRadius:"5px" }}>
            <p style={{ fontFamily:"var(--mono)", fontSize:"12px", fontWeight:"700", color:x.c, lineHeight:1 }}>{x.v}</p>
            <p style={{ fontSize:"8px", color:"var(--muted)", marginTop:"2px" }}>{x.l}</p>
          </div>
        ))}
      </div>

      {/* Plan bar */}
      <PBar value={risk.adherenceRate} max={100}
        color={risk.adherenceRate >= 70 ? "var(--grn)" : risk.adherenceRate >= 40 ? "var(--acc)" : "var(--red)"}
        h={3} />

      {/* Risk flags */}
      {risk.flags.length > 0 && (
        <div style={{ display:"flex", gap:"4px", flexWrap:"wrap", marginTop:"7px" }}>
          {risk.flags.map((f) => <FlagChip key={f} flag={f} />)}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Counselor Notes section
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
      setNotes((p) => [{
        id,
        counselorUid,
        text: text.trim(),
        createdAt: { seconds: Math.floor(Date.now() / 1000) },
      }, ...p]);
      setText("");
    }
    setSaving(false);
  };

  return (
    <div>
      <Label style={{ marginBottom:"8px" }}>Rehberlik Notlari</Label>

      {/* Input */}
      <div style={{ display:"flex", gap:"6px", marginBottom:"10px" }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Not ekle..."
          rows={2}
          style={{ flex:1, padding:"8px 10px", fontSize:"12px", resize:"none", borderRadius:"7px", lineHeight:"1.5" }}
        />
        <button onClick={handleAdd} disabled={saving || !text.trim()}
          style={{ padding:"8px 14px", background:"var(--acc)", color:"#000", fontWeight:"700", fontSize:"12px", borderRadius:"7px", cursor: saving || !text.trim() ? "not-allowed" : "pointer", opacity: saving || !text.trim() ? 0.5 : 1, flexShrink:0 }}>
          {saving ? "..." : "Ekle"}
        </button>
      </div>

      {/* Notes list */}
      {loading && <p style={{ fontFamily:"var(--mono)", fontSize:"10px", color:"var(--muted)", animation:"blink 1.5s ease infinite" }}>Yukleniyor...</p>}
      {!loading && notes.length === 0 && (
        <p style={{ fontFamily:"var(--mono)", fontSize:"10px", color:"var(--muted)" }}>Henuz not yok.</p>
      )}
      <div style={{ display:"flex", flexDirection:"column", gap:"6px" }}>
        {notes.map((n) => (
          <div key={n.id} style={{ padding:"8px 10px", background:"var(--s2)", borderRadius:"7px", border:"1px solid var(--b2)" }}>
            <p style={{ fontSize:"12px", lineHeight:"1.5", color:"var(--txt)" }}>{n.text}</p>
            <p style={{ fontFamily:"var(--mono)", fontSize:"9px", color:"var(--muted)", marginTop:"4px" }}>
              {fmtTs(n.createdAt)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// FIX 12: module-level cache -- keyed by uid, cleared after 5 minutes
const _planDataCache = {};

// ============================================================================
// Weekly plan breakdown -- fetches raw yks_plan for a student
// ============================================================================
function WeeklyPlanBreakdown({ studentUid }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // FIX 12: use cache to avoid refetch on every modal open
    const cached = _planDataCache[studentUid];
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
      setData(cached.data);
      setLoading(false);
      return;
    }
    setLoading(true);
    counselorGetUserData(studentUid).then((d) => {
      _planDataCache[studentUid] = { data: d, ts: Date.now() };
      setData(d);
      setLoading(false);
    });
  }, [studentUid]);

  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - i * 86400000);
    return {
      date:  d.toISOString().slice(0, 10),
      label: d.toLocaleDateString("tr-TR", { weekday: "short", day: "numeric", month: "short" }),
    };
  }).reverse();

  if (loading) return (
    <p style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)", animation: "blink 1.5s ease infinite" }}>
      Yukleniyor...
    </p>
  );

  const plans = data?.data?.yks_plan || {};

  const totalStudyMin = last7.reduce((s, { date }) =>
    s + (plans[date] || [])
      .filter((x) => x.done)
      .reduce((a, x) => a + (x.actualMin || x.durationMin || 0), 0)
  , 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <Label>Son 7 Gun Calisma Detayi</Label>
        <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--acc)" }}>
          Toplam: {Math.floor(totalStudyMin / 60)}s {totalStudyMin % 60}dk
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {last7.map(({ date, label }) => {
          const items = plans[date] || [];
          const doneItems = items.filter((x) => x.done);
          const totalMin  = items.reduce((s, x) => s + (x.durationMin || 0), 0);
          const doneMin   = doneItems.reduce((s, x) => s + (x.actualMin || x.durationMin || 0), 0);
          const rate      = totalMin > 0 ? Math.round((doneMin / totalMin) * 100) : null;
          const isToday   = date === new Date().toISOString().slice(0, 10);

          return (
            <div key={date} style={{ padding: "9px 11px", background: "var(--s2)", borderRadius: "7px", border: `1px solid ${isToday ? "var(--acc)33" : "var(--b2)"}` }}>
              {/* Day header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: items.length > 0 ? "7px" : "0" }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: isToday ? "var(--acc)" : "var(--muted)" }}>
                  {label}{isToday ? " (bugun)" : ""}
                </span>
                {rate !== null ? (
                  <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: rate >= 70 ? "var(--grn)" : rate >= 40 ? "var(--acc)" : "var(--red)" }}>
                    {doneMin}dk / {totalMin}dk · %{rate}
                  </span>
                ) : (
                  <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)" }}>plan yok</span>
                )}
              </div>

              {/* Plan items */}
              {items.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                  {items.map((item, i) => {
                    const isEarly = item.done && item.actualMin != null && item.actualMin < item.durationMin;
                    const statusColor = !item.done ? "var(--muted)"
                      : isEarly ? "var(--ora)"
                      : "var(--grn)";
                    const statusIcon = !item.done ? "○" : isEarly ? "◑" : "●";

                    return (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 7px", background: "var(--s1)", borderRadius: "5px" }}>
                        <div style={{ display: "flex", gap: "7px", alignItems: "center", minWidth: 0 }}>
                          <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: statusColor, flexShrink: 0 }}>{statusIcon}</span>
                          <span style={{ fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: item.done ? "var(--txt)" : "var(--muted)" }}>
                            {item.subject}
                          </span>
                          {item.kind === "trial" && (
                            <span style={{ fontFamily: "var(--mono)", fontSize: "8px", color: "var(--blu)", background: "var(--blu)15", padding: "1px 5px", borderRadius: "3px", flexShrink: 0 }}>
                              {item.trialType || "TYT"}
                            </span>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: "5px", alignItems: "center", flexShrink: 0 }}>
                          {item.done && item.actualMin != null && item.actualMin !== item.durationMin ? (
                            <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: isEarly ? "var(--ora)" : "var(--grn)" }}>
                              {item.actualMin}dk / {item.durationMin}dk
                            </span>
                          ) : (
                            <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)" }}>
                              {item.durationMin}dk
                            </span>
                          )}
                          {isEarly && (
                            <span style={{ fontFamily: "var(--mono)", fontSize: "8px", color: "var(--ora)", background: "var(--ora)15", padding: "1px 5px", borderRadius: "3px" }}>
                              mola
                            </span>
                          )}
                          {item.lateStartMin > 0 && (
                            <span style={{ fontFamily: "var(--mono)", fontSize: "8px", color: "var(--red)", background: "var(--red)10", padding: "1px 5px", borderRadius: "3px" }}>
                              {item.lateStartMin}dk gec
                            </span>
                          )}
                          {item.sessionTopic?.feeling && (
                            <span style={{ fontFamily: "var(--mono)", fontSize: "8px", color: item.sessionTopic.feeling === "iyi" ? "var(--grn)" : item.sessionTopic.feeling === "zor" ? "var(--red)" : "var(--acc)", background: "var(--s2)", padding: "1px 5px", borderRadius: "3px" }}>
                              {item.sessionTopic.feeling}
                            </span>
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
// Student Detail Modal
// ============================================================================
function StudentDetailModal({ student, counselorUid, onClose }) {
  const risk = computeRisk(student);

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.82)", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:200, padding:0 }}
      onClick={onClose}>
      <div className="su"
        onClick={(e) => e.stopPropagation()}
        style={{ background:"var(--s1)", border:"1px solid var(--b1)", borderRadius:"14px 14px 0 0", padding:"20px", width:"100%", maxWidth:"580px", maxHeight:"88vh", overflowY:"auto" }}>

        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", gap:"12px", marginBottom:"16px" }}>
          {student.photoURL
            ? <img src={student.photoURL} alt="" style={{ width:"40px", height:"40px", borderRadius:"50%", flexShrink:0 }} />
            : <div style={{ width:"40px", height:"40px", borderRadius:"50%", background:"var(--b2)", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:"16px", fontWeight:"700" }}>{(student.displayName||"?")[0].toUpperCase()}</div>
          }
          <div style={{ flex:1, minWidth:0 }}>
            <p style={{ fontSize:"15px", fontWeight:"600" }}>{student.displayName || "Isimsiz"}</p>
            <p style={{ fontFamily:"var(--mono)", fontSize:"9px", color:"var(--muted)", marginTop:"1px" }}>{student.email}</p>
          </div>
          <RiskBadge level={risk.level} score={risk.score} />
          <button onClick={onClose} style={{ background:"none", color:"var(--muted)", fontSize:"20px", padding:"0 4px", flexShrink:0 }}>×</button>
        </div>

        {/* Stats grid */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:"7px", marginBottom:"14px" }}>
          {[
            { l:"XP",         v: student.xp           || 0,    c:"var(--pur)" },
            { l:"Streak",     v: `🔥 ${student.streak || 0}`,  c: student.streak > 0 ? "var(--acc)" : "var(--muted)" },
            { l:"Plan Uyumu", v: `%${risk.adherenceRate}`,      c: risk.adherenceRate >= 70 ? "var(--grn)" : risk.adherenceRate >= 40 ? "var(--acc)" : "var(--red)" },
            { l:"Deneme",     v: student.trialCount   || 0,    c:"var(--blu)" },
            { l:"Checkin",    v: student.checkinCount || 0,    c:"var(--grn)" },
            { l:"Haf. Gun",   v: student.weeklyActiveDays || 0, c:"var(--acc)" },
          ].map((x) => (
            <div key={x.l} style={{ padding:"9px", background:"var(--s2)", borderRadius:"7px", textAlign:"center" }}>
              <p style={{ fontFamily:"var(--mono)", fontSize:"17px", fontWeight:"700", color:x.c }}>{x.v}</p>
              <p style={{ fontSize:"9px", color:"var(--muted)", marginTop:"2px" }}>{x.l}</p>
            </div>
          ))}
        </div>

        {/* Plan bar */}
        <div style={{ marginBottom:"14px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"5px" }}>
            <Label>Plan Uyumu (7g)</Label>
            <span style={{ fontFamily:"var(--mono)", fontSize:"10px", color: risk.adherenceRate >= 70 ? "var(--grn)" : risk.adherenceRate >= 40 ? "var(--acc)" : "var(--red)" }}>%{risk.adherenceRate}</span>
          </div>
          <PBar value={risk.adherenceRate} max={100}
            color={risk.adherenceRate >= 70 ? "var(--grn)" : risk.adherenceRate >= 40 ? "var(--acc)" : "var(--red)"}
            h={6} />
        </div>

        {/* Last trial */}
        {student.lastTrialDate && (
          <div style={{ padding:"9px 11px", background:"var(--s2)", borderRadius:"7px", border:"1px solid var(--b2)", marginBottom:"14px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div>
              <Label style={{ marginBottom:"2px" }}>Son Deneme</Label>
              <p style={{ fontSize:"12px" }}>{fmtDate(student.lastTrialDate)}</p>
            </div>
            <div style={{ textAlign:"right" }}>
              <p style={{ fontFamily:"var(--mono)", fontSize:"20px", fontWeight:"700", color:"var(--acc)" }}>{student.lastTrialNet || 0}</p>
              <p style={{ fontSize:"9px", color:"var(--muted)" }}>net</p>
            </div>
          </div>
        )}

        {/* Last seen */}
        <div style={{ padding:"7px 10px", background:"var(--s2)", borderRadius:"7px", marginBottom:"14px", display:"flex", justifyContent:"space-between" }}>
          <span style={{ fontFamily:"var(--mono)", fontSize:"10px", color:"var(--muted)" }}>Son giris</span>
          <span style={{ fontFamily:"var(--mono)", fontSize:"10px", color:"var(--txt)" }}>{fmtTs(student.lastSeen)}</span>
        </div>

        {/* Risk flags with explanations */}
        {risk.flags.length > 0 && (
          <div style={{ marginBottom:"16px" }}>
            <Label style={{ marginBottom:"8px" }}>Risk Detayi</Label>
            <div style={{ display:"flex", flexDirection:"column", gap:"5px" }}>
              {risk.flags.map((f) => {
                const meta = FLAG_META[f] || { label:f, color:"var(--muted)", desc:"" };
                return (
                  <div key={f} style={{ padding:"8px 10px", background:`${meta.color}08`, borderRadius:"6px", border:`1px solid ${meta.color}22`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <div>
                      <p style={{ fontFamily:"var(--mono)", fontSize:"10px", color:meta.color, fontWeight:"600" }}>{meta.label}</p>
                      <p style={{ fontSize:"11px", color:"var(--muted)", marginTop:"2px" }}>{meta.desc}</p>
                    </div>
                    <span style={{ fontFamily:"var(--mono)", fontSize:"9px", color:meta.color, background:`${meta.color}18`, padding:"2px 7px", borderRadius:"4px", flexShrink:0 }}>+{RISK_WEIGHTS[f] || 0}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Weekly plan breakdown */}
        <div style={{ borderTop:"1px solid var(--b1)", paddingTop:"14px", marginBottom:"4px" }}>
          <WeeklyPlanBreakdown studentUid={student.uid} />
        </div>

        {/* Counselor notes */}
        <div style={{ borderTop:"1px solid var(--b1)", paddingTop:"14px" }}>
          <CounselorNotes studentUid={student.uid} counselorUid={counselorUid} />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main CounselorDashboard
// ============================================================================
export default function CounselorDashboard({ profile, user, onSignOut, onSwitchToStudent, onOpenAssign }) {
  const [students,  setStudents]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [selected,  setSelected]  = useState(null);
  const [filter,    setFilter]    = useState("all"); // all | high | mid | low

  const institutionId = profile?.institutionId;
  const groupId       = profile?.groupId;
  const role          = profile?.role;

  useEffect(() => {
    if (!institutionId) { setLoading(false); return; }
    getGroupStudents(institutionId, role === "institution_admin" ? null : groupId)
      .then((data) => { setStudents(data); setLoading(false); });
  }, [institutionId, groupId, role]);

  const withRisk = useMemo(() =>
    students.map((s) => ({ ...s, _risk: computeRisk(s) })),
    [students]
  );

  const counts = useMemo(() => ({
    high: withRisk.filter((s) => s._risk.level === "high").length,
    mid:  withRisk.filter((s) => s._risk.level === "mid").length,
    low:  withRisk.filter((s) => s._risk.level === "low").length,
  }), [withRisk]);

  const sorted = useMemo(() => {
    const list = filter === "all" ? withRisk : withRisk.filter((s) => s._risk.level === filter);
    return [...list].sort((a, b) => {
      if (b._risk.score !== a._risk.score) return b._risk.score - a._risk.score;
      return a._risk.adherenceRate - b._risk.adherenceRate;
    });
  }, [withRisk, filter]);

  return (
    <div style={{ minHeight:"100vh", background:"var(--bg)", fontFamily:"var(--sans)", display:"flex", justifyContent:"center", padding:"24px 12px 80px" }}>
      <style>{CSS}</style>
      <div style={{ width:"100%", maxWidth:"600px" }}>

        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:"20px" }}>
          <div>
            <p style={{ fontFamily:"var(--mono)", fontSize:"10px", color:"var(--muted)", letterSpacing:"2px", marginBottom:"4px" }}>
              {role === "institution_admin" ? "KURUM YONETICISI" : role === "super_admin" ? "SUPER ADMIN" : "REHBERLIKCI"}
            </p>
            <h1 style={{ fontFamily:"var(--mono)", fontSize:"18px", fontWeight:"700", color:"var(--acc)" }}>Ogrenci Paneli</h1>
            {user?.displayName && <p style={{ fontSize:"11px", color:"var(--muted)", marginTop:"3px" }}>{user.displayName}</p>}
          </div>
          <div style={{ display:"flex", gap:"5px", flexDirection:"column", alignItems:"flex-end" }}>
            <button onClick={onSignOut} style={{ fontFamily:"var(--mono)", fontSize:"9px", color:"var(--muted)", background:"none", border:"1px solid var(--b2)", borderRadius:"5px", padding:"5px 10px", cursor:"pointer" }}>Cikis</button>
            {onSwitchToStudent && (
              <button onClick={onSwitchToStudent} style={{ fontFamily:"var(--mono)", fontSize:"9px", color:"var(--acc)", background:"var(--acc)10", border:"1px solid var(--acc)33", borderRadius:"5px", padding:"5px 10px", cursor:"pointer" }}>Ogrenci Modu</button>
            )}
            {onOpenAssign && (
              <button onClick={onOpenAssign} style={{ fontFamily:"var(--mono)", fontSize:"9px", color:"var(--pur)", background:"var(--pur)10", border:"1px solid var(--pur)33", borderRadius:"5px", padding:"5px 10px", cursor:"pointer" }}>Kullanici Atama</button>
            )}
          </div>
        </div>

        {/* No institution */}
        {!institutionId && !loading && (
          <div style={{ textAlign:"center", padding:"60px 20px" }}>
            <p style={{ fontFamily:"var(--mono)", fontSize:"24px", color:"var(--b2)", marginBottom:"12px" }}>◈</p>
            <p style={{ fontSize:"13px", color:"var(--muted)", marginBottom:"6px" }}>Kuruma atanmamissiniz</p>
            <p style={{ fontSize:"11px", color:"var(--b2)", lineHeight:"1.6", maxWidth:"220px", margin:"0 auto" }}>Kurum yoneticisinden kuruma eklemenizi isteyin.</p>
          </div>
        )}

        {loading && (
          <p style={{ fontFamily:"var(--mono)", fontSize:"11px", color:"var(--muted)", textAlign:"center", padding:"40px", animation:"blink 1.5s ease infinite" }}>Yukleniyor...</p>
        )}

        {!loading && institutionId && (
          <>
            {/* Risk summary bar */}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:"7px", marginBottom:"16px" }}>
              {[
                { key:"high", label:"Riskli", color:"var(--red)" },
                { key:"mid",  label:"Dikkat", color:"var(--ora)" },
                { key:"low",  label:"Iyi",    color:"var(--grn)" },
              ].map((x) => (
                <button key={x.key} onClick={() => setFilter(filter === x.key ? "all" : x.key)}
                  style={{ padding:"10px 8px", borderRadius:"8px", textAlign:"center", cursor:"pointer", background: filter === x.key ? `${x.color}18` : "var(--s1)", border:`1px solid ${filter === x.key ? x.color : "var(--b1)"}`, transition:"all .15s" }}>
                  <p style={{ fontFamily:"var(--mono)", fontSize:"20px", fontWeight:"700", color:x.color, lineHeight:1 }}>{counts[x.key]}</p>
                  <p style={{ fontSize:"9px", color:"var(--muted)", marginTop:"3px" }}>{x.label}</p>
                </button>
              ))}
            </div>

            {/* List header */}
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"10px" }}>
              <Label>
                {filter === "all" ? `Tum ogrenciler (${students.length})` : `${RISK_LABEL[filter]} (${counts[filter]})`}
              </Label>
              {filter !== "all" && (
                <button onClick={() => setFilter("all")} style={{ fontFamily:"var(--mono)", fontSize:"9px", color:"var(--muted)", background:"none", border:"none", cursor:"pointer" }}>
                  Tumunu goster
                </button>
              )}
            </div>

            {/* Empty */}
            {sorted.length === 0 && (
              <div style={{ textAlign:"center", padding:"50px 20px" }}>
                <p style={{ fontFamily:"var(--mono)", fontSize:"22px", color:"var(--b2)", marginBottom:"10px" }}>◻</p>
                <p style={{ fontSize:"12px", color:"var(--muted)" }}>
                  {students.length === 0
                    ? "Henuz ogrenci yok. Ogrencilerin kuruma katilmasi gerekiyor."
                    : "Bu filtrede ogrenci yok."}
                </p>
              </div>
            )}

            {/* Student cards */}
            <div style={{ display:"flex", flexDirection:"column", gap:"8px" }}>
              {sorted.map((s) => (
                <StudentCard key={s.uid} student={s} onClick={() => setSelected(s)} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Student detail modal */}
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
