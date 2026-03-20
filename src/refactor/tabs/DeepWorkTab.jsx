import { useEffect, useMemo, useState } from "react";
import {
  completePlanItem,
  startPlanItem,
} from "../utils/planning";

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

function Btn({ children, onClick, style, disabled = false }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid #333",
        background: disabled ? "#333" : "#e8c547",
        color: disabled ? "#888" : "#000",
        fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function fmtClock(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function DeepWorkTab({
  todayPlan,
  activeItem,
  updateTodayPlan,
}) {
  const [running, setRunning] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);

  const activeDurationSec = useMemo(() => {
    if (!activeItem) return 0;
    return activeItem.durationMin * 60;
  }, [activeItem]);

  useEffect(() => {
    if (!activeItem) {
      setRunning(false);
      setTimeLeft(0);
      return;
    }

    // Eğer item daha önce başladıysa ve bitmediyse kalan süreyi yaklaşık koru
    if (activeItem.actualStart && !activeItem.done) {
      const startedAt = new Date(activeItem.actualStart).getTime();
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      const remaining = Math.max(activeDurationSec - elapsedSec, 0);
      setTimeLeft(remaining);
      setRunning(remaining > 0);
    } else {
      setRunning(false);
      setTimeLeft(activeDurationSec);
    }
  }, [activeItem, activeDurationSec]);

  useEffect(() => {
    if (!running || !activeItem) return;

    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          const next = completePlanItem(todayPlan, activeItem.id);
          updateTodayPlan(next);
          setRunning(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [running, activeItem, todayPlan, updateTodayPlan]);

  const handleStart = () => {
    if (!activeItem) return;

    const nextPlan = startPlanItem(todayPlan, activeItem.id);
    updateTodayPlan(nextPlan);

    if (timeLeft <= 0) {
      setTimeLeft(activeItem.durationMin * 60);
    }

    setRunning(true);
  };

  const handleStopEarly = () => {
    setRunning(false);
  };

  const handleCompleteNow = () => {
    if (!activeItem) return;
    const next = completePlanItem(todayPlan, activeItem.id);
    updateTodayPlan(next);
    setRunning(false);
    setTimeLeft(0);
  };

  if (!activeItem) {
    return (
      <Card>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
          Deep Work
        </div>
        <div style={{ color: "#999" }}>
          Şu an aktif plan bloğu yok. Plan sekmesinden bugüne blok ekle veya
          saati gelen bloğu bekle.
        </div>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ border: "1px solid #e8c54755" }}>
        <div style={{ color: "#999", fontSize: 12, marginBottom: 8 }}>
          Aktif blok
        </div>

        <div style={{ fontSize: 24, fontWeight: 700, color: "#e8c547" }}>
          {activeItem.subject}
        </div>

        <div style={{ marginTop: 6, color: "#bbb", fontSize: 16 }}>
          {activeItem.topic}
        </div>

        <div style={{ marginTop: 8, color: "#888", fontSize: 13 }}>
          {activeItem.durationMin} dk · {activeItem.type}
        </div>
      </Card>

      <Card style={{ textAlign: "center" }}>
        <div style={{ color: "#999", fontSize: 12, marginBottom: 10 }}>
          Kalan süre
        </div>

        <div
          style={{
            fontSize: 48,
            fontWeight: 800,
            color: running ? "#4caf7d" : "#e8c547",
            letterSpacing: 1,
          }}
        >
          {fmtClock(timeLeft)}
        </div>

        <div style={{ marginTop: 16, display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          {!running && (
            <Btn onClick={handleStart}>
              Başlat
            </Btn>
          )}

          {running && (
            <Btn
              onClick={handleStopEarly}
              style={{ background: "#151515", color: "#ddd", border: "1px solid #444" }}
            >
              Durdur
            </Btn>
          )}

          <Btn
            onClick={handleCompleteNow}
            style={{ background: "#4caf7d", color: "#081108" }}
          >
            Bloğu Bitir
          </Btn>
        </div>
      </Card>
    </div>
  );
}