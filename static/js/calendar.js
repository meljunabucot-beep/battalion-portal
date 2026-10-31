const Calendar = (() => {
  let current = new Date();
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  function render() {
    const label = document.getElementById('calendarMonthYear');
    const days  = document.getElementById('calendarDays');
    if (!label || !days) return;
    const y = current.getFullYear(), m = current.getMonth();
    label.textContent = `${monthNames[m]} ${y}`;

    const firstIdx = new Date(y, m, 1).getDay();
    const total = new Date(y, m + 1, 0).getDate();
    const prevLast = new Date(y, m, 0).getDate();
    const today = new Date();
    let html = '';
    for (let i = firstIdx; i > 0; i--) {
      html += `<div class="calendar-day disabled">${prevLast - i + 1}</div>`;
    }
    for (let d = 1; d <= total; d++) {
      const isToday = d === today.getDate() && m === today.getMonth() && y === today.getFullYear();
      html += `<div class="calendar-day ${isToday ? 'today' : ''}" onclick="Calendar.pick(${d})">${d}</div>`;
    }
    days.innerHTML = html;
  }

  return {
    render,
    change(delta) { current.setMonth(current.getMonth() + delta); render(); },
        pick(day) {
      const y = current.getFullYear();
      const m = String(current.getMonth() + 1).padStart(2, '0');
      const d = String(day).padStart(2, '0');
      window.location.href = `/activities?date=${y}-${m}-${d}`;
    },
  };
})();

document.addEventListener('DOMContentLoaded', () => Calendar.render());