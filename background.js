const DEFAULT_OPTIONS = {
  minWidth: 480,
  minHeight: 480,
  folder: "jjal-collector",
  includeBackgrounds: true,
  includeSrcset: true,
  hideDownloadUi: true,
  saveByDate: true
};

const MIN_IMAGE_DIMENSION = 480;
const MIN_DELAY_MS = 100;
const MAX_DELAY_MS = 1500;
const ICON_SIZES = [16, 32, 48, 128];
const CONSECUTIVE_FAILURE_LIMIT = 3;
const HOST_PAUSE_MS = 10 * 60 * 1000;
const UPDATE_REPOSITORY = "killkimno/jjalCollector";
const UPDATE_RELEASE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_ALARM_NAME = "checkLatestRelease";

const DEFAULT_RUNTIME = {
  collectorActive: false
};

const DAILY_STATS_KEY = "dailyStats";
const DAILY_DOWNLOADS_KEY = "dailyDownloads";
const DAILY_DOWNLOADS_FILENAME = "download-list.json";
const LOG_KEY = "collectorLogs";
const UPDATE_STATUS_KEY = "updateStatus";
const MAX_LOG_ENTRIES = 200;

const tabStates = new Map();
const pausedHosts = new Map();
let lastActiveWebTabId = null;
let dailyStatsWriteQueue = Promise.resolve();
let dailyDownloadsWriteQueue = Promise.resolve();
let logWriteQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(Object.keys(DEFAULT_OPTIONS));
  const next = {};

  for (const [key, value] of Object.entries(DEFAULT_OPTIONS)) {
    if (existing[key] === undefined) {
      next[key] = value;
    }
  }

  if (Object.keys(next).length > 0) {
    await chrome.storage.sync.set(next);
  }
  await chrome.storage.sync.remove(["minBytes", "maxBytes"]);

  const runtime = await chrome.storage.local.get(DEFAULT_RUNTIME);
  if (runtime.collectorActive === undefined) {
    await chrome.storage.local.set(DEFAULT_RUNTIME);
  }

  await syncActionIcon();
  await setDownloadUiVisible(true);
  scheduleUpdateCheck();
  checkForUpdate({ force: true }).catch((error) => {
    console.warn("Jjal Collector could not check updates:", error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  syncDownloadUiVisibility();
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await getTabById(activeInfo.tabId);
  await syncActiveTabCollection(tab?.id || null, {
    preserveLastWebTab: isOwnExtensionUrl(tab?.url)
  });
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) {
    syncActiveTabCollection();
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    syncActiveTabCollection();
  }
});

chrome.runtime.onStartup.addListener(() => {
  syncActionIcon();
  syncDownloadUiVisibility();
  syncActiveTabCollection();
  scheduleUpdateCheck();
  checkForUpdate({ force: false }).catch((error) => {
    console.warn("Jjal Collector could not check updates:", error);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== UPDATE_ALARM_NAME) {
    return;
  }

  checkForUpdate({ force: false }).catch((error) => {
    console.warn("Jjal Collector could not check updates:", error);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync") {
    if (changes.hideDownloadUi) {
      syncDownloadUiVisibility();
    }

    if (changes.includeBackgrounds || changes.includeSrcset) {
      syncActiveTabCollection();
    }
  }

  if (areaName === "local") {
    if (changes.collectorActive || changes[UPDATE_STATUS_KEY]) {
      syncActionIcon();
    }

    if (changes.collectorActive) {
      syncDownloadUiVisibility();
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SCAN_SUMMARY") {
    addLog("info", "페이지 스캔 완료", {
      pageUrl: sender.tab?.url || "",
      images: toNonNegativeNumber(message.images),
      srcset: toNonNegativeNumber(message.srcset),
      backgrounds: toNonNegativeNumber(message.backgrounds)
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "IMAGE_CANDIDATES") {
    const tabId = sender.tab?.id;
    handleImageCandidates(tabId, message.candidates || [], sender.tab?.url || "")
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CONTENT_READY") {
    const tabId = sender.tab?.id;
    handleContentReady(tabId, sender.tab?.url)
      .then((response) => sendResponse(response))
      .catch(() => sendResponse({ active: false }));
    return true;
  }

  if (message?.type === "GET_TAB_STATUS") {
    getPublicState(message.tabId)
      .then((state) => sendResponse(state))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message?.type === "SET_TAB_ACTIVE") {
    setCollectorActive(message.tabId, Boolean(message.active))
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "RESET_TAB_STATS") {
    resetDailyStats(message.tabId)
      .then(() => getPublicState(message.tabId))
      .then((state) => sendResponse(state))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message?.type === "CLEAR_LOGS") {
    clearLogs()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_UPDATE_STATUS") {
    checkForUpdate({ force: Boolean(message.force) })
      .then((status) => sendResponse(status))
      .catch((error) => sendResponse(createUpdateStatus({
        error: error?.message || String(error)
      })));
    return true;
  }

  return false;
});

function getState(tabId) {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      active: false,
      pageUrl: "",
      queued: 0,
      processing: false,
      failureHost: "",
      failureStreak: 0,
      stopReason: "",
      seen: new Set(),
      queue: []
    });
  }

  return tabStates.get(tabId);
}

async function getPublicState(tabId) {
  const state = getState(tabId);
  const stats = await getDailyStats();
  const collectorActive = await isCollectorActive();
  return {
    active: collectorActive,
    collecting: state.active,
    downloaded: stats.downloaded,
    skipped: stats.skipped,
    errors: stats.errors,
    queued: state.queue.length,
    seen: stats.seen,
    stopReason: state.stopReason
  };
}

async function setCollectorActive(sourceTabId, active) {
  await chrome.storage.local.set({ collectorActive: active });
  addLog("info", active ? "수집 켜짐" : "수집 꺼짐", { tabId: sourceTabId });

  if (active) {
    getState(sourceTabId).stopReason = "";
    await syncActiveTabCollection(sourceTabId);
    await syncDownloadUiVisibility();
    return getPublicState(sourceTabId);
  }

  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id) {
      return;
    }

    const state = getState(tab.id);
    state.active = false;
    state.queue = [];
    state.queued = 0;
    state.stopReason = "";
    resetFailureState(state);

    await sendCollectorStateToTab(tab, false, null);

    await updateBadge(tab.id);
  }));

  await syncDownloadUiVisibility();
  return getPublicState(sourceTabId);
}

function resetTabStats(tabId) {
  const state = getState(tabId);
  state.queued = 0;
  state.queue = [];
  state.seen = new Set();
  state.stopReason = "";
  resetFailureState(state);
}

async function resetDailyStats(tabId) {
  dailyStatsWriteQueue = dailyStatsWriteQueue.then(() => saveDailyStats(createEmptyDailyStats()));
  dailyDownloadsWriteQueue = dailyDownloadsWriteQueue.then(async () => {
    const downloads = createEmptyDailyDownloads();
    await saveDailyDownloads(downloads);
    await tryExportDailyDownloads(downloads, await getOptions());
  });
  await dailyStatsWriteQueue;
  await dailyDownloadsWriteQueue;
  resetTabStats(tabId);
}

async function getDailyStats() {
  await dailyStatsWriteQueue.catch(() => {});
  return getDailyStatsRaw();
}

async function getDailyStatsRaw() {
  const today = getTodayKey();
  const stored = await chrome.storage.local.get(DAILY_STATS_KEY);
  const stats = stored[DAILY_STATS_KEY];

  if (!stats || stats.date !== today) {
    const next = createEmptyDailyStats();
    await saveDailyStats(next);
    return next;
  }

  return {
    ...createEmptyDailyStats(),
    ...stats,
    date: today
  };
}

function addDailyStat(field, amount = 1) {
  dailyStatsWriteQueue = dailyStatsWriteQueue
    .then(async () => {
      const stats = await getDailyStatsRaw();
      stats[field] = toNonNegativeNumber(stats[field]) + amount;
      await saveDailyStats(stats);
    })
    .catch((error) => {
      console.warn("Jjal Collector could not update daily stats:", error);
    });

  return dailyStatsWriteQueue;
}

async function saveDailyStats(stats) {
  await chrome.storage.local.set({
    [DAILY_STATS_KEY]: stats
  });
}

function createEmptyDailyStats() {
  return {
    date: getTodayKey(),
    downloaded: 0,
    skipped: 0,
    errors: 0,
    seen: 0
  };
}

async function getDailyDownloads() {
  await dailyDownloadsWriteQueue.catch(() => {});
  return getDailyDownloadsRaw();
}

async function getDailyDownloadsRaw() {
  const today = getTodayKey();
  const stored = await chrome.storage.local.get(DAILY_DOWNLOADS_KEY);
  const downloads = stored[DAILY_DOWNLOADS_KEY];

  if (!downloads || downloads.date !== today) {
    const next = createEmptyDailyDownloads();
    await saveDailyDownloads(next);
    return next;
  }

  return {
    ...createEmptyDailyDownloads(),
    ...downloads,
    date: today,
    filenames: downloads.filenames || {},
    urls: downloads.urls || {},
    items: Array.isArray(downloads.items) ? downloads.items : []
  };
}

async function hasDownloadedToday(imageUrl) {
  const downloads = await getDailyDownloads();
  return Boolean(downloads.urls[imageUrl]);
}

function addDailyDownload(originalName, savedName, siteUrl, imageUrl, options) {
  dailyDownloadsWriteQueue = dailyDownloadsWriteQueue
    .then(async () => {
      const downloads = await getDailyDownloadsRaw();
      if (downloads.urls[imageUrl]) {
        return;
      }

      downloads.filenames[originalName] = true;
      downloads.urls[imageUrl] = true;
      downloads.items.push({
        filename: originalName,
        savedName,
        siteUrl,
        imageUrl,
        savedAt: new Date().toISOString()
      });
      await saveDailyDownloads(downloads);
      await tryExportDailyDownloads(downloads, options);
    })
    .catch((error) => {
      console.warn("Jjal Collector could not update daily download list:", error);
    });

  return dailyDownloadsWriteQueue;
}

async function saveDailyDownloads(downloads) {
  await chrome.storage.local.set({
    [DAILY_DOWNLOADS_KEY]: downloads
  });
}

function addLog(level, message, details = {}) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: new Date().toISOString(),
    level,
    message,
    details
  };

  logWriteQueue = logWriteQueue
    .then(async () => {
      const stored = await chrome.storage.local.get({ [LOG_KEY]: [] });
      const logs = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
      logs.push(entry);
      await chrome.storage.local.set({
        [LOG_KEY]: logs.slice(-MAX_LOG_ENTRIES)
      });
    })
    .catch((error) => {
      console.warn("Jjal Collector could not write log:", error);
    });

  return logWriteQueue;
}

async function clearLogs() {
  logWriteQueue = logWriteQueue.then(() => chrome.storage.local.set({ [LOG_KEY]: [] }));
  return logWriteQueue;
}

function scheduleUpdateCheck() {
  chrome.alarms.create(UPDATE_ALARM_NAME, {
    periodInMinutes: UPDATE_CHECK_INTERVAL_MS / 60000
  });
}

async function checkForUpdate({ force = false } = {}) {
  const stored = await getStoredUpdateStatus();
  const now = Date.now();
  const currentVersion = chrome.runtime.getManifest().version;

  if (
    !force &&
    stored.checkedAt &&
    stored.currentVersion === currentVersion &&
    now - stored.checkedAt < UPDATE_CHECK_INTERVAL_MS
  ) {
    return stored;
  }

  try {
    const response = await fetch(UPDATE_RELEASE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json"
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub release check failed: ${response.status}`);
    }

    const release = await response.json();
    const tagVersion = normalizeVersion(release.tag_name || release.name || "");
    const latestVersion = tagVersion || "";
    const available = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;
    const status = createUpdateStatus({
      checkedAt: now,
      currentVersion,
      latestVersion,
      available,
      releaseUrl: release.html_url || UPDATE_RELEASES_URL,
      releaseName: release.name || release.tag_name || "",
      publishedAt: release.published_at || "",
      error: ""
    });

    await chrome.storage.local.set({ [UPDATE_STATUS_KEY]: status });
    return status;
  } catch (error) {
    const latestVersion = stored.latestVersion || "";
    const status = createUpdateStatus({
      ...stored,
      checkedAt: now,
      currentVersion,
      available: latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false,
      error: error?.message || String(error)
    });
    await chrome.storage.local.set({ [UPDATE_STATUS_KEY]: status });
    return status;
  }
}

async function getStoredUpdateStatus() {
  const currentVersion = chrome.runtime.getManifest().version;
  const stored = await chrome.storage.local.get({
    [UPDATE_STATUS_KEY]: createUpdateStatus({ currentVersion })
  });
  return createUpdateStatus({
    ...stored[UPDATE_STATUS_KEY],
    currentVersion: stored[UPDATE_STATUS_KEY]?.currentVersion || currentVersion
  });
}

function createUpdateStatus(status = {}) {
  return {
    checkedAt: toNonNegativeNumber(status.checkedAt),
    currentVersion: status.currentVersion || chrome.runtime.getManifest().version,
    latestVersion: status.latestVersion || "",
    available: status.available === true,
    releaseUrl: status.releaseUrl || "",
    releaseName: status.releaseName || "",
    publishedAt: status.publishedAt || "",
    error: status.error || ""
  };
}

function normalizeVersion(value) {
  const match = String(value).trim().match(/^v?(\d+(?:\.\d+){0,3})(?:[-+].*)?$/i);
  return match ? match[1] : "";
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split(".").map((part) => Number(part));
  const rightParts = normalizeVersion(right).split(".").map((part) => Number(part));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const rightPart = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;

    if (leftPart > rightPart) {
      return 1;
    }

    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}

async function exportDailyDownloads(downloads, options) {
  const filename = buildDailyDownloadsFilename(options.folder);
  const body = JSON.stringify(createDailyDownloadsExport(downloads), null, 2);
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(body)}`;

  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: "overwrite",
    saveAs: false
  });
  await waitForDownloadComplete(downloadId);
  await eraseDownloadHistory(downloadId);
}

async function tryExportDailyDownloads(downloads, options) {
  try {
    await exportDailyDownloads(downloads, options);
  } catch (error) {
    console.warn("Jjal Collector could not write daily download list file:", error);
  }
}

function createDailyDownloadsExport(downloads) {
  const items = Array.isArray(downloads.items) ? downloads.items : [];
  return {
    date: downloads.date || getTodayKey(),
    count: items.length,
    items
  };
}

function countCandidateSources(candidates) {
  return candidates.reduce((counts, candidate) => {
    const source = candidate?.source || "unknown";
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, {});
}

function createEmptyDailyDownloads() {
  return {
    date: getTodayKey(),
    filenames: {},
    urls: {},
    items: []
  };
}

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function pauseHostForFailure(tabId, host, reason) {
  const state = getState(tabId);
  pausedHosts.set(host, {
    expiresAt: Date.now() + HOST_PAUSE_MS,
    reason
  });

  state.active = false;
  state.queue = state.queue.filter((candidate) => getCandidateHost(candidate) !== host);
  state.queued = state.queue.length;
  state.stopReason = reason;
  resetFailureState(state);

  await syncActiveTabCollection();
  state.stopReason = reason;
  await updateBadge(tabId);
}

async function handleContentReady(tabId, pageUrl) {
  const collectorActive = await isCollectorActive();
  if (tabId === undefined) {
    addLog("warn", "콘텐츠 준비 메시지에 탭 ID가 없습니다.", { pageUrl });
    return { active: false };
  }

  const state = getState(tabId);
  if (state.pageUrl !== pageUrl) {
    resetTabStats(tabId);
    state.pageUrl = pageUrl || "";
  }

  const pausedReason = getPausedHostReason(getUrlHost(pageUrl));
  state.active = collectorActive && isWebUrl(pageUrl) && !pausedReason && await isFocusedActiveTab(tabId);
  state.stopReason = pausedReason;
  await updateBadge(tabId);
  await syncDownloadUiVisibility();
  addLog("info", "콘텐츠 준비", {
    pageUrl,
    active: state.active,
    stopReason: state.stopReason || ""
  });

  return {
    active: state.active,
    scanOptions: state.active ? getContentScanOptions(await getOptions()) : null
  };
}

async function handleImageCandidates(tabId, candidates, pageUrl) {
  if (tabId === undefined || !(await isCollectorActive()) || !(await isFocusedActiveTab(tabId))) {
    addLog("info", "후보 무시", {
      pageUrl,
      count: candidates.length,
      reason: tabId === undefined ? "탭 ID 없음" : "수집 꺼짐 또는 비활성 탭"
    });
    if (tabId !== undefined) {
      const state = getState(tabId);
      state.active = false;
      state.queue = [];
      state.queued = 0;
      await updateBadge(tabId);
    }
    return;
  }

  const tab = await chrome.tabs.get(tabId);
  const pausedReason = getPausedHostReason(getUrlHost(tab.url));
  if (pausedReason) {
    const state = getState(tabId);
    state.active = false;
    state.queue = [];
    state.queued = 0;
    state.stopReason = pausedReason;
    await updateBadge(tabId);
    addLog("warn", "일시 중단된 호스트라 후보를 무시했습니다.", {
      pageUrl,
      count: candidates.length,
      reason: pausedReason
    });
    return;
  }

  addLog("info", "이미지 후보 수신", {
    pageUrl,
    count: candidates.length,
    sources: countCandidateSources(candidates)
  });
  await enqueueCandidates(tabId, candidates, pageUrl);
}

async function enqueueCandidates(tabId, candidates, pageUrl) {
  const state = getState(tabId);
  if (!state.active) {
    return;
  }

  const dailyDownloads = await getDailyDownloads();
  let seenAdded = 0;
  const skipped = {
    invalid: 0,
    duplicateInPage: 0,
    undersized: 0,
    pausedHost: 0,
    downloadedToday: 0
  };
  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate, pageUrl);
    const key = normalized ? getCandidateKey(normalized) : "";
    if (!normalized) {
      skipped.invalid += 1;
      continue;
    }

    if (state.seen.has(key)) {
      skipped.duplicateInPage += 1;
      continue;
    }

    if (isUndersizedCandidate(normalized)) {
      skipped.undersized += 1;
      continue;
    }

    if (isHostPaused(getCandidateHost(normalized))) {
      skipped.pausedHost += 1;
      continue;
    }

    if (dailyDownloads.urls[normalized.url]) {
      skipped.downloadedToday += 1;
      continue;
    }

    state.seen.add(key);
    seenAdded += 1;
    state.queue.push(normalized);
  }

  if (seenAdded > 0) {
    await addDailyStat("seen", seenAdded);
  }

  addLog(seenAdded > 0 ? "info" : "warn", "후보 큐 반영", {
    pageUrl,
    received: candidates.length,
    queued: seenAdded,
    queueTotal: state.queue.length,
    skipped
  });

  runQueue(tabId);
}

async function runQueue(tabId) {
  const state = getState(tabId);
  if (state.processing) {
    return;
  }

  state.processing = true;
  try {
    while (state.active && state.queue.length > 0) {
      if (!(await isCollectorActive())) {
        state.active = false;
        state.queue = [];
        state.queued = 0;
        break;
      }

      if (!(await isFocusedActiveTab(tabId))) {
        state.active = false;
        state.queue = [];
        state.queued = 0;
        break;
      }

      const candidate = state.queue.shift();
      state.queued = state.queue.length;

      const pausedReason = getPausedHostReason(getCandidateHost(candidate));
      if (pausedReason) {
        state.stopReason = pausedReason;
        state.queue = state.queue.filter((queuedCandidate) => getCandidateHost(queuedCandidate) !== getCandidateHost(candidate));
        state.queued = state.queue.length;
        continue;
      }

      try {
        const options = await getOptions();
        const result = await collectCandidate(candidate, options);
        if (result === "downloaded") {
          await addDailyStat("downloaded");
          state.stopReason = "";
          resetFailureState(state);
        } else {
          await addDailyStat("skipped");
          addLog("info", "이미지 스킵", {
            url: candidate.url,
            reason: result
          });
        }
      } catch (error) {
        console.warn("Jjal Collector failed:", candidate.url, error);
        addLog("error", "이미지 처리 실패", {
          url: candidate.url,
          error: error?.message || String(error)
        });
        await addDailyStat("errors");
        if (await shouldStopAfterFailure(tabId, candidate, error)) {
          break;
        }
      }

      await updateBadge(tabId);
    }
  } finally {
    state.processing = false;
    state.queued = state.queue.length;
    await updateBadge(tabId);
  }
}

async function shouldStopAfterFailure(tabId, candidate, error) {
  const state = getState(tabId);
  const host = getCandidateHost(candidate);
  if (!host) {
    return false;
  }

  if (state.failureHost === host) {
    state.failureStreak += 1;
  } else {
    state.failureHost = host;
    state.failureStreak = 1;
  }

  if (state.failureStreak < CONSECUTIVE_FAILURE_LIMIT) {
    return false;
  }

  const reason = `${host} 다운로드 실패가 ${state.failureStreak}회 연속 발생해 10분 동안 이 사이트 수집을 중단합니다.`;
  console.warn("Jjal Collector paused host:", reason, error);
  await pauseHostForFailure(tabId, host, reason);
  return true;
}

function resetFailureState(state) {
  state.failureHost = "";
  state.failureStreak = 0;
}

async function getOptions() {
  const stored = await chrome.storage.sync.get(DEFAULT_OPTIONS);
  return {
    minWidth: toMinimumDimension(stored.minWidth),
    minHeight: toMinimumDimension(stored.minHeight),
    folder: sanitizeFolder(stored.folder || DEFAULT_OPTIONS.folder),
    includeBackgrounds: stored.includeBackgrounds !== false,
    includeSrcset: stored.includeSrcset !== false,
    hideDownloadUi: stored.hideDownloadUi !== false,
    saveByDate: stored.saveByDate !== false
  };
}

async function syncActiveTabCollection(preferredActiveTabId = null, options = {}) {
  const collectorActive = await isCollectorActive();
  let activeTab = collectorActive ? await getFocusedActiveTab(preferredActiveTabId) : null;

  if (
    collectorActive &&
    (!activeTab || isOwnExtensionUrl(activeTab.url) || (options.preserveLastWebTab && !isWebUrl(activeTab.url)))
  ) {
    activeTab = await getTabById(lastActiveWebTabId);
  }

  if (collectorActive && activeTab?.id && isWebUrl(activeTab.url)) {
    lastActiveWebTabId = activeTab.id;
  }

  const activeTabId = activeTab?.id;
  const scanOptions = collectorActive ? getContentScanOptions(await getOptions()) : null;
  const tabs = await chrome.tabs.query({});

  if (collectorActive) {
    addLog(activeTabId ? "info" : "warn", "활성 탭 동기화", {
      preferredActiveTabId,
      preserveLastWebTab: Boolean(options.preserveLastWebTab),
      activeTabId: activeTabId || null,
      activeTabUrl: activeTab?.url || ""
    });
  }

  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id) {
      return;
    }

    const pausedReason = getPausedHostReason(getUrlHost(tab.url));
    const shouldRun = collectorActive && tab.id === activeTabId && isWebUrl(tab.url) && !pausedReason;
    const state = getState(tab.id);
    state.active = shouldRun;
    state.stopReason = pausedReason;

    if (!shouldRun) {
      if (pausedReason) {
        const pausedHost = getUrlHost(tab.url);
        state.queue = state.queue.filter((candidate) => getCandidateHost(candidate) !== pausedHost);
        state.queued = state.queue.length;
      } else {
        state.queue = [];
        state.queued = 0;
      }
    }

    await sendCollectorStateToTab(tab, shouldRun, shouldRun ? scanOptions : null);

    await updateBadge(tab.id);
  }));
}

async function sendCollectorStateToTab(tab, active, scanOptions) {
  if (!tab.id) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "COLLECTOR_ACTIVE_CHANGED",
      active,
      scanOptions
    });
    return;
  } catch (error) {
    if (!active || !isWebUrl(tab.url) || !isMissingContentScriptError(error)) {
      return;
    }
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (error) {
    console.warn("Jjal Collector could not inject content script:", tab.url, error);
  }
}

async function collectCandidate(candidate, options) {
  if (candidate.source === "background" && !options.includeBackgrounds) {
    return "background-disabled";
  }

  if (candidate.source === "srcset" && !options.includeSrcset) {
    return "srcset-disabled";
  }

  if (candidate.width < options.minWidth) {
    return "min-width";
  }

  if (candidate.height < options.minHeight) {
    return "min-height";
  }

  const originalName = getOriginalFilename(candidate.url);
  if (await hasDownloadedToday(candidate.url)) {
    return "downloaded-today";
  }

  const filename = buildFilename(options.folder, originalName, options.saveByDate);
  addLog("info", "다운로드 시작", {
    url: candidate.url,
    filename,
    width: candidate.width,
    height: candidate.height,
    source: candidate.source
  });
  const downloadId = await chrome.downloads.download({
    url: candidate.url,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });
  await waitForDownloadComplete(downloadId);
  await eraseDownloadHistory(downloadId);
  await addDailyDownload(originalName, filename, candidate.pageUrl || candidate.url, candidate.url, options);
  addLog("info", "다운로드 완료", {
    url: candidate.url,
    filename
  });
  await sleep(randomDelayMs());

  return "downloaded";
}

function waitForDownloadComplete(downloadId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      reject(new Error("Download timed out"));
    }, 120000);

    const listener = (delta) => {
      if (delta.id !== downloadId || !delta.state?.current) {
        return;
      }

      if (delta.state.current === "complete") {
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      }

      if (delta.state.current === "interrupted") {
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error(`Download interrupted${delta.error?.current ? `: ${delta.error.current}` : ""}`));
      }
    };

    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id: downloadId })
      .then((items) => {
        const item = items[0];
        if (!item) {
          return;
        }

        if (item.state === "complete") {
          clearTimeout(timeout);
          chrome.downloads.onChanged.removeListener(listener);
          resolve();
        }

        if (item.state === "interrupted") {
          clearTimeout(timeout);
          chrome.downloads.onChanged.removeListener(listener);
          reject(new Error(`Download interrupted${item.error ? `: ${item.error}` : ""}`));
        }
      })
      .catch((error) => {
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(listener);
        reject(error);
      });
  });
}

async function eraseDownloadHistory(downloadId) {
  try {
    await chrome.downloads.erase({ id: downloadId });
  } catch (error) {
    console.warn("Jjal Collector could not erase download history:", error);
  }
}

function normalizeCandidate(candidate, pageUrl = "") {
  if (!candidate?.url || typeof candidate.url !== "string") {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(candidate.url);
  } catch (_) {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  return {
    url: parsed.href,
    pageUrl,
    width: toNonNegativeNumber(candidate.width),
    height: toNonNegativeNumber(candidate.height),
    source: candidate.source || "image"
  };
}

function getCandidateKey(candidate) {
  return candidate.url;
}

function getCandidateHost(candidate) {
  try {
    return new URL(candidate.url).host;
  } catch (_) {
    return "";
  }
}

function getUrlHost(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return "";
  }
}

function getPausedHostReason(host) {
  if (!host) {
    return "";
  }

  const paused = pausedHosts.get(host);
  if (!paused) {
    return "";
  }

  if (paused.expiresAt <= Date.now()) {
    pausedHosts.delete(host);
    return "";
  }

  return paused.reason;
}

function isHostPaused(host) {
  return Boolean(getPausedHostReason(host));
}

function isUndersizedCandidate(candidate) {
  return candidate.width < MIN_IMAGE_DIMENSION || candidate.height < MIN_IMAGE_DIMENSION;
}

function getOriginalFilename(url) {
  const parsed = new URL(url);
  const pathName = parsed.pathname.split("/").filter(Boolean).pop() || "image";
  const cleanName = pathName
    .replace(/%[0-9a-f]{2}/gi, "_")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .slice(0, 120);
  const hasExtension = /\.[a-z0-9]{2,5}$/i.test(cleanName);
  const finalName = hasExtension ? cleanName : `${cleanName}.jpg`;

  return finalName;
}

function buildFilename(folder, originalName, saveByDate) {
  const dateFolder = saveByDate ? `${getTodayFolderName()}/` : "";
  return `${folder}/${dateFolder}${Date.now()}-${originalName}`;
}

function buildDailyDownloadsFilename(folder) {
  return `${folder}/${DAILY_DOWNLOADS_FILENAME}`;
}

function getTodayFolderName() {
  return getTodayKey().replace(/-/g, "");
}

function sanitizeFolder(folder) {
  const clean = String(folder)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/[<>:"|?*]+/g, "-");

  return clean || DEFAULT_OPTIONS.folder;
}

function toNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function toMinimumDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(MIN_IMAGE_DIMENSION, Math.floor(number)) : MIN_IMAGE_DIMENSION;
}

function randomDelayMs() {
  return Math.floor(MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateBadge(tabId) {
  const state = getState(tabId);
  const stats = await getDailyStats();
  await chrome.action.setBadgeText({
    tabId,
    text: state.active ? String(stats.downloaded) : ""
  });
  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: state.active ? "#2563eb" : "#6b7280"
  });
}

async function syncActionIcon() {
  const active = await isCollectorActive();
  const updateStatus = await getStoredUpdateStatus();
  const hasUpdate = updateStatus.available === true;

  try {
    await chrome.action.setIcon({
      imageData: Object.fromEntries(ICON_SIZES.map((size) => [
        size,
        createActionIcon(size, active, hasUpdate)
      ]))
    });
    await chrome.action.setTitle({
      title: getActionTitle(active, updateStatus)
    });
  } catch (error) {
    console.warn("Jjal Collector could not update action icon:", error);
  }
}

function getActionTitle(active, updateStatus) {
  const stateText = active ? "짤 콜렉터 켜짐" : "짤 콜렉터 꺼짐";
  if (updateStatus.available && updateStatus.latestVersion) {
    return `${stateText} - 새 버전 v${updateStatus.latestVersion}`;
  }

  return stateText;
}

function createActionIcon(size, active, hasUpdate) {
  const data = new Uint8ClampedArray(size * size * 4);
  const background = active ? [37, 99, 235, 255] : [148, 163, 184, 255];
  const foreground = [255, 255, 255, 255];
  const radius = size * 0.22;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (isInsideRoundedSquare(x, y, size, radius)) {
        setPixel(data, size, x, y, background);
      }
    }
  }

  if (active) {
    drawCheckMark(data, size, foreground);
  } else {
    drawPauseMark(data, size, foreground);
  }

  if (hasUpdate) {
    drawUpdateMark(data, size);
  }

  return new ImageData(data, size, size);
}

function isInsideRoundedSquare(x, y, size, radius) {
  const min = radius;
  const max = size - radius - 1;
  const cx = Math.min(Math.max(x, min), max);
  const cy = Math.min(Math.max(y, min), max);
  return Math.hypot(x - cx, y - cy) <= radius;
}

function drawCheckMark(data, size, color) {
  const stroke = Math.max(2, Math.round(size * 0.16));
  drawLine(data, size, size * 0.25, size * 0.54, size * 0.43, size * 0.72, stroke, color);
  drawLine(data, size, size * 0.43, size * 0.72, size * 0.76, size * 0.32, stroke, color);
}

function drawPauseMark(data, size, color) {
  const width = Math.max(2, Math.round(size * 0.16));
  const top = Math.round(size * 0.28);
  const bottom = Math.round(size * 0.72);
  const leftA = Math.round(size * 0.32);
  const leftB = Math.round(size * 0.56);

  fillRect(data, size, leftA, top, leftA + width, bottom, color);
  fillRect(data, size, leftB, top, leftB + width, bottom, color);
}

function drawUpdateMark(data, size) {
  const alertColor = [239, 68, 68, 255];
  const foreground = [255, 255, 255, 255];
  const center = size * 0.76;
  const radius = Math.max(4, size * 0.22);
  fillCircle(data, size, center, size * 0.24, radius, alertColor);

  const lineWidth = Math.max(1, Math.round(size * 0.08));
  const top = Math.round(size * 0.12);
  const bottom = Math.round(size * 0.28);
  fillRect(data, size, Math.round(center - lineWidth / 2), top, Math.round(center + lineWidth / 2) + 1, bottom, foreground);
  fillCircle(data, size, center, size * 0.36, Math.max(1, size * 0.035), foreground);
}

function drawLine(data, size, x1, y1, x2, y2, stroke, color) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2);

  for (let index = 0; index <= steps; index += 1) {
    const t = steps === 0 ? 0 : index / steps;
    const x = Math.round(x1 + (x2 - x1) * t);
    const y = Math.round(y1 + (y2 - y1) * t);
    fillCircle(data, size, x, y, stroke / 2, color);
  }
}

function fillCircle(data, size, centerX, centerY, radius, color) {
  const minX = Math.max(0, Math.floor(centerX - radius));
  const maxX = Math.min(size - 1, Math.ceil(centerX + radius));
  const minY = Math.max(0, Math.floor(centerY - radius));
  const maxY = Math.min(size - 1, Math.ceil(centerY + radius));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (Math.hypot(x - centerX, y - centerY) <= radius) {
        setPixel(data, size, x, y, color);
      }
    }
  }
}

function fillRect(data, size, left, top, right, bottom, color) {
  for (let y = Math.max(0, top); y < Math.min(size, bottom); y += 1) {
    for (let x = Math.max(0, left); x < Math.min(size, right); x += 1) {
      setPixel(data, size, x, y, color);
    }
  }
}

function setPixel(data, size, x, y, color) {
  const offset = (y * size + x) * 4;
  data[offset] = color[0];
  data[offset + 1] = color[1];
  data[offset + 2] = color[2];
  data[offset + 3] = color[3];
}

function getContentScanOptions(options) {
  return {
    includeBackgrounds: options.includeBackgrounds,
    includeSrcset: options.includeSrcset
  };
}

async function syncDownloadUiVisibility() {
  const options = await getOptions();
  const shouldHide = options.hideDownloadUi && await isCollectorActive();
  await setDownloadUiVisible(!shouldHide);
}

async function setDownloadUiVisible(enabled) {
  if (!chrome.downloads.setUiOptions) {
    return;
  }

  try {
    await chrome.downloads.setUiOptions({ enabled });
  } catch (error) {
    console.warn("Jjal Collector could not change download UI:", error);
  }
}

async function isCollectorActive() {
  const runtime = await chrome.storage.local.get(DEFAULT_RUNTIME);
  return runtime.collectorActive === true;
}

async function isFocusedActiveTab(tabId) {
  const activeTab = await getFocusedActiveTab();
  if (activeTab?.id === tabId) {
    return true;
  }

  return isOwnExtensionUrl(activeTab?.url) && lastActiveWebTabId === tabId;
}

async function getTabById(tabId) {
  if (tabId === null || tabId === undefined) {
    return null;
  }

  try {
    return await chrome.tabs.get(tabId);
  } catch (_) {
    return null;
  }
}

async function getFocusedActiveTab(preferredTabId = null) {
  if (preferredTabId !== null && preferredTabId !== undefined) {
    try {
      const preferredTab = await chrome.tabs.get(preferredTabId);
      if (preferredTab?.id && isWebUrl(preferredTab.url)) {
        return preferredTab;
      }
    } catch (_) {
      // Fall through to the browser-focused tab lookup.
    }
  }

  try {
    const lastFocusedTabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });

    if (lastFocusedTabs[0]?.id) {
      return lastFocusedTabs[0];
    }
  } catch (_) {
    // Fall through to normal-window lookup.
  }

  try {
    const windows = await chrome.windows.getAll({
      populate: true,
      windowTypes: ["normal"]
    });
    const focusedWindow = windows.find((window) => window.focused) || windows[0];
    return focusedWindow?.tabs?.find((tab) => tab.active) || null;
  } catch (_) {
    return null;
  }
}

function isWebUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function isOwnExtensionUrl(url) {
  return typeof url === "string" && url.startsWith(chrome.runtime.getURL(""));
}

function isMissingContentScriptError(error) {
  const message = error?.message || "";
  return message.includes("Receiving end does not exist");
}
