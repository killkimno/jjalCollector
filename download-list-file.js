const DAILY_DOWNLOADS_KEY = "dailyDownloads";

const summary = document.getElementById("summary");
const jsonOutput = document.getElementById("jsonOutput");
const copyJson = document.getElementById("copyJson");

let currentJson = "";

document.addEventListener("DOMContentLoaded", loadDownloadList);
copyJson.addEventListener("click", copyCurrentJson);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[DAILY_DOWNLOADS_KEY]) {
    renderDownloads(changes[DAILY_DOWNLOADS_KEY].newValue);
  }
});

async function loadDownloadList() {
  const stored = await chrome.storage.local.get(DAILY_DOWNLOADS_KEY);
  renderDownloads(stored[DAILY_DOWNLOADS_KEY]);
}

function renderDownloads(downloads) {
  const data = createDailyDownloadsExport(downloads);
  currentJson = JSON.stringify(data, null, 2);
  jsonOutput.textContent = currentJson;
  summary.textContent = `${data.date} 기준 ${data.count}개`;
}

async function copyCurrentJson() {
  try {
    await navigator.clipboard.writeText(currentJson);
    copyJson.textContent = "복사됨";
  } catch (_) {
    copyJson.textContent = "복사 실패";
  }

  setTimeout(() => {
    copyJson.textContent = "JSON 복사";
  }, 1200);
}

function createDailyDownloadsExport(downloads) {
  const today = getTodayKey();
  const items = downloads?.date === today && Array.isArray(downloads.items) ? downloads.items : [];

  return {
    date: downloads?.date === today ? downloads.date : today,
    count: items.length,
    items
  };
}

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
