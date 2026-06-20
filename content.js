let collectorActive = false;
let mutationObserver = null;
let scanTimer = null;
let scanInProgress = false;
let scanOptions = {
  includeBackgrounds: true,
  includeSrcset: true
};
const MIN_INITIAL_DELAY_MS = 500;
const MAX_INITIAL_DELAY_MS = 1000;
const MAX_SRCSET_SAMPLES = 300;
const MAX_BACKGROUND_SAMPLES = 300;
const DIMENSION_BATCH_SIZE = 12;
const BACKGROUND_ELEMENT_BATCH_SIZE = 120;
const MIN_SCAN_BATCH_DELAY_MS = 500;
const MAX_SCAN_BATCH_DELAY_MS = 1000;

sendRuntimeMessage({ type: "CONTENT_READY" }, (response) => {
  if (!isRuntimeReady()) {
    handleInvalidContext();
    return;
  }

  const error = chrome.runtime.lastError;
  if (error) {
    handleRuntimeMessageError(error);
    return;
  }

  if (response?.active) {
    collectorActive = true;
    updateScanOptions(response.scanOptions);
    startCollector();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "COLLECTOR_ACTIVE_CHANGED") {
    collectorActive = Boolean(message.active);
    updateScanOptions(message.scanOptions);

    if (collectorActive) {
      startCollector();
    } else {
      stopCollector();
    }

    sendResponse({ ok: true });
    return false;
  }

  return false;
});

function startCollector() {
  queueScan(randomInitialDelayMs());

  if (!mutationObserver) {
    mutationObserver = new MutationObserver(scheduleScan);
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "style"]
    });
  }

  document.addEventListener("load", scheduleScan, true);
  window.addEventListener("scroll", scheduleScan, { passive: true });
  window.addEventListener("resize", scheduleScan);
}

function stopCollector() {
  collectorActive = false;

  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }

  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }

  document.removeEventListener("load", scheduleScan, true);
  window.removeEventListener("scroll", scheduleScan);
  window.removeEventListener("resize", scheduleScan);
}

function scheduleScan() {
  queueScan(600);
}

function queueScan(delay) {
  if (!collectorActive || scanTimer) {
    return;
  }

  scanTimer = setTimeout(() => {
    scanTimer = null;
    scanPage().catch(handleScanError);
  }, delay);
}

async function scanPage() {
  if (!collectorActive || scanInProgress) {
    return;
  }

  scanInProgress = true;
  try {
    const imageCandidates = [];
    collectImageElements(imageCandidates);
    sendCandidates(imageCandidates);

    if (scanOptions.includeSrcset) {
      const srcsetCandidates = [];
      await collectPictureSources(srcsetCandidates);
      sendCandidates(srcsetCandidates);
    }

    if (scanOptions.includeBackgrounds) {
      const backgroundCandidates = [];
      await collectBackgroundImages(backgroundCandidates);
      sendCandidates(backgroundCandidates);
    }
  } finally {
    scanInProgress = false;
  }
}

function sendCandidates(candidates) {
  if (!collectorActive || candidates.length === 0) {
    return;
  }

  sendRuntimeMessage({
    type: "IMAGE_CANDIDATES",
    candidates
  });
}

function collectImageElements(candidates) {
  for (const image of document.images) {
    if (!isVisibleInViewport(image)) {
      continue;
    }

    const url = image.currentSrc || image.src;
    pushCandidate(candidates, url, image.naturalWidth, image.naturalHeight, "image");
  }
}

async function collectPictureSources(candidates) {
  const sourceElements = document.querySelectorAll("source[srcset], img[srcset]");
  const visibleSources = new Map();

  for (const element of sourceElements) {
    const visibleElement = getVisibleSrcsetElement(element);
    if (!visibleElement) {
      continue;
    }

    const currentUrl = visibleElement.currentSrc || visibleElement.src;
    for (const item of parseSrcset(element.getAttribute("srcset"))) {
      const url = toAbsoluteUrl(item);
      if (url && toAbsoluteUrl(currentUrl) === url) {
        visibleSources.set(url, {
          width: visibleElement.naturalWidth,
          height: visibleElement.naturalHeight
        });
      }
    }
  }

  for (const [url, dimensions] of Array.from(visibleSources).slice(0, MAX_SRCSET_SAMPLES)) {
    pushCandidate(candidates, url, dimensions.width, dimensions.height, "srcset");
  }
}

async function collectBackgroundImages(candidates) {
  const elements = Array.from(document.querySelectorAll("*"));
  const urls = new Set();

  for (let index = 0; index < elements.length && collectorActive; index += BACKGROUND_ELEMENT_BATCH_SIZE) {
    const batch = elements.slice(index, index + BACKGROUND_ELEMENT_BATCH_SIZE);

    for (const element of batch) {
      if (!isVisibleInViewport(element)) {
        continue;
      }

      const background = getComputedStyle(element).backgroundImage;
      for (const url of extractCssUrls(background)) {
        urls.add(url);
      }
    }

    if (index + BACKGROUND_ELEMENT_BATCH_SIZE < elements.length) {
      await sleep(randomScanBatchDelayMs());
    }
  }

  const samples = Array.from(urls).slice(0, MAX_BACKGROUND_SAMPLES);
  const dimensions = await loadDimensionsInBatches(samples);

  dimensions.forEach((result) => {
    if (result) {
      pushCandidate(candidates, result.url, result.width, result.height, "background");
    }
  });
}

function getVisibleSrcsetElement(element) {
  if (element instanceof HTMLImageElement) {
    return isVisibleInViewport(element) ? element : null;
  }

  const image = element.parentElement?.querySelector("img");
  return image && isVisibleInViewport(image) ? image : null;
}

function isVisibleInViewport(element) {
  if (!(element instanceof Element)) {
    return false;
  }

  const style = getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    hasInvisibleAncestor(element)
  ) {
    return false;
  }

  const rects = Array.from(element.getClientRects());
  if (rects.length === 0) {
    return false;
  }

  return rects.some((rect) => (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  ));
}

function hasInvisibleAncestor(element) {
  let current = element;

  while (current && current instanceof Element) {
    const style = getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0
    ) {
      return true;
    }

    current = current.parentElement;
  }

  return false;
}

function pushCandidate(candidates, rawUrl, width, height, source) {
  const url = toAbsoluteUrl(rawUrl);
  if (!url) {
    return;
  }

  candidates.push({
    url,
    width: Number(width) || 0,
    height: Number(height) || 0,
    source
  });
}

function toAbsoluteUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return null;
  }

  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:")) {
    return null;
  }

  try {
    return new URL(trimmed, document.baseURI).href;
  } catch (_) {
    return null;
  }
}

function parseSrcset(srcset) {
  if (!srcset) {
    return [];
  }

  return splitSrcsetCandidates(srcset)
    .map(parseSrcsetUrl)
    .filter(Boolean);
}

function splitSrcsetCandidates(srcset) {
  const candidates = [];
  let current = "";
  let quote = "";
  let parenDepth = 0;

  for (const char of srcset) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      current += char;
      continue;
    }

    if (char === ")" && parenDepth > 0) {
      parenDepth -= 1;
      current += char;
      continue;
    }

    if (char === "," && parenDepth === 0) {
      if (current.trim()) {
        candidates.push(current.trim());
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    candidates.push(current.trim());
  }

  return candidates;
}

function parseSrcsetUrl(candidate) {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return "";
  }

  const quoted = trimmed.match(/^(['"])(.*?)\1(?:\s|$)/);
  if (quoted) {
    return quoted[2];
  }

  const match = trimmed.match(/^(\S+)/);
  return match ? match[1] : "";
}

function extractCssUrls(value) {
  const urls = [];
  const pattern = /url\((?:"([^"]+)"|'([^']+)'|([^'")]+))\)/g;
  let match;

  while ((match = pattern.exec(value || "")) !== null) {
    urls.push(match[1] || match[2] || match[3]);
  }

  return urls;
}

function loadImageDimensions(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve({
      url: image.currentSrc || url,
      width: image.naturalWidth,
      height: image.naturalHeight
    });
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

async function loadDimensionsInBatches(urls) {
  const results = [];

  for (let index = 0; index < urls.length && collectorActive; index += DIMENSION_BATCH_SIZE) {
    const batch = urls.slice(index, index + DIMENSION_BATCH_SIZE);
    results.push(...await Promise.all(batch.map(loadImageDimensions)));

    if (index + DIMENSION_BATCH_SIZE < urls.length) {
      await sleep(randomScanBatchDelayMs());
    }
  }

  return results;
}

function updateScanOptions(nextOptions) {
  if (!nextOptions) {
    return;
  }

  scanOptions = {
    includeBackgrounds: nextOptions.includeBackgrounds !== false,
    includeSrcset: nextOptions.includeSrcset !== false
  };
}

function randomInitialDelayMs() {
  return Math.floor(MIN_INITIAL_DELAY_MS + Math.random() * (MAX_INITIAL_DELAY_MS - MIN_INITIAL_DELAY_MS + 1));
}

function randomScanBatchDelayMs() {
  return Math.floor(MIN_SCAN_BATCH_DELAY_MS + Math.random() * (MAX_SCAN_BATCH_DELAY_MS - MIN_SCAN_BATCH_DELAY_MS + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendRuntimeMessage(message, callback) {
  if (!isRuntimeReady()) {
    handleInvalidContext();
    return false;
  }

  try {
    const result = chrome.runtime.sendMessage(message, callback);
    if (result && typeof result.catch === "function") {
      result.catch(handleRuntimeMessageError);
    }

    return true;
  } catch (error) {
    handleRuntimeMessageError(error);
    return false;
  }
}

function isRuntimeReady() {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch (_) {
    return false;
  }
}

function handleScanError(error) {
  handleRuntimeMessageError(error);
}

function handleRuntimeMessageError(error) {
  const message = error?.message || "";

  if (
    message.includes("Extension context invalidated") ||
    message.includes("Extension context was invalidated") ||
    message.includes("Receiving end does not exist")
  ) {
    handleInvalidContext();
    return;
  }

  console.warn("Jjal Collector content script error:", error);
}

function handleInvalidContext() {
  stopCollector();
}
