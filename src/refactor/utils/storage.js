const KEYS = {
    plan: "yks_plan",
    trials: "yks_trials",
    todos: "yks_todos",
    checkins: "yks_checkins",
    attn: "yks_attn",
    xp: "yks_xp",
  };
  
  export { KEYS };
  
  export const store = {
    load(key, fallback = []) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    save(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };
  
  export function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }
  
  export function nowHHMM() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }
  
  export function minsToHHMM(mins) {
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  
  export function hhmmToMins(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  }
  
  export function fmtHHMM(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h > 0) return `${h}s ${m}dk`;
    return `${m}dk`;
  }