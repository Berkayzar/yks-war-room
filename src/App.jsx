import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ============================================================================
// Storage (preserve keys; allow only yks_challenge new)
// ============================================================================
const KEYS = {
  trials: "yks_trials",
  todos: "yks_todos",
  dw: "yks_dw",
  plan: "yks_plan",
  attn: "yks_attn",
  checkins: "yks_checkins",
  xp: "yks_xp",
  brain: "yks_brain",
  challenge: "yks_challenge",
};

const store = {
  load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
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
const fmtDate = (iso) => new Date(iso).toLocaleDateString("tr-TR", { day: "2-digit", month: "short" });
const nowMin = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};
const fmtHHMM = (m) => {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h > 0) return `${h}s${r ? ` ${r}dk` : ""}`;
  return r ? `${r}dk` : "0dk";
};
const calcNet = (d, y) => Math.max(0, parseFloat(d || 0) - parseFloat(y || 0) / 4);

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
    const beep = (freq, t, dur) => {
      const o = ctx.createOscillator();
      o.connect(g);
      o.frequency.value = freq;
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + dur);
    };
    if (type === "start") {
      g.gain.setValueAtTime(0.25, ctx.currentTime);
      beep(880, 0, 0.12);
      beep(1100, 0.12, 0.12);
    } else if (type === "done") {
      g.gain.setValueAtTime(0.22, ctx.currentTime);
      beep(660, 0, 0.12);
      beep(880, 0.15, 0.12);
      beep(1100, 0.3, 0.12);
    } else if (type === "warn") {
      g.gain.setValueAtTime(0.28, ctx.currentTime);
      beep(300, 0, 0.2);
    }
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
  } catch {
    // ignore
  }
}

// ============================================================================
// XP / badges
// ============================================================================
const XP_R = { block_done: 50, trial_added: 30, todo_done: 15, checkin_4: 100, checkin_3: 60, plan_done: 80, challenge_done: 120 };
const BADGES = [
  { id: "first_block", label: "Ilk Blok", icon: "▶", req: (x) => x.totalBlocks >= 1 },
  { id: "week_streak", label: "7 Gun Seri", icon: "🔥", req: (x) => x.streak >= 7 },
  { id: "trial_ace", label: "Deneme Ustu", icon: "◉", req: (x) => x.totalTrials >= 5 },
  { id: "discipline", label: "Demir Irade", icon: "◆", req: (x) => x.perfect4 >= 3 },
  { id: "planner", label: "Planci", icon: "▦", req: (x) => x.plansDone >= 7 },
  { id: "challenger", label: "Challenger", icon: "✦", req: (x) => (x.challengesDone || 0) >= 7 },
];
const loadXP = () =>
  store.load(KEYS.xp, { points: 0, streak: 0, totalBlocks: 0, totalTrials: 0, perfect4: 0, plansDone: 0, challengesDone: 0, badges: [], lastDate: "" });
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
  BADGES.forEach((b) => {
    if (!xp.badges.includes(b.id) && b.req(xp)) xp.badges.push(b.id);
  });
  store.save(KEYS.xp, xp);
  return { pts, xp };
}

// ============================================================================
// Attention
// ============================================================================
const BREAK_REASONS = ["Dikkat dagildi", "Yorgun hissettim", "Telefon", "Su/Yiyecek", "Tuvalet", "Planli mola", "Diger"];
function calcAttentionScore(breaks) {
  if (!breaks?.length) return 100;
  const early = breaks.filter((b) => b.type === "early").length;
  const ratio = early / breaks.length;
  const avgBlock = breaks.reduce((s, b) => s + (b.blockMin || 0), 0) / breaks.length;
  return Math.round(clamp(100 - ratio * 40 - Math.max(0, 60 - avgBlock) * 0.5, 0, 100));
}

// ============================================================================
// Trials analysis -> weekly plan
// ============================================================================
const TYT_SUBS = ["Turkce", "Matematik", "Fizik", "Kimya", "Biyoloji", "Tarih", "Cografya", "Felsefe", "Din"];
const AYT_SUBS = ["Matematik", "Fizik", "Kimya", "Biyoloji", "Edebiyat", "Tarih", "Cografya", "Felsefe"];
function buildSubjectWeakness(trials) {
  const map = {};
  trials.forEach((t) => (t.nets || []).forEach((n) => {
    if (!map[n.subject]) map[n.subject] = { sum: 0, count: 0, target: n.target || 0 };
    map[n.subject].sum += n.net;
    map[n.subject].count++;
    if (n.target > 0) map[n.subject].target = n.target;
  }));
  return Object.entries(map)
    .map(([subject, d]) => ({ subject, avg: d.count ? d.sum / d.count : 0, target: d.target, gap: d.target ? d.target - d.sum / d.count : 0 }))
    .sort((a, b) => (b.gap || 0) - (a.gap || 0));
}
function buildWeeklyPlan(trials, goalHoursPerDay = 4) {
  const weak = buildSubjectWeakness(trials);
  if (!weak.length) return [];
  const totalWeight = weak.reduce((s, w) => s + Math.max(0.5, (w.gap || 0) + 1), 0);
  const dayMins = goalHoursPerDay * 60;
  return weak
    .map((w) => ({
      subject: w.subject,
      dailyMin: Math.round((Math.max(0.5, (w.gap || 0) + 1) / totalWeight) * dayMins),
      avg: Math.round(w.avg * 10) / 10,
      gap: Math.round((w.gap || 0) * 10) / 10,
      priority: (w.gap || 0) > 2 ? "high" : (w.gap || 0) > 0 ? "medium" : "low",
    }))
    .filter((w) => w.dailyMin >= 10);
}

// ============================================================================
// UI
// ============================================================================
const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#060606;--s1:#0e0e0e;--s2:#151515;--b1:#1e1e1e;--b2:#282828;--txt:#e6e6e6;--muted:#4a4a4a;--acc:#e8c547;--red:#e05252;--grn:#4caf7d;--blu:#5b9cf6;--pur:#a78bfa;--mono:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;--sans:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif}
html,body{background:var(--bg);color:var(--txt);font-family:var(--sans)}
button{cursor:pointer;border:none}
input,textarea,select{font-family:var(--sans);background:var(--s2);border:1px solid var(--b2);color:var(--txt);border-radius:8px}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
@keyframes pop{0%{transform:scale(.92);opacity:0}100%{transform:scale(1);opacity:1}}
.pop{animation:pop .16s ease both}
`;

const Card = ({ children, style }) => (
  <div style={{ background: "var(--s1)", border: "1px solid var(--b1)", borderRadius: 12, padding: 14, ...style }}>
    {children}
  </div>
);
const Label = ({ children }) => (
  <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: 1.4, color: "var(--muted)", textTransform: "uppercase" }}>
    {children}
  </div>
);
const Tag = ({ children, color = "var(--acc)" }) => (
  <span style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 6, background: `${color}18`, color }}>
    {children}
  </span>
);
const Btn = ({ children, onClick, variant = "default", disabled, style }) => {
  const map = {
    default: { background: "var(--s2)", color: "var(--txt)", border: "1px solid var(--b2)" },
    primary: { background: "var(--acc)", color: "#000", fontWeight: 700 },
    ghost: { background: "transparent", color: "var(--muted)", border: "1px solid var(--b2)" },
    danger: { background: "transparent", color: "var(--red)", border: "1px solid var(--red)44" },
    success: { background: "transparent", color: "var(--grn)", border: "1px solid var(--grn)44" },
    accent: { background: "var(--acc)18", color: "var(--acc)", border: "1px solid var(--acc)33" },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{ padding: "8px 12px", borderRadius: 10, opacity: disabled ? 0.45 : 1, ...map[variant], ...style }}>
      {children}
    </button>
  );
};

function YKSCountdown() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 60000);
    return () => clearInterval(id);
  }, []);
  const { days, hours, passed } = yksCountdown();
  if (passed) return <Tag color="var(--grn)">YKS GECTI</Tag>;
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ fontFamily: "var(--mono)", fontWeight: 800, color: "var(--red)", animation: "blink 1.5s ease infinite" }}>{days}G</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>{hours}s</span>
    </div>
  );
}

// ============================================================================
// Todos helpers
// ============================================================================
function pushTodos(setTodos, items) {
  const now = new Date().toISOString();
  const mapped = (items || [])
    .map((i) => ({
      id: uid(),
      text: String(i.text || "").trim(),
      source: i.source || "Import",
      priority: i.priority || "medium",
      done: false,
      reviewed: false,
      createdAt: now,
      reviewAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      meta: i.meta || {},
    }))
    .filter((x) => x.text);
  if (!mapped.length) return;
  setTodos((prev) => {
    const next = [...mapped, ...prev];
    store.save(KEYS.todos, next);
    return next;
  });
}

// ============================================================================
// Trials tab
// ============================================================================
function TrialsTab({ trials, setTrials, onPushTodos }) {
  const [adding, setAdding] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const weekPlan = useMemo(() => buildWeeklyPlan(trials, 4), [trials]);

  const saveTrial = (t) => {
    const next = [t, ...trials];
    setTrials(next);
    store.save(KEYS.trials, next);
    grantXP("trial_added");
    toast(`Deneme kaydedildi: ${t.totalNet} net`, "var(--blu)");
    if (t.todos?.length) {
      onPushTodos(
        t.todos.map((text) => ({
          text,
          source: `${t.type} (${fmtDate(t.date)})`,
          priority: "high",
          meta: { kind: "trial", trialId: t.id, trialType: t.type, trialDate: t.date },
        })),
      );
    }
    setAdding(false);
  };

  const delTrial = (id) => {
    const next = trials.filter((t) => t.id !== id);
    setTrials(next);
    store.save(KEYS.trials, next);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {weekPlan.length > 0 && (
        <div>
          <button onClick={() => setShowPlan((p) => !p)} style={{ background: "transparent", border: "none", color: "var(--acc)", fontSize: 12 }}>
            {showPlan ? "Haftalik plan gizle" : "Haftalik plan optimizasyonu goster"}
          </button>
          {showPlan && (
            <Card className="pop" style={{ marginTop: 8 }}>
              <Label>Haftalik Oneri</Label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                {weekPlan.map((w) => (
                  <div key={w.subject} style={{ display: "flex", justifyContent: "space-between", background: "var(--s2)", border: "1px solid var(--b2)", padding: "8px 10px", borderRadius: 10 }}>
                    <span>{w.subject}</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: w.gap > 0 ? "var(--red)" : "var(--grn)" }}>
                      {fmtHHMM(w.dailyMin)}/gun · {w.avg} ort
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {adding ? (
        <Card>
          <TrialForm onSave={saveTrial} onCancel={() => setAdding(false)} />
        </Card>
      ) : (
        <Btn variant="primary" onClick={() => setAdding(true)} style={{ width: "100%" }}>
          + Deneme Ekle
        </Btn>
      )}

      {trials.length === 0 && !adding && <Empty icon="◉" title="Henuz deneme yok" desc="Ilk denemeyi ekle ve analiz et." />}
      {!adding &&
        trials.map((t) => (
          <TrialCard key={t.id} trial={t} onDelete={() => delTrial(t.id)} onPushTodos={onPushTodos} />
        ))}
    </div>
  );
}

function TrialForm({ onSave, onCancel }) {
  const [date, setDate] = useState(todayStr());
  const [type, setType] = useState("TYT");
  const [nets, setNets] = useState({});
  const [targets, setTargets] = useState({});
  const [analysis, setAnalysis] = useState("");
  const [todoText, setTodoText] = useState("");
  const subs = type === "TYT" ? TYT_SUBS : AYT_SUBS;

  const totalNet = subs.reduce((s, sub) => s + calcNet(nets[sub]?.d, nets[sub]?.y), 0);
  const setN = (sub, f, v) => setNets((p) => ({ ...p, [sub]: { ...(p[sub] || {}), [f]: v } }));

  const submit = () => {
    const list = subs
      .map((s) => ({
        subject: s,
        correct: Number(nets[s]?.d || 0),
        wrong: Number(nets[s]?.y || 0),
        net: calcNet(nets[s]?.d, nets[s]?.y),
        target: Number(targets[s] || 0),
      }))
      .filter((n) => n.correct > 0 || n.wrong > 0);
    if (!list.length) return alert("En az bir ders gir.");
    onSave({
      id: uid(),
      date,
      type,
      nets: list,
      totalNet: Math.round(totalNet * 10) / 10,
      errorAnalysis: analysis,
      todos: todoText.split("\n").map((x) => x.trim()).filter(Boolean),
      createdAt: new Date().toISOString(),
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <Label>Tarih</Label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: "100%", padding: "8px 10px", marginTop: 6 }} />
        </div>
        <div style={{ flex: 1 }}>
          <Label>Tur</Label>
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: "100%", padding: "8px 10px", marginTop: 6 }}>
            <option>TYT</option>
            <option>AYT</option>
          </select>
        </div>
        <div style={{ textAlign: "right", paddingTop: 18 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 18, fontWeight: 800, color: "var(--acc)" }}>{totalNet.toFixed(1)}</div>
          <div style={{ fontSize: 10, color: "var(--muted)" }}>net</div>
        </div>
      </div>

      <div>
        <Label>Netler D/Y + Hedef</Label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 6, marginTop: 8 }}>
          {subs.map((s) => {
            const net = calcNet(nets[s]?.d, nets[s]?.y);
            const tgt = Number(targets[s] || 0);
            const miss = tgt > 0 && net < tgt;
            return (
              <div key={s} style={{ background: "var(--s2)", border: `1px solid ${miss ? "var(--red)33" : "var(--b2)"}`, borderRadius: 10, padding: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 12 }}>{s}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: miss ? "var(--red)" : "var(--acc)" }}>{net.toFixed(1)}</span>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <input type="number" placeholder="D" value={nets[s]?.d || ""} onChange={(e) => setN(s, "d", e.target.value)} style={{ flex: 1, padding: "6px 8px" }} />
                  <input type="number" placeholder="Y" value={nets[s]?.y || ""} onChange={(e) => setN(s, "y", e.target.value)} style={{ flex: 1, padding: "6px 8px" }} />
                  <input type="number" placeholder="H" value={targets[s] || ""} onChange={(e) => setTargets((p) => ({ ...p, [s]: e.target.value }))} style={{ flex: 1, padding: "6px 8px" }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <Label>Hata Analizi</Label>
        <textarea value={analysis} onChange={(e) => setAnalysis(e.target.value)} rows={3} style={{ width: "100%", padding: "8px 10px", marginTop: 6, resize: "vertical" }} />
      </div>
      <div>
        <Label>Yapilacaklar (satir satir)</Label>
        <textarea value={todoText} onChange={(e) => setTodoText(e.target.value)} rows={2} style={{ width: "100%", padding: "8px 10px", marginTop: 6, resize: "vertical" }} />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Btn variant="ghost" onClick={onCancel}>
          Iptal
        </Btn>
        <Btn variant="primary" onClick={submit}>
          Kaydet
        </Btn>
      </div>
    </div>
  );
}

function TrialCard({ trial, onDelete, onPushTodos }) {
  const [open, setOpen] = useState(false);
  const top = [...trial.nets].sort((a, b) => b.net - a.net).slice(0, 3);
  const weak = [...trial.nets].sort((a, b) => a.net - b.net).slice(0, 2);
  const maxN = Math.max(...trial.nets.map((n) => n.net), 1);

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div onClick={() => setOpen((p) => !p)} style={{ padding: "10px 12px", display: "flex", justifyContent: "space-between", cursor: "pointer", background: open ? "var(--s2)" : "transparent" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Tag color={trial.type === "TYT" ? "var(--blu)" : "var(--acc)"}>{trial.type}</Tag>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>{fmtDate(trial.date)}</span>
          <span style={{ fontFamily: "var(--mono)", fontWeight: 900, color: "var(--acc)" }}>{trial.totalNet}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {trial.todos?.length > 0 && <Tag color="var(--red)">{trial.todos.length} gorev</Tag>}
          <span style={{ fontSize: 11, color: "var(--muted)" }}>{open ? "▲" : "▼"}</span>
        </div>
      </div>
      {open && (
        <div className="pop" style={{ padding: 12, borderTop: "1px solid var(--b1)", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <Label>Ders Dagilimi</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
              {trial.nets.map((n) => {
                const hit = n.target > 0 && n.net >= n.target;
                const miss = n.target > 0 && n.net < n.target;
                const c = hit ? "var(--grn)" : miss ? "var(--red)" : "var(--acc)";
                return (
                  <div key={n.subject}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>{n.subject}</span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: c }}>
                        {n.net.toFixed(1)}{n.target ? `/${n.target}` : ""}
                      </span>
                    </div>
                    <div style={{ height: 4, background: "var(--b2)", borderRadius: 999 }}>
                      <div style={{ height: "100%", width: `${(n.net / maxN) * 100}%`, background: c, borderRadius: 999 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Card style={{ background: "var(--s2)", border: "1px solid var(--grn)22" }}>
              <Label>En Guclu</Label>
              <div style={{ marginTop: 8 }}>
                {top.map((n) => (
                  <div key={n.subject} style={{ fontSize: 12 }}>
                    {n.subject} <span style={{ fontFamily: "var(--mono)", color: "var(--grn)" }}>{n.net.toFixed(1)}</span>
                  </div>
                ))}
              </div>
            </Card>
            <Card style={{ background: "var(--s2)", border: "1px solid var(--red)22" }}>
              <Label>En Zayif</Label>
              <div style={{ marginTop: 8 }}>
                {weak.map((n) => (
                  <div key={n.subject} style={{ fontSize: 12 }}>
                    {n.subject} <span style={{ fontFamily: "var(--mono)", color: "var(--red)" }}>{n.net.toFixed(1)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {trial.errorAnalysis && (
            <div>
              <Label>Hata Analizi</Label>
              <div style={{ marginTop: 8, whiteSpace: "pre-wrap", color: "var(--muted)", fontSize: 12, lineHeight: 1.6 }}>{trial.errorAnalysis}</div>
            </div>
          )}

          {trial.todos?.length > 0 && (
            <div>
              <Label>Yapilacaklar</Label>
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                {trial.todos.map((t, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, background: "var(--s2)", border: "1px solid var(--b2)", padding: "8px 10px", borderRadius: 10 }}>
                    <span style={{ color: "var(--acc)" }}>→</span>
                    <span style={{ fontSize: 12 }}>{t}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <Btn
                  variant="accent"
                  onClick={() => {
                    onPushTodos(
                      trial.todos.map((text) => ({
                        text,
                        source: `${trial.type} (${fmtDate(trial.date)})`,
                        priority: "high",
                        meta: { kind: "trial", trialId: trial.id, trialType: trial.type, trialDate: trial.date },
                      })),
                    );
                    toast("Gorevlere akti", "var(--grn)");
                  }}
                >
                  Gorevlere aktar
                </Btn>
              </div>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn variant="danger" onClick={onDelete}>
              Sil
            </Btn>
          </div>
        </div>
      )}
    </Card>
  );
}

// ============================================================================
// BrainDump tab: dump->todo + deepwork blocks + plan + timer + delay reason + attn breaks
// ============================================================================
const DW_DEFAULT = { sessions: [], goalMin: 180 };
const QUOTES = ["1 blok bile fark yaratir.", "Basladinsa kapat.", "Disiplin > motivasyon.", "Telefonu odadan cikar."];
const quote = () => QUOTES[Math.floor(Math.random() * QUOTES.length)];

function buildBlocks(goalMin) {
  const blocks = [];
  let rem = goalMin;
  while (rem >= 30) {
    const dur = clamp(rem, 60, 90);
    blocks.push({ id: uid(), dur });
    rem -= dur + (rem - dur >= 30 ? 15 : 0);
  }
  return blocks;
}

function BrainDumpTab({ trials, todos, onPushTodos }) {
  const today = todayStr();
  const [brain, setBrain] = useState(() => store.load(KEYS.brain, {}));
  const [dw, setDw] = useState(() => store.load(KEYS.dw, DW_DEFAULT));
  const [attn, setAttn] = useState(() => store.load(KEYS.attn, {}));
  const [plans, setPlans] = useState(() => store.load(KEYS.plan, {}));

  const saveBrain = (next) => (setBrain(next), store.save(KEYS.brain, next));
  const saveDW = (next) => (setDw(next), store.save(KEYS.dw, next));
  const saveAttn = (next) => (setAttn(next), store.save(KEYS.attn, next));
  const savePlans = (next) => (setPlans(next), store.save(KEYS.plan, next));

  const brainText = brain?.[today]?.text || "";
  const weeklyRec = useMemo(() => buildWeeklyPlan(trials, 4), [trials]);

  const moveDumpToTodos = () => {
    const lines = brainText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    onPushTodos(lines.map((text) => ({ text, source: `BrainDump (${fmtDate(today)})`, priority: "medium", meta: { kind: "brain", date: today } })));
    saveBrain({ ...(brain || {}), [today]: { text: "", updatedAt: new Date().toISOString() } });
    toast(`${lines.length} madde gorevlere akti`, "var(--grn)");
  };

  // Deep work state
  const goalMin = dw.goalMin ?? 180;
  const blocks = useMemo(() => buildBlocks(goalMin), [goalMin]);
  const sess = dw.sessions.find((s) => s.date === today);
  const doneBlocks = sess?.blocks || [];
  const nextIdx = doneBlocks.length;
  const completedMin = doneBlocks.reduce((s, b) => s + b.dur, 0);

  // attention
  const todayBreaks = attn[today]?.breaks || [];
  const attnScore = useMemo(() => calcAttentionScore(todayBreaks), [todayBreaks]);

  const onBlockDone = (dur, early, breakData) => {
    const nb = { id: uid(), dur, early, at: new Date().toISOString() };
    const prev = dw.sessions.find((s) => s.date === today);
    const upd = prev
      ? { ...prev, goalMin, blocks: [...(prev.blocks || []), nb], completedMin: (prev.completedMin || 0) + dur, earlyBreaks: (prev.earlyBreaks || 0) + (early ? 1 : 0) }
      : { date: today, goalMin, blocks: [nb], completedMin: dur, earlyBreaks: early ? 1 : 0 };
    saveDW({ ...dw, sessions: [upd, ...dw.sessions.filter((s) => s.date !== today)] });
    if (breakData) {
      const prevA = attn[today] || { breaks: [] };
      saveAttn({ ...attn, [today]: { ...prevA, breaks: [...prevA.breaks, breakData] } });
    }
    grantXP("block_done");
    playSound("done");
    toast(`+${XP_R.block_done} XP`, "var(--grn)");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card>
        <Label>Brain Dump</Label>
        <textarea value={brainText} onChange={(e) => saveBrain({ ...(brain || {}), [today]: { text: e.target.value, updatedAt: new Date().toISOString() } })} rows={4} placeholder="Her satir bir gorev olabilir..." style={{ width: "100%", padding: "10px 12px", marginTop: 8, resize: "vertical" }} />
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <Btn variant="accent" disabled={!brainText.trim()} onClick={moveDumpToTodos} style={{ flex: 2 }}>
            Goreve cevir
          </Btn>
          <Btn variant="ghost" disabled={!brainText.trim()} onClick={() => saveBrain({ ...(brain || {}), [today]: { text: "", updatedAt: new Date().toISOString() } })} style={{ flex: 1 }}>
            Temizle
          </Btn>
        </div>
        {weeklyRec.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <Label>Bugun onerilen dersler</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
              {weeklyRec.slice(0, 4).map((w) => (
                <div key={w.subject} style={{ display: "flex", justifyContent: "space-between", background: "var(--s2)", border: "1px solid var(--b2)", padding: "8px 10px", borderRadius: 10 }}>
                  <span style={{ fontSize: 12 }}>{w.subject}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: w.priority === "high" ? "var(--red)" : w.priority === "medium" ? "var(--acc)" : "var(--grn)" }}>{fmtHHMM(w.dailyMin)}/gun</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <Label>Deep Work</Label>
            <div style={{ fontFamily: "var(--mono)", fontSize: 20, fontWeight: 900, color: "var(--acc)", marginTop: 6 }}>{fmtHHMM(goalMin)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--muted)" }}>{fmtHHMM(completedMin)}/{fmtHHMM(goalMin)}</div>
            <div style={{ fontSize: 11, color: attnScore < 60 ? "var(--red)" : "var(--muted)" }}>Dikkat: {attnScore}/100</div>
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {blocks.map((b, i) => {
            const done = i < doneBlocks.length;
            const active = i === nextIdx;
            return (
              <div key={b.id} style={{ padding: "6px 9px", borderRadius: 10, fontFamily: "var(--mono)", fontSize: 11, background: done ? "var(--grn)18" : active ? "var(--acc)18" : "var(--s2)", border: `1px solid ${done ? "var(--grn)55" : active ? "var(--acc)55" : "var(--b2)"}`, color: done ? "var(--grn)" : active ? "var(--acc)" : "var(--muted)" }}>
                {done ? "✓" : active ? "▶" : i + 1} {b.dur}dk
              </div>
            );
          })}
        </div>
        {nextIdx < blocks.length ? (
          <BlockTimer block={blocks[nextIdx]} onDone={onBlockDone} />
        ) : (
          <div className="pop" style={{ marginTop: 10, padding: 10, borderRadius: 10, background: "var(--grn)08", border: "1px solid var(--grn)33", textAlign: "center" }}>
            <div style={{ fontFamily: "var(--mono)", fontWeight: 900, color: "var(--grn)" }}>HEDEF TAMAM</div>
          </div>
        )}
      </Card>

      <DailyPlanTab plans={plans} savePlans={savePlans} />

      <Card>
        <Label>Hizli Gorev</Label>
        <QuickTodoAdd todos={todos} onPushTodos={onPushTodos} />
      </Card>
    </div>
  );
}

function BlockTimer({ block, onDone }) {
  const TOTAL = block.dur * 60;
  const [phase, setPhase] = useState("idle");
  const [elapsed, setElapsed] = useState(0);
  const [q, setQ] = useState(quote);
  const [breakReason, setBreakReason] = useState("");
  const itv = useRef(null);

  const start = useCallback(() => {
    setPhase("run");
    playSound("start");
    itv.current = setInterval(() => setElapsed((p) => p + 1), 1000);
  }, []);
  const stop = useCallback(() => clearInterval(itv.current), []);
  useEffect(() => () => stop(), [stop]);
  useEffect(() => {
    if (phase === "run" && elapsed > 0 && elapsed % (15 * 60) === 0) setQ(quote());
    if (phase === "run" && elapsed >= TOTAL) {
      stop();
      setPhase("done");
      onDone(block.dur, false, null);
    }
  }, [elapsed, phase, TOTAL, stop, onDone, block.dur]);

  const rem = Math.max(0, TOTAL - elapsed);
  const elMin = Math.floor(elapsed / 60);

  if (phase === "idle")
    return (
      <div style={{ marginTop: 10 }}>
        <Btn variant="primary" onClick={start} style={{ width: "100%" }}>
          Blok baslat
        </Btn>
      </div>
    );

  if (phase === "warn")
    return (
      <div className="pop" style={{ marginTop: 10, padding: 12, borderRadius: 12, background: "var(--red)06", border: "1px solid var(--red)44" }}>
        <Label>Erken mola</Label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {BREAK_REASONS.map((r) => (
            <button key={r} onClick={() => setBreakReason(r)} style={{ padding: "6px 10px", borderRadius: 999, border: `1px solid ${breakReason === r ? "var(--acc)" : "var(--b2)"}`, background: breakReason === r ? "var(--acc)18" : "transparent", color: breakReason === r ? "var(--acc)" : "var(--muted)", fontSize: 12 }}>
              {r}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <Btn variant="primary" style={{ flex: 2 }} onClick={() => (setPhase("run"), start())}>
            Devam
          </Btn>
          <Btn variant="danger" style={{ flex: 1 }} disabled={!breakReason} onClick={() => (setPhase("done"), onDone(elMin, true, { type: "early", blockMin: elMin, reason: breakReason, at: new Date().toISOString() }))}>
            Mola
          </Btn>
        </div>
      </div>
    );

  if (phase === "done") return null;

  return (
    <div className="pop" style={{ marginTop: 10, padding: 12, borderRadius: 12, background: "var(--s2)", border: "1px solid var(--b2)" }}>
      <Label>Odak modu</Label>
      <div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 900, marginTop: 6 }}>{String(Math.floor(rem / 60)).padStart(2, "0")}:{String(rem % 60).padStart(2, "0")}</div>
      <div style={{ marginTop: 6, fontSize: 12, color: "var(--muted)", fontStyle: "italic" }}>"{q}"</div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Btn variant="ghost" onClick={() => (stop(), setPhase("warn"), playSound("warn"))} style={{ flex: 1 }}>
          Mola iste
        </Btn>
        <Btn variant="success" onClick={() => (stop(), setPhase("done"), onDone(elMin, false, null))} style={{ flex: 1 }}>
          Bitir
        </Btn>
      </div>
    </div>
  );
}

function QuickTodoAdd({ todos, onPushTodos }) {
  const [text, setText] = useState("");
  const add = () => {
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    onPushTodos(lines.map((t) => ({ text: t, source: `BrainDump Quick (${fmtDate(todayStr())})`, priority: "medium", meta: { kind: "brain_quick", date: todayStr() } })));
    setText("");
    toast(`${lines.length} gorev eklendi`, "var(--grn)");
  };
  return (
    <div style={{ marginTop: 8 }}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Her satir bir gorev..." style={{ width: "100%", padding: "8px 10px", resize: "vertical" }} />
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <Btn variant="primary" onClick={add} disabled={!text.trim()} style={{ flex: 2 }}>
          Gorev ekle
        </Btn>
        <Btn variant="ghost" onClick={() => setText("")} disabled={!text.trim()} style={{ flex: 1 }}>
          Temizle
        </Btn>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
        Aktif gorev: <span style={{ fontFamily: "var(--mono)", color: "var(--acc)" }}>{todos.filter((t) => !t.done).length}</span>
      </div>
    </div>
  );
}

// ============================================================================
// Plan tab (in BrainDump): hourly list + timer + delay reason
// ============================================================================
function minsToTime(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function timeToMins(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function DailyPlanTab({ plans, savePlans }) {
  const today = todayStr();
  const list = plans[today] || [];
  const nm = nowMin();
  const overdue = list.filter((p) => !p.done && p.startMin + p.durationMin < nm);
  const [activeId, setActiveId] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const itv = useRef(null);
  const [delayModal, setDelayModal] = useState(null); // {id, delayedMin}

  const start = (id) => {
    setActiveId(id);
    setElapsed(0);
    playSound("start");
    itv.current = setInterval(() => setElapsed((p) => p + 1), 1000);
  };
  const stop = () => {
    clearInterval(itv.current);
    setActiveId(null);
  };
  useEffect(() => () => clearInterval(itv.current), []);

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ time: minsToTime(Math.ceil(nm / 30) * 30), dur: "75", subject: "", note: "" });

  const addItem = () => {
    if (!form.subject.trim()) return;
    const item = { id: uid(), startMin: timeToMins(form.time), durationMin: Number(form.dur) || 75, subject: form.subject.trim(), note: form.note.trim(), done: false, doneAt: null, delayReason: "" };
    const next = { ...plans, [today]: [...list, item].sort((a, b) => a.startMin - b.startMin) };
    savePlans(next);
    setForm((f) => ({ ...f, subject: "", note: "" }));
    setAddOpen(false);
  };

  const markDone = (id) => {
    const item = list.find((x) => x.id === id);
    if (!item) return;
    const delayed = Math.max(0, nm - (item.startMin + item.durationMin));
    if (delayed > 15) return setDelayModal({ id, delayedMin: delayed });
    const next = { ...plans, [today]: list.map((x) => (x.id === id ? { ...x, done: true, doneAt: new Date().toISOString() } : x)) };
    savePlans(next);
    stop();
    playSound("done");
    toast("Plan ogesi tamamlandi", "var(--grn)");
    if (next[today].every((x) => x.done)) {
      grantXP("plan_done");
      toast(`+${XP_R.plan_done} XP`, "var(--acc)");
    }
  };

  const confirmDelay = (id, reason) => {
    const next = { ...plans, [today]: list.map((x) => (x.id === id ? { ...x, done: true, doneAt: new Date().toISOString(), delayReason: reason } : x)) };
    savePlans(next);
    setDelayModal(null);
    stop();
    playSound("done");
  };

  const del = (id) => savePlans({ ...plans, [today]: list.filter((x) => x.id !== id) });

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <Label>Gunluk Plan</Label>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: list.length ? "var(--acc)" : "var(--muted)" }}>
          {list.length ? `${Math.round((list.filter((x) => x.done).length / list.length) * 100)}%` : "—"}
        </span>
      </div>

      {overdue.length > 0 && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: "var(--red)08", border: "1px solid var(--red)44" }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "var(--red)" }}>{overdue.length} plan ogesi gecikti</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{overdue.map((x) => x.subject).join(", ")}</div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
        {list.length === 0 && !addOpen && <Empty icon="▦" title="Plan yok" desc="Bugun icin 1-3 oge ekle." />}
        {list.map((p) => (
          <div key={p.id} style={{ padding: 10, borderRadius: 12, background: "var(--s2)", border: `1px solid ${p.done ? "var(--grn)33" : p.startMin + p.durationMin < nm ? "var(--red)22" : "var(--b2)"}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: p.done ? "var(--grn)" : "var(--muted)" }}>{minsToTime(p.startMin)}</span>
                  <span style={{ fontSize: 13, textDecoration: p.done ? "line-through" : "none", color: p.done ? "var(--muted)" : "var(--txt)" }}>{p.subject}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
                  {fmtHHMM(p.durationMin)}{p.note ? ` · ${p.note}` : ""}{p.delayReason ? ` · ${p.delayReason}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {!p.done && activeId !== p.id && <Btn variant="accent" onClick={() => start(p.id)}>▶</Btn>}
                {!p.done && <Btn variant="success" onClick={() => markDone(p.id)}>✓</Btn>}
                {activeId === p.id && <Btn variant="ghost" onClick={stop}>◼</Btn>}
                <Btn variant="ghost" onClick={() => del(p.id)} style={{ color: "var(--red)" }}>×</Btn>
              </div>
            </div>
            {activeId === p.id && (
              <div style={{ marginTop: 8, fontFamily: "var(--mono)", fontSize: 11, color: "var(--acc)" }}>
                {String(Math.floor(elapsed / 60)).padStart(2, "0")}:{String(elapsed % 60).padStart(2, "0")}
              </div>
            )}
          </div>
        ))}
      </div>

      {addOpen ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <input type="time" value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))} style={{ padding: "8px 10px" }} />
            <select value={form.dur} onChange={(e) => setForm((f) => ({ ...f, dur: e.target.value }))} style={{ padding: "8px 10px" }}>
              {[30, 45, 60, 75, 90, 120].map((d) => (
                <option key={d} value={String(d)}>
                  {d} dk
                </option>
              ))}
            </select>
          </div>
          <input value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} placeholder="Ders / Konu" style={{ width: "100%", padding: "8px 10px", marginTop: 8 }} />
          <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="Not (ops)" style={{ width: "100%", padding: "8px 10px", marginTop: 8 }} />
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Btn variant="ghost" onClick={() => setAddOpen(false)} style={{ flex: 1 }}>
              Iptal
            </Btn>
            <Btn variant="primary" onClick={addItem} style={{ flex: 2 }}>
              Planla
            </Btn>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <Btn variant="primary" onClick={() => setAddOpen(true)} style={{ width: "100%" }}>
            + Plan Ogesi Ekle
          </Btn>
        </div>
      )}

      {delayModal && <DelayModal delayedMin={delayModal.delayedMin} onConfirm={(r) => confirmDelay(delayModal.id, r)} onCancel={() => setDelayModal(null)} />}
    </Card>
  );
}

function DelayModal({ delayedMin, onConfirm, onCancel }) {
  const [reason, setReason] = useState("");
  const reasons = ["Dikkat dagildi", "Konu zor", "Teknoloji", "Yorgunluk", "Diger"];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 9999 }}>
      <div className="pop" style={{ width: "100%", maxWidth: 360, background: "var(--s1)", border: "1px solid var(--b2)", borderRadius: 14, padding: 16 }}>
        <div style={{ fontFamily: "var(--mono)", fontWeight: 900, color: "var(--acc)" }}>⚡ {delayedMin} dk geciktin</div>
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>Neden kaydirma oldu?</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
          {reasons.map((r) => (
            <button key={r} onClick={() => setReason(r)} style={{ padding: "8px 10px", borderRadius: 10, border: `1px solid ${reason === r ? "var(--acc)" : "var(--b2)"}`, background: reason === r ? "var(--acc)18" : "transparent", color: reason === r ? "var(--acc)" : "var(--muted)", textAlign: "left" }}>
              {r}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <Btn variant="ghost" onClick={onCancel} style={{ flex: 1 }}>
            Iptal
          </Btn>
          <Btn variant="primary" onClick={() => onConfirm(reason || "Belirtilmedi")} disabled={!reason} style={{ flex: 2 }}>
            Kaydet
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Todos tab
// ============================================================================
const PRIOS = { high: { l: "Acil", c: "var(--red)" }, medium: { l: "Orta", c: "var(--acc)" }, low: { l: "Dusuk", c: "var(--muted)" } };
function TodosTab({ todos, setTodos }) {
  const [text, setText] = useState("");
  const [prio, setPrio] = useState("high");
  const [filt, setFilt] = useState("active");
  const overdue = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0);

  const add = () => {
    const v = text.trim();
    if (!v) return;
    const next = [{ id: uid(), text: v, source: "Manuel", priority: prio, done: false, reviewed: false, createdAt: new Date().toISOString(), reviewAt: new Date(Date.now() + 7 * 86400000).toISOString() }, ...todos];
    setTodos(next);
    store.save(KEYS.todos, next);
    setText("");
  };
  const toggle = (id) => {
    const before = todos.find((t) => t.id === id);
    const next = todos.map((t) => (t.id === id ? { ...t, done: !t.done, reviewed: true } : t));
    setTodos(next);
    store.save(KEYS.todos, next);
    if (before && !before.done) {
      grantXP("todo_done");
      toast(`+${XP_R.todo_done} XP`, "var(--grn)");
    }
  };
  const del = (id) => {
    const next = todos.filter((t) => t.id !== id);
    setTodos(next);
    store.save(KEYS.todos, next);
  };
  const snooze = (id) => {
    const next = todos.map((t) => (t.id === id ? { ...t, reviewed: true, reviewAt: new Date(Date.now() + 7 * 86400000).toISOString() } : t));
    setTodos(next);
    store.save(KEYS.todos, next);
  };

  const list = useMemo(() => {
    if (filt === "active") return todos.filter((t) => !t.done);
    if (filt === "done") return todos.filter((t) => t.done);
    if (filt === "review") return overdue;
    return todos;
  }, [filt, todos, overdue]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {overdue.length > 0 && (
        <div style={{ padding: 10, borderRadius: 12, background: "var(--acc)08", border: "1px solid var(--acc)44", display: "flex", alignItems: "center", gap: 10 }}>
          <span>⚡</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "var(--acc)" }}>{overdue.length} gorev 7. gunune girdi</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>Bitir veya ertele.</div>
          </div>
          <Btn variant="accent" onClick={() => setFilt("review")}>
            Goster
          </Btn>
        </div>
      )}

      <Card>
        <Label>Yeni Gorev</Label>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Yeni gorev..." style={{ flex: 1, padding: "10px 12px" }} />
          <Btn variant="primary" onClick={add}>
            Ekle
          </Btn>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          {Object.entries(PRIOS).map(([k, v]) => (
            <button key={k} onClick={() => setPrio(k)} style={{ padding: "6px 10px", borderRadius: 999, border: `1px solid ${prio === k ? v.c : "var(--b2)"}`, background: prio === k ? `${v.c}18` : "transparent", color: prio === k ? v.c : "var(--muted)", fontSize: 12 }}>
              {v.l}
            </button>
          ))}
        </div>
      </Card>

      <div style={{ display: "flex", gap: 6 }}>
        {[
          ["active", "Aktif"],
          ["review", "⚡"],
          ["done", "Tamam"],
          ["all", "Tumu"],
        ].map(([k, l]) => (
          <button key={k} onClick={() => setFilt(k)} style={{ padding: "6px 10px", borderRadius: 999, border: `1px solid ${filt === k ? "var(--acc)" : "var(--b2)"}`, background: filt === k ? "var(--acc)18" : "transparent", color: filt === k ? "var(--acc)" : "var(--muted)", fontSize: 12 }}>
            {l}{k === "review" && overdue.length > 0 ? ` ${overdue.length}` : ""}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <Empty icon="◻" title="Gorev yok" desc="Temiz liste." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map((t) => (
            <div key={t.id} style={{ padding: 10, borderRadius: 12, background: "var(--s2)", border: `1px solid ${t.reviewAt && daysFrom(t.reviewAt) >= 0 && !t.done && !t.reviewed ? "var(--acc)44" : "var(--b2)"}`, display: "flex", gap: 10, alignItems: "flex-start" }}>
              <button onClick={() => toggle(t.id)} style={{ width: 18, height: 18, borderRadius: 5, border: `2px solid ${t.done ? "var(--grn)" : "var(--b2)"}`, background: t.done ? "var(--grn)" : "transparent", marginTop: 2 }}>
                {t.done ? <span style={{ color: "#000", fontSize: 10, fontWeight: 900 }}>✓</span> : null}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, lineHeight: 1.4, textDecoration: t.done ? "line-through" : "none", color: t.done ? "var(--muted)" : "var(--txt)" }}>{t.text}</div>
                <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <Tag color={PRIOS[t.priority]?.c}>{PRIOS[t.priority]?.l}</Tag>
                  {t.source ? <span style={{ fontSize: 10, color: "var(--muted)" }}>← {t.source}</span> : null}
                  {t.reviewAt && daysFrom(t.reviewAt) >= 0 && !t.done && !t.reviewed ? <span style={{ fontSize: 10, color: "var(--acc)", fontFamily: "var(--mono)" }}>⚡ 7. Gun</span> : null}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {t.reviewAt && daysFrom(t.reviewAt) >= 0 && !t.done && !t.reviewed ? (
                  <Btn variant="ghost" onClick={() => snooze(t.id)} style={{ padding: "6px 10px" }}>
                    ↻
                  </Btn>
                ) : null}
                <Btn variant="ghost" onClick={() => del(t.id)} style={{ padding: "6px 10px", color: "var(--red)" }}>
                  ×
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Discipline tab: cross alerts + mini coach + streak/xp/badges + daily challenge + benchmark
// ============================================================================
const CHECKIN_QS = [
  { id: "q1", text: "Bugun deneme analizi yaptin mi?", yes: "Analiz iyi.", no: "Aksam 10 dk analiz." },
  { id: "q2", text: "Bugun yanlislarini cozdun mu?", yes: "Guzel.", no: "Yanlisi coz." },
  { id: "q3", text: "Bugun hedef kadar calistin mi?", yes: "Plan uyumu.", no: "Yarin net hedef." },
  { id: "q4", text: "Bugun zayif konuya zaman ayirdin mi?", yes: "Dogru.", no: "Zayifa git." },
];

function overallMsg(score) {
  if (score === 4) return { msg: "4/4. Mukemmel.", c: "var(--grn)" };
  if (score === 3) return { msg: "3/4. Iyi.", c: "var(--acc)" };
  if (score === 2) return { msg: "2/4. Orta.", c: "var(--acc)" };
  if (score === 1) return { msg: "1/4. Dusuk.", c: "var(--red)" };
  return { msg: "0/4. Bugun kayip.", c: "var(--red)" };
}

function calcBenchmark({ xp, dw, plans, checkins }) {
  const last7 = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const dwSessions = (dw?.sessions || []).filter((s) => last7.includes(s.date));
  const dwMin = dwSessions.reduce((s, x) => s + (x.completedMin || 0), 0);
  const dwGoalMin = dwSessions.reduce((s, x) => s + (x.goalMin || 0), 0);
  const dwRatio = dwGoalMin > 0 ? clamp(dwMin / dwGoalMin, 0, 1) : 0;
  const planItems = last7.flatMap((d) => plans?.[d] || []);
  const planDone = planItems.filter((p) => p.done).length;
  const planRatio = planItems.length > 0 ? planDone / planItems.length : 0;
  const ci = (checkins || []).filter((c) => last7.includes(c.date));
  const ciAvg = ci.length ? ci.reduce((s, c) => s + (c.score || 0), 0) / ci.length : 0;
  const xpScore = clamp((xp.points || 0) / 5000, 0, 1);
  const score = Math.round((xpScore * 35 + dwRatio * 35 + planRatio * 20 + (ciAvg / 4) * 10) * 100);
  const level = score >= 85 ? { name: "S", color: "var(--grn)" } : score >= 70 ? { name: "A", color: "var(--acc)" } : score >= 55 ? { name: "B", color: "var(--blu)" } : score >= 40 ? { name: "C", color: "var(--ora)" } : { name: "D", color: "var(--red)" };
  return { score, level, dwMin, planRatio, ciAvg };
}

function generateDailyChallenge({ date, trials, todos, plans }) {
  const seed = parseInt(date.split("-").join("").slice(-3), 10) || 0;
  const weekPlan = buildWeeklyPlan(trials, 4);
  const topWeak = weekPlan[0]?.subject;
  const overdueTodos = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0).length;
  const todayPlan = plans[date] || [];
  const planLate = todayPlan.filter((p) => !p.done && p.startMin + p.durationMin < nowMin()).length;
  const pool = [
    { id: `c_${date}_review`, title: "15dk Gorev Review", desc: "7 gun uyarili gorevleri bitir veya ertele.", kind: "todo_review" },
    { id: `c_${date}_plan`, title: "1 plan ogesi tamamla", desc: "En kucuk plan ogesini sec ve bitir.", kind: "plan_one" },
    { id: `c_${date}_block`, title: "1 Deep Work blok", desc: "Tek blok bile zinciri korur.", kind: "dw_block" },
    { id: `c_${date}_weak`, title: `${topWeak || "Zayif ders"} mini tekrar`, desc: `${topWeak || "Zayif ders"} icin 20dk mini tekrar.`, kind: "weak_20" },
  ];
  let pick = pool[seed % pool.length];
  if (overdueTodos > 0) pick = pool[0];
  else if (planLate > 0) pick = pool[1];
  return pick;
}

function DisciplineTab({ trials, todos }) {
  const today = todayStr();
  const [checkins, setCheckins] = useState(() => store.load(KEYS.checkins, []));
  const [ans, setAns] = useState(() => checkins.find((c) => c.date === today)?.answers || {});
  const [submitted, setSubmitted] = useState(() => !!checkins.find((c) => c.date === today));
  const [xp, setXp] = useState(loadXP);
  const startRef = useRef(Date.now());

  const attn = store.load(KEYS.attn, {});
  const plans = store.load(KEYS.plan, {});
  const dw = store.load(KEYS.dw, DW_DEFAULT);
  const attnScore = calcAttentionScore(attn[today]?.breaks || []);
  const planToday = plans[today] || [];
  const planPct = planToday.length ? Math.round((planToday.filter((p) => p.done).length / planToday.length) * 100) : 0;

  const alerts = {
    todoOverdue: todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0).length,
    planLate: planToday.filter((p) => !p.done && p.startMin + p.durationMin < nowMin()).length,
    missingCheckin: submitted ? 0 : 1,
    lowAttn: attnScore < 60 ? 1 : 0,
  };

  // challenge
  const [challenge, setChallenge] = useState(() => store.load(KEYS.challenge, {}));
  const todaysChallenge = useMemo(() => {
    const ex = challenge?.[today];
    if (ex?.id) return ex;
    const gen = generateDailyChallenge({ date: today, trials, todos, plans });
    const next = { ...gen, date: today, done: false, doneAt: null };
    const all = { ...(challenge || {}), [today]: next };
    setChallenge(all);
    store.save(KEYS.challenge, all);
    return next;
  }, [challenge, today, trials, todos, plans]);

  const completeChallenge = () => {
    if (todaysChallenge.done) return;
    const all = { ...(challenge || {}), [today]: { ...todaysChallenge, done: true, doneAt: new Date().toISOString() } };
    setChallenge(all);
    store.save(KEYS.challenge, all);
    const { pts } = grantXP("challenge_done");
    setXp(loadXP());
    playSound("done");
    toast(`Challenge tamam! +${pts} XP`, "var(--acc)");
  };

  const submit = () => {
    const elapsed = Math.round((Date.now() - startRef.current) / 1000);
    const score = CHECKIN_QS.filter((q) => ans[q.id] === true).length;
    const entry = { date: today, answers: ans, score, elapsed, at: new Date().toISOString() };
    const next = [entry, ...checkins.filter((c) => c.date !== today)];
    setCheckins(next);
    store.save(KEYS.checkins, next);
    setSubmitted(true);
    const t = score === 4 ? "checkin_4" : score >= 3 ? "checkin_3" : null;
    if (t) {
      const { pts } = grantXP(t);
      setXp(loadXP());
      toast(`+${pts} XP`, "var(--acc)");
    }
    if (elapsed > 60) toast("Check-in cok uzun surdu.", "var(--red)");
  };

  const score = CHECKIN_QS.filter((q) => ans[q.id] === true).length;
  const all = CHECKIN_QS.every((q) => ans[q.id] !== undefined);
  const om = overallMsg(score);
  const bench = useMemo(() => calcBenchmark({ xp, dw, plans, checkins }), [xp, dw, plans, checkins]);

  const coach = (() => {
    if (alerts.todoOverdue) return `Once gorev review: ${alerts.todoOverdue} gorev.`;
    if (alerts.planLate) return `Plan gecikmesi: ${alerts.planLate} oge.`;
    if (attnScore < 60) return "Dikkat dusuk: telefonu kapat, ortam degistir.";
    if (planPct < 50) return "Plan uyumu dusuk: bloklari kucult.";
    return "Tek bir seyi iyilestir.";
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <Label>XP</Label>
            <div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 900, color: "var(--acc)", marginTop: 6 }}>{xp.points} XP</div>
          </div>
          <div style={{ textAlign: "right" }}>
            {xp.streak > 0 && <div style={{ fontFamily: "var(--mono)", color: "var(--acc)" }}>🔥 {xp.streak}g</div>}
            <div style={{ fontSize: 10, color: "var(--muted)" }}>{xp.totalBlocks} blok · {xp.totalTrials} deneme</div>
          </div>
        </div>
        {xp.badges?.length ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
            {BADGES.filter((b) => xp.badges.includes(b.id)).map((b) => (
              <div key={b.id} className="pop" style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 999, background: "var(--acc)15", border: "1px solid var(--acc)33" }}>
                <span>{b.icon}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 800, color: "var(--acc)" }}>{b.label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      {(alerts.todoOverdue + alerts.planLate + alerts.missingCheckin + alerts.lowAttn) > 0 && (
        <Card style={{ border: "1px solid var(--red)22" }}>
          <Label>Cross-Module Uyarilar</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
            {alerts.todoOverdue ? <RowAlert label="Gorev review" value={`${alerts.todoOverdue} adet`} color="var(--acc)" /> : null}
            {alerts.planLate ? <RowAlert label="Plan gecikmesi" value={`${alerts.planLate} adet`} color="var(--red)" /> : null}
            {alerts.missingCheckin ? <RowAlert label="Check-in eksik" value="bugun" color="var(--red)" /> : null}
            {alerts.lowAttn ? <RowAlert label="Dikkat dusuk" value={`${attnScore}/100`} color="var(--red)" /> : null}
          </div>
        </Card>
      )}

      <Card>
        <Label>Gunluk Mini Challenge</Label>
        <div style={{ marginTop: 10, padding: 10, borderRadius: 12, background: "var(--s2)", border: `1px solid ${todaysChallenge.done ? "var(--grn)55" : "var(--b2)"}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: todaysChallenge.done ? "var(--grn)" : "var(--acc)" }}>{todaysChallenge.title}</div>
            {todaysChallenge.done ? <Tag color="var(--grn)">tamam</Tag> : <Tag color="var(--acc)">bugun</Tag>}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>{todaysChallenge.desc}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Btn variant="primary" onClick={completeChallenge} disabled={todaysChallenge.done} style={{ flex: 2 }}>
              {todaysChallenge.done ? "Tamamlandi" : "Tamamladim"}
            </Btn>
            <Btn variant="ghost" onClick={() => (playSound("start"), toast("15 dk odak!", "var(--acc)"))} style={{ flex: 1 }}>
              Basla
            </Btn>
          </div>
        </div>
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Label>Offline Benchmark</Label>
          <Tag color={bench.level.color}>Seviye {bench.level.name}</Tag>
        </div>
        <div style={{ marginTop: 10, height: 6, background: "var(--b1)", borderRadius: 999 }}>
          <div style={{ height: "100%", width: `${clamp(bench.score, 0, 100)}%`, background: bench.level.color, borderRadius: 999 }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginTop: 10 }}>
          <MiniStat label="DW 7g" value={fmtHHMM(bench.dwMin)} color="var(--blu)" />
          <MiniStat label="Plan" value={`%${Math.round(bench.planRatio * 100)}`} color={bench.planRatio >= 0.7 ? "var(--grn)" : "var(--acc)"} />
          <MiniStat label="CI" value={bench.ciAvg ? `${bench.ciAvg.toFixed(1)}/4` : "—"} color={bench.ciAvg >= 3 ? "var(--grn)" : "var(--acc)"} />
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>Coach: <span style={{ color: "var(--acc)", fontFamily: "var(--mono)" }}>{coach}</span></div>
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Label>Check-in</Label>
          {submitted ? <Tag color={om.c}>{score}/4</Tag> : <Tag color="var(--muted)">{today}</Tag>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
          {CHECKIN_QS.map((q) => {
            const a = ans[q.id];
            return (
              <div key={q.id} style={{ padding: 10, borderRadius: 12, background: "var(--s2)", border: "1px solid var(--b2)" }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{q.text}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {[true, false].map((v) => {
                    const sel = a === v;
                    const c = v ? "var(--grn)" : "var(--red)";
                    return (
                      <button key={String(v)} onClick={() => !submitted && setAns((p) => ({ ...p, [q.id]: v }))} disabled={submitted} style={{ flex: 1, padding: "8px 10px", borderRadius: 10, border: `1px solid ${sel ? c : "var(--b2)"}`, background: sel ? `${c}22` : "transparent", color: sel ? c : "var(--muted)", fontWeight: 800 }}>
                        {v ? "Evet" : "Hayir"}
                      </button>
                    );
                  })}
                </div>
                {a !== undefined ? <div className="pop" style={{ marginTop: 8, fontSize: 11, color: a ? "var(--grn)" : "var(--red)", fontStyle: "italic" }}>→ {a ? q.yes : q.no}</div> : null}
              </div>
            );
          })}
        </div>
        {!submitted ? (
          <div style={{ marginTop: 10 }}>
            <Btn variant="primary" onClick={submit} disabled={!all} style={{ width: "100%" }}>
              {all ? "Gunu Degerlendir" : "Cevapla"}
            </Btn>
          </div>
        ) : (
          <div className="pop" style={{ marginTop: 10, padding: 10, borderRadius: 12, background: `${om.c}08`, border: `1px solid ${om.c}33` }}>
            <div style={{ fontFamily: "var(--mono)", fontWeight: 900, color: om.c }}>{om.msg}</div>
          </div>
        )}
      </Card>
    </div>
  );
}

function RowAlert({ label, value, color }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", borderRadius: 12, background: "var(--s2)", border: `1px solid ${color}22` }}>
      <span style={{ fontSize: 12 }}>{label}</span>
      <Tag color={color}>{value}</Tag>
    </div>
  );
}

function MiniStat({ label, value, color }) {
  return (
    <div style={{ padding: 10, borderRadius: 12, background: "var(--s2)", border: "1px solid var(--b2)", textAlign: "center" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 16, fontWeight: 900, color }}>{value}</div>
      <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>{label}</div>
    </div>
  );
}

function Empty({ icon, title, desc }) {
  return (
    <div style={{ textAlign: "center", padding: "26px 12px", color: "var(--muted)" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 26, color: "var(--b2)" }}>{icon}</div>
      <div style={{ fontSize: 13, fontWeight: 700, marginTop: 8 }}>{title}</div>
      <div style={{ fontSize: 11, color: "var(--b2)", marginTop: 4 }}>{desc}</div>
    </div>
  );
}

// ============================================================================
// Toast system (simple)
// ============================================================================
let _toast = null;
function useToasts() {
  const [toasts, setToasts] = useState([]);
  _toast = (msg, color = "var(--acc)") => {
    const id = uid();
    setToasts((p) => [...p.slice(-2), { id, msg, color }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 2600);
  };
  return toasts;
}
function toast(msg, color) {
  _toast?.(msg, color);
}
function ToastLayer({ toasts }) {
  return (
    <div style={{ position: "fixed", bottom: 18, right: 14, display: "flex", flexDirection: "column", gap: 8, zIndex: 99999, pointerEvents: "none" }}>
      {toasts.map((t) => (
        <div key={t.id} className="pop" style={{ padding: "10px 12px", borderRadius: 12, background: "var(--s1)", border: `1px solid ${t.color}55`, borderLeft: `3px solid ${t.color}`, color: t.color, fontFamily: "var(--mono)", fontSize: 11, boxShadow: "0 10px 26px rgba(0,0,0,.55)" }}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// App shell
// ============================================================================
const TABS = [
  { key: "trials", label: "Deneme", icon: "◉" },
  { key: "brain", label: "Brain", icon: "▦" },
  { key: "todos", label: "Gorev", icon: "◻" },
  { key: "discipline", label: "Disiplin", icon: "◆" },
];

export default function App() {
  const [tab, setTab] = useState("brain");
  const [trials, setTrials] = useState(() => store.load(KEYS.trials, []));
  const [todos, setTodos] = useState(() => store.load(KEYS.todos, []));
  const [heatOpen, setHeatOpen] = useState(false);
  const [xp, setXp] = useState(loadXP);
  const toasts = useToasts();

  useEffect(() => {
    const id = setInterval(() => setXp(loadXP()), 4000);
    return () => clearInterval(id);
  }, []);

  const onPushTodos = useCallback((items) => pushTodos(setTodos, items), [setTodos]);

  const checkins = useMemo(() => store.load(KEYS.checkins, []), [tab]);
  const dw = useMemo(() => store.load(KEYS.dw, DW_DEFAULT), [tab]);
  const plans = useMemo(() => store.load(KEYS.plan, {}), [tab]);
  const today = todayStr();

  const alerts = useMemo(() => {
    const todoOverdue = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0).length;
    const missingCheckin = checkins.find((c) => c.date === today) ? 0 : 1;
    const planLate = (plans[today] || []).filter((p) => !p.done && p.startMin + p.durationMin < nowMin()).length;
    return { trials: 0, brain: planLate, todos: todoOverdue, discipline: missingCheckin };
  }, [todos, checkins, plans, today]);

  return (
    <div style={{ minHeight: "100vh", display: "flex", justifyContent: "center", padding: "22px 12px 80px" }}>
      <style>{CSS}</style>
      <div style={{ width: "100%", maxWidth: 560 }}>
        <HeaderBar tab={tab} xp={xp} alerts={alerts} heatOpen={heatOpen} onToggleHeat={() => setHeatOpen((p) => !p)} />
        {heatOpen && (
          <Card style={{ marginBottom: 12 }}>
            <Heatmap sessions={dw.sessions || []} trials={trials} checkins={checkins} />
          </Card>
        )}
        <TabBar active={tab} onChange={setTab} alerts={alerts} />
        <div className="pop">
          {tab === "trials" && <TrialsTab trials={trials} setTrials={setTrials} onPushTodos={onPushTodos} />}
          {tab === "brain" && <BrainDumpTab trials={trials} todos={todos} onPushTodos={onPushTodos} />}
          {tab === "todos" && <TodosTab todos={todos} setTodos={setTodos} />}
          {tab === "discipline" && <DisciplineTab trials={trials} todos={todos} />}
        </div>
      </div>
      <ToastLayer toasts={toasts} />
    </div>
  );
}

function HeaderBar({ tab, xp, alerts, heatOpen, onToggleHeat }) {
  const todayCI = store.load(KEYS.checkins, []).find((c) => c.date === todayStr());
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: "var(--mono)", fontWeight: 900, letterSpacing: -0.2 }}>YKS · SAVAS ODASI</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>{new Date().toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" })}</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <YKSCountdown />
          <button onClick={onToggleHeat} style={{ padding: "6px 10px", borderRadius: 10, background: "var(--s1)", border: "1px solid var(--b2)", color: heatOpen ? "var(--acc)" : "var(--muted)" }}>
            ▦
          </button>
          {!todayCI ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--red)", animation: "blink 1.5s ease infinite" }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--red)" }}>check-in</span>
            </div>
          ) : (
            <Tag color={todayCI.score >= 3 ? "var(--grn)" : "var(--acc)"}>{todayCI.score}/4</Tag>
          )}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
        {[
          { l: "Tab", v: tab, c: "var(--muted)" },
          { l: "Uyari", v: Object.values(alerts).reduce((s, n) => s + (n || 0), 0), c: "var(--red)" },
          { l: "Streak", v: xp.streak || 0, c: "var(--acc)" },
          { l: "XP", v: xp.points, c: "var(--pur)" },
        ].map((x) => (
          <div key={x.l} style={{ padding: "10px 10px", borderRadius: 12, background: "var(--s1)", border: "1px solid var(--b1)", textAlign: "center" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 16, fontWeight: 900, color: x.c }}>{x.v}</div>
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>{x.l}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TabBar({ active, onChange, alerts }) {
  return (
    <div style={{ display: "flex", gap: 6, padding: 6, borderRadius: 14, background: "var(--s1)", border: "1px solid var(--b1)", marginBottom: 14 }}>
      {TABS.map((t) => (
        <button key={t.key} onClick={() => onChange(t.key)} style={{ flex: 1, padding: "8px 6px", borderRadius: 12, background: active === t.key ? "var(--acc)" : "transparent", color: active === t.key ? "#000" : "var(--muted)", position: "relative" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{t.icon}</div>
          <div style={{ fontSize: 10, fontWeight: 800 }}>{t.label}</div>
          {(alerts?.[t.key] || 0) > 0 && <span style={{ position: "absolute", top: 6, right: 8, width: 6, height: 6, borderRadius: 999, background: "var(--red)", animation: "blink 1.5s ease infinite" }} />}
        </button>
      ))}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ============================================================================
// Storage (keep existing keys)
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
  challenge: "yks_challenge", // only new key allowed
};

const store = {
  load: (k, fb) => {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : fb;
    } catch {
      return fb;
    }
  },
  save: (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // ignore
    }
  },
};

// ============================================================================
// Utils / constants
// ============================================================================
const YKS_DATE = new Date("2026-06-21T09:00:00");
const todayStr = () => new Date().toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const daysFrom = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
const fmtMMSS = (s) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const fmtHHMM = (m) => {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h > 0) return `${h}s${r > 0 ? ` ${r}dk` : ""}`;
  if (r > 0) return `${r}dk`;
  return "0dk";
};
const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString("tr-TR", { day: "2-digit", month: "short" });
const nowHHMM = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

const TYT_SUBS = [
  "Turkce",
  "Matematik",
  "Fizik",
  "Kimya",
  "Biyoloji",
  "Tarih",
  "Cografya",
  "Felsefe",
  "Din",
];
const AYT_SUBS = [
  "Matematik",
  "Fizik",
  "Kimya",
  "Biyoloji",
  "Edebiyat",
  "Tarih",
  "Cografya",
  "Felsefe",
];
const calcNet = (d, y) => Math.max(0, parseFloat(d || 0) - parseFloat(y || 0) / 4);

function yksCountdown() {
  const diff = YKS_DATE.getTime() - Date.now();
  if (diff <= 0) return { days: 0, hours: 0, passed: true };
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  return { days, hours, passed: false };
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
      const o = ctx.createOscillator();
      o.connect(g);
      o.frequency.setValueAtTime(880, ctx.currentTime);
      o.frequency.setValueAtTime(1100, ctx.currentTime + 0.12);
      g.gain.setValueAtTime(0.3, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      o.start();
      o.stop(ctx.currentTime + 0.35);
    } else if (type === "done") {
      [0, 0.15, 0.3].forEach((t, i) => {
        const o = ctx.createOscillator();
        o.connect(g);
        o.frequency.value = [660, 880, 1100][i];
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.12);
      });
      g.gain.setValueAtTime(0.25, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    } else if (type === "warn") {
      const o = ctx.createOscillator();
      o.connect(g);
      o.frequency.value = 300;
      g.gain.setValueAtTime(0.4, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      o.start();
      o.stop(ctx.currentTime + 0.4);
    }
  } catch {
    // ignore
  }
}

// ============================================================================
// XP / gamification
// ============================================================================
const XP_R = {
  block_done: 50,
  trial_added: 30,
  todo_done: 15,
  checkin_4: 100,
  checkin_3: 60,
  plan_done: 80,
  challenge_done: 120,
};

const BADGES = [
  { id: "first_block", label: "Ilk Blok", icon: "▶", req: (x) => x.totalBlocks >= 1 },
  { id: "week_streak", label: "7 Gun Seri", icon: "🔥", req: (x) => x.streak >= 7 },
  { id: "trial_ace", label: "Deneme Ustu", icon: "◉", req: (x) => x.totalTrials >= 5 },
  { id: "discipline", label: "Demir Irade", icon: "◆", req: (x) => x.perfect4 >= 3 },
  { id: "centurion", label: "100 Blok", icon: "⬛", req: (x) => x.totalBlocks >= 100 },
  { id: "planner", label: "Planci", icon: "▦", req: (x) => x.plansDone >= 7 },
  { id: "challenger", label: "Challenger", icon: "✦", req: (x) => (x.challengesDone || 0) >= 7 },
];

const loadXP = () =>
  store.load(KEYS.xp, {
    points: 0,
    streak: 0,
    totalBlocks: 0,
    totalTrials: 0,
    perfect4: 0,
    plansDone: 0,
    challengesDone: 0,
    badges: [],
    lastDate: "",
  });

const saveXP = (x) => store.save(KEYS.xp, x);

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
  BADGES.forEach((b) => {
    if (!xp.badges.includes(b.id) && b.req(xp)) xp.badges.push(b.id);
  });
  saveXP(xp);
  return { pts, xp };
}

// ============================================================================
// Attention tracking
// ============================================================================
const BREAK_REASONS = [
  "Dikkat dagildi",
  "Yorgun hissettim",
  "Telefon kontrolu",
  "Su/Yiyecek",
  "Tuvalet",
  "Planli mola",
  "Diger",
];

function calcAttentionScore(breaks) {
  if (!breaks || !breaks.length) return 100;
  const early = breaks.filter((b) => b.type === "early").length;
  const ratio = early / breaks.length;
  const avgBlock = breaks.reduce((s, b) => s + (b.blockMin || 0), 0) / breaks.length;
  let score = 100 - ratio * 40 - Math.max(0, 60 - avgBlock) * 0.5;
  return Math.round(clamp(score, 0, 100));
}

function attentionLabel(score) {
  if (score >= 85) return { label: "Yuksek Dikkat", color: "var(--grn)" };
  if (score >= 60) return { label: "Orta Dikkat", color: "var(--acc)" };
  return { label: "Dusuk Dikkat", color: "var(--red)" };
}

// ============================================================================
// Trials -> weekly plan
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

// ============================================================================
// Styles
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
.fu{animation:fadeUp .2s ease both}
.fi{animation:fadeIn .15s ease both}
.sr{animation:slideR .18s ease both}
.pi{animation:popIn .28s cubic-bezier(.34,1.56,.64,1) both}
.flashY{animation:flashY .6s ease}
.flashR{animation:flashR .6s ease}`;

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
    <div
      style={{
        position: "fixed",
        bottom: "24px",
        right: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        zIndex: 9999,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pi"
          style={{
            background: "var(--s1)",
            border: `1px solid ${t.color}55`,
            borderLeft: `3px solid ${t.color}`,
            padding: "10px 14px",
            borderRadius: "8px",
            fontSize: "12px",
            color: t.color,
            fontFamily: "var(--mono)",
            maxWidth: "260px",
            lineHeight: "1.4",
            boxShadow: "0 8px 24px rgba(0,0,0,.5)",
          }}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// UI primitives
// ============================================================================
const Card = ({ children, style, className }) => (
  <div
    className={className}
    style={{
      background: "var(--s1)",
      border: "1px solid var(--b1)",
      borderRadius: "10px",
      padding: "16px",
      ...style,
    }}
  >
    {children}
  </div>
);

const Label = ({ children, style }) => (
  <p
    style={{
      fontFamily: "var(--mono)",
      fontSize: "10px",
      fontWeight: "600",
      color: "var(--muted)",
      letterSpacing: "1.5px",
      textTransform: "uppercase",
      ...style,
    }}
  >
    {children}
  </p>
);

const Btn = ({ children, onClick, variant = "default", size = "md", disabled, style, title }) => {
  const V = {
    default: { background: "var(--s2)", color: "var(--txt)", border: "1px solid var(--b2)" },
    primary: { background: "var(--acc)", color: "#000", fontWeight: "600" },
    danger: { background: "transparent", color: "var(--red)", border: "1px solid var(--red)44" },
    ghost: { background: "transparent", color: "var(--muted)" },
    success: { background: "transparent", color: "var(--grn)", border: "1px solid var(--grn)44" },
    accent: { background: "var(--acc)18", color: "var(--acc)", border: "1px solid var(--acc)33" },
  };
  const S = {
    sm: { padding: "4px 10px", fontSize: "11px", borderRadius: "5px" },
    md: { padding: "8px 15px", fontSize: "13px", borderRadius: "7px" },
    lg: { padding: "12px 22px", fontSize: "14px", borderRadius: "8px", fontWeight: "600" },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...V[variant],
        ...S[size],
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
};

const Tag = ({ children, color = "var(--acc)" }) => (
  <span
    style={{
      fontFamily: "var(--mono)",
      fontSize: "10px",
      fontWeight: "600",
      padding: "2px 7px",
      borderRadius: "4px",
      background: `${color}18`,
      color,
      letterSpacing: "0.5px",
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </span>
);

const PBar = ({ value, max, color = "var(--acc)", h = 5 }) => {
  const pct = max > 0 ? clamp((value / max) * 100, 0, 100) : 0;
  return (
    <div style={{ height: h, background: "var(--b1)", borderRadius: "999px", overflow: "hidden" }}>
      <div
        style={{
          height: "100%",
          width: `${pct}%`,
          background: color,
          borderRadius: "999px",
          transition: "width .8s ease",
        }}
      />
    </div>
  );
};

// ============================================================================
// Widgets: countdown + heatmap
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
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: "11px",
          color: "var(--red)",
          animation: "countdown 2s ease infinite",
          fontWeight: "700",
        }}
      >
        {days}G
      </span>
      <span style={{ fontSize: "10px", color: "var(--muted)" }}>{hours}s</span>
    </div>
  );
}

function Heatmap({ sessions, trials, checkins }) {
  const cells = useMemo(() => {
    const dMap = {};
    const cMap = {};
    const tMap = {};
    (sessions || []).forEach((s) => {
      dMap[s.date] = s.completedMin || 0;
    });
    (checkins || []).forEach((c) => {
      cMap[c.date] = c.score;
    });
    (trials || []).forEach((t) => {
      tMap[t.date] = (tMap[t.date] || 0) + 1;
    });
    return Array.from({ length: 84 }, (_, i) => {
      const key = new Date(Date.now() - (83 - i) * 86400000).toISOString().slice(0, 10);
      const score = clamp(
        Math.floor((dMap[key] || 0) / 60) + ((cMap[key] ?? -1) >= 3 ? 1 : 0) + (tMap[key] || 0),
        0,
        4,
      );
      return { key, score, isToday: key === todayStr() };
    });
  }, [sessions, trials, checkins]);

  const colors = ["var(--b2)", "#1a3a2a", "#2a5a3a", "#3a8a5a", "var(--grn)"];
  return (
    <div>
      <Label style={{ marginBottom: "8px" }}>12 Haftalik Aktivite</Label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(84,1fr)", gap: "2px" }}>
        {cells.map((c) => (
          <div
            key={c.key}
            title={c.key}
            style={{
              aspectRatio: "1",
              borderRadius: "2px",
              background: colors[c.score],
              outline: c.isToday ? "1px solid var(--acc)" : "none",
              outlineOffset: "1px",
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", gap: "5px", alignItems: "center", marginTop: "6px", justifyContent: "flex-end" }}>
        <span style={{ fontSize: "9px", color: "var(--muted)" }}>az</span>
        {colors.map((c, i) => (
          <div key={i} style={{ width: "9px", height: "9px", background: c, borderRadius: "2px" }} />
        ))}
        <span style={{ fontSize: "9px", color: "var(--muted)" }}>cok</span>
      </div>
    </div>
  );
}

function Header({ tab, onToggleHeat, heatOpen, alerts, xp }) {
  const today = todayStr();
  const checkins = store.load(KEYS.checkins, []);
  const todayCI = checkins.find((c) => c.date === today);
  return (
    <div style={{ marginBottom: "18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
        <div>
          <h1 style={{ fontFamily: "var(--mono)", fontSize: "16px", fontWeight: "700", letterSpacing: "-0.5px" }}>
            YKS · SAVAS ODASI
          </h1>
          <p style={{ fontSize: "10px", color: "var(--muted)", marginTop: "2px", fontFamily: "var(--mono)" }}>
            {new Date().toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" })}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
          <YKSCountdown />
          <button
            onClick={onToggleHeat}
            title="Heatmap"
            style={{
              padding: "4px 8px",
              fontSize: "9px",
              fontFamily: "var(--mono)",
              background: "var(--s1)",
              border: "1px solid var(--b2)",
              borderRadius: "4px",
              color: heatOpen ? "var(--acc)" : "var(--muted)",
              cursor: "pointer",
            }}
          >
            ▦
          </button>
          {!todayCI ? (
            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <span
                style={{
                  width: "5px",
                  height: "5px",
                  borderRadius: "50%",
                  background: "var(--red)",
                  display: "inline-block",
                  animation: "blink 1.5s ease infinite",
                }}
              />
              <span style={{ fontSize: "9px", color: "var(--red)", fontFamily: "var(--mono)" }}>check-in</span>
            </div>
          ) : (
            <Tag color={todayCI.score >= 3 ? "var(--grn)" : "var(--acc)"}>{todayCI.score}/4</Tag>
          )}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "6px" }}>
        {[
          { l: "Tab", v: tab, c: "var(--muted)" },
          { l: "Uyari", v: Object.values(alerts).reduce((s, n) => s + (n || 0), 0), c: "var(--red)" },
          { l: "Streak", v: xp.streak || 0, c: "var(--acc)" },
          { l: "XP", v: xp.points, c: "var(--pur)" },
        ].map(({ l, v, c }) => (
          <div key={l} style={{ padding: "8px 9px", background: "var(--s1)", border: "1px solid var(--b1)", borderRadius: "7px", textAlign: "center" }}>
            <p style={{ fontFamily: "var(--mono)", fontSize: "16px", fontWeight: "700", color: c, lineHeight: 1 }}>{v}</p>
            <p style={{ fontSize: "9px", color: "var(--muted)", marginTop: "2px", letterSpacing: "0.5px" }}>{l}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Tabs
// ============================================================================
const TABS = [
  { key: "trials", icon: "◉", label: "Denemeler" },
  { key: "brain", icon: "▦", label: "BrainDump" },
  { key: "todos", icon: "◻", label: "Gorevler" },
  { key: "discipline", icon: "◆", label: "Disiplin" },
];

function TabBar({ active, onChange, alerts }) {
  return (
    <div style={{ display: "flex", gap: "2px", padding: "4px", background: "var(--s1)", borderRadius: "10px", border: "1px solid var(--b1)", marginBottom: "20px" }}>
      {TABS.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          style={{
            flex: 1,
            padding: "7px 2px",
            borderRadius: "7px",
            fontFamily: "var(--sans)",
            fontSize: "9px",
            fontWeight: "600",
            letterSpacing: "0.3px",
            background: active === t.key ? "var(--acc)" : "transparent",
            color: active === t.key ? "#000" : "var(--muted)",
            position: "relative",
            transition: "all .15s",
          }}
        >
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
// Empty state
// ============================================================================
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
// Todos tab
// ============================================================================
const PRIOS = {
  high: { l: "Acil", c: "var(--red)" },
  medium: { l: "Orta", c: "var(--acc)" },
  low: { l: "Dusuk", c: "var(--muted)" },
};

function TodosTab({ todos, setTodos }) {
  const [text, setText] = useState("");
  const [prio, setPrio] = useState("high");
  const [filt, setFilt] = useState("active");

  const overdue = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0);
  const add = () => {
    if (!text.trim()) return;
    const u = [
      {
        id: uid(),
        text: text.trim(),
        source: "Manuel",
        priority: prio,
        done: false,
        reviewed: false,
        createdAt: new Date().toISOString(),
        reviewAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      },
      ...todos,
    ];
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
      grantXP("todo_done");
      toast(`+${XP_R.todo_done} XP`, "var(--grn)");
    }
  };
  const del = (id) => {
    const u = todos.filter((t) => t.id !== id);
    setTodos(u);
    store.save(KEYS.todos, u);
  };
  const snooze = (id) => {
    const u = todos.map((t) =>
      t.id === id ? { ...t, reviewAt: new Date(Date.now() + 7 * 86400000).toISOString(), reviewed: true } : t,
    );
    setTodos(u);
    store.save(KEYS.todos, u);
  };

  const list = useMemo(() => {
    if (filt === "active") return todos.filter((t) => !t.done);
    if (filt === "done") return todos.filter((t) => t.done);
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
          <Btn size="sm" variant="accent" onClick={() => setFilt("review")}>
            Goster
          </Btn>
        </div>
      )}

      <Card style={{ padding: "11px" }}>
        <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Yeni gorev..." style={{ flex: 1, padding: "7px 10px", fontSize: "12px", borderRadius: "6px" }} />
          <Btn variant="primary" onClick={add}>
            Ekle
          </Btn>
        </div>
        <div style={{ display: "flex", gap: "4px" }}>
          {Object.entries(PRIOS).map(([k, { l, c }]) => (
            <button
              key={k}
              onClick={() => setPrio(k)}
              style={{
                padding: "3px 8px",
                borderRadius: "4px",
                border: "1px solid",
                fontSize: "10px",
                cursor: "pointer",
                borderColor: prio === k ? c : "var(--b2)",
                background: prio === k ? `${c}22` : "transparent",
                color: prio === k ? c : "var(--muted)",
              }}
            >
              {l}
            </button>
          ))}
        </div>
      </Card>

      <div style={{ display: "flex", gap: "4px" }}>
        {[
          ["active", "Aktif"],
          ["review", "⚡"],
          ["done", "Tamam"],
          ["all", "Tumu"],
        ].map(([k, l]) => (
          <button
            key={k}
            onClick={() => setFilt(k)}
            style={{
              padding: "4px 9px",
              borderRadius: "5px",
              border: "1px solid",
              fontSize: "10px",
              cursor: "pointer",
              borderColor: filt === k ? "var(--acc)" : "var(--b2)",
              background: filt === k ? "var(--acc)18" : "transparent",
              color: filt === k ? "var(--acc)" : "var(--muted)",
              position: "relative",
            }}
          >
            {l}
            {k === "review" && overdue.length > 0 && (
              <span style={{ marginLeft: "3px", background: "var(--red)", borderRadius: "50%", width: "12px", height: "12px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "8px", color: "#fff" }}>
                {overdue.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <EmptyState icon="◻" title="Gorev yok" desc="Temiz liste, net zihin." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          {list.map((t) => (
            <div key={t.id} className="sr" style={{ display: "flex", alignItems: "flex-start", gap: "9px", padding: "9px 11px", borderRadius: "7px", background: "var(--s2)", border: `1px solid ${t.reviewAt && daysFrom(t.reviewAt) >= 0 && !t.done && !t.reviewed ? "var(--acc)44" : "var(--b2)"}` }}>
              <button
                onClick={() => toggle(t.id)}
                style={{
                  width: "15px",
                  height: "15px",
                  borderRadius: "3px",
                  flexShrink: 0,
                  marginTop: "2px",
                  background: t.done ? "var(--grn)" : "transparent",
                  border: `2px solid ${t.done ? "var(--grn)" : "var(--b2)"}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {t.done && <span style={{ color: "#000", fontSize: "9px", fontWeight: "700" }}>✓</span>}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: "12px", lineHeight: "1.4", textDecoration: t.done ? "line-through" : "none", color: t.done ? "var(--muted)" : "var(--txt)" }}>{t.text}</p>
                <div style={{ display: "flex", gap: "5px", marginTop: "3px", flexWrap: "wrap" }}>
                  <Tag color={PRIOS[t.priority]?.c}>{PRIOS[t.priority]?.l}</Tag>
                  {t.source && <span style={{ fontSize: "9px", color: "var(--muted)" }}>← {t.source}</span>}
                  {t.reviewAt && daysFrom(t.reviewAt) >= 0 && !t.done && !t.reviewed && <span style={{ fontSize: "9px", color: "var(--acc)", animation: "pulse 2s ease infinite" }}>⚡ 7. Gun</span>}
                </div>
              </div>
              <div style={{ display: "flex", gap: "3px" }}>
                {t.reviewAt && daysFrom(t.reviewAt) >= 0 && !t.done && !t.reviewed && (
                  <Btn size="sm" variant="ghost" onClick={() => snooze(t.id)} style={{ color: "var(--acc)" }} title="Ertele">
                    ↻
                  </Btn>
                )}
                <Btn size="sm" variant="ghost" onClick={() => del(t.id)} style={{ color: "var(--red)" }} title="Sil">
                  ×
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Trials tab (standard todo transfer)
// ============================================================================
function TrialsTab({ trials, setTrials, onPushTodos }) {
  const [adding, setAdding] = useState(false);
  const [showOpt, setShowOpt] = useState(false);

  const save = (t) => {
    const updated = [t, ...trials];
    setTrials(updated);
    store.save(KEYS.trials, updated);
    grantXP("trial_added");
    toast(`Deneme kaydedildi — ${t.totalNet} net`, "var(--blu)");
    if (t.todos?.length) {
      const mapped = t.todos.map((text) => ({
        text,
        source: `${t.type} (${fmtDate(t.date)})`,
        priority: "high",
        meta: { kind: "trial", trialId: t.id, trialType: t.type, trialDate: t.date },
      }));
      onPushTodos(mapped);
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
  const weekPlan = useMemo(() => buildWeeklyPlan(trials, 4), [trials]);

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
              <p style={{ fontSize: "10px", color: "var(--muted)", marginTop: "8px", lineHeight: "1.5" }}>Kirmizi = hedef acigi buyuk. Bu derslere gunluk onerilen sure ayir.</p>
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
        <Btn variant="primary" onClick={() => setAdding(true)} style={{ width: "100%", padding: "11px" }}>
          + Deneme Ekle
        </Btn>
      )}

      {!adding && trials.length === 0 && <EmptyState icon="◉" title="Henuz deneme yok" desc="Ilk denemeyi ekle ve analiz et." />}
      {!adding && trials.map((t) => <TrialCard key={t.id} trial={t} onDelete={del} onPushTodos={onPushTodos} />)}
    </div>
  );
}

function TrialForm({ onSave, onCancel }) {
  const [date, setDate] = useState(todayStr());
  const [type, setType] = useState("TYT");
  const [nets, setNets] = useState({});
  const [targets, setTargets] = useState({});
  const [err, setErr] = useState("");
  const [todos, setTodos] = useState("");
  const subs = type === "TYT" ? TYT_SUBS : AYT_SUBS;
  const setN = (s, f, v) => setNets((p) => ({ ...p, [s]: { ...(p[s] || {}), [f]: v } }));
  const totalNet = subs.reduce((sum, s) => sum + calcNet(nets[s]?.d, nets[s]?.y), 0);

  const handleSave = () => {
    const list = subs
      .map((s) => ({
        subject: s,
        correct: parseFloat(nets[s]?.d || 0),
        wrong: parseFloat(nets[s]?.y || 0),
        net: calcNet(nets[s]?.d, nets[s]?.y),
        target: parseFloat(targets[s] || 0),
      }))
      .filter((n) => n.correct > 0 || n.wrong > 0);
    if (!list.length) {
      alert("En az bir ders gir.");
      return;
    }
    onSave({
      id: uid(),
      date,
      type,
      nets: list,
      totalNet: parseFloat(totalNet.toFixed(2)),
      errorAnalysis: err,
      todos: todos.split("\n").map((t) => t.trim()).filter(Boolean),
      createdAt: new Date().toISOString(),
    });
  };

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
            <option>TYT</option>
            <option>AYT</option>
          </select>
        </div>
        <div style={{ textAlign: "right", paddingTop: "16px" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: "18px", fontWeight: "700", color: "var(--acc)" }}>{totalNet.toFixed(1)}</span>
          <p style={{ fontSize: "9px", color: "var(--muted)" }}>net</p>
        </div>
      </div>

      <div>
        <Label style={{ marginBottom: "7px" }}>Netler D/Y + Hedef</Label>
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
                  <input type="number" min="0" placeholder="D" value={nets[s]?.d || ""} onChange={(e) => setN(s, "d", e.target.value)} style={{ flex: 1, padding: "3px 5px", fontSize: "10px", textAlign: "center", borderRadius: "4px", color: "var(--grn)" }} />
                  <input type="number" min="0" placeholder="Y" value={nets[s]?.y || ""} onChange={(e) => setN(s, "y", e.target.value)} style={{ flex: 1, padding: "3px 5px", fontSize: "10px", textAlign: "center", borderRadius: "4px", color: "var(--red)" }} />
                  <input type="number" min="0" placeholder="H" value={targets[s] || ""} onChange={(e) => setTargets((p) => ({ ...p, [s]: e.target.value }))} style={{ flex: 1, padding: "3px 5px", fontSize: "10px", textAlign: "center", borderRadius: "4px", color: "var(--muted)" }} />
                </div>
              </div>
            );
          })}
        </div>
        <p style={{ fontSize: "9px", color: "var(--muted)", marginTop: "4px" }}>D=Dogru · Y=Yanlis · H=Hedef</p>
      </div>

      <div>
        <Label style={{ marginBottom: "4px" }}>Hata Analizi</Label>
        <textarea value={err} onChange={(e) => setErr(e.target.value)} rows={3} placeholder="Hangi konularda hata yaptin?" style={{ padding: "8px 10px", fontSize: "12px", width: "100%", resize: "vertical", lineHeight: "1.6", borderRadius: "6px" }} />
      </div>
      <div>
        <Label style={{ marginBottom: "4px" }}>Yapilmasi Gerekenler</Label>
        <textarea value={todos} onChange={(e) => setTodos(e.target.value)} rows={2} placeholder="Her satira bir madde..." style={{ padding: "8px 10px", fontSize: "12px", width: "100%", resize: "vertical", lineHeight: "1.6", borderRadius: "6px" }} />
      </div>
      <div style={{ display: "flex", gap: "7px", justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onCancel}>
          Iptal
        </Btn>
        <Btn variant="primary" onClick={handleSave}>
          Kaydet
        </Btn>
      </div>
    </div>
  );
}

function TrialCard({ trial, onDelete, onPushTodos }) {
  const [exp, setExp] = useState(false);
  const top = [...trial.nets].sort((a, b) => b.net - a.net).slice(0, 3);
  const weak = [...trial.nets].sort((a, b) => a.net - b.net).slice(0, 2);
  const maxN = Math.max(...trial.nets.map((n) => n.net), 1);

  const quickTodos = () => {
    if (!trial.todos?.length) return;
    const mapped = trial.todos.map((text) => ({
      text,
      source: `${trial.type} (${fmtDate(trial.date)})`,
      priority: "high",
      meta: { kind: "trial", trialId: trial.id, trialType: trial.type, trialDate: trial.date },
    }));
    onPushTodos(mapped);
    toast(`${trial.todos.length} gorev akti`, "var(--grn)");
  };

  return (
    <Card className="sr" style={{ padding: "0", overflow: "hidden" }}>
      <div onClick={() => setExp((p) => !p)} style={{ padding: "11px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", background: exp ? "var(--s2)" : "transparent" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Tag color={trial.type === "TYT" ? "var(--blu)" : "var(--acc)"}>{trial.type}</Tag>
          <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--muted)" }}>{fmtDate(trial.date)}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: "18px", fontWeight: "700", color: "var(--acc)" }}>{trial.totalNet}</span>
        </div>
        <div style={{ display: "flex", gap: "7px", alignItems: "center" }}>
          {trial.todos?.length > 0 && <Tag color="var(--red)">{trial.todos.length} gorev</Tag>}
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
              {top.map((n) => (
                <p key={n.subject} style={{ fontSize: "10px", marginBottom: "2px" }}>
                  {n.subject} <span style={{ fontFamily: "var(--mono)", color: "var(--grn)" }}>{n.net.toFixed(1)}</span>
                </p>
              ))}
            </div>
            <div style={{ flex: 1, padding: "9px", background: "var(--s2)", borderRadius: "7px", border: "1px solid var(--red)22" }}>
              <Label style={{ color: "var(--red)", marginBottom: "5px" }}>En Zayif</Label>
              {weak.map((n) => (
                <p key={n.subject} style={{ fontSize: "10px", marginBottom: "2px" }}>
                  {n.subject} <span style={{ fontFamily: "var(--mono)", color: "var(--red)" }}>{n.net.toFixed(1)}</span>
                </p>
              ))}
            </div>
          </div>

          {trial.errorAnalysis && (
            <div>
              <Label style={{ marginBottom: "4px" }}>Hata Analizi</Label>
              <p style={{ fontSize: "11px", color: "var(--muted)", lineHeight: "1.6", whiteSpace: "pre-wrap", padding: "8px 10px", background: "var(--s2)", borderRadius: "6px" }}>{trial.errorAnalysis}</p>
            </div>
          )}

          {trial.todos?.length > 0 && (
            <div>
              <Label style={{ marginBottom: "5px" }}>Yapilmasi Gerekenler</Label>
              {trial.todos.map((t, i) => (
                <div key={i} style={{ display: "flex", gap: "6px", padding: "5px 8px", background: "var(--s2)", borderRadius: "5px", marginBottom: "3px" }}>
                  <span style={{ color: "var(--acc)", fontSize: "9px" }}>→</span>
                  <span style={{ fontSize: "11px" }}>{t}</span>
                </div>
              ))}
              <Btn variant="accent" size="sm" onClick={quickTodos} style={{ marginTop: "6px" }}>
                Gorevlere aktar
              </Btn>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn variant="danger" size="sm" onClick={() => onDelete(trial.id)}>
              Sil
            </Btn>
          </div>
        </div>
      )}
    </Card>
  );
}

// ============================================================================
// Brain tab: brain dump + (simple) deep work goal + daily plan integration
// ============================================================================
const DW_DEFAULT = { sessions: [], goalMin: 180 };
const FOCUS_QUOTES = [
  "Rakibin simdi calisiyor. Sen ne yapiyorsun?",
  "Bu blok bitince mola hakkin var. Henuz degil.",
  "Disiplin, motivasyon olmadigi zamanlarda ne yaptigindir.",
  "Zorlanmak buyudugune isarettir.",
  "Flow state esigindeydin. Devam et.",
  "60 dakikanin icinde bir omur degisebilir.",
];
const getQuote = () => FOCUS_QUOTES[Math.floor(Math.random() * FOCUS_QUOTES.length)];

function buildBlocks(goalMin) {
  const blocks = [];
  let rem = goalMin;
  while (rem >= 30) {
    const dur = clamp(rem, 60, 90);
    if (dur < 30) break;
    blocks.push({ id: uid(), dur });
    rem -= dur + (rem - dur >= 30 ? 15 : 0);
  }
  return blocks;
}

function BrainDumpTab({ trials, todos, onPushTodos }) {
  const today = todayStr();
  const [brain, setBrainRaw] = useState(() => store.load(KEYS.brain, {}));
  const [dw, setDwRaw] = useState(() => store.load(KEYS.dw, DW_DEFAULT));
  const [attn, setAttnRaw] = useState(() => store.load(KEYS.attn, {}));
  const [plans, setPlansRaw] = useState(() => store.load(KEYS.plan, {}));

  const setBrain = useCallback((fn) => {
    setBrainRaw((p) => {
      const n = typeof fn === "function" ? fn(p) : fn;
      store.save(KEYS.brain, n);
      return n;
    });
  }, []);
  const setDw = useCallback((fn) => {
    setDwRaw((p) => {
      const n = typeof fn === "function" ? fn(p) : fn;
      store.save(KEYS.dw, n);
      return n;
    });
  }, []);
  const setAttn = useCallback((fn) => {
    setAttnRaw((p) => {
      const n = typeof fn === "function" ? fn(p) : fn;
      store.save(KEYS.attn, n);
      return n;
    });
  }, []);
  const setPlans = useCallback((fn) => {
    setPlansRaw((p) => {
      const n = typeof fn === "function" ? fn(p) : fn;
      store.save(KEYS.plan, n);
      return n;
    });
  }, []);

  const brainText = brain?.[today]?.text || "";
  const setBrainText = (text) =>
    setBrain((p) => ({ ...(p || {}), [today]: { ...(p?.[today] || {}), text, updatedAt: new Date().toISOString() } }));

  const weeklyRec = useMemo(() => buildWeeklyPlan(trials, 4), [trials]);

  const pushBrainDumpToTodos = () => {
    const lines = brainText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    onPushTodos(lines.map((text) => ({ text, source: `BrainDump (${fmtDate(today)})`, priority: "medium", meta: { kind: "brain", date: today } })));
    setBrainText("");
    toast(`${lines.length} madde gorevlere akti`, "var(--grn)");
  };

  // deep work
  const goalMin = dw.goalMin ?? 180;
  const blocks = useMemo(() => buildBlocks(goalMin), [goalMin]);
  const todaySess = dw.sessions.find((s) => s.date === today);
  const doneBlocks = todaySess?.blocks ?? [];
  const completedMin = doneBlocks.reduce((s, b) => s + b.dur, 0);
  const todayDone = completedMin >= goalMin;
  const nextIdx = doneBlocks.length;
  const todayBreaks = attn[today]?.breaks || [];
  const attnScore = useMemo(() => calcAttentionScore(todayBreaks), [todayBreaks]);
  const { label: aLabel, color: aColor } = attentionLabel(attnScore);

  const onBlockDone = (dur, early, breakData) => {
    playSound("done");
    grantXP("block_done");
    toast(`+${XP_R.block_done} XP - Blok tamamlandi`, "var(--grn)");
    if (breakData) {
      setAttn((p) => {
        const prev = p[today] || { breaks: [] };
        return { ...p, [today]: { ...prev, breaks: [...prev.breaks, breakData] } };
      });
    }
    setDw((p) => {
      const prev = p.sessions.find((s) => s.date === today);
      const nb = { id: uid(), dur, early, at: new Date().toISOString() };
      const upd = prev
        ? { ...prev, blocks: [...(prev.blocks || []), nb], completedMin: (prev.completedMin || 0) + dur, earlyBreaks: (prev.earlyBreaks || 0) + (early ? 1 : 0), goalMin }
        : { date: today, goalMin, blocks: [nb], completedMin: dur, earlyBreaks: early ? 1 : 0 };
      return { ...p, sessions: [upd, ...p.sessions.filter((s) => s.date !== today)] };
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <Card style={{ padding: "13px 14px" }}>
        <Label style={{ marginBottom: "8px" }}>Brain Dump</Label>
        <textarea value={brainText} onChange={(e) => setBrainText(e.target.value)} rows={4} placeholder="Aklindaki her seyi dok... Her satir bir gorev olabilir." style={{ padding: "10px 12px", fontSize: "12px", width: "100%", resize: "vertical", lineHeight: "1.6", borderRadius: "8px" }} />
        <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
          <Btn variant="accent" onClick={pushBrainDumpToTodos} style={{ flex: 2 }} disabled={!brainText.trim()}>
            Goreve cevir
          </Btn>
          <Btn variant="ghost" onClick={() => setBrainText("")} style={{ flex: 1 }} disabled={!brainText.trim()}>
            Temizle
          </Btn>
        </div>
        {weeklyRec.length > 0 && (
          <div style={{ marginTop: "12px" }}>
            <Label style={{ marginBottom: "8px" }}>Bugun onerilen dersler</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
              {weeklyRec.slice(0, 4).map((w) => (
                <div key={w.subject} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 9px", background: "var(--s2)", borderRadius: "6px" }}>
                  <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: w.priority === "high" ? "var(--red)" : w.priority === "medium" ? "var(--acc)" : "var(--grn)" }} />
                    <span style={{ fontSize: "12px" }}>{w.subject}</span>
                  </div>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>{fmtHHMM(w.dailyMin)}/gun</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {todayBreaks.length > 0 && (
        <Card style={{ padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <Label>Dikkat Durumu</Label>
            <Tag color={aColor}>{aLabel} · {attnScore}/100</Tag>
          </div>
          <PBar value={attnScore} max={100} color={aColor} h={5} />
        </Card>
      )}

      <Card style={{ padding: "12px 14px" }}>
        <Label style={{ marginBottom: "8px" }}>Deep Work</Label>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "8px" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: "22px", fontWeight: "700", color: "var(--acc)" }}>{fmtHHMM(goalMin)}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: todayDone ? "var(--grn)" : "var(--muted)" }}>
            {fmtHHMM(completedMin)}/{fmtHHMM(goalMin)}
          </span>
        </div>
        <PBar value={completedMin} max={goalMin} color={todayDone ? "var(--grn)" : "var(--acc)"} />
        <div style={{ display: "flex", gap: "6px", marginTop: "10px", flexWrap: "wrap" }}>
          {blocks.map((b, i) => {
            const done = i < doneBlocks.length;
            const active = i === nextIdx;
            return (
              <div key={b.id} style={{ padding: "6px 9px", borderRadius: "6px", fontSize: "11px", fontFamily: "var(--mono)", background: done ? "var(--grn)18" : active ? "var(--acc)18" : "var(--s2)", border: `1px solid ${done ? "var(--grn)55" : active ? "var(--acc)55" : "var(--b2)"}`, color: done ? "var(--grn)" : active ? "var(--acc)" : "var(--muted)" }}>
                {done ? "✓" : active ? "▶" : i + 1} <span style={{ opacity: 0.7 }}>{b.dur}dk</span>
              </div>
            );
          })}
        </div>
        {nextIdx < blocks.length && <BlockTimer block={blocks[nextIdx]} idx={nextIdx} onDone={onBlockDone} />}
        {todayDone && <div className="pi" style={{ marginTop: "10px", textAlign: "center", padding: "12px", background: "var(--grn)08", border: "1px solid var(--grn)33", borderRadius: "10px" }}><p style={{ fontFamily: "var(--mono)", color: "var(--grn)", fontWeight: "700" }}>HEDEF TAMAM</p></div>}
      </Card>

      <DailyPlanTab trials={trials} plans={plans} setPlans={setPlans} />

      <Card style={{ padding: "12px 14px" }}>
        <Label style={{ marginBottom: "8px" }}>Hizli Gorev</Label>
        <QuickTodoAdd todos={todos} onPushTodos={onPushTodos} />
      </Card>
    </div>
  );
}

function BlockTimer({ block, idx, onDone }) {
  const TOTAL = block.dur * 60;
  const [phase, setPhase] = useState("idle");
  const [elapsed, setEl] = useState(0);
  const [quote, setQuote] = useState(getQuote);
  const [breakReason, setBreakReason] = useState("");
  const itvRef = useRef(null);

  const start = useCallback(() => {
    setPhase("run");
    playSound("start");
    itvRef.current = setInterval(() => setEl((p) => p + 1), 1000);
  }, []);

  const stop = useCallback(() => clearInterval(itvRef.current), []);

  useEffect(() => () => stop(), [stop]);
  useEffect(() => {
    if (elapsed >= TOTAL && phase === "run") {
      stop();
      setPhase("done");
      onDone(block.dur, false, null);
      playSound("done");
    }
  }, [elapsed, TOTAL, phase, stop, onDone, block.dur]);
  useEffect(() => {
    if (phase === "run" && elapsed > 0 && elapsed % (15 * 60) === 0) setQuote(getQuote());
  }, [elapsed, phase]);

  const rem = Math.max(0, TOTAL - elapsed);
  const elMin = Math.floor(elapsed / 60);

  if (phase === "done") return null;
  if (phase === "idle")
    return (
      <div style={{ marginTop: "10px" }}>
        <Btn variant="primary" onClick={start} style={{ width: "100%", padding: "12px", fontSize: "13px" }}>
          Blok {idx + 1} baslat
        </Btn>
      </div>
    );

  if (phase === "warn")
    return (
      <Card style={{ marginTop: "10px", padding: "14px", background: "var(--red)06", border: "1px solid var(--red)44" }} className="flashR">
        <Label style={{ marginBottom: "6px" }}>Erken mola</Label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginBottom: "10px" }}>
          {BREAK_REASONS.map((r) => (
            <button key={r} onClick={() => setBreakReason(r)} style={{ padding: "4px 9px", borderRadius: "5px", border: `1px solid ${breakReason === r ? "var(--acc)" : "var(--b2)"}`, background: breakReason === r ? "var(--acc)22" : "transparent", color: breakReason === r ? "var(--acc)" : "var(--muted)", fontSize: "11px", cursor: "pointer" }}>
              {r}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <Btn variant="primary" style={{ flex: 2 }} onClick={() => (setPhase("run"), start())}>
            Devam
          </Btn>
          <Btn variant="danger" style={{ flex: 1 }} disabled={!breakReason} onClick={() => (setPhase("done"), onDone(elMin, true, { type: "early", blockMin: elMin, reason: breakReason, at: new Date().toISOString() }))}>
            Mola
          </Btn>
        </div>
      </Card>
    );

  return (
    <Card style={{ marginTop: "10px", padding: "14px", border: "1px solid var(--acc)22" }}>
      <Label style={{ marginBottom: "8px" }}>Odak modu</Label>
      <p style={{ fontFamily: "var(--mono)", fontSize: "20px", fontWeight: "700", marginBottom: "6px" }}>{fmtMMSS(rem)}</p>
      <p style={{ fontSize: "11px", color: "var(--muted)", fontStyle: "italic", lineHeight: "1.6" }}>"{quote}"</p>
      <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
        <Btn variant="ghost" onClick={() => (stop(), setPhase("warn"), playSound("warn"))} style={{ flex: 1 }}>
          Mola iste
        </Btn>
        <Btn variant="success" onClick={() => (stop(), setPhase("done"), onDone(elMin, false, null))} style={{ flex: 1 }}>
          Bitir
        </Btn>
      </div>
    </Card>
  );
}

function QuickTodoAdd({ todos, onPushTodos }) {
  const [text, setText] = useState("");
  const add = () => {
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    onPushTodos(lines.map((t) => ({ text: t, source: `BrainDump Quick (${fmtDate(todayStr())})`, priority: "medium", meta: { kind: "brain_quick", date: todayStr() } })));
    setText("");
    toast(`${lines.length} gorev eklendi`, "var(--grn)");
  };
  return (
    <div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Her satir bir gorev..." style={{ padding: "8px 10px", fontSize: "12px", width: "100%", resize: "vertical", lineHeight: "1.6", borderRadius: "6px" }} />
      <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
        <Btn variant="primary" onClick={add} disabled={!text.trim()} style={{ flex: 2 }}>
          Gorev ekle
        </Btn>
        <Btn variant="ghost" onClick={() => setText("")} disabled={!text.trim()} style={{ flex: 1 }}>
          Temizle
        </Btn>
      </div>
      <p style={{ fontSize: "10px", color: "var(--muted)", marginTop: "8px" }}>
        Aktif gorev: <span style={{ fontFamily: "var(--mono)", color: "var(--acc)" }}>{todos.filter((t) => !t.done).length}</span>
      </p>
    </div>
  );
}

// ============================================================================
// Daily plan (timer + delay reason)
// ============================================================================
function minsToHHMM(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function hhmmToMins(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function DailyPlanTab({ trials, plans, setPlans }) {
  const today = todayStr();
  const todayPlan = plans[today] || [];
  const weeklyRec = useMemo(() => buildWeeklyPlan(trials, 4), [trials]);
  const [activeId, setActiveId] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const itvRef = useRef(null);

  const startTimer = (id) => {
    setActiveId(id);
    setElapsed(0);
    playSound("start");
    itvRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);
  };
  const stopTimer = () => {
    clearInterval(itvRef.current);
    setActiveId(null);
  };
  useEffect(() => () => clearInterval(itvRef.current), []);

  const nowMin = nowHHMM();
  const overdue = todayPlan.filter((p) => !p.done && p.startMin + p.durationMin < nowMin);

  const [form, setForm] = useState({
    startMin: minsToHHMM(Math.ceil(nowMin / 30) * 30),
    dur: "75",
    subject: "",
    note: "",
  });
  const [addOpen, setAddOpen] = useState(false);
  const [delayModal, setDelayModal] = useState(null); // {id, delayedMin}

  const addItem = () => {
    if (!form.subject.trim()) return;
    const item = {
      id: uid(),
      startMin: hhmmToMins(form.startMin),
      durationMin: parseInt(form.dur, 10) || 75,
      subject: form.subject.trim(),
      note: form.note,
      done: false,
      doneAt: null,
      delayReason: "",
    };
    setPlans((p) => ({ ...p, [today]: [...(p[today] || []), item].sort((a, b) => a.startMin - b.startMin) }));
    setForm((f) => ({ ...f, subject: "", note: "" }));
    setAddOpen(false);
  };

  const markDone = (id) => {
    const item = todayPlan.find((x) => x.id === id);
    if (!item) return;
    const expectedEnd = item.startMin + item.durationMin;
    const delayedMin = Math.max(0, nowMin - expectedEnd);
    if (delayedMin > 15) {
      setDelayModal({ id, delayedMin });
      return;
    }
    setPlans((p) => ({ ...p, [today]: (p[today] || []).map((x) => (x.id === id ? { ...x, done: true, doneAt: new Date().toISOString() } : x)) }));
    stopTimer();
    playSound("done");
    toast("Plan ogesi tamamlandi!", "var(--grn)");
    const remaining = (plans[today] || []).filter((x) => !x.done && x.id !== id).length;
    if (remaining === 0) {
      grantXP("plan_done");
      toast(`+${XP_R.plan_done} XP — Plan tamam!`, "var(--acc)");
    }
  };

  const confirmDelay = (id, reason) => {
    setPlans((p) => ({ ...p, [today]: (p[today] || []).map((x) => (x.id === id ? { ...x, done: true, doneAt: new Date().toISOString(), delayReason: reason } : x)) }));
    setDelayModal(null);
    stopTimer();
    playSound("done");
  };

  const delItem = (id) => setPlans((p) => ({ ...p, [today]: (p[today] || []).filter((x) => x.id !== id) }));
  const completionPct = todayPlan.length > 0 ? Math.round((todayPlan.filter((x) => x.done).length / todayPlan.length) * 100) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {overdue.length > 0 && (
        <div className="flashR" style={{ padding: "11px 13px", background: "var(--red)08", border: "1px solid var(--red)44", borderRadius: "8px", display: "flex", gap: "10px", alignItems: "center" }}>
          <span style={{ fontSize: "16px" }}>⚡</span>
          <div>
            <p style={{ fontSize: "12px", fontWeight: "600", color: "var(--red)" }}>{overdue.length} plan ogesi gecikti</p>
            <p style={{ fontSize: "11px", color: "var(--muted)", marginTop: "1px" }}>{overdue.map((x) => x.subject).join(", ")}</p>
          </div>
        </div>
      )}

      {todayPlan.length > 0 && (
        <Card style={{ padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
            <Label>Bugunun Plani</Label>
            <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: completionPct === 100 ? "var(--grn)" : "var(--acc)" }}>{completionPct}%</span>
          </div>
          <PBar value={completionPct} max={100} color={completionPct === 100 ? "var(--grn)" : "var(--acc)"} />
        </Card>
      )}

      {weeklyRec.length > 0 && (
        <Card style={{ padding: "12px 14px" }}>
          <Label style={{ marginBottom: "8px" }}>Bugunku Oncelikler</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            {weeklyRec.slice(0, 4).map((w) => (
              <div key={w.subject} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", background: "var(--s2)", borderRadius: "6px" }}>
                <span style={{ fontSize: "12px" }}>{w.subject}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>{fmtHHMM(w.dailyMin)}/gun</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {todayPlan.length === 0 && !addOpen && <EmptyState icon="▦" title="Bugun icin plan yok" desc="Plan yap, zamana sahip cik." />}
        {todayPlan.map((item) => (
          <PlanItem key={item.id} item={item} nowMin={nowMin} activeId={activeId} elapsed={elapsed} onStart={() => startTimer(item.id)} onStop={stopTimer} onDone={() => markDone(item.id)} onDelete={() => delItem(item.id)} />
        ))}
      </div>

      {addOpen ? (
        <Card style={{ padding: "14px" }}>
          <Label style={{ marginBottom: "10px" }}>Yeni Plan Ogesi</Label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "8px" }}>
            <div>
              <Label style={{ marginBottom: "4px" }}>Saat</Label>
              <input type="time" value={form.startMin} onChange={(e) => setForm((f) => ({ ...f, startMin: e.target.value }))} style={{ padding: "7px 10px", fontSize: "13px", width: "100%", borderRadius: "6px" }} />
            </div>
            <div>
              <Label style={{ marginBottom: "4px" }}>Sure (dk)</Label>
              <select value={form.dur} onChange={(e) => setForm((f) => ({ ...f, dur: e.target.value }))} style={{ padding: "7px 10px", fontSize: "13px", width: "100%", borderRadius: "6px" }}>
                {[30, 45, 60, 75, 90, 120].map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ marginBottom: "8px" }}>
            <Label style={{ marginBottom: "4px" }}>Ders / Konu</Label>
            <input value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} placeholder="Matematik - Turev" style={{ padding: "8px 10px", fontSize: "13px", width: "100%", borderRadius: "6px" }} />
          </div>
          <div style={{ marginBottom: "12px" }}>
            <Label style={{ marginBottom: "4px" }}>Not</Label>
            <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="Konu detayi..." style={{ padding: "8px 10px", fontSize: "13px", width: "100%", borderRadius: "6px" }} />
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <Btn variant="ghost" onClick={() => setAddOpen(false)} style={{ flex: 1 }}>
              Iptal
            </Btn>
            <Btn variant="primary" onClick={addItem} style={{ flex: 2 }}>
              Planla
            </Btn>
          </div>
        </Card>
      ) : (
        <Btn variant="primary" onClick={() => setAddOpen(true)} style={{ width: "100%", padding: "11px" }}>
          + Plan Ogesi Ekle
        </Btn>
      )}

      {delayModal && <DelayModal delayedMin={delayModal.delayedMin} onConfirm={(r) => confirmDelay(delayModal.id, r)} onCancel={() => setDelayModal(null)} />}
    </div>
  );
}

function PlanItem({ item, nowMin, activeId, elapsed, onStart, onStop, onDone, onDelete }) {
  const isActive = activeId === item.id;
  const status = item.done ? "done" : isActive ? "active" : nowMin > item.startMin + item.durationMin ? "late" : "upcoming";
  const colMap = { done: "var(--grn)", active: "var(--acc)", late: "var(--red)", upcoming: "var(--muted)" };
  const col = colMap[status];
  const pct = isActive ? clamp(Math.round((elapsed / (item.durationMin * 60)) * 100), 0, 100) : item.done ? 100 : 0;
  const borderCss = status === "late" ? "var(--red)33" : status === "active" ? "var(--acc)33" : "var(--b2)";

  return (
    <div className="sr" style={{ padding: "11px 13px", borderRadius: "8px", background: "var(--s2)", border: `1px solid ${borderCss}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: isActive ? 8 : 0 }}>
        <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: col, minWidth: "38px", marginTop: "1px" }}>{minsToHHMM(item.startMin)}</span>
          <div>
            <p style={{ fontSize: "13px", fontWeight: "500", textDecoration: item.done ? "line-through" : "none", color: item.done ? "var(--muted)" : "var(--txt)" }}>{item.subject}</p>
            <div style={{ display: "flex", gap: "6px", marginTop: "3px", alignItems: "center" }}>
              <span style={{ fontSize: "10px", color: "var(--muted)" }}>{fmtHHMM(item.durationMin)}</span>
              {item.note && <span style={{ fontSize: "10px", color: "var(--muted)" }}>· {item.note}</span>}
              {status === "late" && <Tag color="var(--red)">Gecikmis</Tag>}
              {item.delayReason && <span style={{ fontSize: "10px", color: "var(--ora)" }}>· {item.delayReason}</span>}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
          {!item.done && !isActive && <Btn size="sm" variant="accent" onClick={onStart}>▶</Btn>}
          {isActive && <Btn size="sm" variant="success" onClick={onDone}>✓ Bitti</Btn>}
          {isActive && <Btn size="sm" variant="ghost" onClick={onStop} style={{ color: "var(--muted)" }}>◼</Btn>}
          {!item.done && !isActive && <Btn size="sm" variant="ghost" onClick={onDone} style={{ color: "var(--grn)" }}>✓</Btn>}
          <Btn size="sm" variant="ghost" onClick={onDelete} style={{ color: "var(--red)" }}>×</Btn>
        </div>
      </div>
      {isActive && (
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
          {["Dikkat dagildi", "Konu zor", "Teknoloji", "Yorgunluk", "Diger"].map((r) => (
            <button key={r} onClick={() => setReason(r)} style={{ padding: "8px 11px", borderRadius: "6px", border: `1px solid ${reason === r ? "var(--acc)" : "var(--b2)"}`, background: reason === r ? "var(--acc)18" : "transparent", color: reason === r ? "var(--acc)" : "var(--muted)", fontSize: "12px", textAlign: "left", cursor: "pointer" }}>
              {r}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <Btn variant="ghost" onClick={onCancel} style={{ flex: 1 }}>
            Iptal
          </Btn>
          <Btn variant="primary" onClick={() => onConfirm(reason || "Belirtilmedi")} style={{ flex: 2 }} disabled={!reason}>
            Kaydet
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Discipline tab: cross alerts + challenge + benchmark + check-in
// ============================================================================
const QS = [
  { id: "q1", text: "Bugun deneme analizi yaptin mi?", yes: "Analiz yaptin.", no: "Bu aksam analiz yap." },
  { id: "q2", text: "Bugun yanlislarini cozdun mu?", yes: "Iyi.", no: "Yanlis cozmeden ilerleme." },
  { id: "q3", text: "Bugun hedefledigin kadar calistin mi?", yes: "Plana sadik kaldin.", no: "Yarin net hedef koy." },
  { id: "q4", text: "Bugun zayif konuya zaman ayirdin mi?", yes: "Cesaret.", no: "Zayiflikla yuzles." },
];

const overallMsg = (s) => {
  if (s === 4) return { msg: "4/4. Mukemmel.", c: "var(--grn)" };
  if (s === 3) return { msg: "3/4. Iyi.", c: "var(--acc)" };
  if (s === 2) return { msg: "2/4. Orta.", c: "var(--acc)" };
  if (s === 1) return { msg: "1/4. Dusuk.", c: "var(--red)" };
  return { msg: "0/4. Kotu gun.", c: "var(--red)" };
};

function miniCoachMsg(score, attnScore, planPct, alerts) {
  if (alerts.todoOverdue > 0) return `Once gorev review: ${alerts.todoOverdue} gorev.`;
  if (alerts.planLate > 0) return `${alerts.planLate} plan ogesi gecikmis. Planini sadeleştir.`;
  if (score === 4 && attnScore >= 80 && planPct >= 80) return "Cok iyi gun. Devam.";
  if (attnScore < 60) return "Dikkat dusuk. Telefonu kapat, ortam degistir.";
  return "Tek bir seyi iyilestir.";
}

function calcBenchmark({ xp, dw, plans, checkins }) {
  const last7 = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const dwSessions = (dw?.sessions || []).filter((s) => last7.includes(s.date));
  const dwMin = dwSessions.reduce((s, x) => s + (x.completedMin || 0), 0);
  const dwGoalMin = dwSessions.reduce((s, x) => s + (x.goalMin || 0), 0);
  const dwRatio = dwGoalMin > 0 ? clamp(dwMin / dwGoalMin, 0, 1) : 0;
  const planItems = last7.flatMap((d) => plans?.[d] || []);
  const planDone = planItems.filter((p) => p.done).length;
  const planRatio = planItems.length > 0 ? planDone / planItems.length : 0;
  const ci = (checkins || []).filter((c) => last7.includes(c.date));
  const ciAvg = ci.length ? ci.reduce((s, c) => s + (c.score || 0), 0) / ci.length : 0;
  const xpScore = clamp((xp.points || 0) / 5000, 0, 1);
  const score = Math.round((xpScore * 35 + dwRatio * 35 + planRatio * 20 + (ciAvg / 4) * 10) * 100);
  const level = score >= 85 ? { name: "S", color: "var(--grn)" } : score >= 70 ? { name: "A", color: "var(--acc)" } : score >= 55 ? { name: "B", color: "var(--blu)" } : score >= 40 ? { name: "C", color: "var(--ora)" } : { name: "D", color: "var(--red)" };
  return { score, level, dwMin, planRatio, ciAvg };
}

function generateDailyChallenge({ date, trials, todos, plans }) {
  const seed = parseInt(date.split("-").join("").slice(-3), 10) || 0;
  const weekPlan = buildWeeklyPlan(trials, 4);
  const topWeak = weekPlan[0]?.subject;
  const overdueTodos = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0).length;
  const todayPlan = plans[date] || [];
  const planLate = todayPlan.filter((p) => !p.done && p.startMin + p.durationMin < nowHHMM()).length;
  const pool = [
    { id: `c_${date}_review`, title: "15dk Gorev Review", desc: "7 gun uyarili gorevleri bitir veya ertele.", kind: "todo_review" },
    { id: `c_${date}_plan`, title: "1 plan ogesi tamamla", desc: "En kucuk plan ogesini sec ve bitir.", kind: "plan_one" },
    { id: `c_${date}_block`, title: "1 Deep Work blok", desc: "Tek blok bile zinciri korur.", kind: "dw_block" },
    { id: `c_${date}_weak`, title: `${topWeak || "Zayif ders"} mini tekrar`, desc: `${topWeak || "Zayif ders"} icin 20dk mini tekrar.`, kind: "weak_20" },
  ];
  let pick = pool[seed % pool.length];
  if (overdueTodos > 0) pick = pool[0];
  else if (planLate > 0) pick = pool[1];
  return pick;
}

function DisciplineTab({ trials, todos }) {
  const today = todayStr();
  const [checkins, setCheckins] = useState(() => store.load(KEYS.checkins, []));
  const [ans, setAns] = useState(() => checkins.find((c) => c.date === today)?.answers || {});
  const [submitted, setSubmitted] = useState(() => !!checkins.find((c) => c.date === today));
  const [xpData, setXpData] = useState(loadXP);
  const startRef = useRef(Date.now());

  const attn = store.load(KEYS.attn, {});
  const todayAttn = attn[today];
  const attnScore = useMemo(() => calcAttentionScore(todayAttn?.breaks || []), [todayAttn]);
  const plans = store.load(KEYS.plan, {});
  const todayPlan = plans[today] || [];
  const planPct = todayPlan.length > 0 ? Math.round((todayPlan.filter((p) => p.done).length / todayPlan.length) * 100) : 0;

  const todoOverdue = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0).length;
  const planLate = todayPlan.filter((p) => !p.done && p.startMin + p.durationMin < nowHHMM()).length;
  const missingCheckin = checkins.find((c) => c.date === today) ? 0 : 1;
  const alerts = { todoOverdue, planLate, missingCheckin, lowAttn: attnScore < 60 ? 1 : 0 };

  const submit = () => {
    const elapsed = Math.round((Date.now() - startRef.current) / 1000);
    const score = QS.filter((q) => ans[q.id] === true).length;
    const entry = { date: today, answers: ans, score, elapsed, at: new Date().toISOString() };
    const updated = [entry, ...checkins.filter((c) => c.date !== today)];
    setCheckins(updated);
    store.save(KEYS.checkins, updated);
    setSubmitted(true);
    const t = score === 4 ? "checkin_4" : score >= 3 ? "checkin_3" : null;
    if (t) {
      const { pts } = grantXP(t);
      toast(`+${pts} XP — ${score}/4`, "var(--acc)");
      setXpData(loadXP());
    }
    if (elapsed > 60) toast("Check-in cok uzun surdu.", "var(--red)");
  };

  const score = QS.filter((q) => ans[q.id] === true).length;
  const all = QS.every((q) => ans[q.id] !== undefined);
  const om = overallMsg(score);

  // Daily challenge
  const [challenge, setChallengeRaw] = useState(() => store.load(KEYS.challenge, {}));
  const setChallenge = useCallback((fn) => {
    setChallengeRaw((p) => {
      const n = typeof fn === "function" ? fn(p) : fn;
      store.save(KEYS.challenge, n);
      return n;
    });
  }, []);

  const todaysChallenge = useMemo(() => {
    const existing = challenge?.[today];
    if (existing?.id) return existing;
    const gen = generateDailyChallenge({ date: today, trials, todos, plans });
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

  const dw = store.load(KEYS.dw, DW_DEFAULT);
  const bench = useMemo(() => calcBenchmark({ xp: xpData, dw, plans, checkins }), [xpData, dw, plans, checkins]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <Card style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
          <div>
            <Label style={{ marginBottom: "2px" }}>Disiplin Puani</Label>
            <span style={{ fontFamily: "var(--mono)", fontSize: "22px", fontWeight: "700", color: "var(--acc)" }}>{xpData.points} XP</span>
          </div>
          <div style={{ textAlign: "right" }}>
            {xpData.streak > 0 && <p style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--acc)" }}>🔥 {xpData.streak}g</p>}
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

      {(todoOverdue + planLate + missingCheckin) > 0 && (
        <Card style={{ padding: "12px 14px", border: "1px solid var(--red)22" }}>
          <Label style={{ marginBottom: "8px" }}>Cross-Module Uyarilar</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {todoOverdue > 0 && <div style={{ display: "flex", justifyContent: "space-between", background: "var(--s2)", borderRadius: "6px", padding: "8px 10px" }}><span style={{ fontSize: "12px" }}>⚡ Gorev review</span><Tag color="var(--acc)">{todoOverdue}</Tag></div>}
            {planLate > 0 && <div style={{ display: "flex", justifyContent: "space-between", background: "var(--s2)", borderRadius: "6px", padding: "8px 10px" }}><span style={{ fontSize: "12px" }}>⚡ Plan gecikmesi</span><Tag color="var(--red)">{planLate}</Tag></div>}
            {missingCheckin > 0 && <div style={{ display: "flex", justifyContent: "space-between", background: "var(--s2)", borderRadius: "6px", padding: "8px 10px" }}><span style={{ fontSize: "12px" }}>⚡ Check-in eksik</span><Tag color="var(--red)">bugun</Tag></div>}
          </div>
        </Card>
      )}

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
            <Btn variant="ghost" onClick={() => (playSound("start"), toast("Challenge modu: 15 dk odak!", "var(--acc)"))} style={{ flex: 1 }}>
              Basla
            </Btn>
          </div>
        </div>
      </Card>

      <Card style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <Label>Offline Benchmark</Label>
          <Tag color={bench.level.color}>Seviye {bench.level.name}</Tag>
        </div>
        <PBar value={bench.score} max={100} color={bench.level.color} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "7px", marginTop: "10px" }}>
          {[
            { l: "DW 7g", v: fmtHHMM(bench.dwMin), c: "var(--blu)" },
            { l: "Plan", v: `%${Math.round(bench.planRatio * 100)}`, c: bench.planRatio >= 0.7 ? "var(--grn)" : "var(--acc)" },
            { l: "CI", v: bench.ciAvg ? `${bench.ciAvg.toFixed(1)}/4` : "—", c: bench.ciAvg >= 3 ? "var(--grn)" : "var(--acc)" },
          ].map((x) => (
            <Card key={x.l} style={{ padding: "10px", textAlign: "center" }}>
              <p style={{ fontFamily: "var(--mono)", fontSize: "16px", fontWeight: "700", color: x.c, lineHeight: 1 }}>{x.v}</p>
              <p style={{ fontSize: "9px", color: "var(--muted)", marginTop: "3px" }}>{x.l}</p>
            </Card>
          ))}
        </div>
      </Card>

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
                    const c = v ? "var(--grn)" : "var(--red)";
                    return (
                      <button key={String(v)} onClick={() => !submitted && setAns((p) => ({ ...p, [q.id]: v }))} disabled={submitted} style={{ flex: 1, padding: "6px", borderRadius: "5px", border: `1px solid ${sel ? c : "var(--b2)"}`, background: sel ? `${c}22` : "transparent", color: sel ? c : "var(--muted)", fontSize: "12px", fontWeight: "600", cursor: submitted ? "default" : "pointer" }}>
                        {v ? "Evet" : "Hayir"}
                      </button>
                    );
                  })}
                </div>
                {a !== undefined && <p className="fi" style={{ fontSize: "10px", color: a ? "var(--grn)" : "var(--red)", marginTop: "6px", lineHeight: "1.5", fontStyle: "italic" }}>→ {a ? q.yes : q.no}</p>}
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
            <p style={{ fontSize: "11px", color: "var(--muted)", lineHeight: "1.5" }}>{miniCoachMsg(score, attnScore, planPct, alerts)}</p>
          </div>
        )}
      </Card>
    </div>
  );
}

// ============================================================================
// App
// ============================================================================
export default function App() {
  const [tab, setTab] = useState("brain");
  const [trials, setTrials] = useState(() => store.load(KEYS.trials, []));
  const [todos, setTodos] = useState(() => store.load(KEYS.todos, []));
  const [heatOpen, setHeat] = useState(false);
  const [xp, setXp] = useState(loadXP);
  const toasts = useToastSystem();

  useEffect(() => {
    const id = setInterval(() => setXp(loadXP()), 4000);
    return () => clearInterval(id);
  }, []);

  const pushTodos = useCallback((items) => {
    const now = new Date().toISOString();
    const mapped = (items || [])
      .map((i) => ({
        id: uid(),
        text: i.text,
        source: i.source || "Import",
        priority: i.priority || "medium",
        done: false,
        reviewed: false,
        createdAt: now,
        reviewAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        meta: i.meta || {},
      }))
      .filter((x) => x.text && x.text.trim());
    if (!mapped.length) return;
    setTodos((prev) => {
      const next = [...mapped, ...prev];
      store.save(KEYS.todos, next);
      return next;
    });
  }, []);

  const dwData = useMemo(() => store.load(KEYS.dw, DW_DEFAULT), [tab]);
  const checkins = useMemo(() => store.load(KEYS.checkins, []), [tab]);

  const alerts = useMemo(() => {
    const today = todayStr();
    const plan = store.load(KEYS.plan, {});
    const todayPlan = plan[today] || [];
    const planLate = todayPlan.filter((p) => !p.done && p.startMin + p.durationMin < nowHHMM()).length;
    const todoOverdue = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0).length;
    const missingCheckin = checkins.find((c) => c.date === today) ? 0 : 1;
    return { todos: todoOverdue, discipline: missingCheckin, brain: planLate, trials: 0 };
  }, [todos, checkins, tab]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: "var(--sans)", display: "flex", justifyContent: "center", padding: "24px 12px 80px" }}>
      <style>{CSS}</style>
      <div style={{ width: "100%", maxWidth: "540px" }}>
        <Header tab={tab} onToggleHeat={() => setHeat((p) => !p)} heatOpen={heatOpen} alerts={alerts} xp={xp} />
        {heatOpen && (
          <div className="fi" style={{ marginBottom: "14px" }}>
            <Card style={{ padding: "13px 14px" }}>
              <Heatmap sessions={dwData.sessions || []} trials={trials} checkins={checkins} />
            </Card>
          </div>
        )}
        <TabBar active={tab} onChange={setTab} alerts={alerts} />
        <div className="fu" key={tab}>
          {tab === "trials" && <TrialsTab trials={trials} setTrials={setTrials} onPushTodos={pushTodos} />}
          {tab === "brain" && <BrainDumpTab trials={trials} todos={todos} onPushTodos={pushTodos} />}
          {tab === "todos" && <TodosTab todos={todos} setTodos={setTodos} />}
          {tab === "discipline" && <DisciplineTab trials={trials} todos={todos} />}
        </div>
      </div>
      <ToastLayer toasts={toasts} />
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ============================================================================
// Storage (keep existing keys)
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
  challenge: "yks_challenge", // only new key allowed
};

const store = {
  load: (k, fb) => {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : fb;
    } catch {
      return fb;
    }
  },
  save: (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // ignore
    }
  },
};

// ============================================================================
// Utils / constants
// ============================================================================
const YKS_DATE = new Date("2026-06-21T09:00:00");
const todayStr = () => new Date().toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const daysFrom = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
const fmtMMSS = (s) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const fmtHHMM = (m) => {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h > 0) return `${h}s${r > 0 ? ` ${r}dk` : ""}`;
  if (r > 0) return `${r}dk`;
  return "0dk";
};
const fmtDate = (iso) => new Date(iso).toLocaleDateString("tr-TR", { day: "2-digit", month: "short" });
const nowHHMM = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

const TYT_SUBS = ["Turkce", "Matematik", "Fizik", "Kimya", "Biyoloji", "Tarih", "Cografya", "Felsefe", "Din"];
const AYT_SUBS = ["Matematik", "Fizik", "Kimya", "Biyoloji", "Edebiyat", "Tarih", "Cografya", "Felsefe"];
const calcNet = (d, y) => Math.max(0, parseFloat(d || 0) - parseFloat(y || 0) / 4);

function yksCountdown() {
  const diff = YKS_DATE.getTime() - Date.now();
  if (diff <= 0) return { days: 0, hours: 0, passed: true };
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  return { days, hours, passed: false };
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
      const o = ctx.createOscillator();
      o.connect(g);
      o.frequency.setValueAtTime(880, ctx.currentTime);
      o.frequency.setValueAtTime(1100, ctx.currentTime + 0.12);
      g.gain.setValueAtTime(0.3, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      o.start();
      o.stop(ctx.currentTime + 0.35);
    } else if (type === "done") {
      [0, 0.15, 0.3].forEach((t, i) => {
        const o = ctx.createOscillator();
        o.connect(g);
        o.frequency.value = [660, 880, 1100][i];
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.12);
      });
      g.gain.setValueAtTime(0.25, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    } else if (type === "warn") {
      const o = ctx.createOscillator();
      o.connect(g);
      o.frequency.value = 300;
      g.gain.setValueAtTime(0.4, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      o.start();
      o.stop(ctx.currentTime + 0.4);
    }
  } catch {
    // ignore
  }
}

// ============================================================================
// XP / gamification
// ============================================================================
const XP_R = {
  block_done: 50,
  trial_added: 30,
  todo_done: 15,
  checkin_4: 100,
  checkin_3: 60,
  plan_done: 80,
  challenge_done: 120,
};

const BADGES = [
  { id: "first_block", label: "Ilk Blok", icon: "▶", req: (x) => x.totalBlocks >= 1 },
  { id: "week_streak", label: "7 Gun Seri", icon: "🔥", req: (x) => x.streak >= 7 },
  { id: "trial_ace", label: "Deneme Ustu", icon: "◉", req: (x) => x.totalTrials >= 5 },
  { id: "discipline", label: "Demir Irade", icon: "◆", req: (x) => x.perfect4 >= 3 },
  { id: "centurion", label: "100 Blok", icon: "⬛", req: (x) => x.totalBlocks >= 100 },
  { id: "planner", label: "Planci", icon: "▦", req: (x) => x.plansDone >= 7 },
  { id: "challenger", label: "Challenger", icon: "✦", req: (x) => (x.challengesDone || 0) >= 7 },
];

const loadXP = () =>
  store.load(KEYS.xp, {
    points: 0,
    streak: 0,
    totalBlocks: 0,
    totalTrials: 0,
    perfect4: 0,
    plansDone: 0,
    challengesDone: 0,
    badges: [],
    lastDate: "",
  });

const saveXP = (x) => store.save(KEYS.xp, x);

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
  BADGES.forEach((b) => {
    if (!xp.badges.includes(b.id) && b.req(xp)) xp.badges.push(b.id);
  });
  saveXP(xp);
  return { pts, xp };
}

// ============================================================================
// Attention tracking
// ============================================================================
const BREAK_REASONS = ["Dikkat dagildi", "Yorgun hissettim", "Telefon kontrolu", "Su/Yiyecek", "Tuvalet", "Planli mola", "Diger"];

function calcAttentionScore(breaks) {
  if (!breaks || !breaks.length) return 100;
  const early = breaks.filter((b) => b.type === "early").length;
  const ratio = early / breaks.length;
  const avgBlock = breaks.reduce((s, b) => s + (b.blockMin || 0), 0) / breaks.length;
  let score = 100 - ratio * 40 - Math.max(0, 60 - avgBlock) * 0.5;
  return Math.round(clamp(score, 0, 100));
}

function attentionLabel(score) {
  if (score >= 85) return { label: "Yuksek Dikkat", color: "var(--grn)" };
  if (score >= 60) return { label: "Orta Dikkat", color: "var(--acc)" };
  return { label: "Dusuk Dikkat", color: "var(--red)" };
}

// ============================================================================
// Trials -> weekly plan
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

// ============================================================================
// Styles
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
.fu{animation:fadeUp .2s ease both}
.fi{animation:fadeIn .15s ease both}
.sr{animation:slideR .18s ease both}
.pi{animation:popIn .28s cubic-bezier(.34,1.56,.64,1) both}
.flashY{animation:flashY .6s ease}
.flashR{animation:flashR .6s ease}
.reward{animation:flashY .6s ease, popIn .28s cubic-bezier(.34,1.56,.64,1) both}`;

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
    <div
      style={{
        position: "fixed",
        bottom: "24px",
        right: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        zIndex: 9999,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pi"
          style={{
            background: "var(--s1)",
            border: `1px solid ${t.color}55`,
            borderLeft: `3px solid ${t.color}`,
            padding: "10px 14px",
            borderRadius: "8px",
            fontSize: "12px",
            color: t.color,
            fontFamily: "var(--mono)",
            maxWidth: "260px",
            lineHeight: "1.4",
            boxShadow: "0 8px 24px rgba(0,0,0,.5)",
          }}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// UI primitives
// ============================================================================
const Card = ({ children, style, className }) => (
  <div
    className={className}
    style={{
      background: "var(--s1)",
      border: "1px solid var(--b1)",
      borderRadius: "10px",
      padding: "16px",
      ...style,
    }}
  >
    {children}
  </div>
);

const Label = ({ children, style }) => (
  <p
    style={{
      fontFamily: "var(--mono)",
      fontSize: "10px",
      fontWeight: "600",
      color: "var(--muted)",
      letterSpacing: "1.5px",
      textTransform: "uppercase",
      ...style,
    }}
  >
    {children}
  </p>
);

const Btn = ({ children, onClick, variant = "default", size = "md", disabled, style, title }) => {
  const V = {
    default: { background: "var(--s2)", color: "var(--txt)", border: "1px solid var(--b2)" },
    primary: { background: "var(--acc)", color: "#000", fontWeight: "600" },
    danger: { background: "transparent", color: "var(--red)", border: "1px solid var(--red)44" },
    ghost: { background: "transparent", color: "var(--muted)" },
    success: { background: "transparent", color: "var(--grn)", border: "1px solid var(--grn)44" },
    accent: { background: "var(--acc)18", color: "var(--acc)", border: "1px solid var(--acc)33" },
  };
  const S = {
    sm: { padding: "4px 10px", fontSize: "11px", borderRadius: "5px" },
    md: { padding: "8px 15px", fontSize: "13px", borderRadius: "7px" },
    lg: { padding: "12px 22px", fontSize: "14px", borderRadius: "8px", fontWeight: "600" },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...V[variant],
        ...S[size],
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
};

const Tag = ({ children, color = "var(--acc)" }) => (
  <span
    style={{
      fontFamily: "var(--mono)",
      fontSize: "10px",
      fontWeight: "600",
      padding: "2px 7px",
      borderRadius: "4px",
      background: `${color}18`,
      color,
      letterSpacing: "0.5px",
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </span>
);

const PBar = ({ value, max, color = "var(--acc)", h = 5 }) => {
  const pct = max > 0 ? clamp((value / max) * 100, 0, 100) : 0;
  return (
    <div style={{ height: h, background: "var(--b1)", borderRadius: "999px", overflow: "hidden" }}>
      <div
        style={{
          height: "100%",
          width: `${pct}%`,
          background: color,
          borderRadius: "999px",
          transition: "width .8s ease",
        }}
      />
    </div>
  );
};

// ============================================================================
// Header + small widgets
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
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: "11px",
          color: "var(--red)",
          animation: "countdown 2s ease infinite",
          fontWeight: "700",
        }}
      >
        {days}G
      </span>
      <span style={{ fontSize: "10px", color: "var(--muted)" }}>{hours}s</span>
    </div>
  );
}

function Heatmap({ sessions, trials, checkins }) {
  const cells = useMemo(() => {
    const dMap = {};
    const cMap = {};
    const tMap = {};
    (sessions || []).forEach((s) => {
      dMap[s.date] = s.completedMin || 0;
    });
    (checkins || []).forEach((c) => {
      cMap[c.date] = c.score;
    });
    (trials || []).forEach((t) => {
      tMap[t.date] = (tMap[t.date] || 0) + 1;
    });
    return Array.from({ length: 84 }, (_, i) => {
      const key = new Date(Date.now() - (83 - i) * 86400000).toISOString().slice(0, 10);
      const score = clamp(
        Math.floor((dMap[key] || 0) / 60) + ((cMap[key] ?? -1) >= 3 ? 1 : 0) + (tMap[key] || 0),
        0,
        4,
      );
      return { key, score, isToday: key === todayStr() };
    });
  }, [sessions, trials, checkins]);

  const colors = ["var(--b2)", "#1a3a2a", "#2a5a3a", "#3a8a5a", "var(--grn)"];
  return (
    <div>
      <Label style={{ marginBottom: "8px" }}>12 Haftalik Aktivite</Label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(84,1fr)", gap: "2px" }}>
        {cells.map((c) => (
          <div
            key={c.key}
            title={c.key}
            style={{
              aspectRatio: "1",
              borderRadius: "2px",
              background: colors[c.score],
              outline: c.isToday ? "1px solid var(--acc)" : "none",
              outlineOffset: "1px",
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", gap: "5px", alignItems: "center", marginTop: "6px", justifyContent: "flex-end" }}>
        <span style={{ fontSize: "9px", color: "var(--muted)" }}>az</span>
        {colors.map((c, i) => (
          <div key={i} style={{ width: "9px", height: "9px", background: c, borderRadius: "2px" }} />
        ))}
        <span style={{ fontSize: "9px", color: "var(--muted)" }}>cok</span>
      </div>
    </div>
  );
}

function Header({ tab, onToggleHeat, heatOpen, alerts, xp }) {
  const today = todayStr();
  const checkins = store.load(KEYS.checkins, []);
  const todayCI = checkins.find((c) => c.date === today);
  return (
    <div style={{ marginBottom: "18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
        <div>
          <h1 style={{ fontFamily: "var(--mono)", fontSize: "16px", fontWeight: "700", letterSpacing: "-0.5px" }}>
            YKS · SAVAS ODASI
          </h1>
          <p style={{ fontSize: "10px", color: "var(--muted)", marginTop: "2px", fontFamily: "var(--mono)" }}>
            {new Date().toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" })}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
          <YKSCountdown />
          <button
            onClick={onToggleHeat}
            title="Heatmap"
            style={{
              padding: "4px 8px",
              fontSize: "9px",
              fontFamily: "var(--mono)",
              background: "var(--s1)",
              border: "1px solid var(--b2)",
              borderRadius: "4px",
              color: heatOpen ? "var(--acc)" : "var(--muted)",
              cursor: "pointer",
            }}
          >
            ▦
          </button>
          {!todayCI ? (
            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <span
                style={{
                  width: "5px",
                  height: "5px",
                  borderRadius: "50%",
                  background: "var(--red)",
                  display: "inline-block",
                  animation: "blink 1.5s ease infinite",
                }}
              />
              <span style={{ fontSize: "9px", color: "var(--red)", fontFamily: "var(--mono)" }}>check-in</span>
            </div>
          ) : (
            <Tag color={todayCI.score >= 3 ? "var(--grn)" : "var(--acc)"}>{todayCI.score}/4</Tag>
          )}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "6px" }}>
        {[
          { l: "Tab", v: tab, c: "var(--muted)" },
          { l: "Uyari", v: Object.values(alerts).reduce((s, n) => s + (n || 0), 0), c: "var(--red)" },
          { l: "Streak", v: xp.streak || 0, c: "var(--acc)" },
          { l: "XP", v: xp.points, c: "var(--pur)" },
        ].map(({ l, v, c }) => (
          <div key={l} style={{ padding: "8px 9px", background: "var(--s1)", border: "1px solid var(--b1)", borderRadius: "7px", textAlign: "center" }}>
            <p style={{ fontFamily: "var(--mono)", fontSize: "16px", fontWeight: "700", color: c, lineHeight: 1 }}>{v}</p>
            <p style={{ fontSize: "9px", color: "var(--muted)", marginTop: "2px", letterSpacing: "0.5px" }}>{l}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Tabs
// ============================================================================
const TABS = [
  { key: "trials", icon: "◉", label: "Denemeler" },
  { key: "brain", icon: "▦", label: "BrainDump" },
  { key: "todos", icon: "◻", label: "Gorevler" },
  { key: "discipline", icon: "◆", label: "Disiplin" },
];

function TabBar({ active, onChange, alerts }) {
  return (
    <div style={{ display: "flex", gap: "2px", padding: "4px", background: "var(--s1)", borderRadius: "10px", border: "1px solid var(--b1)", marginBottom: "20px" }}>
      {TABS.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          style={{
            flex: 1,
            padding: "7px 2px",
            borderRadius: "7px",
            fontFamily: "var(--sans)",
            fontSize: "9px",
            fontWeight: "600",
            letterSpacing: "0.3px",
            background: active === t.key ? "var(--acc)" : "transparent",
            color: active === t.key ? "#000" : "var(--muted)",
            position: "relative",
            transition: "all .15s",
          }}
        >
          <span style={{ display: "block", fontFamily: "var(--mono)", fontSize: "12px", marginBottom: "2px" }}>{t.icon}</span>
          {t.label}
          {(alerts?.[t.key] || 0) > 0 && (
            <span
              style={{
                position: "absolute",
                top: "4px",
                right: "5px",
                width: "5px",
                height: "5px",
                borderRadius: "50%",
                background: "var(--red)",
                display: "block",
                animation: "blink 1.5s ease infinite",
              }}
            />
          )}
        </button>
      ))}
    </div>
  );
}

// ============================================================================
// Todos tab
// ============================================================================
const PRIOS = {
  high: { l: "Acil", c: "var(--red)" },
  medium: { l: "Orta", c: "var(--acc)" },
  low: { l: "Dusuk", c: "var(--muted)" },
};

function TodosTab({ todos, setTodos }) {
  const [text, setText] = useState("");
  const [prio, setPrio] = useState("high");
  const [filt, setFilt] = useState("active");

  const overdue = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0);
  const add = () => {
    if (!text.trim()) return;
    const u = [
      {
        id: uid(),
        text: text.trim(),
        source: "Manuel",
        priority: prio,
        done: false,
        reviewed: false,
        createdAt: new Date().toISOString(),
        reviewAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      },
      ...todos,
    ];
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
      grantXP("todo_done");
      toast(`+${XP_R.todo_done} XP`, "var(--grn)");
    }
  };
  const del = (id) => {
    const u = todos.filter((t) => t.id !== id);
    setTodos(u);
    store.save(KEYS.todos, u);
  };
  const snooze = (id) => {
    const u = todos.map((t) =>
      t.id === id ? { ...t, reviewAt: new Date(Date.now() + 7 * 86400000).toISOString(), reviewed: true } : t,
    );
    setTodos(u);
    store.save(KEYS.todos, u);
  };

  const list = useMemo(() => {
    if (filt === "active") return todos.filter((t) => !t.done);
    if (filt === "done") return todos.filter((t) => t.done);
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
          <Btn size="sm" variant="accent" onClick={() => setFilt("review")}>
            Goster
          </Btn>
        </div>
      )}

      <Card style={{ padding: "11px" }}>
        <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="Yeni gorev..."
            style={{ flex: 1, padding: "7px 10px", fontSize: "12px", borderRadius: "6px" }}
          />
          <Btn variant="primary" onClick={add}>
            Ekle
          </Btn>
        </div>
        <div style={{ display: "flex", gap: "4px" }}>
          {Object.entries(PRIOS).map(([k, { l, c }]) => (
            <button
              key={k}
              onClick={() => setPrio(k)}
              style={{
                padding: "3px 8px",
                borderRadius: "4px",
                border: "1px solid",
                fontSize: "10px",
                cursor: "pointer",
                borderColor: prio === k ? c : "var(--b2)",
                background: prio === k ? `${c}22` : "transparent",
                color: prio === k ? c : "var(--muted)",
              }}
            >
              {l}
            </button>
          ))}
        </div>
      </Card>

      <div style={{ display: "flex", gap: "4px" }}>
        {[
          ["active", "Aktif"],
          ["review", "⚡"],
          ["done", "Tamam"],
          ["all", "Tumu"],
        ].map(([k, l]) => (
          <button
            key={k}
            onClick={() => setFilt(k)}
            style={{
              padding: "4px 9px",
              borderRadius: "5px",
              border: "1px solid",
              fontSize: "10px",
              cursor: "pointer",
              borderColor: filt === k ? "var(--acc)" : "var(--b2)",
              background: filt === k ? "var(--acc)18" : "transparent",
              color: filt === k ? "var(--acc)" : "var(--muted)",
              position: "relative",
            }}
          >
            {l}
            {k === "review" && overdue.length > 0 && (
              <span style={{ marginLeft: "3px", background: "var(--red)", borderRadius: "50%", width: "12px", height: "12px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "8px", color: "#fff" }}>
                {overdue.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <EmptyState icon="◻" title="Gorev yok" desc="Temiz liste, net zihin." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          {list.map((t) => (
            <div key={t.id} className="sr" style={{ display: "flex", alignItems: "flex-start", gap: "9px", padding: "9px 11px", borderRadius: "7px", background: "var(--s2)", border: `1px solid ${t.reviewAt && daysFrom(t.reviewAt) >= 0 && !t.done && !t.reviewed ? "var(--acc)44" : "var(--b2)"}` }}>
              <button
                onClick={() => toggle(t.id)}
                style={{
                  width: "15px",
                  height: "15px",
                  borderRadius: "3px",
                  flexShrink: 0,
                  marginTop: "2px",
                  background: t.done ? "var(--grn)" : "transparent",
                  border: `2px solid ${t.done ? "var(--grn)" : "var(--b2)"}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
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
                  <Btn size="sm" variant="ghost" onClick={() => snooze(t.id)} style={{ color: "var(--acc)" }} title="Ertele">
                    ↻
                  </Btn>
                )}
                <Btn size="sm" variant="ghost" onClick={() => del(t.id)} style={{ color: "var(--red)" }} title="Sil">
                  ×
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Trials tab (TYT/AYT + optimization + standardized todo transfer)
// ============================================================================
function TrialsTab({ trials, setTrials, onPushTodos }) {
  const [adding, setAdding] = useState(false);
  const [showOpt, setShowOpt] = useState(false);

  const save = (t) => {
    const updated = [t, ...trials];
    setTrials(updated);
    store.save(KEYS.trials, updated);
    grantXP("trial_added");
    toast(`Deneme kaydedildi — ${t.totalNet} net`, "var(--blu)");

    if (t.todos?.length) {
      const mapped = t.todos.map((text) => ({
        text,
        source: `${t.type} (${fmtDate(t.date)})`,
        priority: "high",
        meta: { kind: "trial", trialId: t.id, trialType: t.type, trialDate: t.date },
      }));
      onPushTodos(mapped);
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

  const weekPlan = useMemo(() => buildWeeklyPlan(trials, 4), [trials]);
  const weakness = useMemo(() => buildSubjectWeakness(trials).slice(0, 8), [trials]);
  const strengths = useMemo(() => {
    const all = [];
    trials.forEach((t) => (t.nets || []).forEach((n) => all.push({ ...n, type: t.type, date: t.date })));
    const by = {};
    all.forEach((n) => {
      if (!by[n.subject]) by[n.subject] = { sum: 0, count: 0 };
      by[n.subject].sum += n.net;
      by[n.subject].count += 1;
    });
    return Object.entries(by)
      .map(([subject, d]) => ({ subject, avg: d.sum / d.count }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 6);
  }, [trials]);

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
                {d !== null && (
                  <p style={{ fontFamily: "var(--mono)", fontSize: "10px", marginTop: "2px", color: d >= 0 ? "var(--grn)" : "var(--red)" }}>
                    {d >= 0 ? "▲" : "▼"} {Math.abs(d).toFixed(1)}
                  </p>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {(weakness.length > 0 || strengths.length > 0) && (
        <Card style={{ padding: "13px" }}>
          <Label style={{ marginBottom: "8px" }}>Genel Analiz (Tum Denemeler)</Label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            <div>
              <Label style={{ color: "var(--red)", marginBottom: "6px" }}>Zayiflar</Label>
              <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                {weakness.slice(0, 6).map((w) => (
                  <div key={w.subject} style={{ display: "flex", justifyContent: "space-between", padding: "6px 9px", background: "var(--s2)", borderRadius: "6px", border: "1px solid var(--red)22" }}>
                    <span style={{ fontSize: "12px" }}>{w.subject}</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: w.gap > 0 ? "var(--red)" : "var(--muted)" }}>{w.gap > 0 ? `+${w.gap.toFixed(1)} acik` : "hedef yok"}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <Label style={{ color: "var(--grn)", marginBottom: "6px" }}>Gucluler</Label>
              <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                {strengths.map((s) => (
                  <div key={s.subject} style={{ display: "flex", justifyContent: "space-between", padding: "6px 9px", background: "var(--s2)", borderRadius: "6px", border: "1px solid var(--grn)22" }}>
                    <span style={{ fontSize: "12px" }}>{s.subject}</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--grn)" }}>{s.avg.toFixed(1)} ort</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>
      )}

      {weekPlan.length > 0 && (
        <div>
          <button
            onClick={() => setShowOpt((p) => !p)}
            style={{ fontSize: "11px", color: "var(--acc)", background: "none", border: "none", cursor: "pointer", marginBottom: "6px", display: "flex", alignItems: "center", gap: "5px" }}
          >
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
              <p style={{ fontSize: "10px", color: "var(--muted)", marginTop: "8px", lineHeight: "1.5" }}>
                Kirmizi = hedef acigi buyuk. Bu derslere gunluk onerilen sure ayir.
              </p>
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
        <Btn variant="primary" onClick={() => setAdding(true)} style={{ width: "100%", padding: "11px" }}>
          + Deneme Ekle
        </Btn>
      )}

      {!adding && trials.length === 0 && <EmptyState icon="◉" title="Henuz deneme yok" desc="Ilk denemeyi ekle ve analiz et." />}
      {!adding && trials.map((t) => <TrialCard key={t.id} trial={t} onDelete={del} onPushTodos={onPushTodos} />)}
    </div>
  );
}

function TrialForm({ onSave, onCancel }) {
  const [date, setDate] = useState(todayStr());
  const [type, setType] = useState("TYT");
  const [nets, setNets] = useState({});
  const [targets, setTargets] = useState({});
  const [err, setErr] = useState("");
  const [todos, setTodos] = useState("");
  const subs = type === "TYT" ? TYT_SUBS : AYT_SUBS;
  const setN = (s, f, v) => setNets((p) => ({ ...p, [s]: { ...(p[s] || {}), [f]: v } }));
  const totalNet = subs.reduce((sum, s) => sum + calcNet(nets[s]?.d, nets[s]?.y), 0);

  const handleSave = () => {
    const list = subs
      .map((s) => ({
        subject: s,
        correct: parseFloat(nets[s]?.d || 0),
        wrong: parseFloat(nets[s]?.y || 0),
        net: calcNet(nets[s]?.d, nets[s]?.y),
        target: parseFloat(targets[s] || 0),
      }))
      .filter((n) => n.correct > 0 || n.wrong > 0);
    if (!list.length) {
      alert("En az bir ders gir.");
      return;
    }
    onSave({
      id: uid(),
      date,
      type,
      nets: list,
      totalNet: parseFloat(totalNet.toFixed(2)),
      errorAnalysis: err,
      todos: todos
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean),
      createdAt: new Date().toISOString(),
    });
  };

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
            <option>TYT</option>
            <option>AYT</option>
          </select>
        </div>
        <div style={{ textAlign: "right", paddingTop: "16px" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: "18px", fontWeight: "700", color: "var(--acc)" }}>{totalNet.toFixed(1)}</span>
          <p style={{ fontSize: "9px", color: "var(--muted)" }}>net</p>
        </div>
      </div>

      <div>
        <Label style={{ marginBottom: "7px" }}>Netler D/Y + Hedef</Label>
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
                  <input type="number" min="0" placeholder="D" value={nets[s]?.d || ""} onChange={(e) => setN(s, "d", e.target.value)} style={{ flex: 1, padding: "3px 5px", fontSize: "10px", textAlign: "center", borderRadius: "4px", color: "var(--grn)" }} />
                  <input type="number" min="0" placeholder="Y" value={nets[s]?.y || ""} onChange={(e) => setN(s, "y", e.target.value)} style={{ flex: 1, padding: "3px 5px", fontSize: "10px", textAlign: "center", borderRadius: "4px", color: "var(--red)" }} />
                  <input type="number" min="0" placeholder="H" value={targets[s] || ""} onChange={(e) => setTargets((p) => ({ ...p, [s]: e.target.value }))} style={{ flex: 1, padding: "3px 5px", fontSize: "10px", textAlign: "center", borderRadius: "4px", color: "var(--muted)" }} />
                </div>
              </div>
            );
          })}
        </div>
        <p style={{ fontSize: "9px", color: "var(--muted)", marginTop: "4px" }}>D=Dogru · Y=Yanlis · H=Hedef</p>
      </div>

      <div>
        <Label style={{ marginBottom: "4px" }}>Hata Analizi</Label>
        <textarea value={err} onChange={(e) => setErr(e.target.value)} rows={3} placeholder="Hangi konularda hata yaptin?" style={{ padding: "8px 10px", fontSize: "12px", width: "100%", resize: "vertical", lineHeight: "1.6", borderRadius: "6px" }} />
      </div>
      <div>
        <Label style={{ marginBottom: "4px" }}>Yapilmasi Gerekenler</Label>
        <textarea value={todos} onChange={(e) => setTodos(e.target.value)} rows={2} placeholder="Her satira bir madde..." style={{ padding: "8px 10px", fontSize: "12px", width: "100%", resize: "vertical", lineHeight: "1.6", borderRadius: "6px" }} />
      </div>
      <div style={{ display: "flex", gap: "7px", justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onCancel}>
          Iptal
        </Btn>
        <Btn variant="primary" onClick={handleSave}>
          Kaydet →
        </Btn>
      </div>
    </div>
  );
}

function TrialCard({ trial, onDelete, onPushTodos }) {
  const [exp, setExp] = useState(false);
  const top = [...trial.nets].sort((a, b) => b.net - a.net).slice(0, 3);
  const weak = [...trial.nets].sort((a, b) => a.net - b.net).slice(0, 2);
  const maxN = Math.max(...trial.nets.map((n) => n.net), 1);
  const repeat = trial.nets.filter((n) => n.net < 5).map((n) => n.subject);

  const quickTodos = () => {
    if (!trial.todos?.length) return;
    const mapped = trial.todos.map((text) => ({
      text,
      source: `${trial.type} (${fmtDate(trial.date)})`,
      priority: "high",
      meta: { kind: "trial", trialId: trial.id, trialType: trial.type, trialDate: trial.date },
    }));
    onPushTodos(mapped);
    toast(`${trial.todos.length} gorev gorevlere aktarildi`, "var(--grn)");
  };

  return (
    <Card className="sr" style={{ padding: "0", overflow: "hidden" }}>
      <div onClick={() => setExp((p) => !p)} style={{ padding: "11px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", background: exp ? "var(--s2)" : "transparent" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Tag color={trial.type === "TYT" ? "var(--blu)" : "var(--acc)"}>{trial.type}</Tag>
          <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--muted)" }}>{fmtDate(trial.date)}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: "18px", fontWeight: "700", color: "var(--acc)" }}>{trial.totalNet}</span>
        </div>
        <div style={{ display: "flex", gap: "7px", alignItems: "center" }}>
          {trial.todos?.length > 0 && <Tag color="var(--red)">{trial.todos.length} gorev</Tag>}
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
              {top.map((n) => (
                <p key={n.subject} style={{ fontSize: "10px", marginBottom: "2px" }}>
                  {n.subject} <span style={{ fontFamily: "var(--mono)", color: "var(--grn)" }}>{n.net.toFixed(1)}</span>
                </p>
              ))}
            </div>
            <div style={{ flex: 1, padding: "9px", background: "var(--s2)", borderRadius: "7px", border: "1px solid var(--red)22" }}>
              <Label style={{ color: "var(--red)", marginBottom: "5px" }}>En Zayif</Label>
              {weak.map((n) => (
                <p key={n.subject} style={{ fontSize: "10px", marginBottom: "2px" }}>
                  {n.subject} <span style={{ fontFamily: "var(--mono)", color: "var(--red)" }}>{n.net.toFixed(1)}</span>
                </p>
              ))}
            </div>
          </div>

          {repeat.length > 0 && (
            <div style={{ padding: "9px 11px", background: "var(--red)08", borderRadius: "6px", border: "1px solid var(--red)22" }}>
              <p style={{ fontSize: "11px", color: "var(--red)", marginBottom: "3px", fontWeight: "600" }}>Tekrar Gerekli</p>
              <p style={{ fontSize: "11px", color: "var(--muted)" }}>{repeat.join(", ")} — 5 netin altinda.</p>
            </div>
          )}

          {trial.errorAnalysis && (
            <div>
              <Label style={{ marginBottom: "4px" }}>Hata Analizi</Label>
              <p style={{ fontSize: "11px", color: "var(--muted)", lineHeight: "1.6", whiteSpace: "pre-wrap", padding: "8px 10px", background: "var(--s2)", borderRadius: "6px" }}>{trial.errorAnalysis}</p>
            </div>
          )}

          {trial.todos?.length > 0 && (
            <div>
              <Label style={{ marginBottom: "5px" }}>Yapilmasi Gerekenler</Label>
              {trial.todos.map((t, i) => (
                <div key={i} style={{ display: "flex", gap: "6px", padding: "5px 8px", background: "var(--s2)", borderRadius: "5px", marginBottom: "3px" }}>
                  <span style={{ color: "var(--acc)", fontSize: "9px" }}>→</span>
                  <span style={{ fontSize: "11px" }}>{t}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
            <Btn variant="accent" size="sm" onClick={quickTodos} disabled={!trial.todos?.length} title="Gorevlere aktar">
              Gorevlere aktar
            </Btn>
            <Btn variant="danger" size="sm" onClick={() => onDelete(trial.id)}>
              Sil
            </Btn>
          </div>
        </div>
      )}
    </Card>
  );
}

// ============================================================================
// Brain tab: Brain dump + Plan + DeepWork + Attention
// ============================================================================
const DW_DEFAULT = { sessions: [], goalMin: 180 };
const FOCUS_QUOTES = [
  "Rakibin simdi calisiyor. Sen ne yapiyorsun?",
  "Bu blok bitince mola hakkin var. Henuz degil.",
  "Disiplin, motivasyon olmadigi zamanlarda ne yaptigindir.",
  "Zorlanmak buyudugune isarettir.",
  "Flow state esigindeydin. Devam et.",
  "60 dakikanin icinde bir omur degisebilir.",
  "Konsantrasyon bir kastir. Her tekrarda gucleniyor.",
  "En iyi antrenmani yapan kazanir, en iyi hisseden degil.",
];
const getQuote = () => FOCUS_QUOTES[Math.floor(Math.random() * FOCUS_QUOTES.length)];

function buildBlocks(goalMin) {
  const blocks = [];
  let rem = goalMin;
  while (rem >= 30) {
    const dur = clamp(rem, 60, 90);
    if (dur < 30) break;
    blocks.push({ id: uid(), dur });
    rem -= dur + (rem - dur >= 30 ? 15 : 0);
  }
  return blocks;
}

function calcAdaptiveGoal(sessions, currentMin) {
  const recent = sessions.filter((s) => daysFrom(s.date) > 0 && daysFrom(s.date) <= 7 && s.goalMin > 0).slice(0, 7);
  if (recent.length < 2) return { min: currentMin, reason: "Yeterli veri yok.", trend: "same" };
  const avg = recent.reduce((s, x) => s + clamp(x.completedMin / x.goalMin, 0, 1), 0) / recent.length;
  const pct = Math.round(avg * 100);
  if (avg >= 0.9) return { min: Math.min(480, currentMin + 30), reason: `%${pct} tamamlama. Artiriliyor.`, trend: "up" };
  if (avg >= 0.6) return { min: currentMin, reason: `%${pct} — hedef uygun.`, trend: "same" };
  return { min: Math.max(120, currentMin - 30), reason: `%${pct} — optimize ediliyor.`, trend: "down" };
}

function BrainDumpTab({ trials, todos, onPushTodos }) {
  const today = todayStr();

  const [brain, setBrainRaw] = useState(() => store.load(KEYS.brain, {}));
  const setBrain = useCallback((fn) => {
    setBrainRaw((p) => {
      const n = typeof fn === "function" ? fn(p) : fn;
      store.save(KEYS.brain, n);
      return n;
    });
  }, []);

  const [dw, setDwRaw] = useState(() => store.load(KEYS.dw, DW_DEFAULT));
  const [attn, setAttnRaw] = useState(() => store.load(KEYS.attn, {}));
  const [plans, setPlansRaw] = useState(() => store.load(KEYS.plan, {}));

  const setDw = useCallback((fn) => {
    setDwRaw((p) => {
      const n = typeof fn === "function" ? fn(p) : fn;
      store.save(KEYS.dw, n);
      return n;
    });
  }, []);
  const setAttn = useCallback((fn) => {
    setAttnRaw((p) => {
      const n = typeof fn === "function" ? fn(p) : fn;
      store.save(KEYS.attn, n);
      return n;
    });
  }, []);
  const setPlans = useCallback((fn) => {
    setPlansRaw((p) => {
      const n = typeof fn === "function" ? fn(p) : fn;
      store.save(KEYS.plan, n);
      return n;
    });
  }, []);

  // brain dump text per day
  const brainText = brain?.[today]?.text || "";
  const setBrainText = (text) =>
    setBrain((p) => ({
      ...(p || {}),
      [today]: { ...(p?.[today] || {}), text, updatedAt: new Date().toISOString() },
    }));

  const pushBrainDumpToTodos = () => {
    const lines = brainText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) return;
    onPushTodos(
      lines.map((text) => ({
        text,
        source: `BrainDump (${fmtDate(today)})`,
        priority: "medium",
        meta: { kind: "brain", date: today },
      })),
    );
    setBrainText("");
    toast(`${lines.length} madde gorevlere akti`, "var(--grn)");
  };

  // plan suggestion
  const weeklyRec = useMemo(() => buildWeeklyPlan(trials, 4), [trials]);

  // deep work
  const goalMin = dw.goalMin ?? 180;
  const blocks = useMemo(() => buildBlocks(goalMin), [goalMin]);
  const todaySess = dw.sessions.find((s) => s.date === today);
  const doneBlocks = todaySess?.blocks ?? [];
  const completedMin = doneBlocks.reduce((s, b) => s + b.dur, 0);
  const earlyBreaks = todaySess?.earlyBreaks ?? 0;
  const adaptive = useMemo(() => calcAdaptiveGoal(dw.sessions, goalMin), [dw.sessions, goalMin]);
  const pct = goalMin > 0 ? clamp(Math.round((completedMin / goalMin) * 100), 0, 100) : 0;
  const todayDone = completedMin >= goalMin;

  const todayBreaks = attn[today]?.breaks || [];
  const attnScore = useMemo(() => calcAttentionScore(todayBreaks), [todayBreaks]);
  const { label: aLabel, color: aColor } = attentionLabel(attnScore);

  const streak = useMemo(() => {
    let n = 0;
    for (let i = 1; i <= 30; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const s = dw.sessions.find((x) => x.date === d);
      if (s && s.completedMin >= (s.goalMin || 180)) n++;
      else break;
    }
    return n;
  }, [dw.sessions]);

  const dispMsg = useMemo(() => {
    if (earlyBreaks >= 3) return { msg: `${earlyBreaks} erken mola. Telefonu odadan cikar.`, color: "var(--red)" };
    if (todayDone) return { msg: streak >= 3 ? `${streak} gun ust uste hedef.` : "Bugunun hedefini tamamladin.", color: "var(--grn)" };
    if (pct >= 60) return { msg: "Hedefe yakin. Son blok seni sinava sokacak.", color: "var(--acc)" };
    if (pct > 0) return { msg: "Basladinsa kapat. Yarim birakma.", color: "var(--acc)" };
    return { msg: "1 blok bile fark yaratir.", color: "var(--muted)" };
  }, [earlyBreaks, todayDone, streak, pct]);

  const nextIdx = doneBlocks.length;

  function onBlockDone(dur, early, breakData) {
    playSound("done");
    grantXP("block_done");
    toast(`+${XP_R.block_done} XP - Blok tamamlandi`, "var(--grn)");
    if (breakData) {
      setAttn((p) => {
        const prev = p[today] || { breaks: [] };
        return { ...p, [today]: { ...prev, breaks: [...prev.breaks, breakData] } };
      });
    }
    setDw((p) => {
      const prev = p.sessions.find((s) => s.date === today);
      const nb = { id: uid(), dur, early, at: new Date().toISOString() };
      const upd = prev
        ? { ...prev, blocks: [...(prev.blocks || []), nb], completedMin: (prev.completedMin || 0) + dur, earlyBreaks: (prev.earlyBreaks || 0) + (early ? 1 : 0) }
        : { date: today, goalMin, blocks: [nb], completedMin: dur, earlyBreaks: early ? 1 : 0 };
      return { ...p, sessions: [upd, ...p.sessions.filter((s) => s.date !== today)] };
    });
  }

  // plan
  const todayPlan = plans[today] || [];
  const nowMin = nowHHMM();
  const overduePlan = todayPlan.filter((p) => !p.done && p.startMin + p.durationMin < nowMin);

  // sub-layout toggles
  const [showPlan, setShowPlan] = useState(true);
  const [showDW, setShowDW] = useState(true);

  // brain dump card + suggestions
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <Card style={{ padding: "13px 14px" }}>
        <Label style={{ marginBottom: "8px" }}>Brain Dump</Label>
        <textarea
          value={brainText}
          onChange={(e) => setBrainText(e.target.value)}
          rows={4}
          placeholder="Aklindaki her seyi dok... Her satir bir gorev olabilir."
          style={{ padding: "10px 12px", fontSize: "12px", width: "100%", resize: "vertical", lineHeight: "1.6", borderRadius: "8px" }}
        />
        <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
          <Btn variant="accent" onClick={pushBrainDumpToTodos} style={{ flex: 2 }} disabled={!brainText.trim()}>
            Goreve cevir (satir satir) →
          </Btn>
          <Btn variant="ghost" onClick={() => setBrainText("")} style={{ flex: 1, color: "var(--muted)" }} disabled={!brainText.trim()}>
            Temizle
          </Btn>
        </div>
        {weeklyRec.length > 0 && (
          <div style={{ marginTop: "12px" }}>
            <Label style={{ marginBottom: "8px" }}>Bugun onerilen dersler</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
              {weeklyRec.slice(0, 4).map((w) => (
                <div key={w.subject} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 9px", background: "var(--s2)", borderRadius: "6px" }}>
                  <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: w.priority === "high" ? "var(--red)" : w.priority === "medium" ? "var(--acc)" : "var(--grn)" }} />
                    <span style={{ fontSize: "12px" }}>{w.subject}</span>
                  </div>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>{fmtHHMM(w.dailyMin)}/gun</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {overduePlan.length > 0 && (
        <div className="flashR" style={{ padding: "11px 13px", background: "var(--red)08", border: "1px solid var(--red)44", borderRadius: "8px", display: "flex", gap: "10px", alignItems: "center" }}>
          <span style={{ fontSize: "16px" }}>⚡</span>
          <div>
            <p style={{ fontSize: "12px", fontWeight: "600", color: "var(--red)" }}>{overduePlan.length} plan ogesi gecikti</p>
            <p style={{ fontSize: "11px", color: "var(--muted)", marginTop: "1px" }}>{overduePlan.map((x) => x.subject).join(", ")}</p>
          </div>
        </div>
      )}

      {todayBreaks.length > 0 && (
        <Card style={{ padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <Label>Dikkat Durumu</Label>
            <Tag color={aColor}>
              {aLabel} · {attnScore}/100
            </Tag>
          </div>
          <PBar value={attnScore} max={100} color={aColor} h={5} />
          <div style={{ marginTop: "8px" }}>
            {Object.entries(todayBreaks.reduce((m, b) => ((m[b.reason] = (m[b.reason] || 0) + 1), m), {})).map(([r, c]) => (
              <span key={r} style={{ display: "inline-block", fontSize: "10px", color: "var(--muted)", marginRight: "8px", marginBottom: "2px" }}>
                {r}: {c}x
              </span>
            ))}
          </div>
          {attnScore < 60 && (
            <p style={{ fontSize: "11px", color: "var(--red)", marginTop: "6px", lineHeight: "1.4" }}>
              ⚡ Dikkat dusuk. Erken molalarin ana nedeni: {todayBreaks.filter((b) => b.type === "early").map((b) => b.reason)[0] || "belirsiz"}
            </p>
          )}
        </Card>
      )}

      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <Btn variant={showDW ? "accent" : "ghost"} size="sm" onClick={() => setShowDW((p) => !p)} style={{ flex: 1 }}>
          {showDW ? "Deep Work (acik)" : "Deep Work (kapali)"}
        </Btn>
        <Btn variant={showPlan ? "accent" : "ghost"} size="sm" onClick={() => setShowPlan((p) => !p)} style={{ flex: 1 }}>
          {showPlan ? "Plan (acik)" : "Plan (kapali)"}
        </Btn>
      </div>

      {showDW && (
        <div className="fu">
          <div style={{ padding: "11px 14px", background: "var(--s2)", borderRadius: "8px", border: `1px solid ${dispMsg.color}33`, display: "flex", gap: "10px", alignItems: "center" }}>
            <div style={{ width: "3px", height: "32px", background: dispMsg.color, borderRadius: "2px", flexShrink: 0 }} />
            <p style={{ fontSize: "12px", color: dispMsg.color, lineHeight: "1.5" }}>{dispMsg.msg}</p>
          </div>
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "10px" }}>
              <div>
                <Label style={{ marginBottom: "3px" }}>Gunluk Hedef</Label>
                <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "28px", fontWeight: "700", color: "var(--acc)" }}>{fmtHHMM(goalMin)}</span>
                  {streak > 0 && <span style={{ fontSize: "11px", color: "var(--acc)", fontFamily: "var(--mono)" }}>🔥 {streak}g</span>}
                </div>
              </div>
              <GoalEditor goalMin={goalMin} adaptive={adaptive} onSave={(min) => setDw((p) => ({ ...p, goalMin: min }))} />
            </div>
            <PBar value={completedMin} max={goalMin} color={todayDone ? "var(--grn)" : pct >= 60 ? "var(--acc)" : "var(--blu)"} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "5px" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>
                {fmtHHMM(completedMin)}/{fmtHHMM(goalMin)}
              </span>
              <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: todayDone ? "var(--grn)" : "var(--muted)" }}>{pct}%</span>
            </div>
          </Card>

          <BlockGrid blocks={blocks} doneBlocks={doneBlocks} nextIdx={nextIdx} />
          {nextIdx < blocks.length && <BlockTimer block={blocks[nextIdx]} idx={nextIdx} earlyBreaks={earlyBreaks} onDone={onBlockDone} />}
          {todayDone && (
            <div className="pi" style={{ textAlign: "center", padding: "18px", background: "var(--grn)08", border: "1px solid var(--grn)33", borderRadius: "10px" }}>
              <p style={{ fontFamily: "var(--mono)", fontSize: "16px", color: "var(--grn)", marginBottom: "3px" }}>✓ HEDEF TAMAM</p>
              <p style={{ fontSize: "11px", color: "var(--muted)" }}>Bugunun gorevini yerine getirdin.</p>
            </div>
          )}
          <DWHistory sessions={dw.sessions} />
        </div>
      )}

      {showPlan && <DailyPlanTab trials={trials} plans={plans} setPlans={setPlans} />}

      <SmallTodoFunnel todos={todos} onPushTodos={onPushTodos} />
    </div>
  );
}

function SmallTodoFunnel({ todos, onPushTodos }) {
  const [text, setText] = useState("");
  const add = () => {
    const lines = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) return;
    onPushTodos(
      lines.map((t) => ({
        text: t,
        source: `BrainDump Quick (${fmtDate(todayStr())})`,
        priority: "medium",
        meta: { kind: "brain_quick", date: todayStr() },
      })),
    );
    setText("");
    toast(`${lines.length} gorev eklendi`, "var(--grn)");
  };
  return (
    <Card style={{ padding: "12px 14px" }}>
      <Label style={{ marginBottom: "8px" }}>Hizli Gorev Girisi</Label>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Her satir bir gorev..." style={{ padding: "8px 10px", fontSize: "12px", width: "100%", resize: "vertical", lineHeight: "1.6", borderRadius: "6px" }} />
      <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
        <Btn variant="primary" onClick={add} disabled={!text.trim()} style={{ flex: 2 }}>
          Gorev ekle →
        </Btn>
        <Btn variant="ghost" onClick={() => setText("")} disabled={!text.trim()} style={{ flex: 1 }}>
          Temizle
        </Btn>
      </div>
      <p style={{ fontSize: "10px", color: "var(--muted)", marginTop: "8px", lineHeight: "1.5" }}>
        Not: Buradan girilen gorevler otomatik 7 gun reviewAt ile eklenir.
      </p>
      <p style={{ fontSize: "10px", color: "var(--muted)", marginTop: "2px", lineHeight: "1.5" }}>
        Aktif gorev: <span style={{ fontFamily: "var(--mono)", color: "var(--acc)" }}>{todos.filter((t) => !t.done).length}</span>
      </p>
    </Card>
  );
}

function GoalEditor({ goalMin, adaptive, onSave }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <Btn size="sm" variant="ghost" onClick={() => setOpen((p) => !p)} style={{ color: "var(--muted)", fontSize: "11px" }}>
        {open ? "✕" : "Degistir"}
      </Btn>
      {open && (
        <div className="fi" style={{ position: "absolute", right: 0, top: "26px", background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: "9px", padding: "12px", zIndex: 100, width: "210px", boxShadow: "0 12px 32px rgba(0,0,0,.6)" }}>
          <Label style={{ marginBottom: "7px" }}>Hizli Secim</Label>
          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginBottom: "10px" }}>
            {[2, 3, 4, 5, 6, 8].map((h) => (
              <button
                key={h}
                onClick={() => {
                  onSave(h * 60);
                  setOpen(false);
                }}
                style={{
                  padding: "5px 9px",
                  borderRadius: "5px",
                  border: "1px solid",
                  fontSize: "11px",
                  cursor: "pointer",
                  fontFamily: "var(--mono)",
                  borderColor: Math.round(goalMin / 60) === h ? "var(--acc)" : "var(--b2)",
                  background: Math.round(goalMin / 60) === h ? "var(--acc)22" : "transparent",
                  color: Math.round(goalMin / 60) === h ? "var(--acc)" : "var(--muted)",
                }}
              >
                {h}s
              </button>
            ))}
          </div>
          {adaptive.trend !== "same" && (
            <div style={{ padding: "8px 10px", borderRadius: "7px", background: adaptive.trend === "up" ? "var(--grn)08" : "var(--red)08", border: `1px solid ${adaptive.trend === "up" ? "var(--grn)" : "var(--red)"}33` }}>
              <p style={{ fontSize: "10px", color: "var(--muted)", marginBottom: "4px", lineHeight: "1.4" }}>{adaptive.reason}</p>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: adaptive.trend === "up" ? "var(--grn)" : "var(--red)" }}>
                  {adaptive.trend === "up" ? "▲" : "▼"} {fmtHHMM(adaptive.min)}
                </span>
                <Btn size="sm" variant={adaptive.trend === "up" ? "success" : "danger"} onClick={() => (onSave(adaptive.min), setOpen(false))}>
                  Uygula
                </Btn>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BlockGrid({ blocks, doneBlocks, nextIdx }) {
  return (
    <Card style={{ padding: "12px 14px" }}>
      <Label style={{ marginBottom: "8px" }}>Bloklar — {blocks.length} blok</Label>
      <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
        {blocks.map((b, i) => {
          const done = i < doneBlocks.length;
          const active = i === nextIdx;
          const early = doneBlocks[i]?.early;
          return (
            <div
              key={b.id}
              style={{
                padding: "6px 9px",
                borderRadius: "6px",
                fontSize: "11px",
                fontFamily: "var(--mono)",
                minWidth: "42px",
                textAlign: "center",
                background: done ? (early ? "var(--red)18" : "var(--grn)18") : active ? "var(--acc)18" : "var(--s2)",
                border: `1px solid ${done ? (early ? "var(--red)55" : "var(--grn)55") : active ? "var(--acc)55" : "var(--b2)"}`,
                color: done ? (early ? "var(--red)" : "var(--grn)") : active ? "var(--acc)" : "var(--muted)",
                transition: "all .3s",
              }}
            >
              {done ? (early ? "!" : "✓") : active ? "▶" : i + 1}
              <div style={{ fontSize: "9px", marginTop: "1px", opacity: 0.7 }}>{b.dur}dk</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function BlockTimer({ block, idx, earlyBreaks, onDone }) {
  const TOTAL = block.dur * 60;
  const [phase, setPhase] = useState("idle");
  const [elapsed, setEl] = useState(0);
  const [quote, setQuote] = useState(getQuote);
  const [breakReason, setBreakReason] = useState("");
  const itvRef = useRef(null);

  const start = useCallback(() => {
    setPhase("run");
    playSound("start");
    itvRef.current = setInterval(() => setEl((p) => p + 1), 1000);
  }, []);

  const stop = useCallback(() => {
    clearInterval(itvRef.current);
  }, []);

  useEffect(() => () => stop(), [stop]);

  useEffect(() => {
    if (elapsed >= TOTAL && phase === "run") {
      stop();
      setPhase("done");
      onDone(block.dur, false, null);
      playSound("done");
    }
  }, [elapsed, TOTAL, phase, stop, onDone, block.dur]);

  useEffect(() => {
    if (phase === "run" && elapsed > 0 && elapsed % (15 * 60) === 0) setQuote(getQuote());
  }, [elapsed, phase]);

  const rem = Math.max(0, TOTAL - elapsed);
  const pct = clamp(Math.round((elapsed / TOTAL) * 100), 0, 100);
  const elMin = Math.floor(elapsed / 60);
  const minL = Math.ceil(rem / 60);

  if (phase === "done") {
    return (
      <Card style={{ textAlign: "center", padding: "20px", background: "var(--grn)08", border: "1px solid var(--grn)33" }}>
        <p style={{ fontFamily: "var(--mono)", fontSize: "18px", color: "var(--grn)", marginBottom: "3px" }}>✓ BLOK {idx + 1} TAMAM</p>
        <p style={{ fontSize: "11px", color: "var(--muted)" }}>Mola hakkin var.</p>
      </Card>
    );
  }

  if (phase === "warn") {
    return (
      <Card style={{ padding: "18px", background: "var(--red)06", border: "1px solid var(--red)44" }} className="flashR">
        <p style={{ fontFamily: "var(--mono)", fontSize: "13px", color: "var(--red)", fontWeight: "700", marginBottom: "6px" }}>⚡ ERKEN MOLA — {minL} dk kaldi</p>
        {earlyBreaks >= 2 && <p style={{ fontSize: "11px", color: "var(--muted)", marginBottom: "10px" }}>Bu bugun {earlyBreaks + 1}. erken molan.</p>}
        <Label style={{ marginBottom: "6px" }}>Neden mola istiyorsun?</Label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginBottom: "12px" }}>
          {BREAK_REASONS.map((r) => (
            <button
              key={r}
              onClick={() => setBreakReason(r)}
              style={{
                padding: "4px 9px",
                borderRadius: "5px",
                border: `1px solid ${breakReason === r ? "var(--acc)" : "var(--b2)"}`,
                background: breakReason === r ? "var(--acc)22" : "transparent",
                color: breakReason === r ? "var(--acc)" : "var(--muted)",
                fontSize: "11px",
                cursor: "pointer",
              }}
            >
              {r}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <Btn variant="primary" style={{ flex: 2 }} onClick={() => (setPhase("run"), start())}>
            Devam ediyorum
          </Btn>
          <Btn
            variant="danger"
            style={{ flex: 1 }}
            disabled={!breakReason}
            onClick={() => {
              setPhase("done");
              onDone(elMin, true, { type: "early", blockMin: elMin, reason: breakReason, at: new Date().toISOString() });
            }}
          >
            Mola ver
          </Btn>
        </div>
      </Card>
    );
  }

  if (phase === "idle") {
    return (
      <Card style={{ padding: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <div>
            <Label style={{ marginBottom: "2px" }}>Siradaki Blok</Label>
            <p style={{ fontFamily: "var(--mono)", fontSize: "18px", fontWeight: "700" }}>
              Blok {idx + 1} · {block.dur}dk
            </p>
          </div>
          <Tag color="var(--blu)">{fmtHHMM(block.dur)}</Tag>
        </div>
        <Btn variant="primary" onClick={start} style={{ width: "100%", padding: "12px", fontSize: "13px" }}>
          ▶ Bloku Baslat
        </Btn>
      </Card>
    );
  }

  const r = 52;
  const circ = 2 * Math.PI * r;
  return (
    <Card style={{ padding: "22px 16px", textAlign: "center", border: "1px solid var(--acc)22" }}>
      <Label style={{ marginBottom: "12px" }}>ODAK MODU · BLOK {idx + 1}</Label>
      <div style={{ position: "relative", display: "inline-block", marginBottom: "14px" }}>
        <svg width="120" height="120" style={{ transform: "rotate(-90deg)" }}>
          <circle cx="60" cy="60" r={r} fill="none" stroke="var(--b1)" strokeWidth="6" />
          <circle
            cx="60"
            cy="60"
            r={r}
            fill="none"
            stroke={pct >= 80 ? "var(--grn)" : "var(--acc)"}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - pct / 100)}
            style={{ transition: "stroke-dashoffset 1s ease,stroke .5s" }}
          />
        </svg>
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", textAlign: "center" }}>
          <p style={{ fontFamily: "var(--mono)", fontSize: "22px", fontWeight: "700", lineHeight: 1 }}>{fmtMMSS(rem)}</p>
          <p style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)", marginTop: "2px" }}>kaldi</p>
        </div>
      </div>
      <p style={{ fontSize: "11px", color: "var(--muted)", fontStyle: "italic", maxWidth: "250px", margin: "0 auto 14px", lineHeight: "1.6" }}>
        "{quote}"
      </p>
      <PBar value={elapsed} max={TOTAL} color={pct >= 80 ? "var(--grn)" : "var(--acc)"} h={3} />
      <div style={{ display: "flex", gap: "8px", justifyContent: "center", marginTop: "12px" }}>
        <Btn variant="ghost" onClick={() => (stop(), setPhase("warn"), playSound("warn"))} style={{ color: "var(--muted)", fontSize: "11px" }}>
          Mola iste
        </Btn>
        <Btn variant="success" onClick={() => (stop(), setPhase("done"), onDone(elMin, false, null))}>
          Bloku Tamamla ✓
        </Btn>
      </div>
    </Card>
  );
}

function DWHistory({ sessions }) {
  const [open, setOpen] = useState(false);
  const recent = useMemo(() => [...sessions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10), [sessions]);
  if (!sessions.length) return null;
  return (
    <div>
      <button onClick={() => setOpen((p) => !p)} style={{ fontSize: "11px", color: "var(--muted)", background: "none", border: "none", cursor: "pointer", marginBottom: "6px" }}>
        {open ? "▲ Gizle" : `▼ Son ${Math.min(10, sessions.length)} seans`}
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }} className="fi">
          {recent.map((s) => {
            const r = s.goalMin > 0 ? clamp(s.completedMin / s.goalMin, 0, 1) : 0;
            const c = r >= 1 ? "var(--grn)" : r >= 0.6 ? "var(--acc)" : "var(--red)";
            return (
              <div key={s.date} style={{ display: "flex", alignItems: "center", gap: "9px", padding: "7px 11px", background: "var(--s2)", borderRadius: "6px", border: "1px solid var(--b2)" }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)", minWidth: "68px" }}>{s.date}</span>
                <div style={{ flex: 1 }}>
                  <PBar value={s.completedMin} max={s.goalMin} color={c} h={4} />
                </div>
                <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: c, minWidth: "50px", textAlign: "right" }}>
                  {fmtHHMM(s.completedMin)}/{fmtHHMM(s.goalMin)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Daily plan (timer + delay reason)
// ============================================================================
function minsToHHMM(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function hhmmToMins(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function DailyPlanTab({ trials, plans, setPlans }) {
  const today = todayStr();
  const todayPlan = plans[today] || [];
  const weeklyRec = useMemo(() => buildWeeklyPlan(trials, 4), [trials]);

  const [activeId, setActiveId] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const itvRef = useRef(null);

  const startTimer = (id) => {
    setActiveId(id);
    setElapsed(0);
    playSound("start");
    itvRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);
  };
  const stopTimer = () => {
    clearInterval(itvRef.current);
    setActiveId(null);
  };
  useEffect(() => () => clearInterval(itvRef.current), []);

  const nowMin = nowHHMM();
  const overdue = todayPlan.filter((p) => !p.done && p.startMin + p.durationMin < nowMin);

  const [form, setForm] = useState({
    startMin: minsToHHMM(Math.ceil(nowMin / 30) * 30),
    dur: "75",
    subject: "",
    note: "",
  });
  const [addOpen, setAddOpen] = useState(false);
  const [delayModal, setDelayModal] = useState(null); // {id, delayedMin}

  const addItem = () => {
    if (!form.subject.trim()) return;
    const item = {
      id: uid(),
      startMin: hhmmToMins(form.startMin),
      durationMin: parseInt(form.dur, 10) || 75,
      subject: form.subject.trim(),
      note: form.note,
      done: false,
      doneAt: null,
      delayedMin: 0,
      delayReason: "",
    };
    setPlans((p) => ({
      ...p,
      [today]: [...(p[today] || []), item].sort((a, b) => a.startMin - b.startMin),
    }));
    setForm((f) => ({ ...f, subject: "", note: "" }));
    setAddOpen(false);
  };

  const markDone = (id) => {
    const item = todayPlan.find((x) => x.id === id);
    if (!item) return;
    const expectedEnd = item.startMin + item.durationMin;
    const delayedMin = Math.max(0, nowMin - expectedEnd);
    if (delayedMin > 15) {
      setDelayModal({ id, delayedMin });
      return;
    }
    setPlans((p) => ({ ...p, [today]: (p[today] || []).map((x) => (x.id === id ? { ...x, done: true, doneAt: new Date().toISOString() } : x)) }));
    stopTimer();
    playSound("done");
    toast("Plan ogesi tamamlandi!", "var(--grn)");
    const remaining = (plans[today] || []).filter((x) => !x.done && x.id !== id).length;
    if (remaining === 0) {
      grantXP("plan_done");
      toast(`+${XP_R.plan_done} XP — Gunluk plan tamam!`, "var(--acc)");
    }
  };

  const confirmDelay = (id, reason) => {
    setPlans((p) => ({
      ...p,
      [today]: (p[today] || []).map((x) => (x.id === id ? { ...x, done: true, doneAt: new Date().toISOString(), delayReason: reason } : x)),
    }));
    setDelayModal(null);
    stopTimer();
    playSound("done");
  };

  const delItem = (id) => setPlans((p) => ({ ...p, [today]: (p[today] || []).filter((x) => x.id !== id) }));

  const completionPct = todayPlan.length > 0 ? Math.round((todayPlan.filter((x) => x.done).length / todayPlan.length) * 100) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {overdue.length > 0 && (
        <div className="flashR" style={{ padding: "11px 13px", background: "var(--red)08", border: "1px solid var(--red)44", borderRadius: "8px", display: "flex", gap: "10px", alignItems: "center" }}>
          <span style={{ fontSize: "16px" }}>⚡</span>
          <div>
            <p style={{ fontSize: "12px", fontWeight: "600", color: "var(--red)" }}>{overdue.length} plan ogesi gecikti</p>
            <p style={{ fontSize: "11px", color: "var(--muted)", marginTop: "1px" }}>{overdue.map((x) => x.subject).join(", ")} — kayma tespit edildi.</p>
          </div>
        </div>
      )}

      {todayPlan.length > 0 && (
        <Card style={{ padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
            <Label>Bugunun Plani</Label>
            <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: completionPct === 100 ? "var(--grn)" : "var(--acc)" }}>{completionPct}%</span>
          </div>
          <PBar value={completionPct} max={100} color={completionPct === 100 ? "var(--grn)" : "var(--acc)"} />
        </Card>
      )}

      {weeklyRec.length > 0 && (
        <Card style={{ padding: "12px 14px" }}>
          <Label style={{ marginBottom: "8px" }}>Deneme Analizine Gore Bugunku Oncelikler</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            {weeklyRec.slice(0, 4).map((w) => (
              <div key={w.subject} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", background: "var(--s2)", borderRadius: "6px" }}>
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: w.priority === "high" ? "var(--red)" : w.priority === "medium" ? "var(--acc)" : "var(--grn)", flexShrink: 0 }} />
                  <span style={{ fontSize: "12px" }}>{w.subject}</span>
                </div>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>{fmtHHMM(w.dailyMin)}/gun</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: w.gap > 0 ? "var(--red)" : "var(--grn)" }}>{w.avg} ort.</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {todayPlan.length === 0 && !addOpen && (
          <div style={{ textAlign: "center", padding: "32px 16px", color: "var(--muted)" }}>
            <p style={{ fontFamily: "var(--mono)", fontSize: "24px", marginBottom: "10px", color: "var(--b2)" }}>▦</p>
            <p style={{ fontSize: "13px", marginBottom: "4px" }}>Bugun icin plan yok</p>
            <p style={{ fontSize: "11px", color: "var(--b3)" }}>Plan yap, zamana sahip cik.</p>
          </div>
        )}
        {todayPlan.map((item) => (
          <PlanItem
            key={item.id}
            item={item}
            nowMin={nowMin}
            activeId={activeId}
            elapsed={elapsed}
            onStart={() => startTimer(item.id)}
            onStop={stopTimer}
            onDone={() => markDone(item.id)}
            onDelete={() => delItem(item.id)}
          />
        ))}
      </div>

      {addOpen ? (
        <Card style={{ padding: "14px" }}>
          <Label style={{ marginBottom: "10px" }}>Yeni Plan Ogesi</Label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "8px" }}>
            <div>
              <Label style={{ marginBottom: "4px" }}>Saat</Label>
              <input type="time" value={form.startMin} onChange={(e) => setForm((f) => ({ ...f, startMin: e.target.value }))} style={{ padding: "7px 10px", fontSize: "13px", width: "100%", borderRadius: "6px" }} />
            </div>
            <div>
              <Label style={{ marginBottom: "4px" }}>Sure (dk)</Label>
              <select value={form.dur} onChange={(e) => setForm((f) => ({ ...f, dur: e.target.value }))} style={{ padding: "7px 10px", fontSize: "13px", width: "100%", borderRadius: "6px" }}>
                {[30, 45, 60, 75, 90, 120].map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ marginBottom: "8px" }}>
            <Label style={{ marginBottom: "4px" }}>Ders / Konu</Label>
            <input value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} placeholder="Matematik — Turev" style={{ padding: "8px 10px", fontSize: "13px", width: "100%", borderRadius: "6px" }} />
          </div>
          <div style={{ marginBottom: "12px" }}>
            <Label style={{ marginBottom: "4px" }}>Not (opsiyonel)</Label>
            <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="Konu detayi..." style={{ padding: "8px 10px", fontSize: "13px", width: "100%", borderRadius: "6px" }} />
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <Btn variant="ghost" onClick={() => setAddOpen(false)} style={{ flex: 1 }}>
              Iptal
            </Btn>
            <Btn variant="primary" onClick={addItem} style={{ flex: 2 }}>
              Planla →
            </Btn>
          </div>
        </Card>
      ) : (
        <Btn variant="primary" onClick={() => setAddOpen(true)} style={{ width: "100%", padding: "11px" }}>
          + Plan Ogesi Ekle
        </Btn>
      )}

      {delayModal && <DelayModal delayedMin={delayModal.delayedMin} onConfirm={(r) => confirmDelay(delayModal.id, r)} onCancel={() => setDelayModal(null)} />}
    </div>
  );
}

function PlanItem({ item, nowMin, activeId, elapsed, onStart, onStop, onDone, onDelete }) {
  const isActive = activeId === item.id;
  const status = item.done ? "done" : isActive ? "active" : nowMin > item.startMin + item.durationMin ? "late" : "upcoming";
  const colMap = { done: "var(--grn)", active: "var(--acc)", late: "var(--red)", upcoming: "var(--muted)" };
  const col = colMap[status];
  const pct = isActive ? clamp(Math.round((elapsed / (item.durationMin * 60)) * 100), 0, 100) : item.done ? 100 : 0;
  const borderCss = status === "late" ? "var(--red)33" : status === "active" ? "var(--acc)33" : "var(--b2)";

  return (
    <div className="sr" style={{ padding: "11px 13px", borderRadius: "8px", background: "var(--s2)", border: `1px solid ${borderCss}`, transition: "all .2s" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: isActive ? 8 : 0 }}>
        <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: col, minWidth: "38px", marginTop: "1px" }}>{minsToHHMM(item.startMin)}</span>
          <div>
            <p style={{ fontSize: "13px", fontWeight: "500", textDecoration: item.done ? "line-through" : "none", color: item.done ? "var(--muted)" : "var(--txt)" }}>{item.subject}</p>
            <div style={{ display: "flex", gap: "6px", marginTop: "3px", alignItems: "center" }}>
              <span style={{ fontSize: "10px", color: "var(--muted)" }}>{fmtHHMM(item.durationMin)}</span>
              {item.note && <span style={{ fontSize: "10px", color: "var(--muted)" }}>· {item.note}</span>}
              {status === "late" && <Tag color="var(--red)">Gecikmis</Tag>}
              {item.delayReason && <span style={{ fontSize: "10px", color: "var(--ora)" }}>· {item.delayReason}</span>}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
          {!item.done && !isActive && (
            <Btn size="sm" variant="accent" onClick={onStart}>
              ▶
            </Btn>
          )}
          {isActive && (
            <Btn size="sm" variant="success" onClick={onDone}>
              ✓ Bitti
            </Btn>
          )}
          {isActive && (
            <Btn size="sm" variant="ghost" onClick={onStop} style={{ color: "var(--muted)" }}>
              ◼
            </Btn>
          )}
          {!item.done && !isActive && (
            <Btn size="sm" variant="ghost" onClick={onDone} style={{ color: "var(--grn)" }}>
              ✓
            </Btn>
          )}
          <Btn size="sm" variant="ghost" onClick={onDelete} style={{ color: "var(--red)" }}>
            ×
          </Btn>
        </div>
      </div>
      {isActive && (
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
        <p style={{ fontSize: "13px", color: "var(--muted)", lineHeight: "1.5", marginBottom: "16px" }}>Plan kaydi tespit edildi. Neden geciktin?</p>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "14px" }}>
          {["Dikkat dagildi", "Konu beklenenden zor oldu", "Teknoloji kesintisi", "Yorgunluk", "Diger"].map((r) => (
            <button
              key={r}
              onClick={() => setReason(r)}
              style={{
                padding: "8px 11px",
                borderRadius: "6px",
                border: `1px solid ${reason === r ? "var(--acc)" : "var(--b2)"}`,
                background: reason === r ? "var(--acc)18" : "transparent",
                color: reason === r ? "var(--acc)" : "var(--muted)",
                fontSize: "12px",
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              {r}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <Btn variant="ghost" onClick={onCancel} style={{ flex: 1 }}>
            Iptal
          </Btn>
          <Btn variant="primary" onClick={() => onConfirm(reason || "Belirtilmedi")} style={{ flex: 2 }} disabled={!reason}>
            Kaydet →
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Discipline tab: cross alerts + mini coach + streak/xp/badges + challenge + benchmark
// ============================================================================
const QS = [
  { id: "q1", text: "Bugun deneme analizi yaptin mi?", yes: "Analiz yapmak en zor kisim — yaptin, iyi.", no: "Analiz yapmadan hata tekrarlanir. Bu aksam mutlaka yap." },
  { id: "q2", text: "Bugun yanlislarini cozdun mu?", yes: "Hatalari tekrar etmek guctur. Yapiyorsun — bu fark yaratir.", no: "Yanlis cozmeden ilerlemek kumda kale yapmak gibidir." },
  { id: "q3", text: "Bugun hedefledigin kadar calistin mi?", yes: "Plana sadik kalmak disiplinin temelidir.", no: "Yarin icin kucuk ve net bir hedef belirle." },
  { id: "q4", text: "Bugun zayif oldugun konuya zaman ayirdin mi?", yes: "Zayiflikla yuzlesmek cesarettir.", no: "Guclu konularda calismak konforu secmektir." },
];

const overallMsg = (s) => {
  if (s === 4) return { msg: "4/4. Mukemmel. Bu gunu kopyala.", c: "var(--grn)" };
  if (s === 3) return { msg: "3/4. Iyi ama 1 nokta eksik.", c: "var(--acc)" };
  if (s === 2) return { msg: "2/4. Ortalama. Yeterlinin altinda.", c: "var(--acc)" };
  if (s === 1) return { msg: "1/4. Ciddi eksik. Yarin plan yap.", c: "var(--red)" };
  return { msg: "0/4. Bu gun kayboldu. Yarin sifirdan.", c: "var(--red)" };
};

function miniCoachMsg(score, attnScore, completionPct, alerts) {
  if (alerts.todoOverdue > 0) return `Once gorev review: ${alerts.todoOverdue} gorev 7. gunune girdi. 15 dk ayir, bitir/ertele.`;
  if (alerts.planLate > 0) return `${alerts.planLate} plan ogesi gecikmis. Planini gercekci yap: bloklari kucult, buffer ekle.`;
  if (score === 4 && attnScore >= 80 && completionPct >= 80) return "Istisna bir gun. Dikkat yuksek, plan uyumu guclu. Bu tempo yeterli.";
  if (score <= 1 && attnScore < 60) return "Dikkat dusuk VE check-in skoru kotu. Telefonu kapat, mekana git, uykuya odaklan.";
  if (completionPct < 50 && score >= 3) return "Check-in iyi ama plan uyumu dusuk. Bloklar cok uzun olabilir, sadeleştir.";
  if (attnScore < 60) return "Dikkat analizi sorun gosteriyor. Erken molalar fazla — sebebi bul ve yok et.";
  return "Dengeli bir gun. Tek bir zayif noktayi sec, yarin sadece onu duzelt.";
}

function calcBenchmark({ xp, dw, plans, checkins }) {
  const today = todayStr();
  const last7 = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));

  const dwSessions = (dw?.sessions || []).filter((s) => last7.includes(s.date));
  const dwMin = dwSessions.reduce((s, x) => s + (x.completedMin || 0), 0);
  const dwGoalMin = dwSessions.reduce((s, x) => s + (x.goalMin || 0), 0);
  const dwRatio = dwGoalMin > 0 ? clamp(dwMin / dwGoalMin, 0, 1) : 0;

  const planItems = last7.flatMap((d) => plans?.[d] || []);
  const planDone = planItems.filter((p) => p.done).length;
  const planRatio = planItems.length > 0 ? planDone / planItems.length : 0;

  const ci = (checkins || []).filter((c) => last7.includes(c.date));
  const ciAvg = ci.length ? ci.reduce((s, c) => s + (c.score || 0), 0) / ci.length : 0;

  const xpScore = clamp((xp.points || 0) / 5000, 0, 1); // soft normalize
  const score = Math.round((xpScore * 35 + dwRatio * 35 + planRatio * 20 + (ciAvg / 4) * 10) * 100);

  const level =
    score >= 85 ? { name: "S", color: "var(--grn)" } :
    score >= 70 ? { name: "A", color: "var(--acc)" } :
    score >= 55 ? { name: "B", color: "var(--blu)" } :
    score >= 40 ? { name: "C", color: "var(--ora)" } :
    { name: "D", color: "var(--red)" };

  const focus = (() => {
    const gaps = [];
    if (dwRatio < 0.6) gaps.push("deep work");
    if (planRatio < 0.6) gaps.push("plan");
    if (ciAvg < 2.5) gaps.push("check-in");
    if ((xp.points || 0) < 1500) gaps.push("sureklilik");
    return gaps[0] || "denge";
  })();

  return { score, level, dwMin, planRatio, ciAvg, focus, today };
}

function generateDailyChallenge({ date, trials, todos, plans }) {
  const seed = date.split("-").join("");
  const num = parseInt(seed.slice(-3), 10) || 0;
  const weekPlan = buildWeeklyPlan(trials, 4);
  const topWeak = weekPlan[0]?.subject;
  const overdueTodos = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0).length;
  const todayPlan = plans[date] || [];
  const planLate = todayPlan.filter((p) => !p.done && p.startMin + p.durationMin < nowHHMM()).length;

  const pool = [
    { id: `c_${date}_review`, title: "15dk Gorev Review", desc: "7 gun uyarili gorevleri bitir veya ertele.", kind: "todo_review", target: 15, unit: "dk" },
    { id: `c_${date}_plan`, title: "Bugun 1 plan ogesi tamamla", desc: "En kucuk plan ogesini sec ve bitir.", kind: "plan_one", target: 1, unit: "adet" },
    { id: `c_${date}_block`, title: "1 Deep Work blok", desc: "Tek blok bile zinciri korur.", kind: "dw_block", target: 1, unit: "blok" },
    { id: `c_${date}_weak`, title: `${topWeak || "Zayif ders"} mini tekrar`, desc: `${topWeak || "Zayif ders"} icin 20dk mini tekrar.`, kind: "weak_20", target: 20, unit: "dk" },
  ];

  let pick = pool[num % pool.length];
  if (overdueTodos > 0) pick = pool[0];
  else if (planLate > 0) pick = pool[1];
  return pick;
}

function DisciplineTab({ trials, todos }) {
  const today = todayStr();
  const [checkins, setCheckins] = useState(() => store.load(KEYS.checkins, []));
  const [ans, setAns] = useState(() => checkins.find((c) => c.date === today)?.answers || {});
  const [submitted, setSubmitted] = useState(() => !!checkins.find((c) => c.date === today));
  const [showHist, setHist] = useState(false);
  const [xpData, setXpData] = useState(loadXP);

  const startRef = useRef(Date.now());

  const attn = store.load(KEYS.attn, {});
  const todayAttn = attn[today];
  const attnScore = useMemo(() => calcAttentionScore(todayAttn?.breaks || []), [todayAttn]);
  const plans = store.load(KEYS.plan, {});
  const todayPlan = plans[today] || [];
  const planPct = todayPlan.length > 0 ? Math.round((todayPlan.filter((p) => p.done).length / todayPlan.length) * 100) : 0;

  const todoOverdue = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0).length;
  const planLate = todayPlan.filter((p) => !p.done && p.startMin + p.durationMin < nowHHMM()).length;
  const missingCheckin = checkins.find((c) => c.date === today) ? 0 : 1;
  const lowAttn = attnScore < 60 ? 1 : 0;
  const alerts = { todoOverdue, planLate, missingCheckin, lowAttn };

  const setA = (qId, v) => {
    if (!submitted) setAns((p) => ({ ...p, [qId]: v }));
  };
  const submit = () => {
    const elapsed = Math.round((Date.now() - startRef.current) / 1000);
    const score = QS.filter((q) => ans[q.id] === true).length;
    const entry = { date: today, answers: ans, score, elapsed, at: new Date().toISOString() };
    const updated = [entry, ...checkins.filter((c) => c.date !== today)];
    setCheckins(updated);
    store.save(KEYS.checkins, updated);
    setSubmitted(true);
    const t = score === 4 ? "checkin_4" : score >= 3 ? "checkin_3" : null;
    if (t) {
      const { pts } = grantXP(t);
      toast(`+${pts} XP — ${score}/4`, "var(--acc)");
      setXpData(loadXP());
    }
    if (elapsed > 60) toast("Check-in cok uzun surdu. Dusunmeden cevapla.", "var(--red)");
  };

  const score = QS.filter((q) => ans[q.id] === true).length;
  const all = QS.every((q) => ans[q.id] !== undefined);
  const om = overallMsg(score);

  const last7 = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10);
        const c = checkins.find((x) => x.date === d);
        return { date: d, score: c?.score ?? -1 };
      }),
    [checkins],
  );
  const avg = useMemo(() => {
    const f = last7.filter((d) => d.score >= 0);
    return f.length ? (f.reduce((s, d) => s + d.score, 0) / f.length).toFixed(1) : null;
  }, [last7]);

  // Daily challenge
  const [challenge, setChallengeRaw] = useState(() => store.load(KEYS.challenge, {}));
  const setChallenge = useCallback((fn) => {
    setChallengeRaw((p) => {
      const n = typeof fn === "function" ? fn(p) : fn;
      store.save(KEYS.challenge, n);
      return n;
    });
  }, []);

  const todaysChallenge = useMemo(() => {
    const existing = challenge?.[today];
    if (existing?.id) return existing;
    const gen = generateDailyChallenge({ date: today, trials, todos, plans });
    const next = { ...gen, date: today, done: false, doneAt: null };
    // persist once
    setChallenge((p) => ({ ...(p || {}), [today]: next }));
    return next;
  }, [today, challenge, trials, todos, plans, setChallenge]);

  const completeChallenge = () => {
    if (todaysChallenge.done) return;
    setChallenge((p) => ({
      ...(p || {}),
      [today]: { ...(p?.[today] || todaysChallenge), done: true, doneAt: new Date().toISOString() },
    }));
    const { pts } = grantXP("challenge_done");
    playSound("done");
    toast(`✦ Challenge tamam! +${pts} XP`, "var(--acc)");
    setXpData(loadXP());
  };

  const dw = store.load(KEYS.dw, DW_DEFAULT);
  const bench = useMemo(() => calcBenchmark({ xp: xpData, dw, plans, checkins }), [xpData, dw, plans, checkins]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <Card style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
          <div>
            <Label style={{ marginBottom: "2px" }}>Disiplin Puani</Label>
            <span style={{ fontFamily: "var(--mono)", fontSize: "22px", fontWeight: "700", color: "var(--acc)" }}>{xpData.points} XP</span>
          </div>
          <div style={{ textAlign: "right" }}>
            {xpData.streak > 0 && <p style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--acc)" }}>🔥 {xpData.streak}g</p>}
            <p style={{ fontSize: "9px", color: "var(--muted)", marginTop: "1px" }}>
              {xpData.totalBlocks} blok · {xpData.totalTrials} deneme
            </p>
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

      {(todoOverdue + planLate + missingCheckin + lowAttn) > 0 && (
        <Card style={{ padding: "12px 14px", border: "1px solid var(--red)22" }}>
          <Label style={{ marginBottom: "8px" }}>Cross-Module Uyarilar</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {todoOverdue > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", background: "var(--s2)", borderRadius: "6px", padding: "8px 10px", border: "1px solid var(--acc)22" }}>
                <span style={{ fontSize: "12px" }}>⚡ Gorev review</span>
                <Tag color="var(--acc)">{todoOverdue} adet</Tag>
              </div>
            )}
            {planLate > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", background: "var(--s2)", borderRadius: "6px", padding: "8px 10px", border: "1px solid var(--red)22" }}>
                <span style={{ fontSize: "12px" }}>⚡ Plan gecikmesi</span>
                <Tag color="var(--red)">{planLate} adet</Tag>
              </div>
            )}
            {missingCheckin > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", background: "var(--s2)", borderRadius: "6px", padding: "8px 10px", border: "1px solid var(--red)22" }}>
                <span style={{ fontSize: "12px" }}>⚡ Check-in eksik</span>
                <Tag color="var(--red)">bugun</Tag>
              </div>
            )}
            {lowAttn > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", background: "var(--s2)", borderRadius: "6px", padding: "8px 10px", border: "1px solid var(--red)22" }}>
                <span style={{ fontSize: "12px" }}>⚡ Dikkat dusuk</span>
                <Tag color="var(--red)">{attnScore}/100</Tag>
              </div>
            )}
          </div>
        </Card>
      )}

      <Card style={{ padding: "12px 14px" }}>
        <Label style={{ marginBottom: "8px" }}>Gunluk Mini Challenge</Label>
        <div className={todaysChallenge.done ? "reward" : ""} style={{ padding: "10px 12px", background: "var(--s2)", borderRadius: "8px", border: `1px solid ${todaysChallenge.done ? "var(--grn)55" : "var(--b2)"}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
            <p style={{ fontSize: "13px", fontWeight: "600", color: todaysChallenge.done ? "var(--grn)" : "var(--acc)" }}>{todaysChallenge.title}</p>
            {todaysChallenge.done ? <Tag color="var(--grn)">tamam</Tag> : <Tag color="var(--acc)">bugun</Tag>}
          </div>
          <p style={{ fontSize: "11px", color: "var(--muted)", lineHeight: "1.5" }}>{todaysChallenge.desc}</p>
          <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
            <Btn variant="primary" onClick={completeChallenge} disabled={todaysChallenge.done} style={{ flex: 2 }}>
              {todaysChallenge.done ? "Tamamlandi" : "Tamamladim ✦"}
            </Btn>
            <Btn
              variant="ghost"
              onClick={() => {
                playSound("start");
                toast("Challenge modu: 15 dk odak!", "var(--acc)");
              }}
              style={{ flex: 1 }}
            >
              Basla
            </Btn>
          </div>
        </div>
      </Card>

      <Card style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <Label>Offline Benchmark</Label>
          <Tag color={bench.level.color}>Seviye {bench.level.name}</Tag>
        </div>
        <PBar value={bench.score} max={100} color={bench.level.color} />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)" }}>skor</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: bench.level.color }}>{bench.score}/100</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "7px", marginTop: "10px" }}>
          {[
            { l: "DW 7g", v: fmtHHMM(bench.dwMin), c: "var(--blu)" },
            { l: "Plan", v: `%${Math.round(bench.planRatio * 100)}`, c: bench.planRatio >= 0.7 ? "var(--grn)" : "var(--acc)" },
            { l: "CI", v: bench.ciAvg ? `${bench.ciAvg.toFixed(1)}/4` : "—", c: bench.ciAvg >= 3 ? "var(--grn)" : "var(--acc)" },
          ].map((x) => (
            <Card key={x.l} style={{ padding: "10px", textAlign: "center" }}>
              <p style={{ fontFamily: "var(--mono)", fontSize: "16px", fontWeight: "700", color: x.c, lineHeight: 1 }}>{x.v}</p>
              <p style={{ fontSize: "9px", color: "var(--muted)", marginTop: "3px" }}>{x.l}</p>
            </Card>
          ))}
        </div>
        <p style={{ fontSize: "11px", color: "var(--muted)", marginTop: "10px", lineHeight: "1.5" }}>
          Fokus oneri: <span style={{ color: "var(--acc)", fontFamily: "var(--mono)" }}>{bench.focus}</span>
        </p>
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <p style={{ fontWeight: "600", fontSize: "13px" }}>
            Check-in <span style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--muted)", marginLeft: "5px" }}>{today}</span>
          </p>
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
                    const c = v ? "var(--grn)" : "var(--red)";
                    return (
                      <button
                        key={String(v)}
                        onClick={() => setA(q.id, v)}
                        disabled={submitted}
                        style={{
                          flex: 1,
                          padding: "6px",
                          borderRadius: "5px",
                          border: `1px solid ${sel ? c : "var(--b2)"}`,
                          background: sel ? `${c}22` : "transparent",
                          color: sel ? c : "var(--muted)",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: submitted ? "default" : "pointer",
                        }}
                      >
                        {v ? "Evet" : "Hayir"}
                      </button>
                    );
                  })}
                </div>
                {a !== undefined && (
                  <p className="fi" style={{ fontSize: "10px", color: a ? "var(--grn)" : "var(--red)", marginTop: "6px", lineHeight: "1.5", fontStyle: "italic" }}>
                    → {a ? q.yes : q.no}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        {!submitted ? (
          <Btn variant="primary" onClick={submit} disabled={!all} style={{ width: "100%", marginTop: "12px", padding: "10px" }}>
            {all ? "Gunu Degerlendir →" : `${QS.filter((q) => ans[q.id] !== undefined).length}/${QS.length} cevaplandi`}
          </Btn>
        ) : (
          <div className="pi" style={{ marginTop: "12px", padding: "12px 13px", background: `${om.c}08`, border: `1px solid ${om.c}33`, borderRadius: "7px" }}>
            <p style={{ fontFamily: "var(--mono)", fontSize: "12px", fontWeight: "700", color: om.c, marginBottom: "6px" }}>{om.msg}</p>
            <p style={{ fontSize: "11px", color: "var(--muted)", lineHeight: "1.5" }}>{miniCoachMsg(score, attnScore, planPct, alerts)}</p>
          </div>
        )}
      </Card>

      {checkins.length > 0 && (
        <div>
          <button onClick={() => setHist((p) => !p)} style={{ fontSize: "10px", color: "var(--muted)", background: "none", border: "none", cursor: "pointer", marginBottom: "6px" }}>
            {showHist ? "▲ Gizle" : `▼ Gecmis (${checkins.length})`}
          </button>
          {showHist && (
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }} className="fi">
              {checkins.slice(0, 14).map((c) => (
                <div key={c.date} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 11px", background: "var(--s2)", borderRadius: "6px", border: "1px solid var(--b2)" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "10px" }}>{c.date}</span>
                  <div style={{ display: "flex", gap: "3px" }}>
                    {QS.map((q) => (
                      <span key={q.id} style={{ width: "6px", height: "6px", borderRadius: "50%", background: c.answers?.[q.id] === true ? "var(--grn)" : c.answers?.[q.id] === false ? "var(--red)" : "var(--b2)" }} />
                    ))}
                  </div>
                  <Tag color={c.score >= 3 ? "var(--grn)" : c.score >= 2 ? "var(--acc)" : "var(--red)"}>{c.score}/4</Tag>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Card style={{ padding: "12px 14px" }}>
        <Label style={{ marginBottom: "8px" }}>Son 7 Gun</Label>
        <div style={{ display: "flex", gap: "4px", alignItems: "flex-end", height: "44px" }}>
          {last7.map((d) => {
            const h = d.score >= 0 ? (d.score / 4) * 100 : 5;
            const c = d.score < 0 ? "var(--b2)" : d.score >= 3 ? "var(--grn)" : d.score >= 2 ? "var(--acc)" : "var(--red)";
            const isT = d.date === today;
            return (
              <div key={d.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: "3px" }}>
                <div style={{ width: "100%", height: `${h}%`, minHeight: "3px", background: c, borderRadius: "3px", outline: isT ? `2px solid ${c}` : "none", outlineOffset: "2px", transition: "height .5s ease" }} />
                <span style={{ fontSize: "8px", color: isT ? "var(--txt)" : "var(--muted)", fontFamily: "var(--mono)" }}>
                  {new Date(`${d.date}T12:00:00`).toLocaleDateString("tr-TR", { weekday: "short" }).slice(0, 2)}
                </span>
              </div>
            );
          })}
        </div>
        {avg && <p style={{ fontSize: "10px", color: "var(--muted)", marginTop: "8px" }}>ort. <span style={{ fontFamily: "var(--mono)", color: "var(--acc)" }}>{avg}/4</span></p>}
      </Card>
    </div>
  );
}

// ============================================================================
// Shared
// ============================================================================
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
// App
// ============================================================================
export default function App() {
  const [tab, setTab] = useState("brain");
  const [trials, setTrials] = useState(() => store.load(KEYS.trials, []));
  const [todos, setTodos] = useState(() => store.load(KEYS.todos, []));
  const [heatOpen, setHeat] = useState(false);
  const [xp, setXp] = useState(loadXP);
  const toasts = useToastSystem();

  useEffect(() => {
    const id = setInterval(() => setXp(loadXP()), 4000);
    return () => clearInterval(id);
  }, []);

  const pushTodos = useCallback(
    (items) => {
      const now = new Date().toISOString();
      const mapped = (items || [])
        .map((i) => ({
          id: uid(),
          text: i.text,
          source: i.source || "Import",
          priority: i.priority || "medium",
          done: false,
          reviewed: false,
          createdAt: now,
          reviewAt: new Date(Date.now() + 7 * 86400000).toISOString(),
          meta: i.meta || {},
        }))
        .filter((x) => x.text && x.text.trim());

      if (!mapped.length) return;
      setTodos((prev) => {
        const next = [...mapped, ...prev];
        store.save(KEYS.todos, next);
        return next;
      });
    },
    [setTodos],
  );

  const dwData = useMemo(() => store.load(KEYS.dw, DW_DEFAULT), [tab]);
  const checkins = useMemo(() => store.load(KEYS.checkins, []), [tab]);

  const alerts = useMemo(() => {
    const today = todayStr();
    const plan = store.load(KEYS.plan, {});
    const todayPlan = plan[today] || [];
    const planLate = todayPlan.filter((p) => !p.done && p.startMin + p.durationMin < nowHHMM()).length;
    const todoOverdue = todos.filter((t) => !t.done && !t.reviewed && t.reviewAt && daysFrom(t.reviewAt) >= 0).length;
    const missingCheckin = checkins.find((c) => c.date === today) ? 0 : 1;
    return {
      todos: todoOverdue,
      discipline: missingCheckin,
      brain: planLate,
      trials: 0,
    };
  }, [todos, checkins, tab]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: "var(--sans)", display: "flex", justifyContent: "center", padding: "24px 12px 80px" }}>
      <style>{CSS}</style>
      <div style={{ width: "100%", maxWidth: "540px" }}>
        <Header tab={tab} onToggleHeat={() => setHeat((p) => !p)} heatOpen={heatOpen} alerts={alerts} xp={xp} />
        {heatOpen && (
          <div className="fi" style={{ marginBottom: "14px" }}>
            <Card style={{ padding: "13px 14px" }}>
              <Heatmap sessions={dwData.sessions || []} trials={trials} checkins={checkins} />
            </Card>
          </div>
        )}
        <TabBar active={tab} onChange={setTab} alerts={alerts} />
        <div className="fu" key={tab}>
          {tab === "trials" && <TrialsTab trials={trials} setTrials={setTrials} onPushTodos={pushTodos} />}
          {tab === "brain" && <BrainDumpTab trials={trials} todos={todos} onPushTodos={pushTodos} />}
          {tab === "todos" && <TodosTab todos={todos} setTodos={setTodos} />}
          {tab === "discipline" && <DisciplineTab trials={trials} todos={todos} />}
        </div>
      </div>
      <ToastLayer toasts={toasts} />
    </div>
  );
}

/* LEGACY APP (disabled - kept only as reference)
*** End of File

// ═══════════════════════════════════════════════════════════════════
//  STORAGE
// ═══════════════════════════════════════════════════════════════════
const KEYS = {
trials:“yks_trials”, todos:“yks_todos”, brain:“yks_brain”,
checkins:“yks_checkins”, dw:“yks_dw”, xp:“yks_xp”,
plan:“yks_plan”,       // günlük saatlik plan
attn:“yks_attn”,       // dikkat takip verileri
};
const store = {
load:(k,fb=[])=>{ try{const v=localStorage.getItem(k);return v?JSON.parse(v):fb;}catch{return fb;} },
save:(k,v)=>{ try{localStorage.setItem(k,JSON.stringify(v));}catch{} },
};

// ═══════════════════════════════════════════════════════════════════
//  SABITLER & UTILS
// ═══════════════════════════════════════════════════════════════════
const YKS_DATE   = new Date(“2026-06-21T09:00:00”);
const todayStr   = ()=>new Date().toISOString().slice(0,10);
const uid        = ()=>Math.random().toString(36).slice(2,9);
const daysFrom   = (iso)=>Math.floor((Date.now()-new Date(iso).getTime())/86400000);
const clamp      = (v,lo,hi)=>Math.min(hi,Math.max(lo,v));
const fmtMMSS    = s=>`${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
const fmtHHMM    = m=>{ const h=Math.floor(m/60),r=m%60; return h>0?`${h}s${r>0?` ${r}dk`:""}`:r>0?`${r}dk`:“0dk”; };
const fmtDate    = iso=>new Date(iso).toLocaleDateString(“tr-TR”,{day:“2-digit”,month:“short”});
const nowHHMM    = ()=>{ const d=new Date(); return d.getHours()*60+d.getMinutes(); }; // dk cinsinden günün dakikası
const TYT_SUBS   = [“Turkce”,“Matematik”,“Fizik”,“Kimya”,“Biyoloji”,“Tarih”,“Cografya”,“Felsefe”,“Din”];
const AYT_SUBS   = [“Matematik”,“Fizik”,“Kimya”,“Biyoloji”,“Edebiyat”,“Tarih”,“Cografya”,“Felsefe”];
const calcNet    = (d,y)=>Math.max(0,parseFloat(d||0)-parseFloat(y||0)/4);

// YKS’ye kalan süre
function yksCountdown() {
const diff = YKS_DATE - Date.now();
if (diff <= 0) return { days:0, hours:0, passed:true };
const days  = Math.floor(diff/86400000);
const hours = Math.floor((diff%86400000)/3600000);
return { days, hours, passed:false };
}

// ═══════════════════════════════════════════════════════════════════
//  SES
// ═══════════════════════════════════════════════════════════════════
function playSound(type) {
try {
const ctx=new(window.AudioContext||window.webkitAudioContext)();
const g=ctx.createGain(); g.connect(ctx.destination);
if(type===“start”){
const o=ctx.createOscillator(); o.connect(g);
o.frequency.setValueAtTime(880,ctx.currentTime);
o.frequency.setValueAtTime(1100,ctx.currentTime+.12);
g.gain.setValueAtTime(.3,ctx.currentTime);
g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.35);
o.start(); o.stop(ctx.currentTime+.35);
} else if(type===“done”){
[0,.15,.3].forEach((t,i)=>{
const o=ctx.createOscillator(); o.connect(g);
o.frequency.value=[660,880,1100][i];
o.start(ctx.currentTime+t); o.stop(ctx.currentTime+t+.12);
});
g.gain.setValueAtTime(.25,ctx.currentTime);
g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.5);
} else if(type===“warn”){
const o=ctx.createOscillator(); o.connect(g);
o.frequency.value=300;
g.gain.setValueAtTime(.4,ctx.currentTime);
g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.4);
o.start(); o.stop(ctx.currentTime+.4);
}
} catch {}
}

// ═══════════════════════════════════════════════════════════════════
//  XP / GAMİFİCATION
// ═══════════════════════════════════════════════════════════════════
const XP_R  = {block_done:50,trial_added:30,todo_done:15,checkin_4:100,checkin_3:60,plan_done:80};
const BADGES = [
{id:“first_block”, label:“Ilk Blok”,    icon:“▶”, req:x=>x.totalBlocks>=1},
{id:“week_streak”, label:“7 Gun Seri”,  icon:“🔥”,req:x=>x.streak>=7},
{id:“trial_ace”,   label:“Deneme Ustu”, icon:“◉”, req:x=>x.totalTrials>=5},
{id:“discipline”,  label:“Demir Irade”, icon:“◆”, req:x=>x.perfect4>=3},
{id:“centurion”,   label:“100 Blok”,   icon:“⬛”, req:x=>x.totalBlocks>=100},
{id:“planner”,     label:“Planci”,     icon:“▦”, req:x=>x.plansDone>=7},
];
const loadXP  = ()=>store.load(KEYS.xp,{points:0,streak:0,totalBlocks:0,totalTrials:0,perfect4:0,plansDone:0,badges:[],lastDate:””});
const saveXP  = x=>store.save(KEYS.xp,x);
function grantXP(type){
const xp=loadXP(), pts=XP_R[type]||0, now=todayStr();
if(type===“block_done”){ xp.totalBlocks++;
if(xp.lastDate!==now){ const y=new Date(Date.now()-86400000).toISOString().slice(0,10); xp.streak=xp.lastDate===y?xp.streak+1:1; xp.lastDate=now; }
}
if(type===“trial_added”) xp.totalTrials++;
if(type===“checkin_4”)   xp.perfect4++;
if(type===“plan_done”)   xp.plansDone=(xp.plansDone||0)+1;
xp.points+=pts;
BADGES.forEach(b=>{ if(!xp.badges.includes(b.id)&&b.req(xp)) xp.badges.push(b.id); });
saveXP(xp); return { pts, xp };
}

// ═══════════════════════════════════════════════════════════════════
//  DİKKAT TAKİP SİSTEMİ
//  Her mola kaydedilir: {at, reason, blockMin, breakMin, type}
//  type: “early” | “normal” | “planned”
// ═══════════════════════════════════════════════════════════════════
const BREAK_REASONS = [
“Dikkat dağıldı”,“Yorgun hissettim”,“Telefon kontrolü”,
“Su/Yiyecek”,“Tuvalet”,“Planlı mola”,“Diğer”
];

/**

- Dikkat skoru hesapla: erken molalar fazlaysa düşer.
- earlyRatio = erken mola / toplam mola
- avgBlockMin = ortalama blok süresi
  */
  function calcAttentionScore(breaks) {
  if(!breaks||!breaks.length) return 100;
  const early = breaks.filter(b=>b.type===“early”).length;
  const ratio = early/breaks.length;
  const avgBlock = breaks.reduce((s,b)=>s+(b.blockMin||0),0)/breaks.length;
  let score = 100 - (ratio*40) - (Math.max(0,60-avgBlock)*0.5);
  return Math.round(clamp(score,0,100));
  }

function attentionLabel(score) {
if(score>=85) return {label:“Yuksek Dikkat”,color:“var(–grn)”};
if(score>=60) return {label:“Orta Dikkat”,color:“var(–acc)”};
return {label:“Dusuk Dikkat”,color:“var(–red)”};
}

// ═══════════════════════════════════════════════════════════════════
//  ANALİZ MOTORU — deneme sonuçlarından haftalık plan önerisi
// ═══════════════════════════════════════════════════════════════════
/**

- Tüm denemelerden ders bazlı zayıflık skoru çıkarır.
- Skor: 0=çok zayıf, 10=çok güçlü
  */
  function buildSubjectWeakness(trials) {
  const map = {};
  trials.forEach(t => {
  (t.nets||[]).forEach(n => {
  if(!map[n.subject]) map[n.subject]={sum:0,count:0,target:n.target||0};
  map[n.subject].sum   += n.net;
  map[n.subject].count += 1;
  if(n.target>0) map[n.subject].target = n.target;
  });
  });
  return Object.entries(map).map(([subject,d])=>({
  subject,
  avg: d.count>0 ? parseFloat((d.sum/d.count).toFixed(1)) : 0,
  target: d.target,
  gap: d.target>0 ? parseFloat((d.target - d.sum/d.count).toFixed(1)) : 0,
  })).sort((a,b)=>b.gap-a.gap); // en büyük açıktan küçüğe
  }

/**

- Haftalık çalışma planı öner.
- Günde 3 blok x 75dk = 225dk/gün varsayımıyla.
- Zayıf dersler daha fazla yer alır.
  */
  function buildWeeklyPlan(trials, goalHoursPerDay=4) {
  const weak = buildSubjectWeakness(trials);
  if(!weak.length) return [];
  const totalWeight = weak.reduce((s,w)=>s+Math.max(0.5,w.gap+1),0);
  const dayMins = goalHoursPerDay*60;
  return weak.map(w=>({
  subject: w.subject,
  dailyMin: Math.round((Math.max(0.5,w.gap+1)/totalWeight)*dayMins),
  avg: w.avg,
  gap: w.gap,
  priority: w.gap>2?“high”:w.gap>0?“medium”:“low”,
  })).filter(w=>w.dailyMin>=10);
  }

// ═══════════════════════════════════════════════════════════════════
//  CSS
// ═══════════════════════════════════════════════════════════════════
const CSS = `@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap'); *,*::before,*::after{box-sizing:border-box;margin:0;padding:0} :root{ --bg:#060606;--s1:#0e0e0e;--s2:#151515;--s3:#1c1c1c; --b1:#1e1e1e;--b2:#282828;--b3:#333; --txt:#e6e6e6;--muted:#4a4a4a; --acc:#e8c547;--red:#e05252;--grn:#4caf7d;--blu:#5b9cf6;--pur:#a78bfa;--ora:#f59e0b; --mono:'IBM Plex Mono',monospace;--sans:'IBM Plex Sans',sans-serif; } html,body{background:var(--bg);color:var(--txt);font-family:var(--sans);-webkit-font-smoothing:antialiased} button{cursor:pointer;font-family:var(--sans);transition:all .12s ease;border:none} button:hover:not(:disabled){filter:brightness(1.15)} button:active:not(:disabled){transform:scale(.97)} input,textarea,select{font-family:var(--sans);background:var(--s2);border:1px solid var(--b2);color:var(--txt);border-radius:6px;transition:border-color .15s} input:focus,textarea:focus,select:focus{outline:none;border-color:var(--acc)} input::placeholder,textarea::placeholder{color:var(--muted)} select option{background:var(--s2)} ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px} @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}} @keyframes fadeIn{from{opacity:0}to{opacity:1}} @keyframes blink{0%,100%{opacity:1}50%{opacity:0}} @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}} @keyframes flashY{0%{box-shadow:0 0 0 0 #e8c54760}60%{box-shadow:0 0 0 16px transparent}100%{box-shadow:0 0 0 0 transparent}} @keyframes flashR{0%{box-shadow:0 0 0 0 #e0525260}60%{box-shadow:0 0 0 16px transparent}100%{box-shadow:0 0 0 0 transparent}} @keyframes popIn{0%{transform:scale(.6);opacity:0}70%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}} @keyframes slideR{from{transform:translateX(-8px);opacity:0}to{transform:none;opacity:1}} @keyframes countdown{0%,100%{opacity:1}50%{opacity:.5}} .fu{animation:fadeUp .2s ease both} .fi{animation:fadeIn .15s ease both} .sr{animation:slideR .18s ease both} .pi{animation:popIn .28s cubic-bezier(.34,1.56,.64,1) both} .flashY{animation:flashY .6s ease} .flashR{animation:flashR .6s ease}`;

// ═══════════════════════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════════════════════
let _setToast=null;
function useToastSystem(){
const [toasts,setToasts]=useState([]);
_setToast=(msg,color=“var(–acc)”)=>{
const id=uid();
setToasts(p=>[…p.slice(-2),{id,msg,color}]);
setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==id)),2800);
};
return toasts;
}
const toast=(msg,color)=>_setToast?.(msg,color);

function ToastLayer({toasts}){
return(
<div style={{position:“fixed”,bottom:“24px”,right:“16px”,display:“flex”,flexDirection:“column”,gap:“6px”,zIndex:9999,pointerEvents:“none”}}>
{toasts.map(t=>(
<div key={t.id} className=“pi” style={{background:“var(–s1)”,border:`1px solid ${t.color}55`,borderLeft:`3px solid ${t.color}`,padding:“10px 14px”,borderRadius:“8px”,fontSize:“12px”,color:t.color,fontFamily:“var(–mono)”,maxWidth:“260px”,lineHeight:“1.4”,boxShadow:“0 8px 24px rgba(0,0,0,.5)”}}>{t.msg}</div>
))}
</div>
);
}

// ═══════════════════════════════════════════════════════════════════
//  UI PRİMİTİVLERİ
// ═══════════════════════════════════════════════════════════════════
const Card=({children,style,className})=>(

  <div className={className} style={{background:"var(--s1)",border:"1px solid var(--b1)",borderRadius:"10px",padding:"16px",...style}}>{children}</div>
);
const Label=({children,style})=>(
  <p style={{fontFamily:"var(--mono)",fontSize:"10px",fontWeight:"600",color:"var(--muted)",letterSpacing:"1.5px",textTransform:"uppercase",...style}}>{children}</p>
);
const Btn=({children,onClick,variant="default",size="md",disabled,style})=>{
  const V={default:{background:"var(--s2)",color:"var(--txt)",border:"1px solid var(--b2)"},primary:{background:"var(--acc)",color:"#000",fontWeight:"600"},danger:{background:"transparent",color:"var(--red)",border:"1px solid var(--red)44"},ghost:{background:"transparent",color:"var(--muted)"},success:{background:"transparent",color:"var(--grn)",border:"1px solid var(--grn)44"},accent:{background:"var(--acc)18",color:"var(--acc)",border:"1px solid var(--acc)33"}};
  const S={sm:{padding:"4px 10px",fontSize:"11px",borderRadius:"5px"},md:{padding:"8px 15px",fontSize:"13px",borderRadius:"7px"},lg:{padding:"12px 22px",fontSize:"14px",borderRadius:"8px",fontWeight:"600"}};
  return <button onClick={onClick} disabled={disabled} style={{...V[variant],...S[size],opacity:disabled?.4:1,cursor:disabled?"not-allowed":"pointer",...style}}>{children}</button>;
};
const Tag=({children,color="var(--acc)"})=>(
  <span style={{fontFamily:"var(--mono)",fontSize:"10px",fontWeight:"600",padding:"2px 7px",borderRadius:"4px",background:color+"18",color,letterSpacing:"0.5px",whiteSpace:"nowrap"}}>{children}</span>
);
const PBar=({value,max,color="var(--acc)",h=5})=>{
  const pct=max>0?clamp((value/max)*100,0,100):0;
  return <div style={{height:h,background:"var(--b1)",borderRadius:"999px",overflow:"hidden"}}><div style={{height:"100%",width:`${pct}%`,background:color,borderRadius:"999px",transition:"width .8s ease"}}/></div>;
};

// ═══════════════════════════════════════════════════════════════════
//  YKS COUNTDOWN — header için
// ═══════════════════════════════════════════════════════════════════
function YKSCountdown(){
const [tick,setTick]=useState(0);
useEffect(()=>{ const id=setInterval(()=>setTick(p=>p+1),60000); return()=>clearInterval(id); },[]);
const {days,hours,passed}=yksCountdown();
if(passed) return <Tag color="var(--grn)">YKS GECTI</Tag>;
return(
<div style={{display:“flex”,alignItems:“center”,gap:“6px”}}>
<span style={{fontFamily:“var(–mono)”,fontSize:“11px”,color:“var(–red)”,animation:“countdown 2s ease infinite”,fontWeight:“700”}}>{days}G</span>
<span style={{fontSize:“10px”,color:“var(–muted)”}}>kaldi</span>
</div>
);
}

// ═══════════════════════════════════════════════════════════════════
//  HEATMAP
// ═══════════════════════════════════════════════════════════════════
function Heatmap({sessions,trials,checkins}){
const cells=useMemo(()=>{
const dMap={},cMap={},tMap={};
(sessions||[]).forEach(s=>{dMap[s.date]=(s.completedMin||0);});
(checkins||[]).forEach(c=>{cMap[c.date]=c.score;});
(trials||[]).forEach(t=>{tMap[t.date]=(tMap[t.date]||0)+1;});
return Array.from({length:84},(_,i)=>{
const key=new Date(Date.now()-(83-i)*86400000).toISOString().slice(0,10);
const score=clamp(Math.floor((dMap[key]||0)/60)+((cMap[key]??-1)>=3?1:0)+(tMap[key]||0),0,4);
return{key,score,isToday:key===todayStr()};
});
},[sessions,trials,checkins]);
const colors=[“var(–b2)”,”#1a3a2a”,”#2a5a3a”,”#3a8a5a”,“var(–grn)”];
return(
<div>
<Label style={{marginBottom:“8px”}}>12 Haftalık Aktivite</Label>
<div style={{display:“grid”,gridTemplateColumns:“repeat(84,1fr)”,gap:“2px”}}>
{cells.map(c=><div key={c.key} title={c.key} style={{aspectRatio:“1”,borderRadius:“2px”,background:colors[c.score],outline:c.isToday?“1px solid var(–acc)”:“none”,outlineOffset:“1px”}}/>)}
</div>
<div style={{display:“flex”,gap:“5px”,alignItems:“center”,marginTop:“6px”,justifyContent:“flex-end”}}>
<span style={{fontSize:“9px”,color:“var(–muted)”}}>az</span>
{colors.map((c,i)=><div key={i} style={{width:“9px”,height:“9px”,background:c,borderRadius:“2px”}}/>)}
<span style={{fontSize:“9px”,color:“var(–muted)”}}>cok</span>
</div>
</div>
);
}

// ═══════════════════════════════════════════════════════════════════
//  SEKME ÇUBUĞU
// ═══════════════════════════════════════════════════════════════════
const TABS=[
{key:“plan”,  icon:“▦”,label:“Gunluk Plan”},
{key:“dw”,   icon:“▶”,label:“Deep Work”},
{key:“trial”,icon:“◉”,label:“Deneme”},
{key:“todo”, icon:“◻”,label:“Gorev”},
{key:“disc”, icon:“◆”,label:“Disiplin”},
];
function TabBar({active,onChange,alerts}){
return(
<div style={{display:“flex”,gap:“2px”,padding:“4px”,background:“var(–s1)”,borderRadius:“10px”,border:“1px solid var(–b1)”,marginBottom:“20px”}}>
{TABS.map(t=>(
<button key={t.key} onClick={()=>onChange(t.key)}
style={{flex:1,padding:“7px 2px”,borderRadius:“7px”,fontFamily:“var(–sans)”,fontSize:“9px”,fontWeight:“600”,letterSpacing:“0.3px”,background:active===t.key?“var(–acc)”:“transparent”,color:active===t.key?”#000”:“var(–muted)”,position:“relative”,transition:“all .15s”}}>
<span style={{display:“block”,fontFamily:“var(–mono)”,fontSize:“12px”,marginBottom:“2px”}}>{t.icon}</span>
{t.label}
{(alerts?.[t.key]||0)>0&&<span style={{position:“absolute”,top:“4px”,right:“5px”,width:“5px”,height:“5px”,borderRadius:“50%”,background:“var(–red)”,display:“block”,animation:“blink 1.5s ease infinite”}}/>}
</button>
))}
</div>
);
}

// ═══════════════════════════════════════════════════════════════════
//  MODÜL: GÜNLÜK PLAN
//  Saat saat planlama, timer entegrasyonu, kayma uyarısı
// ═══════════════════════════════════════════════════════════════════

/**

- Plan item yapısı:
- { id, startMin, durationMin, subject, note, done, doneAt, delayedMin, delayReason }
- startMin: günün başından dakika (örn 09:00 → 540)
  */
  function minsToHHMM(mins){
  const h=Math.floor(mins/60)%24, m=mins%60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  }
  function hhmmToMins(hhmm){ const [h,m]=hhmm.split(”:”).map(Number); return h*60+m; }

function DailyPlanTab({trials}){
const today=todayStr();
const [plans,setPlansRaw]=useState(()=>store.load(KEYS.plan,{}));
const setPlan=useCallback(fn=>{
setPlansRaw(p=>{const n=typeof fn===“function”?fn(p):fn;store.save(KEYS.plan,n);return n;});
},[]);

const todayPlan  = plans[today] || [];
const weeklyRec  = useMemo(()=>buildWeeklyPlan(trials,4),[trials]);

// Aktif timer state
const [activeId,setActiveId]=useState(null);
const [elapsed,setElapsed]=useState(0);
const itvRef=useRef(null);

const startTimer=(id)=>{ setActiveId(id); setElapsed(0); playSound(“start”); itvRef.current=setInterval(()=>setElapsed(p=>p+1),1000); };
const stopTimer=()=>{ clearInterval(itvRef.current); setActiveId(null); };
useEffect(()=>()=>clearInterval(itvRef.current),[]);

// Kayma tespiti: şu an çalışılması gereken blok
const nowMin = nowHHMM();
const overdue = todayPlan.filter(p=>!p.done && (p.startMin+p.durationMin)<nowMin);

// Yeni item form
const [form,setForm]=useState({startMin:minsToHHMM(Math.ceil(nowMin/30)*30),dur:“75”,subject:””,note:””});
const [addOpen,setAddOpen]=useState(false);
const [delayModal,setDelayModal]=useState(null); // {id, type:“delay”|“skip”}

const addItem=()=>{
if(!form.subject.trim()) return;
const item={id:uid(),startMin:hhmmToMins(form.startMin),durationMin:parseInt(form.dur)||75,subject:form.subject.trim(),note:form.note,done:false,doneAt:null,delayedMin:0,delayReason:””};
setPlan(p=>({…p,[today]:[…(p[today]||[]),item].sort((a,b)=>a.startMin-b.startMin)}));
setForm(f=>({…f,subject:””,note:””})); setAddOpen(false);
};

const markDone=(id)=>{
const item=todayPlan.find(x=>x.id===id);
if(!item) return;
// Gecikmeli tamamlama kontrolü
const expectedEnd=item.startMin+item.durationMin;
const delayedMin=Math.max(0,nowMin-expectedEnd);
if(delayedMin>15){ setDelayModal({id,type:“done”,delayedMin}); return; }
setPlan(p=>({…p,[today]:(p[today]||[]).map(x=>x.id===id?{…x,done:true,doneAt:new Date().toISOString()}:x)}));
stopTimer(); playSound(“done”); toast(“Plan ögesi tamamlandi!”,“var(–grn)”);
// Plan tamamlandıysa XP
const remaining=(plans[today]||[]).filter(x=>!x.done&&x.id!==id).length;
if(remaining===0){ grantXP(“plan_done”); toast(”+80 XP — Günlük plan tamam!”,“var(–acc)”); }
};

const confirmDelay=(id,reason)=>{
setPlan(p=>({…p,[today]:(p[today]||[]).map(x=>x.id===id?{…x,done:true,doneAt:new Date().toISOString(),delayReason:reason}:x)}));
setDelayModal(null); stopTimer(); playSound(“done”);
};

const delItem=(id)=>setPlan(p=>({…p,[today]:(p[today]||[]).filter(x=>x.id!==id)}));

const completionPct=todayPlan.length>0?Math.round(todayPlan.filter(x=>x.done).length/todayPlan.length*100):0;

return(
<div style={{display:“flex”,flexDirection:“column”,gap:“14px”}}>

  {/* YKS countdown banner */}
  <div style={{padding:"12px 14px",background:"var(--s2)",borderRadius:"8px",border:"1px solid var(--red)33",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
    <div>
      <p style={{fontFamily:"var(--mono)",fontSize:"10px",color:"var(--muted)",letterSpacing:"1px",marginBottom:"3px"}}>YKS'YE KALAN</p>
      <YKSCountdown/>
    </div>
    <div style={{textAlign:"right"}}>
      <p style={{fontSize:"10px",color:"var(--muted)"}}>21 Haziran 2026</p>
      <p style={{fontFamily:"var(--mono)",fontSize:"11px",color:"var(--acc)",marginTop:"2px"}}>{yksCountdown().days} gun</p>
    </div>
  </div>

  {/* Kayma uyarısı */}
  {overdue.length>0&&(
    <div style={{padding:"11px 13px",background:"var(--red)08",border:"1px solid var(--red)44",borderRadius:"8px",display:"flex",gap:"10px",alignItems:"center"}} className="flashR">
      <span style={{fontSize:"16px"}}>⚡</span>
      <div>
        <p style={{fontSize:"12px",fontWeight:"600",color:"var(--red)"}}>{overdue.length} plan ögesi gecikti</p>
        <p style={{fontSize:"11px",color:"var(--muted)",marginTop:"1px"}}>{overdue.map(x=>x.subject).join(", ")} — kayma tespit edildi.</p>
      </div>
    </div>
  )}

  {/* Progress */}
  {todayPlan.length>0&&(
    <Card style={{padding:"12px 14px"}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:"8px"}}>
        <Label>Bugunun Plani</Label>
        <span style={{fontFamily:"var(--mono)",fontSize:"11px",color:completionPct===100?"var(--grn)":"var(--acc)"}}>{completionPct}%</span>
      </div>
      <PBar value={completionPct} max={100} color={completionPct===100?"var(--grn)":"var(--acc)"}/>
    </Card>
  )}

  {/* Haftalık zayıflık önerisi */}
  {weeklyRec.length>0&&(
    <Card style={{padding:"12px 14px"}}>
      <Label style={{marginBottom:"8px"}}>Deneme Analizine Gore Bugünkü Öncelikler</Label>
      <div style={{display:"flex",flexDirection:"column",gap:"5px"}}>
        {weeklyRec.slice(0,4).map(w=>(
          <div key={w.subject} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 8px",background:"var(--s2)",borderRadius:"6px"}}>
            <div style={{display:"flex",gap:"6px",alignItems:"center"}}>
              <span style={{width:"5px",height:"5px",borderRadius:"50%",background:w.priority==="high"?"var(--red)":w.priority==="medium"?"var(--acc)":"var(--grn)",flexShrink:0}}/>
              <span style={{fontSize:"12px"}}>{w.subject}</span>
            </div>
            <div style={{display:"flex",gap:"8px",alignItems:"center"}}>
              <span style={{fontFamily:"var(--mono)",fontSize:"10px",color:"var(--muted)"}}>{fmtHHMM(w.dailyMin)}/gün</span>
              <span style={{fontFamily:"var(--mono)",fontSize:"10px",color:w.gap>0?"var(--red)":"var(--grn)"}}>{w.avg} ort.</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )}

  {/* Saatlik plan listesi */}
  <div style={{display:"flex",flexDirection:"column",gap:"6px"}}>
    {todayPlan.length===0&&!addOpen&&(
      <div style={{textAlign:"center",padding:"32px 16px",color:"var(--muted)"}}>
        <p style={{fontFamily:"var(--mono)",fontSize:"24px",marginBottom:"10px",color:"var(--b2)"}}>▦</p>
        <p style={{fontSize:"13px",marginBottom:"4px"}}>Bugün için plan yok</p>
        <p style={{fontSize:"11px",color:"var(--b3)"}}>Plan yap, zamana sahip çık.</p>
      </div>
    )}
    {todayPlan.map(item=>(
      <PlanItem key={item.id} item={item} nowMin={nowMin}
        activeId={activeId} elapsed={elapsed}
        onStart={()=>startTimer(item.id)}
        onStop={stopTimer}
        onDone={()=>markDone(item.id)}
        onDelete={()=>delItem(item.id)}/>
    ))}
  </div>

  {/* Ekle formu */}
  {addOpen?(
    <Card style={{padding:"14px"}}>
      <Label style={{marginBottom:"10px"}}>Yeni Plan Ögesi</Label>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px",marginBottom:"8px"}}>
        <div>
          <Label style={{marginBottom:"4px"}}>Saat</Label>
          <input type="time" value={form.startMin} onChange={e=>setForm(f=>({...f,startMin:e.target.value}))} style={{padding:"7px 10px",fontSize:"13px",width:"100%",borderRadius:"6px"}}/>
        </div>
        <div>
          <Label style={{marginBottom:"4px"}}>Süre (dk)</Label>
          <select value={form.dur} onChange={e=>setForm(f=>({...f,dur:e.target.value}))} style={{padding:"7px 10px",fontSize:"13px",width:"100%",borderRadius:"6px"}}>
            {[30,45,60,75,90,120].map(d=><option key={d}>{d}</option>)}
          </select>
        </div>
      </div>
      <div style={{marginBottom:"8px"}}>
        <Label style={{marginBottom:"4px"}}>Ders / Konu</Label>
        <input value={form.subject} onChange={e=>setForm(f=>({...f,subject:e.target.value}))} placeholder="Matematik — Türev" style={{padding:"8px 10px",fontSize:"13px",width:"100%",borderRadius:"6px"}}/>
      </div>
      <div style={{marginBottom:"12px"}}>
        <Label style={{marginBottom:"4px"}}>Not (opsiyonel)</Label>
        <input value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} placeholder="Konu detayı..." style={{padding:"8px 10px",fontSize:"13px",width:"100%",borderRadius:"6px"}}/>
      </div>
      <div style={{display:"flex",gap:"8px"}}>
        <Btn variant="ghost" onClick={()=>setAddOpen(false)} style={{flex:1}}>İptal</Btn>
        <Btn variant="primary" onClick={addItem} style={{flex:2}}>Planla →</Btn>
      </div>
    </Card>
  ):(
    <Btn variant="primary" onClick={()=>setAddOpen(true)} style={{width:"100%",padding:"11px"}}>+ Plan Ögesi Ekle</Btn>
  )}

  {/* Gecikme modal */}
  {delayModal&&(
    <DelayModal delayedMin={delayModal.delayedMin} onConfirm={r=>confirmDelay(delayModal.id,r)} onCancel={()=>setDelayModal(null)}/>
  )}
</div>


);
}

function PlanItem({item,nowMin,activeId,elapsed,onStart,onStop,onDone,onDelete}){
const isActive = activeId===item.id;
const status   = item.done?“done”:isActive?“active”:nowMin>item.startMin+item.durationMin?“late”:“upcoming”;
const colMap   = {done:“var(–grn)”,active:“var(–acc)”,late:“var(–red)”,upcoming:“var(–muted)”};
const col      = colMap[status];
const pct      = isActive?clamp(Math.round(elapsed/(item.durationMin*60)*100),0,100):item.done?100:0;

const borderCss = status==="late" ? "var(--red)33" : status==="active" ? "var(--acc)33" : "var(--b2)";

return(
<div className="sr" style={{padding:"11px 13px",borderRadius:"8px",background:"var(--s2)",border:"1px solid "+borderCss,transition:"all .2s"}}>
<div style={{display:“flex”,justifyContent:“space-between”,alignItems:“flex-start”,marginBottom:isActive?8:0}}>
<div style={{display:“flex”,gap:“10px”,alignItems:“flex-start”}}>
<span style={{fontFamily:“var(–mono)”,fontSize:“11px”,color:col,minWidth:“38px”,marginTop:“1px”}}>{minsToHHMM(item.startMin)}</span>
<div>
<p style={{fontSize:“13px”,fontWeight:“500”,textDecoration:item.done?“line-through”:“none”,color:item.done?“var(–muted)”:“var(–txt)”}}>{item.subject}</p>
<div style={{display:“flex”,gap:“6px”,marginTop:“3px”,alignItems:“center”}}>
<span style={{fontSize:“10px”,color:“var(–muted)”}}>{fmtHHMM(item.durationMin)}</span>
{item.note&&<span style={{fontSize:“10px”,color:“var(–muted)”}}>· {item.note}</span>}
{status===“late”&&<Tag color="var(--red)">Gecikmis</Tag>}
{item.delayReason&&<span style={{fontSize:“10px”,color:“var(–ora)”}}>· {item.delayReason}</span>}
</div>
</div>
</div>
<div style={{display:“flex”,gap:“4px”,flexShrink:0}}>
{!item.done&&!isActive&&<Btn size="sm" variant="accent" onClick={onStart}>▶</Btn>}
{isActive&&<Btn size="sm" variant="success" onClick={onDone}>✓ Bitti</Btn>}
{isActive&&<Btn size=“sm” variant=“ghost” onClick={onStop} style={{color:“var(–muted)”}}>◼</Btn>}
{!item.done&&!isActive&&<Btn size=“sm” variant=“ghost” onClick={onDone} style={{color:“var(–grn)”}}>✓</Btn>}
<Btn size=“sm” variant=“ghost” onClick={onDelete} style={{color:“var(–red)”}}>×</Btn>
</div>
</div>
{isActive&&(
<div className="fi">
<div style={{display:“flex”,justifyContent:“space-between”,marginBottom:“4px”}}>
<span style={{fontFamily:“var(–mono)”,fontSize:“11px”,color:“var(–acc)”}}>{fmtMMSS(elapsed)}</span>
<span style={{fontFamily:“var(–mono)”,fontSize:“10px”,color:“var(–muted)”}}>{pct}%</span>
</div>
<PBar value={elapsed} max={item.durationMin*60} color="var(--acc)" h={3}/>
</div>
)}
</div>
);
}

function DelayModal({delayedMin,onConfirm,onCancel}){
const [reason,setReason]=useState(””);
return(
<div style={{position:“fixed”,inset:0,background:“rgba(0,0,0,.8)”,display:“flex”,alignItems:“center”,justifyContent:“center”,zIndex:1000,padding:“20px”,backdropFilter:“blur(4px)”}}>
<div className=“pi” style={{background:“var(–s1)”,border:“1px solid var(–b2)”,borderRadius:“12px”,padding:“24px”,maxWidth:“340px”,width:“100%”}}>
<p style={{fontFamily:“var(–mono)”,fontSize:“14px”,color:“var(–acc)”,fontWeight:“700”,marginBottom:“8px”}}>⚡ {delayedMin} DK GECİKTİN</p>
<p style={{fontSize:“13px”,color:“var(–muted)”,lineHeight:“1.5”,marginBottom:“16px”}}>Plan kaydı tespit edildi. Neden geciktin? Bu analiz öneri üretmek için kullanılır.</p>
<div style={{display:“flex”,flexDirection:“column”,gap:“6px”,marginBottom:“14px”}}>
{[“Dikkat dağıldı”,“Konu beklenenden zor oldu”,“Teknoloji kesintisi”,“Yorgunluk”,“Diğer”].map(r=>(
<button key={r} onClick={()=>setReason(r)}
style={{padding:“8px 11px”,borderRadius:“6px”,border:"1px solid "+(reason===r?"var(--acc)":"var(--b2)"),background:reason===r?“var(–acc)18”:“transparent”,color:reason===r?“var(–acc)”:“var(–muted)”,fontSize:“12px”,textAlign:“left”,cursor:“pointer”}}>
{r}
</button>
))}
</div>
<div style={{display:“flex”,gap:“8px”}}>
<Btn variant="ghost" onClick={onCancel} style={{flex:1}}>İptal</Btn>
<Btn variant=“primary” onClick={()=>onConfirm(reason||“Belirtilmedi”)} style={{flex:2}} disabled={!reason}>Kaydet →</Btn>
</div>
</div>
</div>
);
}

// ═══════════════════════════════════════════════════════════════════
//  MODÜL: DEEP WORK + DİKKAT TAKİP
// ═══════════════════════════════════════════════════════════════════
const DW_DEFAULT={sessions:[],goalMin:180};
const FOCUS_QUOTES=[
“Rakibin simdi calisiyor. Sen ne yapiyorsun?”,
“Bu blok bitince mola hakkin var. Henuz degil.”,
“Disiplin, motivasyon olmadigi zamanlarda ne yaptigindir.”,
“Zorlanmak buyudugune isarettir.”,
“Flow state esigindeydin. Devam et.”,
“60 dakikanin icinde bir omur degisebilir.”,
“Konsantrasyon bir kastir. Her tekrarda gucleniyor.”,
“En iyi antrenmani yapan kazanir, en iyi hisseden degil.”,
];
const getQuote=()=>FOCUS_QUOTES[Math.floor(Math.random()*FOCUS_QUOTES.length)];

function buildBlocks(goalMin){
const blocks=[]; let rem=goalMin;
while(rem>=30){ const dur=clamp(rem,60,90); if(dur<30) break; blocks.push({id:uid(),dur}); rem-=dur+(rem-dur>=30?15:0); }
return blocks;
}
function calcAdaptiveGoal(sessions,currentMin){
const recent=sessions.filter(s=>daysFrom(s.date)>0&&daysFrom(s.date)<=7&&s.goalMin>0).slice(0,7);
if(recent.length<2) return { min: currentMin, reason: "Yeterli veri yok.", trend: "same" };
const avg=recent.reduce((s,x)=>s+clamp(x.completedMin/x.goalMin,0,1),0)/recent.length;
const pct=Math.round(avg*100);
if(avg>=.9) return { min: Math.min(480,currentMin+30), reason: "%" + pct + " tamamlama. Artiriliyor.", trend: "up" };
if(avg>=.6) return { min: currentMin, reason: "%" + pct + " — hedef uygun.", trend: "same" };
return { min: Math.max(120,currentMin-30), reason: "%" + pct + " — optimize ediliyor.", trend: "down" };
}

function DeepWorkTab(){
const [dw,setDwRaw]=useState(()=>store.load(KEYS.dw,DW_DEFAULT));
const [attn,setAttnRaw]=useState(()=>store.load(KEYS.attn,{}));
const setDw=useCallback(fn=>{setDwRaw(p=>{const n=typeof fn===“function”?fn(p):fn;store.save(KEYS.dw,n);return n;});},[]);
const setAttn=useCallback(fn=>{setAttnRaw(p=>{const n=typeof fn===“function”?fn(p):fn;store.save(KEYS.attn,n);return n;});},[]);

const today=todayStr();
const goalMin=dw.goalMin??180;
const blocks=useMemo(()=>buildBlocks(goalMin),[goalMin]);
const todaySess=dw.sessions.find(s=>s.date===today);
const doneBlocks=todaySess?.blocks??[];
const completedMin=doneBlocks.reduce((s,b)=>s+b.dur,0);
const earlyBreaks=todaySess?.earlyBreaks??0;
const adaptive=useMemo(()=>calcAdaptiveGoal(dw.sessions,goalMin),[dw.sessions,goalMin]);
const pct=goalMin>0?clamp(Math.round(completedMin/goalMin*100),0,100):0;
const todayDone=completedMin>=goalMin;

// Dikkat verileri
const todayBreaks=(attn[today]?.breaks||[]);
const attnScore=useMemo(()=>calcAttentionScore(todayBreaks),[todayBreaks]);
const {label:attnLabel,color:attnColor}=attentionLabel(attnScore);

const streak=useMemo(()=>{
let n=0;
for(let i=1;i<=30;i++){ const d=new Date(Date.now()-i*86400000).toISOString().slice(0,10); const s=dw.sessions.find(x=>x.date===d); if(s&&s.completedMin>=(s.goalMin||180)) n++; else break; }
return n;
},[dw.sessions]);

const dispMsg=useMemo(()=>{
if(earlyBreaks>=3) return{msg:String(earlyBreaks) + " erken mola. Konsantrasyon cokuyor. Telefonu odadan cikar.",color:"var(--red)"};
if(todayDone)      return{msg:streak>=3? String(streak) + " gun ust uste hedef. Bu aliskanlik biriyor." : "Bugunun hedefini tamamladin.",color:"var(--grn)"};
if(pct>=60)        return{msg:"Hedefe yakin. Son blok seni sinava sokacak.",color:"var(--acc)"};
if(pct>0)          return{msg:"Basladinsa kapat. Yarim birakmak yarin daha zor baslamana neden olur.",color:"var(--acc)"};
return{msg:"Hic baslamamak en kotu secenek. 1 blok bile fark yaratir.",color:"var(--muted)"};
},[earlyBreaks,todayDone,streak,pct]);

const nextIdx=doneBlocks.length;

function onBlockDone(dur,early,breakData){
playSound(“done”); grantXP(“block_done”);
toast("+" + XP_R.block_done + " XP - Blok tamamlandi","var(--grn)");
// Dikkat kaydı
if(breakData){
setAttn(p=>{
const prev=p[today]||{breaks:[]};
return{…p,[today]:{…prev,breaks:[…prev.breaks,breakData]}};
});
}
setDw(p=>{
const prev=p.sessions.find(s=>s.date===today);
const nb={id:uid(),dur,early,at:new Date().toISOString()};
const upd=prev?{…prev,blocks:[…(prev.blocks||[]),nb],completedMin:(prev.completedMin||0)+dur,earlyBreaks:(prev.earlyBreaks||0)+(early?1:0)}:{date:today,goalMin,blocks:[nb],completedMin:dur,earlyBreaks:early?1:0};
return{…p,sessions:[upd,…p.sessions.filter(s=>s.date!==today)]};
});
}

return(
<div style={{display:“flex”,flexDirection:“column”,gap:“14px”}}>
{/* Disiplin mesajı */}
<div style={{padding:“11px 14px”,background:“var(–s2)”,borderRadius:“8px”,border:"1px solid " + dispMsg.color + "33",display:“flex”,gap:“10px”,alignItems:“center”}}>
<div style={{width:“3px”,height:“32px”,background:dispMsg.color,borderRadius:“2px”,flexShrink:0}}/>
<p style={{fontSize:“12px”,color:dispMsg.color,lineHeight:“1.5”}}>{dispMsg.msg}</p>
</div>

  {/* Dikkat skoru */}
  {todayBreaks.length>0&&(
    <Card style={{padding:"12px 14px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"8px"}}>
        <Label>Dikkat Durumu</Label>
        <Tag color={attnColor}>{attnLabel} · {attnScore}/100</Tag>
      </div>
      <PBar value={attnScore} max={100} color={attnColor} h={5}/>
      <div style={{marginTop:"8px"}}>
        {/* Mola nedenlerini özetle */}
        {Object.entries(todayBreaks.reduce((m,b)=>{m[b.reason]=(m[b.reason]||0)+1;return m;},{})).map(([r,c])=>(
          <span key={r} style={{display:"inline-block",fontSize:"10px",color:"var(--muted)",marginRight:"8px",marginBottom:"2px"}}>
            {r}: {c}x
          </span>
        ))}
      </div>
      {attnScore<60&&(
        <p style={{fontSize:"11px",color:"var(--red)",marginTop:"6px",lineHeight:"1.4"}}>
          ⚡ Dikkat dusuk. Erken molalarin ana nedeni: {todayBreaks.filter(b=>b.type==="early").map(b=>b.reason)[0]||"belirsiz"}
        </p>
      )}
    </Card>
  )}

  {/* Hedef & progress */}
  <Card>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:"10px"}}>
      <div>
        <Label style={{marginBottom:"3px"}}>Gunluk Hedef</Label>
        <div style={{display:"flex",alignItems:"baseline",gap:"8px"}}>
          <span style={{fontFamily:"var(--mono)",fontSize:"28px",fontWeight:"700",color:"var(--acc)"}}>{fmtHHMM(goalMin)}</span>
          {streak>0&&<span style={{fontSize:"11px",color:"var(--acc)",fontFamily:"var(--mono)"}}>🔥 {streak}g</span>}
        </div>
      </div>
      <GoalEditor goalMin={goalMin} adaptive={adaptive} onSave={min=>setDw(p=>({...p,goalMin:min}))}/>
    </div>
    <PBar value={completedMin} max={goalMin} color={todayDone?"var(--grn)":pct>=60?"var(--acc)":"var(--blu)"}/>
    <div style={{display:"flex",justifyContent:"space-between",marginTop:"5px"}}>
      <span style={{fontFamily:"var(--mono)",fontSize:"10px",color:"var(--muted)"}}>{fmtHHMM(completedMin)}/{fmtHHMM(goalMin)}</span>
      <span style={{fontFamily:"var(--mono)",fontSize:"10px",color:todayDone?"var(--grn)":"var(--muted)"}}>{pct}%</span>
    </div>
  </Card>

  {/* Blok grid */}
  <BlockGrid blocks={blocks} doneBlocks={doneBlocks} nextIdx={nextIdx}/>

  {nextIdx<blocks.length&&(
    <BlockTimer block={blocks[nextIdx]} idx={nextIdx} earlyBreaks={earlyBreaks} onDone={onBlockDone}/>
  )}
  {todayDone&&(
    <div className="pi" style={{textAlign:"center",padding:"18px",background:"var(--grn)08",border:"1px solid var(--grn)33",borderRadius:"10px"}}>
      <p style={{fontFamily:"var(--mono)",fontSize:"16px",color:"var(--grn)",marginBottom:"3px"}}>✓ HEDEF TAMAM</p>
      <p style={{fontSize:"11px",color:"var(--muted)"}}>Bugunun gorevini yerine getirdin.</p>
    </div>
  )}
  <DWHistory sessions={dw.sessions}/>
</div>

);
}

function GoalEditor({goalMin,adaptive,onSave}){
const [open,setOpen]=useState(false);
return(
<div style={{position:“relative”}}>
<Btn size=“sm” variant=“ghost” onClick={()=>setOpen(p=>!p)} style={{color:“var(–muted)”,fontSize:“11px”}}>{open?“✕”:“Degistir”}</Btn>
{open&&(
<div className=“fi” style={{position:“absolute”,right:0,top:“26px”,background:“var(–s2)”,border:“1px solid var(–b2)”,borderRadius:“9px”,padding:“12px”,zIndex:100,width:“210px”,boxShadow:“0 12px 32px rgba(0,0,0,.6)”}}>
<Label style={{marginBottom:“7px”}}>Hizli Secim</Label>
<div style={{display:“flex”,gap:“4px”,flexWrap:“wrap”,marginBottom:“10px”}}>
{[2,3,4,5,6,8].map(h=>(
<button key={h} onClick={()=>{onSave(h*60);setOpen(false);}}
style={{padding:“5px 9px”,borderRadius:“5px”,border:“1px solid”,fontSize:“11px”,cursor:“pointer”,fontFamily:“var(–mono)”,borderColor:Math.round(goalMin/60)===h?“var(–acc)”:“var(–b2)”,background:Math.round(goalMin/60)===h?“var(–acc)22”:“transparent”,color:Math.round(goalMin/60)===h?“var(–acc)”:“var(–muted)”}}>
{h}s
</button>
))}
</div>
{adaptive.trend!==“same”&&(
<div style={{padding:“8px 10px”,borderRadius:“7px”,background:adaptive.trend===“up”?“var(–grn)08”:“var(–red)08”,border:`1px solid ${adaptive.trend==="up"?"var(--grn)":"var(--red)"}33`}}>
<p style={{fontSize:“10px”,color:“var(–muted)”,marginBottom:“4px”,lineHeight:“1.4”}}>{adaptive.reason}</p>
<div style={{display:“flex”,justifyContent:“space-between”,alignItems:“center”}}>
<span style={{fontFamily:“var(–mono)”,fontSize:“11px”,color:adaptive.trend===“up”?“var(–grn)”:“var(–red)”}}>{adaptive.trend===“up”?“▲”:“▼”} {fmtHHMM(adaptive.min)}</span>
<Btn size=“sm” variant={adaptive.trend===“up”?“success”:“danger”} onClick={()=>{onSave(adaptive.min);setOpen(false);}}>Uygula</Btn>
</div>
</div>
)}
</div>
)}
</div>
);
}

function BlockGrid({blocks,doneBlocks,nextIdx}){
return(
<Card style={{padding:“12px 14px”}}>
<Label style={{marginBottom:“8px”}}>Bloklar — {blocks.length} blok</Label>
<div style={{display:“flex”,gap:“4px”,flexWrap:“wrap”}}>
{blocks.map((b,i)=>{
const done=i<doneBlocks.length,active=i===nextIdx,early=doneBlocks[i]?.early;
return(
<div key={b.id} style={{padding:“6px 9px”,borderRadius:“6px”,fontSize:“11px”,fontFamily:“var(–mono)”,minWidth:“42px”,textAlign:“center”,background:done?(early?“var(–red)18”:“var(–grn)18”):active?“var(–acc)18”:“var(–s2)”,border:`1px solid ${done?(early?"var(--red)55":"var(--grn)55"):active?"var(--acc)55":"var(--b2)"}`,color:done?(early?“var(–red)”:“var(–grn)”):active?“var(–acc)”:“var(–muted)”,transition:“all .3s”}}>
{done?(early?”!”:“✓”):active?“▶”:i+1}
<div style={{fontSize:“9px”,marginTop:“1px”,opacity:.7}}>{b.dur}dk</div>
</div>
);
})}
</div>
</Card>
);
}

function BlockTimer({block,idx,earlyBreaks,onDone}){
const TOTAL=block.dur*60;
const [phase,setPhase]=useState(“idle”);
const [elapsed,setEl]=useState(0);
const [quote,setQuote]=useState(getQuote);
const [breakReason,setBreakReason]=useState(””);
const itvRef=useRef(null);
const start=useCallback(()=>{setPhase(“run”);playSound(“start”);itvRef.current=setInterval(()=>setEl(p=>p+1),1000);},[]);
const stop=useCallback(()=>{clearInterval(itvRef.current);},[]);
useEffect(()=>()=>stop(),[stop]);
useEffect(()=>{if(elapsed>=TOTAL&&phase===“run”){stop();setPhase(“done”);onDone(block.dur,false,null);playSound(“done”);}},[elapsed,TOTAL,phase]);
useEffect(()=>{if(phase===“run”&&elapsed>0&&elapsed%(15*60)===0) setQuote(getQuote());},[elapsed,phase]);

const rem=Math.max(0,TOTAL-elapsed),pct=clamp(Math.round(elapsed/TOTAL*100),0,100),elMin=Math.floor(elapsed/60),minL=Math.ceil(rem/60);

if(phase===“done”) return(
<Card style={{textAlign:“center”,padding:“20px”,background:“var(–grn)08”,border:“1px solid var(–grn)33”}}>
<p style={{fontFamily:“var(–mono)”,fontSize:“18px”,color:“var(–grn)”,marginBottom:“3px”}}>✓ BLOK {idx+1} TAMAM</p>
<p style={{fontSize:“11px”,color:“var(–muted)”}}>Mola hakkin var.</p>
</Card>
);

if(phase===“warn”) return(
<Card style={{padding:“18px”,background:“var(–red)06”,border:“1px solid var(–red)44”}} className=“flashR”>
<p style={{fontFamily:“var(–mono)”,fontSize:“13px”,color:“var(–red)”,fontWeight:“700”,marginBottom:“6px”}}>⚡ ERKEN MOLA — {minL} dk kaldi</p>
{earlyBreaks>=2&&<p style={{fontSize:“11px”,color:“var(–muted)”,marginBottom:“10px”}}>Bu bugun {earlyBreaks+1}. erken molan.</p>}
<Label style={{marginBottom:“6px”}}>Neden mola istiyorsun?</Label>
<div style={{display:“flex”,flexWrap:“wrap”,gap:“5px”,marginBottom:“12px”}}>
{BREAK_REASONS.map(r=>(
<button key={r} onClick={()=>setBreakReason(r)}
style={{padding:“4px 9px”,borderRadius:“5px”,border:`1px solid ${breakReason===r?"var(--acc)":"var(--b2)"}`,background:breakReason===r?“var(–acc)22”:“transparent”,color:breakReason===r?“var(–acc)”:“var(–muted)”,fontSize:“11px”,cursor:“pointer”}}>
{r}
</button>
))}
</div>
<div style={{display:“flex”,gap:“8px”}}>
<Btn variant=“primary” style={{flex:2}} onClick={()=>{setPhase(“run”);start();}}>Devam ediyorum</Btn>
<Btn variant=“danger” style={{flex:1}} disabled={!breakReason} onClick={()=>{setPhase(“done”);onDone(elMin,true,{type:“early”,blockMin:elMin,reason:breakReason,at:new Date().toISOString()});}}>Mola ver</Btn>
</div>
</Card>
);

if(phase===“idle”) return(
<Card style={{padding:“16px”}}>
<div style={{display:“flex”,justifyContent:“space-between”,alignItems:“center”,marginBottom:“12px”}}>
<div>
<Label style={{marginBottom:“2px”}}>Siradaki Blok</Label>
<p style={{fontFamily:“var(–mono)”,fontSize:“18px”,fontWeight:“700”}}>Blok {idx+1} · {block.dur}dk</p>
</div>
<Tag color="var(--blu)">{fmtHHMM(block.dur)}</Tag>
</div>
<Btn variant=“primary” onClick={start} style={{width:“100%”,padding:“12px”,fontSize:“13px”}}>▶ Bloku Baslat</Btn>
</Card>
);

const r=52,circ=2*Math.PI*r;
return(
<Card style={{padding:“22px 16px”,textAlign:“center”,border:“1px solid var(–acc)22”}}>
<Label style={{marginBottom:“12px”}}>ODAK MODU · BLOK {idx+1}</Label>
<div style={{position:“relative”,display:“inline-block”,marginBottom:“14px”}}>
<svg width=“120” height=“120” style={{transform:“rotate(-90deg)”}}>
<circle cx="60" cy="60" r={r} fill="none" stroke="var(--b1)" strokeWidth="6"/>
<circle cx="60" cy="60" r={r} fill="none" stroke={pct>=80?“var(–grn)”:“var(–acc)”} strokeWidth=“6” strokeLinecap=“round” strokeDasharray={circ} strokeDashoffset={circ*(1-pct/100)} style={{transition:“stroke-dashoffset 1s ease,stroke .5s”}}/>
</svg>
<div style={{position:“absolute”,top:“50%”,left:“50%”,transform:“translate(-50%,-50%)”,textAlign:“center”}}>
<p style={{fontFamily:“var(–mono)”,fontSize:“22px”,fontWeight:“700”,lineHeight:1}}>{fmtMMSS(rem)}</p>
<p style={{fontFamily:“var(–mono)”,fontSize:“9px”,color:“var(–muted)”,marginTop:“2px”}}>kaldi</p>
</div>
</div>
<p style={{fontSize:“11px”,color:“var(–muted)”,fontStyle:“italic”,maxWidth:“250px”,margin:“0 auto 14px”,lineHeight:“1.6”}}>”{quote}”</p>
<PBar value={elapsed} max={TOTAL} color={pct>=80?“var(–grn)”:“var(–acc)”} h={3}/>
<div style={{display:“flex”,gap:“8px”,justifyContent:“center”,marginTop:“12px”}}>
<Btn variant=“ghost” onClick={()=>{stop();setPhase(“warn”);playSound(“warn”);}} style={{color:“var(–muted)”,fontSize:“11px”}}>Mola iste</Btn>
<Btn variant=“success” onClick={()=>{stop();setPhase(“done”);onDone(elMin,false,null);}}>Bloku Tamamla ✓</Btn>
</div>
</Card>
);
}

function DWHistory({sessions}){
const [open,setOpen]=useState(false);
const recent=useMemo(()=>[…sessions].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,10),[sessions]);
if(!sessions.length) return null;
return(
<div>
<button onClick={()=>setOpen(p=>!p)} style={{fontSize:“11px”,color:“var(–muted)”,background:“none”,border:“none”,cursor:“pointer”,marginBottom:“6px”}}>{open?“▲ Gizle”:`▼ Son ${Math.min(10,sessions.length)} seans`}</button>
{open&&(
<div style={{display:“flex”,flexDirection:“column”,gap:“4px”}} className=“fi”>
{recent.map(s=>{
const r=s.goalMin>0?clamp(s.completedMin/s.goalMin,0,1):0;
const c=r>=1?“var(–grn)”:r>=.6?“var(–acc)”:“var(–red)”;
return(
<div key={s.date} style={{display:“flex”,alignItems:“center”,gap:“9px”,padding:“7px 11px”,background:“var(–s2)”,borderRadius:“6px”,border:“1px solid var(–b2)”}}>
<span style={{fontFamily:“var(–mono)”,fontSize:“10px”,color:“var(–muted)”,minWidth:“68px”}}>{s.date}</span>
<div style={{flex:1}}><PBar value={s.completedMin} max={s.goalMin} color={c} h={4}/></div>
<span style={{fontFamily:“var(–mono)”,fontSize:“10px”,color:c,minWidth:“50px”,textAlign:“right”}}>{fmtHHMM(s.completedMin)}/{fmtHHMM(s.goalMin)}</span>
</div>
);
})}
</div>
)}
</div>
);
}

// ═══════════════════════════════════════════════════════════════════
//  MODÜL: DENEMELER + HAFTALIK OPTİMİZASYON
// ═══════════════════════════════════════════════════════════════════
function TrialTab({trials,setTrials}){
const [adding,setAdding]=useState(false);
const [showOpt,setShowOpt]=useState(false);
const save=t=>{
const updated=[t,…trials];
setTrials(updated);store.save(KEYS.trials,updated);
grantXP(“trial_added”); toast(`Deneme kaydedildi — ${t.totalNet} net`,“var(–blu)”);
if(t.todos?.length){ const ex=store.load(KEYS.todos); store.save(KEYS.todos,[…t.todos.map(text=>({id:uid(),text,source:`${t.type} (${fmtDate(t.date)})`,priority:“high”,done:false,reviewed:false,createdAt:new Date().toISOString(),reviewAt:new Date(Date.now()+7*86400000).toISOString()})),…ex]); }
setAdding(false);
};
const del=id=>{const u=trials.filter(t=>t.id!==id);setTrials(u);store.save(KEYS.trials,u);};
const trend=useMemo(()=>{ const m={}; […trials].reverse().forEach(t=>{if(!m[t.type]) m[t.type]=[]; m[t.type].push({net:t.totalNet,date:t.date});}); return m; },[trials]);
const weekPlan=useMemo(()=>buildWeeklyPlan(trials,4),[trials]);

return(
<div style={{display:“flex”,flexDirection:“column”,gap:“13px”}}>
{Object.keys(trend).length>0&&(
<div style={{display:“flex”,gap:“9px”}}>
{Object.entries(trend).map(([type,arr])=>{
const last=arr[arr.length-1]?.net,prev=arr[arr.length-2]?.net,d=prev!==undefined?last-prev:null;
return(
<Card key={type} style={{flex:1,textAlign:“center”,padding:“11px”}}>
<Tag color={type===“TYT”?“var(–blu)”:“var(–acc)”}>{type}</Tag>
<p style={{fontFamily:“var(–mono)”,fontSize:“24px”,fontWeight:“700”,color:“var(–acc)”,margin:“5px 0 2px”}}>{last?.toFixed(1)}</p>
<p style={{fontSize:“9px”,color:“var(–muted)”}}>son net</p>
{d!==null&&<p style={{fontFamily:“var(–mono)”,fontSize:“10px”,marginTop:“2px”,color:d>=0?“var(–grn)”:“var(–red)”}}>{d>=0?“▲”:“▼”} {Math.abs(d).toFixed(1)}</p>}
</Card>
);
})}
</div>
)}

  {/* Haftalık optimizasyon önerisi */}
  {weekPlan.length>0&&(
    <div>
      <button onClick={()=>setShowOpt(p=>!p)} style={{fontSize:"11px",color:"var(--acc)",background:"none",border:"none",cursor:"pointer",marginBottom:"6px",display:"flex",alignItems:"center",gap:"5px"}}>
        <span style={{fontFamily:"var(--mono)"}}>◈</span> {showOpt?"Haftalik plani gizle":"Haftalik plan optimizasyonu goster"}
      </button>
      {showOpt&&(
        <Card style={{padding:"13px"}} className="fi">
          <Label style={{marginBottom:"8px"}}>Deneme Sonucuna Gore Haftalik Plan</Label>
          <div style={{display:"flex",flexDirection:"column",gap:"5px"}}>
            {weekPlan.map(w=>(
              <div key={w.subject} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 9px",background:"var(--s2)",borderRadius:"6px",border:`1px solid ${w.priority==="high"?"var(--red)33":w.priority==="medium"?"var(--acc)33":"var(--grn)33"}`}}>
                <div style={{display:"flex",gap:"7px",alignItems:"center"}}>
                  <span style={{width:"5px",height:"5px",borderRadius:"50%",background:w.priority==="high"?"var(--red)":w.priority==="medium"?"var(--acc)":"var(--grn)",flexShrink:0}}/>
                  <span style={{fontSize:"12px"}}>{w.subject}</span>
                </div>
                <div style={{display:"flex",gap:"10px",alignItems:"center"}}>
                  <span style={{fontFamily:"var(--mono)",fontSize:"10px",color:"var(--muted)"}}>{fmtHHMM(w.dailyMin)}/gün</span>
                  <span style={{fontFamily:"var(--mono)",fontSize:"10px",color:w.gap>0?"var(--red)":"var(--grn)"}}>{w.avg} ort · {w.gap>0?"+"+w.gap.toFixed(1):"ok"}</span>
                </div>
              </div>
            ))}
          </div>
          <p style={{fontSize:"10px",color:"var(--muted)",marginTop:"8px",lineHeight:"1.5"}}>Kirmizi = hedef açığı büyük. Bu derslere günlük önerilen süre ayır.</p>
        </Card>
      )}
    </div>
  )}

  {adding?<Card><p style={{fontWeight:"600",fontSize:"13px",marginBottom:"14px"}}>Yeni Deneme</p><TrialForm onSave={save} onCancel={()=>setAdding(false)}/></Card>
    :<Btn variant="primary" onClick={()=>setAdding(true)} style={{width:"100%",padding:"11px"}}>+ Deneme Ekle</Btn>}
  {!adding&&trials.length===0&&<EmptyState icon="◉" title="Henuz deneme yok" desc="Ilk denemeyi ekle ve analiz et."/>}
  {!adding&&trials.map(t=><TrialCard key={t.id} trial={t} onDelete={del}/>)}
</div>

);
}

function TrialForm({onSave,onCancel}){
const [date,setDate]=useState(todayStr());
const [type,setType]=useState(“TYT”);
const [nets,setNets]=useState({});
const [targets,setTargets]=useState({});
const [err,setErr]=useState(””);
const [todos,setTodos]=useState(””);
const subs=type===“TYT”?TYT_SUBS:AYT_SUBS;
const setN=(s,f,v)=>setNets(p=>({…p,[s]:{…p[s],[f]:v}}));
const totalNet=subs.reduce((sum,s)=>sum+calcNet(nets[s]?.d,nets[s]?.y),0);
const handleSave=()=>{
const list=subs.map(s=>({subject:s,correct:parseFloat(nets[s]?.d||0),wrong:parseFloat(nets[s]?.y||0),net:calcNet(nets[s]?.d,nets[s]?.y),target:parseFloat(targets[s]||0)})).filter(n=>n.correct>0||n.wrong>0);
if(!list.length){alert(“En az bir ders gir.”);return;}
onSave({id:uid(),date,type,nets:list,totalNet:parseFloat(totalNet.toFixed(2)),errorAnalysis:err,todos:todos.split(”\n”).map(t=>t.trim()).filter(Boolean),createdAt:new Date().toISOString()});
};
return(
<div style={{display:“flex”,flexDirection:“column”,gap:“14px”}}>
<div style={{display:“flex”,gap:“9px”}}>
<div style={{flex:1}}><Label style={{marginBottom:“4px”}}>Tarih</Label><input type=“date” value={date} onChange={e=>setDate(e.target.value)} style={{padding:“7px 9px”,fontSize:“12px”,width:“100%”,borderRadius:“6px”}}/></div>
<div style={{flex:1}}><Label style={{marginBottom:“4px”}}>Tur</Label><select value={type} onChange={e=>setType(e.target.value)} style={{padding:“7px 9px”,fontSize:“12px”,width:“100%”,borderRadius:“6px”}}><option>TYT</option><option>AYT</option></select></div>
<div style={{textAlign:“right”,paddingTop:“16px”}}><span style={{fontFamily:“var(–mono)”,fontSize:“18px”,fontWeight:“700”,color:“var(–acc)”}}>{totalNet.toFixed(1)}</span><p style={{fontSize:“9px”,color:“var(–muted)”}}>net</p></div>
</div>
<div>
<Label style={{marginBottom:“7px”}}>Netler D/Y + Hedef</Label>
<div style={{display:“grid”,gridTemplateColumns:“repeat(2,1fr)”,gap:“5px”}}>
{subs.map(s=>{
const n=calcNet(nets[s]?.d,nets[s]?.y),tgt=parseFloat(targets[s]||0),hit=tgt>0&&n>=tgt,miss=tgt>0&&n<tgt;
return(
<div key={s} style={{background:“var(–s2)”,borderRadius:“6px”,padding:“8px 9px”,border:`1px solid ${hit?"var(--grn)33":miss?"var(--red)33":"var(--b2)"}`}}>
<div style={{display:“flex”,justifyContent:“space-between”,marginBottom:“5px”}}><span style={{fontSize:“11px”}}>{s}</span><span style={{fontFamily:“var(–mono)”,fontSize:“10px”,color:hit?“var(–grn)”:miss?“var(–red)”:“var(–acc)”}}>{n.toFixed(1)}</span></div>
<div style={{display:“flex”,gap:“3px”}}>
<input type=“number” min=“0” placeholder=“D” value={nets[s]?.d||””} onChange={e=>setN(s,“d”,e.target.value)} style={{flex:1,padding:“3px 5px”,fontSize:“10px”,textAlign:“center”,borderRadius:“4px”,color:“var(–grn)”}}/>
<input type=“number” min=“0” placeholder=“Y” value={nets[s]?.y||””} onChange={e=>setN(s,“y”,e.target.value)} style={{flex:1,padding:“3px 5px”,fontSize:“10px”,textAlign:“center”,borderRadius:“4px”,color:“var(–red)”}}/>
<input type=“number” min=“0” placeholder=“H” value={targets[s]||””} onChange={e=>setTargets(p=>({…p,[s]:e.target.value}))} style={{flex:1,padding:“3px 5px”,fontSize:“10px”,textAlign:“center”,borderRadius:“4px”,color:“var(–muted)”}}/>
</div>
</div>
);
})}
</div>
<p style={{fontSize:“9px”,color:“var(–muted)”,marginTop:“4px”}}>D=Dogru · Y=Yanlis · H=Hedef</p>
</div>
<div><Label style={{marginBottom:“4px”}}>Hata Analizi</Label><textarea value={err} onChange={e=>setErr(e.target.value)} rows={3} placeholder=“Hangi konularda hata yaptin?” style={{padding:“8px 10px”,fontSize:“12px”,width:“100%”,resize:“vertical”,lineHeight:“1.6”,borderRadius:“6px”}}/></div>
<div><Label style={{marginBottom:“4px”}}>Yapilmasi Gerekenler</Label><textarea value={todos} onChange={e=>setTodos(e.target.value)} rows={2} placeholder=“Her satira bir madde…” style={{padding:“8px 10px”,fontSize:“12px”,width:“100%”,resize:“vertical”,lineHeight:“1.6”,borderRadius:“6px”}}/></div>
<div style={{display:“flex”,gap:“7px”,justifyContent:“flex-end”}}><Btn variant="ghost" onClick={onCancel}>Iptal</Btn><Btn variant="primary" onClick={handleSave}>Kaydet →</Btn></div>
</div>
);
}

function TrialCard({trial,onDelete}){
const [exp,setExp]=useState(false);
const top=[…trial.nets].sort((a,b)=>b.net-a.net).slice(0,3);
const weak=[…trial.nets].sort((a,b)=>a.net-b.net).slice(0,2);
const maxN=Math.max(…trial.nets.map(n=>n.net),1);
const repeat=trial.nets.filter(n=>n.net<5).map(n=>n.subject);
return(
<Card className=“sr” style={{padding:“0”,overflow:“hidden”}}>
<div onClick={()=>setExp(p=>!p)} style={{padding:“11px 14px”,cursor:“pointer”,display:“flex”,justifyContent:“space-between”,alignItems:“center”,background:exp?“var(–s2)”:“transparent”}}>
<div style={{display:“flex”,alignItems:“center”,gap:“10px”}}>
<Tag color={trial.type===“TYT”?“var(–blu)”:“var(–acc)”}>{trial.type}</Tag>
<span style={{fontFamily:“var(–mono)”,fontSize:“11px”,color:“var(–muted)”}}>{fmtDate(trial.date)}</span>
<span style={{fontFamily:“var(–mono)”,fontSize:“18px”,fontWeight:“700”,color:“var(–acc)”}}>{trial.totalNet}</span>
</div>
<div style={{display:“flex”,gap:“7px”,alignItems:“center”}}>
{trial.todos?.length>0&&<Tag color="var(--red)">{trial.todos.length} gorev</Tag>}
<span style={{color:“var(–muted)”,fontSize:“10px”,transform:exp?“rotate(180deg)”:“none”,transition:“transform .2s”}}>▼</span>
</div>
</div>
{exp&&(
<div className=“fi” style={{padding:“12px 14px”,borderTop:“1px solid var(–b1)”,display:“flex”,flexDirection:“column”,gap:“12px”}}>
<div>
<Label style={{marginBottom:“7px”}}>Ders Dagilimi</Label>
{trial.nets.map(n=>{
const hit=n.target>0&&n.net>=n.target,miss=n.target>0&&n.net<n.target;
return(
<div key={n.subject} style={{marginBottom:“5px”}}>
<div style={{display:“flex”,justifyContent:“space-between”,marginBottom:“2px”}}>
<span style={{fontSize:“10px”,color:“var(–muted)”}}>{n.subject}</span>
<div style={{display:“flex”,gap:“5px”,alignItems:“center”}}>
{n.target>0&&<span style={{fontSize:“9px”,color:“var(–muted)”}}>/{n.target}</span>}
<span style={{fontFamily:“var(–mono)”,fontSize:“10px”,color:hit?“var(–grn)”:miss?“var(–red)”:“var(–acc)”}}>{n.net.toFixed(1)}</span>
</div>
</div>
<div style={{height:“4px”,background:“var(–b2)”,borderRadius:“999px”,overflow:“hidden”}}><div style={{height:“100%”,width:`${(n.net/maxN)*100}%`,background:hit?“var(–grn)”:miss?“var(–red)”:“var(–acc)”,borderRadius:“999px”,transition:“width .5s ease”}}/></div>
</div>
);
})}
</div>
<div style={{display:“flex”,gap:“9px”}}>
<div style={{flex:1,padding:“9px”,background:“var(–s2)”,borderRadius:“7px”,border:“1px solid var(–grn)22”}}><Label style={{color:“var(–grn)”,marginBottom:“5px”}}>En Guclu</Label>{top.map(n=><p key={n.subject} style={{fontSize:“10px”,marginBottom:“2px”}}>{n.subject} <span style={{fontFamily:“var(–mono)”,color:“var(–grn)”}}>{n.net.toFixed(1)}</span></p>)}</div>
<div style={{flex:1,padding:“9px”,background:“var(–s2)”,borderRadius:“7px”,border:“1px solid var(–red)22”}}><Label style={{color:“var(–red)”,marginBottom:“5px”}}>En Zayif</Label>{weak.map(n=><p key={n.subject} style={{fontSize:“10px”,marginBottom:“2px”}}>{n.subject} <span style={{fontFamily:“var(–mono)”,color:“var(–red)”}}>{n.net.toFixed(1)}</span></p>)}</div>
</div>
{repeat.length>0&&<div style={{padding:“9px 11px”,background:“var(–red)08”,borderRadius:“6px”,border:“1px solid var(–red)22”}}><p style={{fontSize:“11px”,color:“var(–red)”,marginBottom:“3px”,fontWeight:“600”}}>Tekrar Gerekli</p><p style={{fontSize:“11px”,color:“var(–muted)”}}>{repeat.join(”, “)} — 5 netin altinda. Temel eksik var.</p></div>}
{trial.errorAnalysis&&<div><Label style={{marginBottom:“4px”}}>Hata Analizi</Label><p style={{fontSize:“11px”,color:“var(–muted)”,lineHeight:“1.6”,whiteSpace:“pre-wrap”,padding:“8px 10px”,background:“var(–s2)”,borderRadius:“6px”}}>{trial.errorAnalysis}</p></div>}
{trial.todos?.length>0&&<div><Label style={{marginBottom:“5px”}}>Yapilmasi Gerekenler</Label>{trial.todos.map((t,i)=><div key={i} style={{display:“flex”,gap:“6px”,padding:“5px 8px”,background:“var(–s2)”,borderRadius:“5px”,marginBottom:“3px”}}><span style={{color:“var(–acc)”,fontSize:“9px”}}>→</span><span style={{fontSize:“11px”}}>{t}</span></div>)}</div>}
<div style={{display:“flex”,justifyContent:“flex-end”}}><Btn variant=“danger” size=“sm” onClick={()=>onDelete(trial.id)}>Sil</Btn></div>
</div>
)}
</Card>
);
}

// ═══════════════════════════════════════════════════════════════════
//  MODÜL: GÖREVLER
// ═══════════════════════════════════════════════════════════════════
const PRIOS={high:{l:“Acil”,c:“var(–red)”},medium:{l:“Orta”,c:“var(–acc)”},low:{l:“Dusuk”,c:“var(–muted)”}};
function TodoTab({todos,setTodos}){
const [text,setText]=useState(””);
const [prio,setPrio]=useState(“high”);
const [filt,setFilt]=useState(“active”);
const overdue=todos.filter(t=>!t.done&&!t.reviewed&&daysFrom(t.reviewAt)>=0);
const add=()=>{ if(!text.trim()) return; const u=[{id:uid(),text:text.trim(),source:“Manuel”,priority:prio,done:false,reviewed:false,createdAt:new Date().toISOString(),reviewAt:new Date(Date.now()+7*86400000).toISOString()},…todos]; setTodos(u);store.save(KEYS.todos,u);setText(””); };
const toggle=id=>{ const u=todos.map(t=>t.id===id?{…t,done:!t.done,reviewed:true}:t); setTodos(u);store.save(KEYS.todos,u); if(!todos.find(x=>x.id===id)?.done){grantXP(“todo_done”);toast(”+15 XP”,“var(–grn)”);} };
const del=id=>{const u=todos.filter(t=>t.id!==id);setTodos(u);store.save(KEYS.todos,u);};
const snooze=id=>{const u=todos.map(t=>t.id===id?{…t,reviewAt:new Date(Date.now()+7*86400000).toISOString(),reviewed:true}:t);setTodos(u);store.save(KEYS.todos,u);};
const list=useMemo(()=>{ if(filt===“active”) return todos.filter(t=>!t.done); if(filt===“done”) return todos.filter(t=>t.done); if(filt===“review”) return overdue; return todos; },[todos,filt,overdue]);
return(
<div style={{display:“flex”,flexDirection:“column”,gap:“11px”}}>
{overdue.length>0&&(
<div style={{padding:“10px 12px”,background:“var(–acc)08”,border:“1px solid var(–acc)44”,borderRadius:“7px”,display:“flex”,alignItems:“center”,gap:“9px”}} className=“flashY”>
<span>⚡</span>
<div style={{flex:1}}><p style={{fontSize:“11px”,fontWeight:“600”,color:“var(–acc)”}}>{overdue.length} gorev 7. gununu doldurdu</p><p style={{fontSize:“10px”,color:“var(–muted)”,marginTop:“1px”}}>Yaptin mi? Kontrol et.</p></div>
<Btn size=“sm” variant=“accent” onClick={()=>setFilt(“review”)}>Goster</Btn>
</div>
)}
<Card style={{padding:“11px”}}>
<div style={{display:“flex”,gap:“6px”,marginBottom:“8px”}}>
<input value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>e.key===“Enter”&&add()} placeholder=“Yeni gorev…” style={{flex:1,padding:“7px 10px”,fontSize:“12px”,borderRadius:“6px”}}/>
<Btn variant="primary" onClick={add}>Ekle</Btn>
</div>
<div style={{display:“flex”,gap:“4px”}}>
{Object.entries(PRIOS).map(([k,{l,c}])=><button key={k} onClick={()=>setPrio(k)} style={{padding:“3px 8px”,borderRadius:“4px”,border:“1px solid”,fontSize:“10px”,cursor:“pointer”,borderColor:prio===k?c:“var(–b2)”,background:prio===k?c+“22”:“transparent”,color:prio===k?c:“var(–muted)”}}>{l}</button>)}
</div>
</Card>
<div style={{display:“flex”,gap:“4px”}}>
{[[“active”,“Aktif”],[“review”,“⚡”],[“done”,“Tamam”],[“all”,“Tumu”]].map(([k,l])=>(
<button key={k} onClick={()=>setFilt(k)} style={{padding:“4px 9px”,borderRadius:“5px”,border:“1px solid”,fontSize:“10px”,cursor:“pointer”,borderColor:filt===k?“var(–acc)”:“var(–b2)”,background:filt===k?“var(–acc)18”:“transparent”,color:filt===k?“var(–acc)”:“var(–muted)”,position:“relative”}}>
{l}{k===“review”&&overdue.length>0&&<span style={{marginLeft:“3px”,background:“var(–red)”,borderRadius:“50%”,width:“12px”,height:“12px”,display:“inline-flex”,alignItems:“center”,justifyContent:“center”,fontSize:“8px”,color:”#fff”}}>{overdue.length}</span>}
</button>
))}
</div>
{list.length===0&&<EmptyState icon="◻" title="Gorev yok" desc="Temiz liste, net zihin."/>}
<div style={{display:“flex”,flexDirection:“column”,gap:“4px”}}>
{list.map(t=>(<div key={t.id} className=“sr” style={{display:“flex”,alignItems:“flex-start”,gap:“9px”,padding:“9px 11px”,borderRadius:“7px”,background:“var(–s2)”,border:`1px solid ${t.reviewAt&&daysFrom(t.reviewAt)>=0&&!t.done&&!t.reviewed?"var(--acc)44":"var(--b2)"}`}}>
<button onClick={()=>toggle(t.id)} style={{width:“15px”,height:“15px”,borderRadius:“3px”,flexShrink:0,marginTop:“2px”,background:t.done?“var(–grn)”:“transparent”,border:`2px solid ${t.done?"var(--grn)":"var(--b2)"}`,display:“flex”,alignItems:“center”,justifyContent:“center”}}>{t.done&&<span style={{color:”#000”,fontSize:“9px”,fontWeight:“700”}}>✓</span>}</button>
<div style={{flex:1,minWidth:0}}>
<p style={{fontSize:“12px”,lineHeight:“1.4”,textDecoration:t.done?“line-through”:“none”,color:t.done?“var(–muted)”:“var(–txt)”}}>{t.text}</p>
<div style={{display:“flex”,gap:“5px”,marginTop:“3px”,flexWrap:“wrap”}}>
<Tag color={PRIOS[t.priority]?.c}>{PRIOS[t.priority]?.l}</Tag>
{t.source&&<span style={{fontSize:“9px”,color:“var(–muted)”}}>← {t.source}</span>}
{t.reviewAt&&daysFrom(t.reviewAt)>=0&&!t.done&&!t.reviewed&&<span style={{fontSize:“9px”,color:“var(–acc)”,animation:“pulse 2s ease infinite”}}>⚡ 7. Gun</span>}
</div>
</div>
<div style={{display:“flex”,gap:“3px”}}>
{t.reviewAt&&daysFrom(t.reviewAt)>=0&&!t.done&&!t.reviewed&&<Btn size=“sm” variant=“ghost” onClick={()=>snooze(t.id)} style={{color:“var(–acc)”}}>↻</Btn>}
<Btn size=“sm” variant=“ghost” onClick={()=>del(t.id)} style={{color:“var(–red)”}}>×</Btn>
</div>
</div>))}
</div>
</div>
);
}

// ═══════════════════════════════════════════════════════════════════
//  MODÜL: DİSİPLİN + AI MINI COACH
// ═══════════════════════════════════════════════════════════════════
const QS=[
{id:“q1”,text:“Bugun deneme analizi yaptin mi?”,yes:“Analiz yapmak en zor kisim — yaptin, iyi.”,no:“Analiz yapmadan hata tekrarlanir. Bu aksam mutlaka yap.”},
{id:“q2”,text:“Bugun yanlisinlari cozdin mi?”,yes:“Hatalari tekrar etmek guctur. Yapiyorsun — bu fark yaratir.”,no:“Yanlis cozmeden ilerlemek kumda kale yapmak gibidir.”},
{id:“q3”,text:“Bugun hedefledigin kadar calistin mi?”,yes:“Plana sadik kalmak disiplinin temelidir.”,no:“Yarin icin kucuk ve net bir hedef belirle.”},
{id:“q4”,text:“Bugun zayif oldugun konuya zaman ayirdin mi?”,yes:“Zayiflikla yuzlesmek cesarettir.”,no:“Guclu konularda calismak konforu secmektir.”},
];
const overallMsg=s=>{ if(s===4) return{msg:“4/4. Mukemmel. Bu gunu kopyala.”,c:“var(–grn)”}; if(s===3) return{msg:“3/4. Iyi ama 1 nokta eksik.”,c:“var(–acc)”}; if(s===2) return{msg:“2/4. Ortalama. Yeterlinin altinda.”,c:“var(–acc)”}; if(s===1) return{msg:“1/4. Ciddi eksik. Yarin plan yap.”,c:“var(–red)”}; return{msg:“0/4. Bu gun kayboldu. Yarin sifirdan.”,c:“var(–red)”}; };

// Mini AI coach — skor + dikkat + plan uyumuna göre tavsiye
function miniCoachMsg(score,attnScore,completionPct){
if(score===4&&attnScore>=80&&completionPct>=80) return “Istisna bir gun. Dikkat yuksek, plan uyumu guclu. Bu tempo YKS icin yeterli.”;
if(score<=1&&attnScore<60) return “Dikkat dusuk VE check-in skoru kotu. Uyku mi eksik? Ortami degistir — mekana git, telefonu kapat.”;
if(completionPct<50&&score>=3) return “Check-in iyi ama plan uyumu dusuk. Planlamayi gozden gecir — bloklar cok uzun olabilir.”;
if(attnScore<60) return “Dikkat analizi sorun gosteriyor. Erken molalar fazla — neden dikkat dagiliyor? Sebebi bul, eliminate et.”;
return “Dengeli bir gun. Zayif noktayi bul ve yarin tek bir sekilde duzelt — hepsini birden degil.”;
}

function DiscipTab({checkins,setCheckins}){
const today=todayStr();
const todayData=checkins.find(c=>c.date===today);
const [ans,setAns]=useState(todayData?.answers||{});
const [submitted,setSub]=useState(!!todayData);
const [showHist,setHist]=useState(false);
const [xpData,setXpData]=useState(loadXP);
const startRef=useRef(Date.now());

// Dikkat skoru bugün
const todayAttn=store.load(KEYS.attn,{})[today];
const attnScore=useMemo(()=>calcAttentionScore(todayAttn?.breaks||[]),[todayAttn]);

// Plan tamamlanma
const todayPlan=(store.load(KEYS.plan,{})[today]||[]);
const planPct=todayPlan.length>0?Math.round(todayPlan.filter(p=>p.done).length/todayPlan.length*100):0;

const setA=(qId,v)=>{if(!submitted) setAns(p=>({…p,[qId]:v}));};
const submit=()=>{
const elapsed=Math.round((Date.now()-startRef.current)/1000);
const score=QS.filter(q=>ans[q.id]===true).length;
const entry={date:today,answers:ans,score,elapsed,at:new Date().toISOString()};
const updated=[entry,…checkins.filter(c=>c.date!==today)];
setCheckins(updated);store.save(KEYS.checkins,updated);setSub(true);
const t=score===4?“checkin_4”:score>=3?“checkin_3”:null;
if(t){const{pts}=grantXP(t);toast(`+${pts} XP — ${score}/4`,“var(–acc)”);setXpData(loadXP());}
if(elapsed>60) toast(“Check-in cok uzun surdu. Dusunmeden cevapla.”,“var(–red)”);
};
const score=QS.filter(q=>ans[q.id]===true).length;
const all=QS.every(q=>ans[q.id]!==undefined);
const om=overallMsg(submitted?score:score);

const last7=useMemo(()=>Array.from({length:7},(_,i)=>{const d=new Date(Date.now()-(6-i)*86400000).toISOString().slice(0,10);const c=checkins.find(x=>x.date===d);return{date:d,score:c?.score??-1};}),[checkins]);
const avg=useMemo(()=>{const f=last7.filter(d=>d.score>=0);return f.length?(f.reduce((s,d)=>s+d.score,0)/f.length).toFixed(1):null;},[last7]);

return(
<div style={{display:“flex”,flexDirection:“column”,gap:“14px”}}>
{/* XP + badges */}
<Card style={{padding:“12px 14px”}}>
<div style={{display:“flex”,justifyContent:“space-between”,alignItems:“center”,marginBottom:“8px”}}>
<div><Label style={{marginBottom:“2px”}}>Disiplin Puani</Label><span style={{fontFamily:“var(–mono)”,fontSize:“22px”,fontWeight:“700”,color:“var(–acc)”}}>{xpData.points} XP</span></div>
<div style={{textAlign:“right”}}>{xpData.streak>0&&<p style={{fontFamily:“var(–mono)”,fontSize:“11px”,color:“var(–acc)”}}>🔥 {xpData.streak}g</p>}<p style={{fontSize:“9px”,color:“var(–muted)”,marginTop:“1px”}}>{xpData.totalBlocks} blok · {xpData.totalTrials} deneme</p></div>
</div>
{xpData.badges.length>0&&(
<div style={{display:“flex”,gap:“5px”,flexWrap:“wrap”}}>
{BADGES.filter(b=>xpData.badges.includes(b.id)).map(b=>(
<div key={b.id} className=“pi” style={{padding:“3px 8px”,background:“var(–acc)15”,borderRadius:“4px”,border:“1px solid var(–acc)33”,display:“flex”,gap:“3px”,alignItems:“center”}}>
<span style={{fontSize:“11px”}}>{b.icon}</span><span style={{fontSize:“9px”,color:“var(–acc)”,fontFamily:“var(–mono)”,fontWeight:“600”}}>{b.label}</span>
</div>
))}
</div>
)}
</Card>
  {/* 3 metrik */}
  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:"7px"}}>
    {[
      {l:"Check-in",v:avg?`${avg}/4`:"—",c:"var(--acc)"},
      {l:"Dikkat",v:`${attnScore}`,c:attnScore>=80?"var(--grn)":attnScore>=60?"var(--acc)":"var(--red)"},
      {l:"Plan",v:`%${planPct}`,c:planPct>=80?"var(--grn)":planPct>=50?"var(--acc)":"var(--red)"},
    ].map(({l,v,c})=>(
      <Card key={l} style={{padding:"10px",textAlign:"center"}}>
        <p style={{fontFamily:"var(--mono)",fontSize:"18px",fontWeight:"700",color:c,lineHeight:1}}>{v}</p>
        <p style={{fontSize:"9px",color:"var(--muted)",marginTop:"3px"}}>{l}</p>
      </Card>
    ))}
  </div>

  {/* 7 gün bar */}
  <Card style={{padding:"12px 14px"}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"10px"}}>
      <Label>Son 7 Gun</Label>
      {avg&&<span style={{fontFamily:"var(--mono)",fontSize:"11px",color:"var(--acc)"}}>ort. {avg}/4</span>}
    </div>
    <div style={{display:"flex",gap:"4px",alignItems:"flex-end",height:"44px"}}>
      {last7.map(d=>{
        const h=d.score>=0?(d.score/4)*100:5,c=d.score<0?"var(--b2)":d.score>=3?"var(--grn)":d.score>=2?"var(--acc)":"var(--red)",isT=d.date===today;
        return(
          <div key={d.date} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:"3px"}}>
            <div style={{width:"100%",height:`${h}%`,minHeight:"3px",background:c,borderRadius:"3px",outline:isT?`2px solid ${c}`:"none",outlineOffset:"2px",transition:"height .5s ease"}}/>
            <span style={{fontSize:"8px",color:isT?"var(--txt)":"var(--muted)",fontFamily:"var(--mono)"}}>{new Date(d.date+"T12:00:00").toLocaleDateString("tr-TR",{weekday:"short"}).slice(0,2)}</span>
          </div>
        );
      })}
    </div>
  </Card>

  {/* Sorular */}
  <Card>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"12px"}}>
      <p style={{fontWeight:"600",fontSize:"13px"}}>Check-in <span style={{fontFamily:"var(--mono)",fontSize:"10px",color:"var(--muted)",marginLeft:"5px"}}>{today}</span></p>
      {submitted&&<Tag color={om.c}>{score}/4</Tag>}
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
      {QS.map(q=>{
        const a=ans[q.id];
        return(
          <div key={q.id} style={{padding:"10px 12px",borderRadius:"7px",background:"var(--s2)",border:"1px solid var(--b2)"}}>
            <p style={{fontSize:"12px",fontWeight:"500",marginBottom:"8px",lineHeight:"1.4"}}>{q.text}</p>
            <div style={{display:"flex",gap:"6px"}}>
              {[true,false].map(v=>{const sel=a===v,c=v?"var(--grn)":"var(--red)";return(<button key={String(v)} onClick={()=>setA(q.id,v)} disabled={submitted} style={{flex:1,padding:"6px",borderRadius:"5px",border:`1px solid ${sel?c:"var(--b2)"}`,background:sel?c+"22":"transparent",color:sel?c:"var(--muted)",fontSize:"12px",fontWeight:"600",cursor:submitted?"default":"pointer"}}>{v?"Evet":"Hayir"}</button>);})}
            </div>
            {a!==undefined&&<p className="fi" style={{fontSize:"10px",color:a?"var(--grn)":"var(--red)",marginTop:"6px",lineHeight:"1.5",fontStyle:"italic"}}>→ {a?q.yes:q.no}</p>}
          </div>
        );
      })}
    </div>
    {!submitted
      ?<Btn variant="primary" onClick={submit} disabled={!all} style={{width:"100%",marginTop:"12px",padding:"10px"}}>{all?"Gunu Degerlendir →":`${QS.filter(q=>ans[q.id]!==undefined).length}/${QS.length} cevaplandi`}</Btn>
      :(
        <div className="pi" style={{marginTop:"12px",padding:"12px 13px",background:om.c+"08",border:`1px solid ${om.c}33`,borderRadius:"7px"}}>
          <p style={{fontFamily:"var(--mono)",fontSize:"12px",fontWeight:"700",color:om.c,marginBottom:"6px"}}>{om.msg}</p>
          <p style={{fontSize:"11px",color:"var(--muted)",lineHeight:"1.5"}}>{miniCoachMsg(score,attnScore,planPct)}</p>
        </div>
      )
    }
  </Card>

  {checkins.length>0&&(
    <div>
      <button onClick={()=>setHist(p=>!p)} style={{fontSize:"10px",color:"var(--muted)",background:"none",border:"none",cursor:"pointer",marginBottom:"6px"}}>{showHist?"▲ Gizle":`▼ Gecmis (${checkins.length})`}</button>
      {showHist&&(
        <div style={{display:"flex",flexDirection:"column",gap:"4px"}} className="fi">
          {checkins.slice(0,14).map(c=>(
            <div key={c.date} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 11px",background:"var(--s2)",borderRadius:"6px",border:"1px solid var(--b2)"}}>
              <span style={{fontFamily:"var(--mono)",fontSize:"10px"}}>{c.date}</span>
              <div style={{display:"flex",gap:"3px"}}>{QS.map(q=><span key={q.id} style={{width:"6px",height:"6px",borderRadius:"50%",background:c.answers?.[q.id]===true?"var(--grn)":c.answers?.[q.id]===false?"var(--red)":"var(--b2)"}}/>)}</div>
              <Tag color={c.score>=3?"var(--grn)":c.score>=2?"var(--acc)":"var(--red)"}>{c.score}/4</Tag>
            </div>
          ))}
        </div>
      )}
    </div>
  )}
</div>

);
}

// ═══════════════════════════════════════════════════════════════════
//  PAYLAŞILAN
// ═══════════════════════════════════════════════════════════════════
function EmptyState({icon,title,desc}){
return(
<div style={{textAlign:“center”,padding:“40px 16px”}}>
<p style={{fontFamily:“var(–mono)”,fontSize:“26px”,color:“var(–b2)”,marginBottom:“10px”}}>{icon}</p>
<p style={{fontSize:“13px”,fontWeight:“500”,color:“var(–muted)”,marginBottom:“4px”}}>{title}</p>
<p style={{fontSize:“10px”,color:“var(–b3)”,lineHeight:“1.6”,maxWidth:“200px”,margin:“0 auto”}}>{desc}</p>
</div>
);
}

// ═══════════════════════════════════════════════════════════════════
//  HEADER
// ═══════════════════════════════════════════════════════════════════
function Header({trials,todos,checkins,xp,onHeat,heatOpen}){
const pending=todos.filter(t=>!t.done).length;
const overdue=todos.filter(t=>!t.done&&!t.reviewed&&daysFrom(t.reviewAt)>=0).length;
const todayCI=checkins.find(c=>c.date===todayStr());
return(
<div style={{marginBottom:“18px”}}>
<div style={{display:“flex”,justifyContent:“space-between”,alignItems:“flex-start”,marginBottom:“12px”}}>
<div>
<h1 style={{fontFamily:“var(–mono)”,fontSize:“16px”,fontWeight:“700”,letterSpacing:”-0.5px”,color:“var(–txt)”}}>YKS · SAVAS ODASI</h1>
<p style={{fontSize:“10px”,color:“var(–muted)”,marginTop:“2px”,fontFamily:“var(–mono)”}}>{new Date().toLocaleDateString(“tr-TR”,{weekday:“long”,day:“numeric”,month:“long”})}</p>
</div>
<div style={{display:“flex”,alignItems:“center”,gap:“7px”}}>
<YKSCountdown/>
<button onClick={onHeat} style={{padding:“4px 8px”,fontSize:“9px”,fontFamily:“var(–mono)”,background:“var(–s1)”,border:“1px solid var(–b2)”,borderRadius:“4px”,color:heatOpen?“var(–acc)”:“var(–muted)”,cursor:“pointer”}}>▦</button>
{!todayCI?<div style={{display:“flex”,alignItems:“center”,gap:“4px”}}><span style={{width:“5px”,height:“5px”,borderRadius:“50%”,background:“var(–red)”,display:“inline-block”,animation:“blink 1.5s ease infinite”}}/><span style={{fontSize:“9px”,color:“var(–red)”,fontFamily:“var(–mono)”}}>check-in</span></div>:<Tag color={todayCI.score>=3?“var(–grn)”:“var(–acc)”}>{todayCI.score}/4</Tag>}
</div>
</div>
<div style={{display:“grid”,gridTemplateColumns:“repeat(4,1fr)”,gap:“6px”}}>
{[{l:“Deneme”,v:trials.length,c:“var(–blu)”},{l:“Gorev”,v:pending,c:“var(–acc)”},{l:“Kontrol”,v:overdue,c:overdue>0?“var(–red)”:“var(–muted)”},{l:“XP”,v:xp.points,c:“var(–pur)”}].map(({l,v,c})=>(
<div key={l} style={{padding:“8px 9px”,background:“var(–s1)”,border:“1px solid var(–b1)”,borderRadius:“7px”,textAlign:“center”}}>
<p style={{fontFamily:“var(–mono)”,fontSize:“16px”,fontWeight:“700”,color:c,lineHeight:1}}>{v}</p>
<p style={{fontSize:“9px”,color:“var(–muted)”,marginTop:“2px”,letterSpacing:“0.5px”}}>{l}</p>
</div>
))}
</div>
</div>
);
}

// ═══════════════════════════════════════════════════════════════════
//  ANA UYGULAMA
// ═══════════════════════════════════════════════════════════════════
export default function App(){
const [tab,setTab]=useState(“plan”);
const [trials,setTrials]=useState(()=>store.load(KEYS.trials));
const [todos,setTodos]=useState(()=>store.load(KEYS.todos));
const [checkins,setCheckins]=useState(()=>store.load(KEYS.checkins));
const [xp,setXp]=useState(loadXP);
const [heatOpen,setHeat]=useState(false);
const toasts=useToastSystem();

useEffect(()=>{const id=setInterval(()=>setXp(loadXP()),5000);return()=>clearInterval(id);},[]);

const dwData=useMemo(()=>store.load(KEYS.dw,DW_DEFAULT),[tab]);

const alerts=useMemo(()=>({
todo: todos.filter(t=>!t.done&&!t.reviewed&&daysFrom(t.reviewAt)>=0).length,
disc: checkins.find(c=>c.date===todayStr())?0:1,
plan: (store.load(KEYS.plan,{})[todayStr()]||[]).filter(p=>!p.done&&(p.startMin+p.durationMin)<nowHHMM()).length,
}),[todos,checkins,tab]);

return(
<div style={{minHeight:“100vh”,background:“var(–bg)”,fontFamily:“var(–sans)”,display:“flex”,justifyContent:“center”,padding:“24px 12px 80px”}}>
<style>{CSS}</style>
<div style={{width:“100%”,maxWidth:“540px”}}>
<Header trials={trials} todos={todos} checkins={checkins} xp={xp} onHeat={()=>setHeat(p=>!p)} heatOpen={heatOpen}/>
{heatOpen&&(
<div className=“fi” style={{marginBottom:“14px”}}>
<Card style={{padding:“13px 14px”}}>
<Heatmap sessions={dwData.sessions||[]} trials={trials} checkins={checkins}/>
</Card>
</div>
)}
<TabBar active={tab} onChange={setTab} alerts={{todo:alerts.todo,disc:alerts.disc,plan:alerts.plan}}/>
<div className="fu" key={tab}>
{tab===“plan”  && <DailyPlanTab trials={trials}/>}
{tab===“dw”    && <DeepWorkTab/>}
{tab===“trial” && <TrialTab trials={trials} setTrials={setTrials}/>}
{tab===“todo”  && <TodoTab todos={todos} setTodos={setTodos}/>}
{tab===“disc”  && <DiscipTab checkins={checkins} setCheckins={setCheckins}/>}
</div>
</div>
<ToastLayer toasts={toasts}/>
</div>
);
}
*/