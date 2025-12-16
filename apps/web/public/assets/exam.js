(function () {
  const API_BASE = window.MOCKERA_API_BASE;
  if (!API_BASE) {
    alert("Missing window.MOCKERA_API_BASE. Set it in /config.js");
    return;
  }

  const qs = new URLSearchParams(location.search);
  const testId = qs.get("testId");
  let attemptId = qs.get("attemptId");

  // UI refs
  const timerValue = document.getElementById("timerValue");
  const sectionSelect = document.getElementById("sectionSelect");
  const paletteGrid = document.getElementById("paletteGrid");
  const qNumEl = document.getElementById("qNum");
  const qTypeEl = document.getElementById("qType");
  const qImage = document.getElementById("qImage");
  const responseArea = document.getElementById("responseArea");

  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");
  const saveNextBtn = document.getElementById("saveNextBtn");
  const submitBtn = document.getElementById("submitBtn");
  const markBtn = document.getElementById("markBtn");
  const clearBtn = document.getElementById("clearBtn");

  // Attempt state from server
  let attempt = null; // { id, endsAt, test: { sections, questions[] } }
  let endsAtMs = 0;

  // Local state mirror (NO localStorage)
  // key: questionId -> { visited, isMarked, responseJson, timeSpentMs }
  const qState = new Map();

  // Navigation
  let currentSectionId = "__ALL__";
  let currentIndex = 0;

  // Time tracking
  let currentQuestionId = null;
  let currentQuestionEnterMs = 0;
  let heartbeatTimer = null;
  let tickTimer = null;

  function fmt2(n) { return String(n).padStart(2, "0"); }
  function fmtHMS(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${fmt2(h)}:${fmt2(m)}:${fmt2(s)}`;
  }

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
      // MPA-friendly: send to login
      location.href = "/login.html";
      return null;
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || `HTTP ${res.status}`);
    }

    return res.json();
  }

  function getQuestionsInCurrentSection() {
    const all = attempt.test.questions;
    if (currentSectionId === "__ALL__") return all;
    return all.filter(q => q.sectionId === currentSectionId);
  }

  function stateClass(st) {
    const visited = !!st.visited;
    const marked = !!st.isMarked;
    const answered = st.responseJson != null;

    if (!visited) return "p-notvisited";
    if (answered && marked) return "p-answeredmarked";
    if (answered) return "p-answered";
    if (marked) return "p-marked";
    return "p-notvisited";
  }

  function flushTimeForCurrentQuestion() {
    if (!currentQuestionId) return;
    const now = Date.now();
    const delta = Math.max(0, now - currentQuestionEnterMs);

    const st = qState.get(currentQuestionId);
    if (!st) return;

    st.timeSpentMs = (st.timeSpentMs || 0) + delta;

    // reset enter time
    currentQuestionEnterMs = now;
  }

  async function saveQuestionPatch(questionId, patch) {
    // merge into local state first (so UI is instant)
    const st = qState.get(questionId) || { visited: false, isMarked: false, responseJson: null, timeSpentMs: 0 };
    if (patch.visited !== undefined) st.visited = patch.visited;
    if (patch.isMarked !== undefined) st.isMarked = patch.isMarked;
    if (patch.responseJson !== undefined) st.responseJson = patch.responseJson;
    if (patch.timeSpentMs !== undefined) st.timeSpentMs = patch.timeSpentMs;
    qState.set(questionId, st);

    // persist
    await api(`/v1/attempts/${encodeURIComponent(attemptId)}/answers/${encodeURIComponent(questionId)}`, {
      method: "PUT",
      body: JSON.stringify(patch)
    });

    renderPalette(); // update colors
  }

  function renderSectionSelect() {
    sectionSelect.innerHTML = "";
    const optAll = document.createElement("option");
    optAll.value = "__ALL__";
    optAll.textContent = "All Sections";
    sectionSelect.appendChild(optAll);

    for (const s of attempt.test.sections) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name;
      sectionSelect.appendChild(opt);
    }

    sectionSelect.value = currentSectionId;
    sectionSelect.onchange = () => {
      flushTimeForCurrentQuestion();
      currentSectionId = sectionSelect.value;
      currentIndex = 0;
      renderPalette();
      goToIndex(0);
    };
  }

  function renderPalette() {
    const questions = getQuestionsInCurrentSection();
    paletteGrid.innerHTML = "";

    questions.forEach((q, idx) => {
      const st = qState.get(q.questionId) || { visited: false, isMarked: false, responseJson: null, timeSpentMs: 0 };

      const btn = document.createElement("button");
      btn.className = `pbtn ${stateClass(st)} ${idx === currentIndex ? "active" : ""}`;
      btn.textContent = String(idx + 1);
      btn.onclick = () => {
        flushTimeForCurrentQuestion();
        goToIndex(idx);
      };
      paletteGrid.appendChild(btn);
    });
  }

  function renderResponseUI(q) {
    responseArea.innerHTML = "";
    const st = qState.get(q.questionId);

    if (q.type === "MCQ") {
      const wrap = document.createElement("div");
      wrap.className = "opt-grid";

      const selected = st?.responseJson?.option;
      ["A", "B", "C", "D"].forEach((label, optionIndex) => {
        const b = document.createElement("button");
        b.className = "opt-btn" + (selected === optionIndex ? " selected" : "");
        b.textContent = label;
        b.onclick = async () => {
          flushTimeForCurrentQuestion();
          const next = { option: optionIndex };
          await saveQuestionPatch(q.questionId, {
            visited: true,
            responseJson: next,
            timeSpentMs: qState.get(q.questionId)?.timeSpentMs ?? 0
          });
          renderResponseUI(q);
        };
        wrap.appendChild(b);
      });

      responseArea.appendChild(wrap);

      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "MCQ: Select one option.";
      responseArea.appendChild(hint);
      return;
    }

    if (q.type === "MSQ") {
      const wrap = document.createElement("div");
      wrap.className = "msq-list";

      const selected = new Set(st?.responseJson?.options || []);
      ["A", "B", "C", "D"].forEach((label, optionIndex) => {
        const item = document.createElement("label");
        item.className = "msq-item";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = selected.has(optionIndex);
        cb.onchange = async () => {
          flushTimeForCurrentQuestion();

          if (cb.checked) selected.add(optionIndex);
          else selected.delete(optionIndex);

          const options = Array.from(selected).sort((a, b) => a - b);
          const next = options.length ? { options } : null;

          await saveQuestionPatch(q.questionId, {
            visited: true,
            responseJson: next,
            timeSpentMs: qState.get(q.questionId)?.timeSpentMs ?? 0
          });

          renderResponseUI(q);
        };

        const span = document.createElement("span");
        span.textContent = label;

        item.appendChild(cb);
        item.appendChild(span);
        wrap.appendChild(item);
      });

      responseArea.appendChild(wrap);

      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "MSQ: Select one or more options.";
      responseArea.appendChild(hint);
      return;
    }

    // NUMERICAL
    const wrap = document.createElement("div");
    wrap.className = "num-wrap";

    const input = document.createElement("input");
    input.className = "num-input";
    input.placeholder = "Enter numeric answer";
    input.inputMode = "decimal";
    input.value = (st?.responseJson?.value ?? "").toString();

    let saveTimer = null;
    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        flushTimeForCurrentQuestion();
        const raw = input.value.trim();
        const next = raw === "" ? null : { value: raw };
        await saveQuestionPatch(q.questionId, {
          visited: true,
          responseJson: next,
          timeSpentMs: qState.get(q.questionId)?.timeSpentMs ?? 0
        });
      }, 400);
    };

    input.addEventListener("input", scheduleSave);
    input.addEventListener("blur", scheduleSave);

    wrap.appendChild(input);
    responseArea.appendChild(wrap);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Numerical: Your input is auto-saved.";
    responseArea.appendChild(hint);
  }

  async function goToIndex(idx) {
    const questions = getQuestionsInCurrentSection();
    if (!questions.length) return;

    currentIndex = Math.max(0, Math.min(idx, questions.length - 1));
    const q = questions[currentIndex];

    currentQuestionId = q.questionId;
    currentQuestionEnterMs = Date.now();

    // mark visited immediately (server + local)
    const st = qState.get(q.questionId);
    if (!st?.visited) {
      await saveQuestionPatch(q.questionId, {
        visited: true,
        timeSpentMs: st?.timeSpentMs ?? 0
      });
    }

    // render
    qNumEl.textContent = `Q${currentIndex + 1}`;
    qTypeEl.textContent = q.type;

    qImage.src = q.promptImageUrl;
    qImage.onerror = () => { qImage.alt = "Failed to load question image"; };

    renderPalette();
    renderResponseUI(q);

    // mark button text reflects current state
    const st2 = qState.get(q.questionId);
    markBtn.textContent = st2?.isMarked ? "Unmark" : "Mark for Review";
  }

  function tickTimerUi() {
    const left = endsAtMs - Date.now();
    timerValue.textContent = fmtHMS(left);

    if (left <= 0) {
      // auto-submit
      doSubmit(true).catch(() => {});
    }
  }

  async function doSubmit(isAuto) {
    // stop periodic saves
    if (tickTimer) clearInterval(tickTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);

    // finalize time on current question before submit
    flushTimeForCurrentQuestion();
    if (currentQuestionId) {
      const st = qState.get(currentQuestionId);
      if (st) {
        await saveQuestionPatch(currentQuestionId, {
          visited: true,
          isMarked: st.isMarked,
          responseJson: st.responseJson,
          timeSpentMs: st.timeSpentMs
        });
      }
    }

    if (!isAuto) {
      const ok = confirm("Submit test now? You cannot change answers after submission.");
      if (!ok) {
        // resume timer ticks if cancelled
        tickTimer = setInterval(tickTimerUi, 1000);
        heartbeatTimer = setInterval(heartbeatSaveTimeOnly, 15000);
        return;
      }
    }

    await api(`/v1/attempts/${encodeURIComponent(attemptId)}/submit`, { method: "POST", body: "{}" });

    // Phase 4 will implement analysis page properly
    location.href = `/analysis.html?attemptId=${encodeURIComponent(attemptId)}`;
  }

  async function heartbeatSaveTimeOnly() {
    if (!currentQuestionId) return;
    flushTimeForCurrentQuestion();
    const st = qState.get(currentQuestionId);
    if (!st) return;

    // time-only patch (cheap)
    await saveQuestionPatch(currentQuestionId, {
      timeSpentMs: st.timeSpentMs
    });
  }

  function wireButtons() {
    prevBtn.onclick = async () => {
      flushTimeForCurrentQuestion();
      await goToIndex(currentIndex - 1);
    };

    nextBtn.onclick = async () => {
      flushTimeForCurrentQuestion();
      await goToIndex(currentIndex + 1);
    };

    saveNextBtn.onclick = async () => {
      flushTimeForCurrentQuestion();
      await goToIndex(currentIndex + 1);
    };

    submitBtn.onclick = () => doSubmit(false).catch(e => alert(e.message || String(e)));

    markBtn.onclick = async () => {
      const questions = getQuestionsInCurrentSection();
      const q = questions[currentIndex];
      const st = qState.get(q.questionId) || { visited: true, isMarked: false, responseJson: null, timeSpentMs: 0 };
      st.isMarked = !st.isMarked;
      qState.set(q.questionId, st);

      await saveQuestionPatch(q.questionId, {
        visited: true,
        isMarked: st.isMarked,
        timeSpentMs: st.timeSpentMs
      });

      markBtn.textContent = st.isMarked ? "Unmark" : "Mark for Review";
    };

    clearBtn.onclick = async () => {
      const questions = getQuestionsInCurrentSection();
      const q = questions[currentIndex];
      const st = qState.get(q.questionId) || { visited: true, isMarked: false, responseJson: null, timeSpentMs: 0 };
      st.responseJson = null;
      qState.set(q.questionId, st);

      await saveQuestionPatch(q.questionId, {
        visited: true,
        responseJson: null,
        timeSpentMs: st.timeSpentMs
      });

      renderResponseUI(q);
    };
  }

  async function init() {
    if (!attemptId) {
      if (!testId) {
        alert("Missing testId or attemptId in URL. Use /attempt.html?testId=...");
        return;
      }
      const started = await api(`/v1/tests/${encodeURIComponent(testId)}/attempts/start`, {
        method: "POST",
        body: "{}"
      });
      attemptId = started.attempt.id;

      // keep URL clean (MPA-friendly)
      history.replaceState({}, "", `/attempt.html?attemptId=${encodeURIComponent(attemptId)}`);
    }

    const ov = await api(`/v1/attempts/${encodeURIComponent(attemptId)}/overview`, { method: "GET" });
    attempt = ov.attempt;
    endsAtMs = new Date(attempt.endsAt).getTime();

    // hydrate local state map from server
    attempt.test.questions.forEach(q => {
      qState.set(q.questionId, {
        visited: !!q.visited,
        isMarked: !!q.isMarked,
        responseJson: q.responseJson ?? null,
        timeSpentMs: q.timeSpentMs ?? 0
      });
    });

    // sections
    currentSectionId = "__ALL__";
    renderSectionSelect();

    wireButtons();
    renderPalette();

    // go first question
    await goToIndex(0);

    // timer + heartbeat
    tickTimerUi();
    tickTimer = setInterval(tickTimerUi, 1000);
    heartbeatTimer = setInterval(heartbeatSaveTimeOnly, 15000);

    // save time if user closes tab
    window.addEventListener("beforeunload", () => {
      try { flushTimeForCurrentQuestion(); } catch (_) {}
    });
  }

  init().catch(e => alert(e.message || String(e)));
})();