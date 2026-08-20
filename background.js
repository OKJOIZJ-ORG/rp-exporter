// 툴바 아이콘 클릭 = 현재 탭에 export.js 주입
//
// 설계 원칙: URL 기반 사전 차단을 최소화한다.
// 기존 버전은 tab.url이 비어 있으면(권한 타이밍 문제) 무조건 차단하여
// "채팅 탭에서 열어주세요"라는 오해 유발 메시지를 표시했다.
// 이제는 activeTab + <all_urls> 권한으로 주입을 먼저 시도하고,
// 실패 시 Chrome이 반환한 실제 에러 원인을 그대로 표시한다.

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

// 브라우저 내부 페이지 등 주입이 원천적으로 불가능한 페이지만 차단.
// URL을 알 수 없는 경우(tab.url undefined)는 차단하지 않고 주입을 시도한다.
function isProtected(url) {
  if (!url) return false;
  if (/^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|moz-extension|view-source|devtools|file):/i.test(url)) return true;
  if (url.indexOf("chromewebstore.google.com") !== -1) return true;
  if (url.indexOf("chrome.google.com/webstore") !== -1) return true;
  return false;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  if (isProtected(tab.url || "")) {
    flash("!", "#C0392B", "브라우저 내부 페이지에서는 사용할 수 없습니다.");
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["export.js"],
    });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (/permission|access|not allowed/i.test(msg)) {
      flash("!", "#C0392B", "사이트 접근 권한이 필요합니다. chrome://extensions → 앵챗추출기 → 사이트 액세스 → '모든 사이트'로 변경 후 다시 눌러주세요.");
    } else {
      flash("!", "#C0392B", "열 수 없는 페이지예요 (" + msg + ")");
    }
  }
});
