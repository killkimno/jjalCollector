const DEFAULTS = {
  minWidth: 480,
  minHeight: 480,
  folder: "jjal-collector",
  includeBackgrounds: true,
  includeSrcset: true,
  hideDownloadUi: true,
  saveByDate: true
};
const MIN_IMAGE_DIMENSION = 480;
const LOG_KEY = "collectorLogs";

const form = document.getElementById("optionsForm");
const minWidth = document.getElementById("minWidth");
const minHeight = document.getElementById("minHeight");
const folder = document.getElementById("folder");
const saveByDate = document.getElementById("saveByDate");
const hideDownloadUi = document.getElementById("hideDownloadUi");
const includeSrcset = document.getElementById("includeSrcset");
const includeBackgrounds = document.getElementById("includeBackgrounds");
const saveStatus = document.getElementById("saveStatus");
const logList = document.getElementById("logList");
const refreshLogs = document.getElementById("refreshLogs");
const clearLogs = document.getElementById("clearLogs");

document.addEventListener("DOMContentLoaded", loadOptions);
form.addEventListener("submit", saveOptions);
saveByDate.addEventListener("change", saveOptions);
refreshLogs.addEventListener("click", loadLogs);
clearLogs.addEventListener("click", clearCollectorLogs);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[LOG_KEY]) {
    renderLogs(changes[LOG_KEY].newValue || []);
  }
});

async function loadOptions() {
  const options = await chrome.storage.sync.get(DEFAULTS);

  minWidth.value = toMinimumDimension(options.minWidth);
  minHeight.value = toMinimumDimension(options.minHeight);
  folder.value = options.folder || DEFAULTS.folder;
  saveByDate.checked = options.saveByDate !== false;
  hideDownloadUi.checked = options.hideDownloadUi !== false;
  includeSrcset.checked = options.includeSrcset !== false;
  includeBackgrounds.checked = options.includeBackgrounds !== false;
  await loadLogs();
}

async function saveOptions(event) {
  event.preventDefault();

  await chrome.storage.sync.set({
    minWidth: toMinimumDimension(minWidth.value),
    minHeight: toMinimumDimension(minHeight.value),
    folder: sanitizeFolder(folder.value),
    saveByDate: saveByDate.checked,
    hideDownloadUi: hideDownloadUi.checked,
    includeSrcset: includeSrcset.checked,
    includeBackgrounds: includeBackgrounds.checked
  });

  saveStatus.textContent = "저장됨";
  setTimeout(() => {
    saveStatus.textContent = "";
  }, 1400);
}

function toMinimumDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(MIN_IMAGE_DIMENSION, Math.floor(number)) : MIN_IMAGE_DIMENSION;
}

function sanitizeFolder(value) {
  const clean = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/[<>:"|?*]+/g, "-");

  return clean || DEFAULTS.folder;
}

async function loadLogs() {
  const stored = await chrome.storage.local.get({ [LOG_KEY]: [] });
  renderLogs(stored[LOG_KEY]);
}

async function clearCollectorLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "CLEAR_LOGS" });
    if (response?.ok) {
      return;
    }
  } catch (_) {
    // Fall back to direct storage update below.
  }

  try {
    await chrome.storage.local.set({ [LOG_KEY]: [] });
  } catch (_) {
    renderLogs([]);
  }
}

function renderLogs(logs) {
  logList.replaceChildren();

  const entries = Array.isArray(logs) ? logs.slice().reverse() : [];
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "logEmpty";
    empty.textContent = "아직 로그가 없습니다.";
    logList.append(empty);
    return;
  }

  for (const entry of entries) {
    logList.append(createLogItem(entry));
  }
}

function createLogItem(entry) {
  const item = document.createElement("article");
  item.className = "logItem";

  const meta = document.createElement("div");
  meta.className = "logMeta";

  const level = document.createElement("span");
  const levelName = entry.level || "info";
  level.className = `logLevel ${levelName}`;
  level.textContent = levelName;

  const time = document.createElement("time");
  time.textContent = formatLogTime(entry.time);

  meta.append(level, time);

  const message = document.createElement("div");
  message.className = "logMessage";
  message.textContent = entry.message || "";

  item.append(meta, message);

  if (entry.details && Object.keys(entry.details).length > 0) {
    const details = document.createElement("pre");
    details.className = "logDetails";
    details.textContent = JSON.stringify(entry.details, null, 2);
    item.append(details);
  }

  return item;
}

function formatLogTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString("ko-KR", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}
