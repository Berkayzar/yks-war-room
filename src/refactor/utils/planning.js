export function createPlanItem({
    subject,
    topic,
    startMin,
    durationMin,
    type = "study"
  }) {
    return {
      id: Math.random().toString(36).slice(2),
      subject,
      topic,
      startMin,
      durationMin,
      type,
      done: false,
      actualStart: null,
      actualEnd: null,
      delayReason: null
    };
  }
  
  export function getTodayPlan(plans, today) {
    return plans[today] || [];
  }
  
  export function getActivePlanItem(plan, nowMin) {
    return plan.find(
      (item) =>
        !item.done &&
        nowMin >= item.startMin &&
        nowMin < item.startMin + item.durationMin
    );
  }
  
  export function startPlanItem(plan, id) {
    return plan.map((item) =>
      item.id === id
        ? { ...item, actualStart: new Date().toISOString() }
        : item
    );
  }
  
  export function completePlanItem(plan, id) {
    return plan.map((item) =>
      item.id === id
        ? {
            ...item,
            done: true,
            actualEnd: new Date().toISOString()
          }
        : item
    );
  }
  
  export function calculateDayStats(plan) {
    const planned = plan.reduce((sum, p) => sum + p.durationMin, 0);
  
    const actual = plan.reduce((sum, p) => {
      if (!p.actualStart || !p.actualEnd) return sum;
      const start = new Date(p.actualStart).getTime();
      const end = new Date(p.actualEnd).getTime();
      return sum + Math.round((end - start) / 60000);
    }, 0);
  
    const completed = plan.filter((p) => p.done).length;
  
    const completionRate =
      plan.length > 0 ? Math.round((completed / plan.length) * 100) : 0;
  
    return {
      plannedMin: planned,
      actualMin: actual,
      completionRate
    };
  }