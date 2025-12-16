(function () {
  const API_BASE = window.MOCKERA_API_BASE;
  if (!API_BASE) {
    alert("Missing window.MOCKERA_API_BASE in /config.js");
    return;
  }

  const qs = new URLSearchParams(location.search);
  const attemptId = qs.get("attemptId");

  const el = (id) => document.getElementById(id);

  function fmt2(n) { return String(n).padStart(2, "0"); }
  function fmtHMS(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    return `${fmt2(h)}:${fmt2(m)}:${fmt2(s)}`;
  }
  function pct(x) { return `${Math.round(x * 1000) / 10}%`; }

  async function api(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    if (res.status === 401) {
      location.href = "/login.html";
      return null;
    }
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  function badgeForRow(r) {
    if (!r.attempted) return `<span class="badge b-na">UNATTEMPTED</span>`;
    if (r.correct) return `<span class="badge b-ok">CORRECT</span>`;
    return `<span class="badge b-bad">WRONG</span>`;
  }

  function safeStr(x) {
    return (x === null || x === undefined || x === "") ? "—" : String(x);
  }

  let DATA = null;

  function openModal(row) {
    el("modalTitle").textContent = `Q${row.index} • ${row.subject}`;
    el("modalImg").src = row.promptImageUrl;
    el("modalMeta").textContent =
      `Type: ${row.type} | Chapter: ${safeStr(row.chapter)} | Difficulty: ${row.difficulty} | Time: ${fmtHMS(row.timeSpentMs)}`;

    el("modalJson").textContent =
      `Your response: ${JSON.stringify(row.responseJson, null, 2)}\n` +
      `Correct key:  ${JSON.stringify(row.correctAnswerKey, null, 2)}\n` +
      `Marks: ${row.marksAwarded} (max ${row.marks}, neg ${row.negative})`;

    const sol = [];
    if (row.solutionText) sol.push(`<div><b>Solution:</b><br/>${row.solutionText.replaceAll("\n", "<br/>")}</div>`);
    if (row.solutionImageUrl) sol.push(`<div style="margin-top:10px;"><img src="${row.solutionImageUrl}" style="width:100%;border:1px solid #1f2937;background:#0b1220;" /></div>`);
    el("modalSolution").innerHTML = sol.length ? sol.join("") : `<div class="meta">No solution provided.</div>`;

    el("modal").classList.remove("hidden");
  }

  function closeModal() {
    el("modal").classList.add("hidden");
  }

  function renderTable() {
    const tbody = el("qTableBody");
    tbody.innerHTML = "";

    const filter = el("filterSelect").value;
    const search = (el("searchBox").value || "").trim().toLowerCase();

    const rows = DATA.perQuestion.filter(r => {
      if (filter === "CORRECT" && !(r.attempted && r.correct)) return false;
      if (filter === "WRONG" && !(r.attempted && !r.correct)) return false;
      if (filter === "UNATTEMPTED" && r.attempted) return false;
      if (filter === "MARKED" && !r.isMarked) return false;

      if (search) {
        const hay = `${r.subject || ""} ${r.chapter || ""}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    for (const r of rows) {
      const tr = document.createElement("tr");

      const marked = r.isMarked ? ` <span class="badge b-mark">MARKED</span>` : "";
      tr.innerHTML = `
        <td>${r.index}</td>
        <td>${safeStr(r.sectionName)}</td>
        <td>${safeStr(r.subject)}</td>
        <td>${safeStr(r.chapter)}</td>
        <td>${r.type}</td>
        <td>${badgeForRow(r)}${marked}</td>
        <td>${r.marksAwarded}</td>
        <td>${fmtHMS(r.timeSpentMs)}</td>
        <td><button class="btn" data-q="${r.questionId}">View</button></td>
      `;

      tr.querySelector("button").onclick = () => openModal(r);
      tbody.appendChild(tr);
    }
  }

  function renderCharts() {
    const s = DATA.summary;

    // Outcome donut
    new Chart(el("chartOutcome"), {
      type: "doughnut",
      data: {
        labels: ["Correct", "Wrong", "Unattempted"],
        datasets: [{
          data: [s.correctCount, s.wrongCount, s.unattemptedCount],
          backgroundColor: ["#22c55e", "#ef4444", "#64748b"]
        }]
      },
      options: {
        plugins: {
          legend: { labels: { color: "#e6edf3" } }
        }
      }
    });

    // Subject bar (score/max)
    const labels = DATA.subjectBreakup.map(x => x.subject);
    const scores = DATA.subjectBreakup.map(x => x.score);
    const maxes = DATA.subjectBreakup.map(x => x.maxScore);

    new Chart(el("chartSubjects"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Score", data: scores, backgroundColor: "rgba(96,165,250,0.55)" },
          { label: "Max", data: maxes, backgroundColor: "rgba(148,163,184,0.25)" }
        ]
      },
      options: {
        plugins: { legend: { labels: { color: "#e6edf3" } } },
        scales: {
          x: { ticks: { color: "#e6edf3" }, grid: { color: "rgba(31,41,55,0.6)" } },
          y: { ticks: { color: "#e6edf3" }, grid: { color: "rgba(31,41,55,0.6)" } }
        }
      }
    });

    // Time per question
    const qLabels = DATA.perQuestion.map(r => `Q${r.index}`);
    const times = DATA.perQuestion.map(r => Math.round(r.timeSpentMs / 1000));

    new Chart(el("chartTime"), {
      type: "line",
      data: {
        labels: qLabels,
        datasets: [{
          label: "Seconds",
          data: times,
          borderColor: "#f59e0b",
          backgroundColor: "rgba(245,158,11,0.15)",
          fill: true,
          tension: 0.25,
          pointRadius: 2
        }]
      },
      options: {
        plugins: { legend: { labels: { color: "#e6edf3" } } },
        scales: {
          x: { ticks: { color: "#e6edf3" }, grid: { color: "rgba(31,41,55,0.6)" } },
          y: { ticks: { color: "#e6edf3" }, grid: { color: "rgba(31,41,55,0.6)" } }
        }
      }
    });
  }

  async function init() {
    if (!attemptId) {
      alert("Missing attemptId in URL. Use /analysis.html?attemptId=...");
      return;
    }

    DATA = await api(`/v1/attempts/${encodeURIComponent(attemptId)}/analysis`, { method: "GET" });

    el("testTitle").textContent = DATA.attempt.testTitle;
    el("scoreValue").textContent = `${DATA.summary.score} / ${DATA.summary.maxScore}`;
    el("accuracyValue").textContent = pct(DATA.summary.accuracy);
    el("cwuValue").textContent = `${DATA.summary.correctCount} / ${DATA.summary.wrongCount} / ${DATA.summary.unattemptedCount}`;
    el("timeValue").textContent = fmtHMS(DATA.summary.totalTimeMs);

    // reattempt link (starts new attempt using testId)
    el("reattemptLink").href = `/attempt.html?testId=${encodeURIComponent(DATA.attempt.testId)}`;

    el("filterSelect").onchange = renderTable;
    el("searchBox").oninput = renderTable;

    el("modalClose").onclick = closeModal;
    el("modalX").onclick = closeModal;

    renderCharts();
    renderTable();
  }

  init().catch(e => alert(e.message || String(e)));
})();