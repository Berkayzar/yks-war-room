import { useMemo, useState } from "react";
import { KEYS, store, todayStr, nowHHMM, fmtHHMM } from "./utils/storage";
import {
  getTodayPlan,
  calculateDayStats,
} from "./utils/planning";
import PlanTab from "./tabs/PlanTab";

function Card({ children, style }) {
  return (
    <div
      style={{
        background: "#111",
        border: "1px solid #2a2a2a",
        borderRadius: 10,
        padding: 14,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function TabButton({ active, children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid #333",
        background: active ? "#e8c547" : "#151515",
        color: active ? "#000" : "#ddd",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

export default function App() {
  const [tab, setTab] = useState("plan");
  const [plansByDate, setPlansByDate] = useState(() =>
    store.load(KEYS.plan, {})
  );

  const today = todayStr();
  const nowMin = nowHHMM();
  const todayPlan = useMemo(() => getTodayPlan(plansByDate, today), [plansByDate, today]);
  const stats = useMemo(() => calculateDayStats(todayPlan), [todayPlan]);

  const daysLeft = Math.floor(
    (new Date("2026-06-21T09:00:00").getTime() - Date.now()) / 86400000
  );

  const updateTodayPlan = (nextPlan) => {
    const next = { ...plansByDate, [today]: nextPlan };
    setPlansByDate(next);
    store.save(KEYS.plan, next);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#060606",
        color: "#e6e6e6",
        padding: 20,
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24 }}>YKS WAR ROOM · REFACTOR</h1>
            <div style={{ color: "#999", marginTop: 4 }}>{today}</div>
          </div>
          <Card style={{ minWidth: 160 }}>
            <div style={{ color: "#999", fontSize: 12 }}>YKS'ye kalan</div>
            <div style={{ color: "#e05252", fontWeight: 700, fontSize: 24 }}>{daysLeft} gün</div>
          </Card>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <TabButton active={tab === "plan"} onClick={() => setTab("plan")}>
            Plan
          </TabButton>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 14 }}>
          <Card>
            <div style={{ color: "#999", fontSize: 12 }}>Planlanan</div>
            <div style={{ color: "#e8c547", fontSize: 22, fontWeight: 700 }}>
              {fmtHHMM(stats.plannedMin)}
            </div>
          </Card>
          <Card>
            <div style={{ color: "#999", fontSize: 12 }}>Gerçek</div>
            <div style={{ color: "#4caf7d", fontSize: 22, fontWeight: 700 }}>
              {fmtHHMM(stats.actualMin)}
            </div>
          </Card>
          <Card>
            <div style={{ color: "#999", fontSize: 12 }}>Plan uyumu</div>
            <div style={{ color: "#5b9cf6", fontSize: 22, fontWeight: 700 }}>
              %{stats.completionRate}
            </div>
          </Card>
        </div>

        <PlanTab
          todayPlan={todayPlan}
          updateTodayPlan={updateTodayPlan}
        />
      </div>
    </div>
  );
}