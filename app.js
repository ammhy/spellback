"use strict";

const STORAGE_KEY = "daily-vocab-web.v1";
const DEFAULT_SETTINGS = {
  intervals: { 1: 1, 2: 2, 3: 4, 4: 7, 5: 15 },
  dailyLimit: 30,
  answerMode: "strict",
  retryWrongTomorrow: true,
  prioritizeMistakes: true,
};
const LEVEL_NAMES = { 1: "陌生", 2: "眼熟", 3: "一般", 4: "熟悉", 5: "掌握" };

let state = loadState();
let activeView = "dashboard";
let reviewQueue = [];
let reviewIndex = 0;
let answerChecked = false;
let pendingAnswerCorrect = false;
let reviewedThisSession = 0;
let toastTimer = 0;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function localISO(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(iso, count) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + count);
  return localISO(date);
}

function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[,，;；\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueList(items) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function normalizeSettings(settings = {}) {
  const intervals = {};
  for (let level = 1; level <= 5; level += 1) {
    intervals[level] = clampNumber(settings.intervals?.[level], 1, 3650, DEFAULT_SETTINGS.intervals[level]);
  }
  return {
    intervals,
    dailyLimit: clampNumber(settings.dailyLimit, 1, 500, DEFAULT_SETTINGS.dailyLimit),
    answerMode: settings.answerMode === "forgiving" ? "forgiving" : "strict",
    retryWrongTomorrow: settings.retryWrongTomorrow !== false,
    prioritizeMistakes: settings.prioritizeMistakes !== false,
  };
}

function normalizeWord(word) {
  const level = Math.max(1, Math.min(5, Number(word.level) || 1));
  return {
    id: String(word.id || uid()),
    english: String(word.english || "").trim(),
    chinese: String(word.chinese || "").trim(),
    aliases: uniqueList(splitList(word.aliases)),
    tags: uniqueList(splitList(word.tags)),
    level,
    createdAt: String(word.createdAt || new Date().toISOString()),
    lastReviewed: String(word.lastReviewed || ""),
    nextReview: String(word.nextReview || localISO()),
    reviewCount: Math.max(0, Number(word.reviewCount) || 0),
    correctCount: Math.max(0, Number(word.correctCount) || 0),
    wrongCount: Math.max(0, Number(word.wrongCount) || 0),
  };
}

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (raw && Array.isArray(raw.words)) {
      return {
        version: 2,
        settings: normalizeSettings(raw.settings),
        words: raw.words.map(normalizeWord),
      };
    }
  } catch (error) {
    console.warn("Unable to read local data", error);
  }
  return { version: 2, settings: normalizeSettings(), words: [] };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    showToast("本地保存失败，请先导出备份并检查浏览器设置");
    console.error(error);
  }
}

function intervalForLevel(level) {
  return state.settings.intervals[level] || DEFAULT_SETTINGS.intervals[level];
}

function dueWords() {
  const today = localISO();
  return state.words
    .filter((word) => word.nextReview <= today)
    .sort((a, b) => {
      const dateOrder = a.nextReview.localeCompare(b.nextReview);
      if (dateOrder) return dateOrder;
      if (state.settings.prioritizeMistakes && a.wrongCount !== b.wrongCount) return b.wrongCount - a.wrongCount;
      return a.level - b.level || a.english.localeCompare(b.english);
    });
}

function reviewedTodayCount() {
  const today = localISO();
  return state.words.filter((word) => word.lastReviewed === today).length;
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeAnswer(value, mode = "strict") {
  const normalized = String(value)
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ");
  return mode === "forgiving" ? normalized.replace(/[^a-z0-9]/g, "") : normalized;
}

function answersMatch(answer, word) {
  const mode = state.settings.answerMode;
  const normalizedAnswer = normalizeAnswer(answer, mode);
  return [word.english, ...word.aliases].some((candidate) => normalizeAnswer(candidate, mode) === normalizedAnswer);
}

function accuracyFor(word) {
  const total = word.correctCount + word.wrongCount;
  return total ? `${Math.round((word.correctCount / total) * 100)}%` : "-";
}

function formatDate(iso) {
  if (!iso || iso === localISO()) return "今天";
  const [year, month, day] = iso.split("-");
  return `${year}.${month}.${day}`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2400);
}

function switchView(view, options = {}) {
  activeView = view;
  $$(".view").forEach((item) => item.classList.toggle("is-active", item.id === `view-${view}`));
  $$(".nav-item").forEach((item) => item.classList.toggle("is-active", item.dataset.view === view));

  if (view === "dashboard") renderDashboard();
  if (view === "library") renderLibrary();
  if (view === "review") startReview(Boolean(options.keepQueue));
  if (view === "editor" && !options.keepForm) resetEditor();
  if (view === "data") renderSettings();
  updateGlobalCounts();
}

function updateGlobalCounts() {
  const due = dueWords().length;
  $("#nav-due-count").textContent = due;
  $("#side-due-count").textContent = due;
  $("#side-total-count").textContent = `共 ${state.words.length} 个单词`;
}

function renderDashboard() {
  const due = dueWords();
  const formatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  $("#today-label").textContent = formatter.format(new Date());
  $("#stat-due").textContent = due.length;
  $("#stat-total").textContent = state.words.length;
  $("#stat-mastered").textContent = state.words.filter((word) => word.level === 5).length;
  $("#stat-reviewed").textContent = reviewedTodayCount();
  $("#start-review-btn").disabled = due.length === 0;
  $("#start-review-btn").classList.toggle("is-disabled", due.length === 0);
  for (let level = 1; level <= 5; level += 1) {
    $(`#schedule-level-${level}`).textContent = `每 ${intervalForLevel(level)} 天`;
  }

  const preview = $("#due-preview");
  if (!due.length) {
    preview.innerHTML = `<div class="no-due"><div><svg><use href="#i-check"></use></svg><h3>今天已经完成</h3><p>没有到期单词</p></div></div>`;
    return;
  }
  preview.innerHTML = due.slice(0, 6).map((word) => `
    <div class="due-row">
      <strong>${escapeHTML(word.english)}</strong>
      <span>${escapeHTML(word.chinese)}</span>
      <b class="level-badge level-${word.level}">${word.level} 级</b>
    </div>`).join("");
}

function startReview(keepQueue = false) {
  if (!keepQueue) {
    reviewQueue = dueWords().slice(0, state.settings.dailyLimit).map((word) => word.id);
    reviewIndex = 0;
    reviewedThisSession = 0;
  }
  answerChecked = false;
  pendingAnswerCorrect = false;
  renderReview();
}

function renderReview() {
  const stage = $("#review-stage");
  const total = reviewQueue.length;
  const currentId = reviewQueue[reviewIndex];
  const word = state.words.find((item) => item.id === currentId);
  const progress = total ? Math.min(100, (reviewIndex / total) * 100) : 100;
  $("#review-progress-text").textContent = `${Math.min(reviewIndex, total)} / ${total}`;
  $("#review-progress-bar").style.width = `${progress}%`;

  if (!word) {
    const remaining = dueWords().length;
    const title = total ? "本轮复习完成" : "今天没有到期单词";
    const detail = total
      ? `本次完成 ${reviewedThisSession} 个单词${remaining ? `，还有 ${remaining} 个到期词` : ""}`
      : "可以去词库添加新单词";
    stage.innerHTML = `
      <div class="review-complete">
        <div><span class="complete-mark"><svg><use href="#i-check"></use></svg></span><h2>${title}</h2><p>${detail}</p><button class="button button-primary" data-complete-home>回到今日</button></div>
      </div>`;
    $("[data-complete-home]").addEventListener("click", () => switchView("dashboard"));
    return;
  }

  stage.innerHTML = `
    <article class="review-card">
      <p class="prompt-label">根据中文拼写英文</p>
      <h2 class="chinese-prompt">${escapeHTML(word.chinese)}</h2>
      ${word.tags.length ? `<div class="review-tags">${word.tags.map((tag) => `<span>${escapeHTML(tag)}</span>`).join("")}</div>` : ""}
      <form class="answer-row" id="answer-form">
        <input id="answer-input" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="输入英文拼写" placeholder="输入英文">
        <button class="button button-primary" type="submit">检查答案</button>
      </form>
      <div id="answer-feedback"></div>
    </article>`;
  $("#answer-form").addEventListener("submit", checkAnswer);
  $("#answer-input").focus();
}

function checkAnswer(event) {
  event.preventDefault();
  if (answerChecked) return;
  const currentId = reviewQueue[reviewIndex];
  const word = state.words.find((item) => item.id === currentId);
  const input = $("#answer-input");
  const answer = input.value;
  if (!answer.trim()) {
    showToast("先输入英文拼写");
    input.focus();
    return;
  }

  answerChecked = true;
  pendingAnswerCorrect = answersMatch(answer, word);
  input.disabled = true;
  input.classList.add(pendingAnswerCorrect ? "is-correct" : "is-wrong");
  $("#answer-form button").disabled = true;
  const feedback = $("#answer-feedback");
  feedback.innerHTML = `
    <div class="feedback ${pendingAnswerCorrect ? "correct" : "wrong"}">
      <strong>${pendingAnswerCorrect ? "拼写正确" : "正确答案"}</strong>
      <p>${escapeHTML(word.english)}</p>
      ${word.aliases.length ? `<small>也接受：${word.aliases.map(escapeHTML).join(" / ")}</small>` : ""}
    </div>
    <div class="level-update">
      <span>复习后熟练度</span>
      <div class="review-levels">
        ${[1, 2, 3, 4, 5].map((level) => `<button type="button" data-review-level="${level}"><b>${level}</b><small>${LEVEL_NAMES[level]} · ${intervalForLevel(level)}天</small></button>`).join("")}
      </div>
    </div>`;
  $$('[data-review-level]').forEach((button) => button.addEventListener("click", () => finishWord(Number(button.dataset.reviewLevel))));
}

function finishWord(level) {
  const currentId = reviewQueue[reviewIndex];
  const word = state.words.find((item) => item.id === currentId);
  if (!word) return;
  word.level = level;
  word.lastReviewed = localISO();
  const interval = !pendingAnswerCorrect && state.settings.retryWrongTomorrow ? 1 : intervalForLevel(level);
  word.nextReview = addDays(localISO(), interval);
  word.reviewCount += 1;
  word.correctCount += pendingAnswerCorrect ? 1 : 0;
  word.wrongCount += pendingAnswerCorrect ? 0 : 1;
  saveState();
  reviewedThisSession += 1;
  reviewIndex += 1;
  answerChecked = false;
  pendingAnswerCorrect = false;
  renderReview();
  updateGlobalCounts();
}

function refreshTagFilter() {
  const select = $("#tag-filter");
  const current = select.value;
  const tags = uniqueList(state.words.flatMap((word) => word.tags)).sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="all">全部</option>${tags.map((tag) => `<option value="${escapeHTML(tag)}">${escapeHTML(tag)}</option>`).join("")}`;
  select.value = tags.includes(current) ? current : "all";
}

function renderLibrary() {
  refreshTagFilter();
  const query = normalizeAnswer($("#search-input").value || "");
  const level = $("#level-filter").value;
  const tag = $("#tag-filter").value;
  const words = [...state.words]
    .filter((word) => !query || normalizeAnswer(`${word.english} ${word.chinese} ${word.aliases.join(" ")} ${word.tags.join(" ")}`).includes(query))
    .filter((word) => level === "all" || word.level === Number(level))
    .filter((word) => tag === "all" || word.tags.includes(tag))
    .sort((a, b) => a.english.localeCompare(b.english));

  const tbody = $("#word-table-body");
  tbody.innerHTML = words.map((word) => `
    <tr>
      <td><strong>${escapeHTML(word.english)}</strong>${word.aliases.length ? `<small class="sub-copy">${word.aliases.map(escapeHTML).join(" / ")}</small>` : ""}</td>
      <td>${escapeHTML(word.chinese)}</td>
      <td>${word.tags.length ? `<div class="tag-list">${word.tags.map((item) => `<span>${escapeHTML(item)}</span>`).join("")}</div>` : "-"}</td>
      <td><b class="level-badge level-${word.level}">${word.level} 级</b></td>
      <td>${formatDate(word.nextReview)}</td>
      <td>${accuracyFor(word)}</td>
      <td class="actions">
        <button class="icon-button" data-edit-id="${word.id}" title="编辑"><svg><use href="#i-edit"></use></svg></button>
        <button class="icon-button danger" data-delete-id="${word.id}" title="删除"><svg><use href="#i-trash"></use></svg></button>
      </td>
    </tr>`).join("");
  $("#library-empty").classList.toggle("is-hidden", words.length > 0);
  $$('[data-edit-id]').forEach((button) => button.addEventListener("click", () => editWord(button.dataset.editId)));
  $$('[data-delete-id]').forEach((button) => button.addEventListener("click", () => deleteWord(button.dataset.deleteId)));
}

function resetEditor() {
  $("#word-form").reset();
  $("#word-id").value = "";
  $("#editor-title").textContent = "添加单词";
  $('input[name="editor-level"][value="1"]').checked = true;
  setTimeout(() => $("#english-input").focus(), 0);
}

function editWord(id) {
  const word = state.words.find((item) => item.id === id);
  if (!word) return;
  switchView("editor", { keepForm: true });
  $("#editor-title").textContent = "编辑单词";
  $("#word-id").value = word.id;
  $("#english-input").value = word.english;
  $("#chinese-input").value = word.chinese;
  $("#aliases-input").value = word.aliases.join("，");
  $("#tags-input").value = word.tags.join("，");
  $(`input[name="editor-level"][value="${word.level}"]`).checked = true;
  $("#english-input").focus();
}

function saveWord(event) {
  event.preventDefault();
  const id = $("#word-id").value;
  const english = $("#english-input").value.trim();
  const chinese = $("#chinese-input").value.trim();
  const aliases = uniqueList(splitList($("#aliases-input").value));
  const tags = uniqueList(splitList($("#tags-input").value));
  const level = Number($('input[name="editor-level"]:checked').value);
  if (!english || !chinese) return;

  const duplicate = state.words.find((word) => normalizeAnswer(word.english) === normalizeAnswer(english) && word.id !== id);
  if (duplicate && !confirm(`“${english}” 已存在，仍然保存吗？`)) return;

  if (id) {
    const word = state.words.find((item) => item.id === id);
    if (!word) return;
    word.english = english;
    word.chinese = chinese;
    word.aliases = aliases;
    word.tags = tags;
    if (word.level !== level) {
      word.level = level;
      word.nextReview = addDays(localISO(), intervalForLevel(level));
    }
  } else {
    state.words.push(normalizeWord({ id: uid(), english, chinese, aliases, tags, level, nextReview: localISO() }));
  }
  saveState();
  showToast(id ? "单词已更新" : "单词已添加，今天可以复习");
  switchView("library");
}

function deleteWord(id) {
  const word = state.words.find((item) => item.id === id);
  if (!word || !confirm(`确定删除“${word.english}”吗？`)) return;
  state.words = state.words.filter((item) => item.id !== id);
  saveState();
  renderLibrary();
  updateGlobalCounts();
  showToast("已删除");
}

function renderSettings() {
  $("#daily-limit-input").value = state.settings.dailyLimit;
  $("#answer-mode-select").value = state.settings.answerMode;
  $("#retry-wrong-input").checked = state.settings.retryWrongTomorrow;
  $("#mistake-first-input").checked = state.settings.prioritizeMistakes;
  for (let level = 1; level <= 5; level += 1) {
    $(`#interval-${level}-input`).value = intervalForLevel(level);
  }
}

function savePreferences(event) {
  event.preventDefault();
  const intervals = {};
  for (let level = 1; level <= 5; level += 1) {
    intervals[level] = clampNumber($(`#interval-${level}-input`).value, 1, 3650, DEFAULT_SETTINGS.intervals[level]);
  }
  state.settings = normalizeSettings({
    intervals,
    dailyLimit: $("#daily-limit-input").value,
    answerMode: $("#answer-mode-select").value,
    retryWrongTomorrow: $("#retry-wrong-input").checked,
    prioritizeMistakes: $("#mistake-first-input").checked,
  });
  saveState();
  renderSettings();
  showToast("个性化设置已保存");
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `daily-vocab-${localISO()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
  showToast("备份已导出");
}

async function importData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.words)) throw new Error("Invalid backup");
    const incoming = data.words.map(normalizeWord).filter((word) => word.english && word.chinese);
    const merged = new Map(state.words.map((word) => [normalizeAnswer(word.english), word]));
    incoming.forEach((word) => merged.set(normalizeAnswer(word.english), word));
    state.words = [...merged.values()];
    if (data.settings) state.settings = normalizeSettings(data.settings);
    saveState();
    updateGlobalCounts();
    renderSettings();
    showToast(`已导入 ${incoming.length} 个单词`);
  } catch (error) {
    showToast("导入失败：文件格式不正确");
    console.error(error);
  } finally {
    event.target.value = "";
  }
}

function resetAll() {
  if (!state.words.length) return;
  if (!confirm("确定清空全部单词和复习记录吗？此操作无法撤销。")) return;
  state = { version: 2, settings: state.settings, words: [] };
  saveState();
  updateGlobalCounts();
  showToast("词库已清空");
  switchView("dashboard");
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$('[data-view-target]').forEach((button) => button.addEventListener("click", () => switchView(button.dataset.viewTarget)));
  $("#start-review-btn").addEventListener("click", () => switchView("review"));
  $("#search-input").addEventListener("input", renderLibrary);
  $("#level-filter").addEventListener("change", renderLibrary);
  $("#tag-filter").addEventListener("change", renderLibrary);
  $("#word-form").addEventListener("submit", saveWord);
  $("#cancel-edit-btn").addEventListener("click", () => switchView("library"));
  $("#preferences-form").addEventListener("submit", savePreferences);
  $("#export-btn").addEventListener("click", exportData);
  $("#import-input").addEventListener("change", importData);
  $("#reset-btn").addEventListener("click", resetAll);
}

bindEvents();
renderDashboard();
renderSettings();
updateGlobalCounts();
