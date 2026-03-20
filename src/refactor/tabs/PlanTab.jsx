import { useState } from "react";
import { createPlanItem } from "../utils/planning";
import { hhmmToMins, minsToHHMM } from "../utils/storage";

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

function Label({ children }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: "#999",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function Btn({ children, onClick, style, type = "button" }) {
  return (
    <button
      type={type}
      onClick={onClick}
      style={{
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid #333",
        background: "#e8c547",
        color: "#000",
        fontWeight: 700,
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export default function PlanTab({ todayPlan, updateTodayPlan }) {
  const [subject, setSubject] = useState("");
  const [topic, setTopic] = useState("");
  const [time, setTime] = useState("10:00");
  const [duration, setDuration] = useState(60);
  const [type, setType] = useState("study");

  const addItem = () => {
    if (!subject.trim() || !topic.trim()) return;

    const item = createPlanItem({
      subject: subject.trim(),
      topic: topic.trim(),
      startMin: hhmmToMins(time),
      durationMin: Number(duration) || 60,
      type,
    });

    const next = [...todayPlan, item].sort((a, b) => a.startMin - b.startMin);
    updateTodayPlan(next);

    setSubject("");
    setTopic("");
    setDuration(60);
    setType("study");
  };

  const removeItem = (id) => {
    updateTodayPlan(todayPlan.filter((item) => item.id !== id));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>
          Günlük Plan
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <Label>Ders</Label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Matematik"
              style={inputStyle}
            />
          </div>

          <div>
            <Label>Konu</Label>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Türev"
              style={inputStyle}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <Label>Saat</Label>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                style={inputStyle}
              />
            </div>

            <div>
              <Label>Süre (dk)</Label>
              <input
                type="number"
                min="15"
                step="5"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                style={inputStyle}
              />
            </div>
          </div>

          <div>
            <Label>Blok Türü</Label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              style={inputStyle}
            >
              <option value="study">Ders</option>
              <option value="exam">Deneme</option>
              <option value="review">Tekrar</option>
            </select>
          </div>

          <Btn onClick={addItem}>+ Plan Öğesi Ekle</Btn>
        </div>
      </Card>

      <Card>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
          Bugünkü Bloklar
        </div>

        {todayPlan.length === 0 ? (
          <div style={{ color: "#888" }}>Bugün için plan yok.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {todayPlan.map((item) => (
              <div
                key={item.id}
                style={{
                  border: "1px solid #2f2f2f",
                  borderRadius: 8,
                  padding: 12,
                  background: item.done ? "#102010" : "#151515",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    alignItems: "flex-start",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700 }}>
                      {minsToHHMM(item.startMin)} · {item.subject}
                    </div>
                    <div style={{ color: "#aaa", marginTop: 4 }}>{item.topic}</div>
                    <div style={{ color: "#888", marginTop: 6, fontSize: 12 }}>
                      {item.durationMin} dk · {item.type} ·{" "}
                      {item.done ? "tamamlandı" : "bekliyor"}
                    </div>
                  </div>

                  <button
                    onClick={() => removeItem(item.id)}
                    style={{
                      background: "transparent",
                      color: "#e05252",
                      border: "1px solid #4a2222",
                      borderRadius: 6,
                      padding: "6px 8px",
                      cursor: "pointer",
                    }}
                  >
                    Sil
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #333",
  background: "#0f0f0f",
  color: "#eee",
};