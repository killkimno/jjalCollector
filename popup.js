let activeTabId = null;
let refreshTimer = null;

const activeToggle = document.getElementById("activeToggle");
const downloadedCount = document.getElementById("downloadedCount");
const skippedCount = document.getElementById("skippedCount");
const seenCount = document.getElementById("seenCount");
const statusText = document.getElementById("statusText");
const pageHost = document.getElementById("pageHost");
const resetButton = document.getElementById("resetButton");
const optionsButton = document.getElementById("optionsButton");

document.addEventListener("DOMContentLoaded", init);

activeToggle.addEventListener("change", async () => {
  if (activeTabId === null) {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "SET_TAB_ACTIVE",
    tabId: activeTabId,
    active: activeToggle.checked
  });

  if (!response?.ok) {
    activeToggle.checked = false;
    statusText.textContent = response?.error || "이 페이지에서는 실행할 수 없습니다.";
    return;
  }

  renderState(response.state);
});

resetButton.addEventListener("click", async () => {
  if (activeTabId === null) {
    return;
  }

  const state = await chrome.runtime.sendMessage({
    type: "RESET_TAB_STATS",
    tabId: activeTabId
  });
  renderState(state);
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function init() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    statusText.textContent = "현재 탭을 찾을 수 없습니다.";
    return;
  }

  activeTabId = tab.id;
  pageHost.textContent = getHostLabel(tab.url);
  await refreshState();

  refreshTimer = setInterval(refreshState, 1000);
}

async function refreshState() {
  if (activeTabId === null) {
    return;
  }

  const state = await chrome.runtime.sendMessage({
    type: "GET_TAB_STATUS",
    tabId: activeTabId
  });
  renderState(state);
}

function renderState(state) {
  if (!state) {
    return;
  }

  activeToggle.checked = state.active;
  downloadedCount.textContent = state.downloaded;
  skippedCount.textContent = state.skipped;
  seenCount.textContent = state.seen;

  if (state.active) {
    statusText.textContent = state.queued > 0 ? `${state.queued}개 처리 중` : "전체 수집 중";
  } else if (state.stopReason) {
    statusText.textContent = state.stopReason;
  } else {
    statusText.textContent = "대기 중";
  }
}

function getHostLabel(url) {
  try {
    return new URL(url).host || "현재 탭";
  } catch (_) {
    return "현재 탭";
  }
}

window.addEventListener("unload", () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
});
