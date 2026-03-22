import { useEffect, useState } from "react";
import {
  getAllUsers,
  updateUserProfileRole,
  updateUserInstitutionGroup,
} from "../firebase.js";

// ============================================================================
// Constants
// ============================================================================
const ROLES = ["student", "counselor", "institution_admin", "super_admin"];

const ROLE_COLOR = {
  student:           "#5b9cf6",
  counselor:         "#4caf7d",
  institution_admin: "#f59e0b",
  super_admin:       "#a78bfa",
};

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
  html, body { background: var(--bg); color: var(--txt); font-family: var(--sans); -webkit-font-smoothing: antialiased; }
  button { cursor: pointer; font-family: var(--sans); border: none; transition: all .12s; }
  button:hover:not(:disabled) { filter: brightness(1.12); }
  input, select { font-family: var(--sans); background: var(--s2); border: 1px solid var(--b2); color: var(--txt); border-radius: 6px; }
  input:focus, select:focus { outline: none; border-color: var(--acc); }
  select option { background: var(--s2); }
  @keyframes fadeUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
  @keyframes blink  { 0%,100%{opacity:1} 50%{opacity:.3} }
  .fu { animation: fadeUp .2s ease both; }
  .fi { animation: fadeIn .15s ease both; }
`;

// ============================================================================
// Primitives
// ============================================================================
const Label = ({ children, style }) => (
  <p style={{ fontFamily: "var(--mono)", fontSize: "10px", fontWeight: "600", color: "var(--muted)", letterSpacing: "1.4px", textTransform: "uppercase", ...style }}>
    {children}
  </p>
);

const Btn = ({ children, onClick, variant = "default", disabled, style }) => {
  const V = {
    default: { background: "var(--s2)", color: "var(--txt)", border: "1px solid var(--b2)" },
    primary: { background: "var(--acc)", color: "#000", fontWeight: "600" },
    danger:  { background: "transparent", color: "var(--red)", border: "1px solid var(--red)44" },
    ghost:   { background: "transparent", color: "var(--muted)" },
    success: { background: "transparent", color: "var(--grn)", border: "1px solid var(--grn)44" },
  };
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ ...V[variant], padding: "6px 13px", fontSize: "12px", borderRadius: "7px", opacity: disabled ? 0.4 : 1, cursor: disabled ? "not-allowed" : "pointer", ...style }}>
      {children}
    </button>
  );
};

const RoleBadge = ({ role }) => {
  const c = ROLE_COLOR[role] || "var(--muted)";
  return (
    <span style={{ fontFamily: "var(--mono)", fontSize: "9px", fontWeight: "600", padding: "2px 8px", borderRadius: "4px", background: `${c}18`, color: c, border: `1px solid ${c}33`, whiteSpace: "nowrap" }}>
      {role || "--"}
    </span>
  );
};

// ============================================================================
// User edit row
// ============================================================================
function UserRow({ user, onSaved }) {
  const [editing, setEditing]   = useState(false);
  const [role, setRole]         = useState(user.role || "student");
  const [instId, setInstId]     = useState(user.institutionId || "");
  const [groupId, setGroupId]   = useState(user.groupId || "");
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [err, setErr]           = useState("");

  const fmtTs = (ts) => {
    if (!ts) return "--";
    const d = ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts);
    const diff = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diff < 60)   return `${diff}dk once`;
    if (diff < 1440) return `${Math.floor(diff / 60)}s once`;
    return `${Math.floor(diff / 1440)}g once`;
  };

  const handleSave = async () => {
    setSaving(true);
    setErr("");
    try {
      const [r1, r2] = await Promise.all([
        updateUserProfileRole(user.uid, role),
        updateUserInstitutionGroup(user.uid, instId.trim(), groupId.trim()),
      ]);
      if (r1 && r2) {
        setSaved(true);
        setEditing(false);
        onSaved({ ...user, role, institutionId: instId.trim(), groupId: groupId.trim() });
        setTimeout(() => setSaved(false), 3000);
      } else {
        setErr("Kaydedilemedi. Firestore rules kontrol et.");
      }
    } catch (e) {
      setErr(e.message || "Hata");
    }
    setSaving(false);
  };

  const hasChanges = role !== (user.role || "student") ||
                     instId.trim() !== (user.institutionId || "") ||
                     groupId.trim() !== (user.groupId || "");

  return (
    <div className="fu" style={{ padding: "12px 14px", background: "var(--s1)", border: `1px solid ${editing ? "var(--acc)44" : "var(--b1)"}`, borderRadius: "10px", transition: "border-color .2s" }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: editing ? "12px" : "0" }}>
        {user.photoURL
          ? <img src={user.photoURL} alt="" style={{ width: "30px", height: "30px", borderRadius: "50%", flexShrink: 0 }} />
          : <div style={{ width: "30px", height: "30px", borderRadius: "50%", background: "var(--b2)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", color: "var(--muted)" }}>{(user.displayName || "?")[0]}</div>
        }
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: "13px", fontWeight: "500", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user.displayName || "Isimsiz"}
          </p>
          <p style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)", marginTop: "1px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user.email}
          </p>
        </div>
        <div style={{ display: "flex", gap: "6px", alignItems: "center", flexShrink: 0 }}>
          {saved && <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--grn)" }}>kaydedildi ✓</span>}
          <RoleBadge role={user.role} />
          <Btn variant={editing ? "ghost" : "default"} onClick={() => { setEditing((p) => !p); setErr(""); }}
            style={{ padding: "4px 10px", fontSize: "10px" }}>
            {editing ? "Kapat" : "Duzenle"}
          </Btn>
        </div>
      </div>

      {/* Edit form */}
      {editing && (
        <div className="fi" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {/* Meta info */}
          <div style={{ display: "flex", gap: "12px", padding: "8px 10px", background: "var(--s2)", borderRadius: "7px" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)" }}>uid: {user.uid}</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)" }}>son giris: {fmtTs(user.lastSeen)}</span>
          </div>

          {/* Role select */}
          <div>
            <Label style={{ marginBottom: "5px" }}>Rol</Label>
            <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
              {ROLES.map((r) => {
                const c = ROLE_COLOR[r];
                return (
                  <button key={r} onClick={() => setRole(r)}
                    style={{ padding: "5px 11px", borderRadius: "6px", fontSize: "11px", fontFamily: "var(--mono)", cursor: "pointer", border: `1px solid ${role === r ? c : "var(--b2)"}`, background: role === r ? `${c}20` : "transparent", color: role === r ? c : "var(--muted)" }}>
                    {r}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Institution + Group */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            <div>
              <Label style={{ marginBottom: "5px" }}>Institution ID</Label>
              <input value={instId} onChange={(e) => setInstId(e.target.value)}
                placeholder="test_inst_001"
                style={{ width: "100%", padding: "7px 10px", fontSize: "12px" }} />
            </div>
            <div>
              <Label style={{ marginBottom: "5px" }}>Group ID</Label>
              <input value={groupId} onChange={(e) => setGroupId(e.target.value)}
                placeholder="test_grp_001"
                style={{ width: "100%", padding: "7px 10px", fontSize: "12px" }} />
            </div>
          </div>

          {err && <p style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--red)" }}>{err}</p>}

          <div style={{ display: "flex", gap: "8px" }}>
            <Btn variant="ghost" onClick={() => { setEditing(false); setErr(""); setRole(user.role || "student"); setInstId(user.institutionId || ""); setGroupId(user.groupId || ""); }} style={{ flex: 1 }}>
              Iptal
            </Btn>
            <Btn variant="primary" onClick={handleSave} disabled={saving || !hasChanges} style={{ flex: 2 }}>
              {saving ? "Kaydediliyor..." : "Kaydet"}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main AdminAssignPanel
// ============================================================================
export default function AdminAssignPanel({ onClose }) {
  const [users,   setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [search,  setSearch]  = useState("");
  const [filter,  setFilter]  = useState("all"); // all | student | counselor | institution_admin | super_admin

  useEffect(() => {
    getAllUsers().then((u) => { setUsers(u); setLoading(false); });
  }, []);

  const handleSaved = (updated) => {
    setUsers((prev) => prev.map((u) => u.uid === updated.uid ? { ...u, ...updated } : u));
  };

  const filtered = users.filter((u) => {
    const matchSearch = !search ||
      (u.displayName || "").toLowerCase().includes(search.toLowerCase()) ||
      (u.email       || "").toLowerCase().includes(search.toLowerCase()) ||
      (u.uid         || "").toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === "all" || u.role === filter;
    return matchSearch && matchFilter;
  });

  const roleCounts = users.reduce((acc, u) => {
    const r = u.role || "student";
    acc[r] = (acc[r] || 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: "var(--sans)", display: "flex", justifyContent: "center", padding: "24px 12px 80px" }}>
      <style>{CSS}</style>
      <div style={{ width: "100%", maxWidth: "640px" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <div>
            <p style={{ fontFamily: "var(--mono)", fontSize: "10px", color: "var(--pur)", letterSpacing: "2px", marginBottom: "4px" }}>SUPER ADMIN</p>
            <h1 style={{ fontFamily: "var(--mono)", fontSize: "18px", fontWeight: "700", color: "var(--txt)" }}>Kullanici Atama Paneli</h1>
          </div>
          <Btn variant="ghost" onClick={onClose} style={{ fontSize: "10px" }}>← Geri Don</Btn>
        </div>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "6px", marginBottom: "16px" }}>
          {[
            { role: "student",           label: "Ogrenci",  c: ROLE_COLOR.student },
            { role: "counselor",         label: "Rehber",   c: ROLE_COLOR.counselor },
            { role: "institution_admin", label: "Kurum",    c: ROLE_COLOR.institution_admin },
            { role: "super_admin",       label: "Sysadmin", c: ROLE_COLOR.super_admin },
          ].map((x) => (
            <button key={x.role} onClick={() => setFilter(filter === x.role ? "all" : x.role)}
              style={{ padding: "9px 6px", borderRadius: "8px", textAlign: "center", cursor: "pointer", background: filter === x.role ? `${x.c}18` : "var(--s1)", border: `1px solid ${filter === x.role ? x.c : "var(--b1)"}`, transition: "all .15s" }}>
              <p style={{ fontFamily: "var(--mono)", fontSize: "18px", fontWeight: "700", color: x.c, lineHeight: 1 }}>{roleCounts[x.role] || 0}</p>
              <p style={{ fontSize: "8px", color: "var(--muted)", marginTop: "3px" }}>{x.label}</p>
            </button>
          ))}
        </div>

        {/* Search */}
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Ad, email veya uid ara..."
          style={{ width: "100%", padding: "9px 12px", fontSize: "13px", marginBottom: "14px", borderRadius: "8px" }} />

        {/* Loading */}
        {loading && (
          <p style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--muted)", textAlign: "center", padding: "40px", animation: "blink 1.5s ease infinite" }}>
            Yukleniyor...
          </p>
        )}

        {/* Filter info */}
        {!loading && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <Label>
              {filtered.length} kullanici
              {filter !== "all" && ` · ${filter} filtresi`}
              {search && ` · "${search}"`}
            </Label>
            {(filter !== "all" || search) && (
              <button onClick={() => { setFilter("all"); setSearch(""); }}
                style={{ fontFamily: "var(--mono)", fontSize: "9px", color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}>
                Filtreyi temizle
              </button>
            )}
          </div>
        )}

        {/* Empty */}
        {!loading && filtered.length === 0 && (
          <p style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--muted)", textAlign: "center", padding: "30px" }}>
            {users.length === 0
              ? "Henuz kullanici yok. Kullanicilar giris yapinca buraya gelir."
              : "Aramayla eslesen kullanici yok."}
          </p>
        )}

        {/* User list */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {filtered.map((u) => (
            <UserRow key={u.uid} user={u} onSaved={handleSaved} />
          ))}
        </div>
      </div>
    </div>
  );
}
