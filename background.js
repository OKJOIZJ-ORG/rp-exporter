// Service Worker for 앵챗추출기
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  const url = tab.url || "";

  if (/^(chrome|edge|brave|opera|about|chrome-extension):\/\//i.test(url) || url.startsWith("https://chromewebstore.google.com")) {
    try {
      await chrome.action.setBadgeText({ tabId: tab.id, text: "X" });
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#D9534F" });
      setTimeout(async () => {
        try { await chrome.action.setBadgeText({ tabId: tab.id, text: "" }); } catch (e) {}
      }, 3000);
    } catch (e) {}
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["export.js"]
    });
  } catch (err) {
    console.error("[앵챗추출기] 주입 실패:", err);
    try {
      await chrome.action.setBadgeText({ tabId: tab.id, text: "ERR" });
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#D9534F" });
      setTimeout(async () => {
        try { await chrome.action.setBadgeText({ tabId: tab.id, text: "" }); } catch (e) {}
      }, 3000);
    } catch (e) {}
  }
});
