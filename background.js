// 툴바 아이콘 클릭 = 현재 탭에 export.js 주입
// 단, chrome:// 등 보호된 페이지에는 주입이 불가하므로 미리 걸러 안내한다.
const RESTRICTED = /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|moz-extension|view-source|devtools|file):/i;

function flash(badge, color, title) {
  try {
    chrome.action.setBadgeText({ text: badge });
    chrome.action.setBadgeBackgroundColor({ color: color });
    if (title) chrome.action.setTitle({ title: title });
    setTimeout(function () {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: "앵챗추출기 패널 열기" });
    }, 4000);
  } catch (e) {}
}

function blocked(url) {
  if (!url) return true;
  if (RESTRICTED.test(url)) return true;
  if (url.indexOf("chromewebstore.google.com") !== -1) return true;
  if (url.indexOf("chrome.google.com/webstore") !== -1) return true;
  return false;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  if (blocked(tab.url || "")) {
    flash("!", "#C0392B", "이 페이지에서는 사용할 수 없어요. 내보낼 대화(채팅)가 열린 탭에서 아이콘을 눌러주세요.");
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["export.js"],
    });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    flash("!", "#C0392B", "열 수 없는 페이지예요 (" + msg + "). 채팅 탭에서 다시 시도해주세요.");
  }
});
