const DAILY_DOWNLOADS_KEY = "dailyDownloads";

const summary = document.getElementById("summary");
const downloadRows = document.getElementById("downloadRows");
const emptyState = document.getElementById("emptyState");

document.addEventListener("DOMContentLoaded", loadDownloadList);
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
  const today = getTodayKey();
  const items = downloads?.date === today && Array.isArray(downloads.items) ? downloads.items : [];
  downloadRows.replaceChildren();
  emptyState.hidden = items.length > 0;
  summary.textContent = `${downloads?.date === today ? downloads.date : today} 기준 ${items.length}개`;

  for (const item of items.slice().reverse()) {
    downloadRows.append(createDownloadRow(item));
  }
}

function createDownloadRow(item) {
  const row = document.createElement("tr");
  row.append(
    createTextCell(formatDateTime(item.savedAt)),
    createTextCell(item.filename || ""),
    createTextCell(item.savedName || ""),
    createLinkCell(item.siteUrl || ""),
    createLinkCell(item.imageUrl || "")
  );
  return row;
}

function createTextCell(text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

function createLinkCell(url) {
  const cell = document.createElement("td");
  if (!url) {
    return cell;
  }

  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = url;
  cell.append(link);
  return cell;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString("ko-KR", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
