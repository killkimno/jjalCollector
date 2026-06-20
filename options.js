const DEFAULTS = {
  minWidth: 480,
  minHeight: 480,
  folder: "jjal-collector",
  includeBackgrounds: true,
  includeSrcset: true,
  hideDownloadUi: true
};
const MIN_IMAGE_DIMENSION = 480;

const form = document.getElementById("optionsForm");
const minWidth = document.getElementById("minWidth");
const minHeight = document.getElementById("minHeight");
const folder = document.getElementById("folder");
const hideDownloadUi = document.getElementById("hideDownloadUi");
const includeSrcset = document.getElementById("includeSrcset");
const includeBackgrounds = document.getElementById("includeBackgrounds");
const saveStatus = document.getElementById("saveStatus");

document.addEventListener("DOMContentLoaded", loadOptions);
form.addEventListener("submit", saveOptions);

async function loadOptions() {
  const options = await chrome.storage.sync.get(DEFAULTS);

  minWidth.value = toMinimumDimension(options.minWidth);
  minHeight.value = toMinimumDimension(options.minHeight);
  folder.value = options.folder || DEFAULTS.folder;
  hideDownloadUi.checked = options.hideDownloadUi !== false;
  includeSrcset.checked = options.includeSrcset !== false;
  includeBackgrounds.checked = options.includeBackgrounds !== false;
}

async function saveOptions(event) {
  event.preventDefault();

  await chrome.storage.sync.set({
    minWidth: toMinimumDimension(minWidth.value),
    minHeight: toMinimumDimension(minHeight.value),
    folder: sanitizeFolder(folder.value),
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
