(() => {
  const ID = "__rp_panel";
  if (document.getElementById(ID)) {
    const existing = document.getElementById(ID);
    if (existing.__rp_closeTimer) { clearTimeout(existing.__rp_closeTimer); existing.__rp_closeTimer = null; }
    existing.classList.remove("__rp_closing");
    existing.style.display = "block";
    return;
  }

  // ══ 자동 모드 설정 (모든 RP 플랫폼 통합 최적화) ══
  const AUTO_STABLE = 8;   // 높이/메시지가 이 횟수 연속 불변이어야 최상단 판정
  const DWELL = 700;       // 상단 고정 후 네트워크/DB 로딩 대기 기본시간(ms)
  const OSC = 2;           // 한 사이클당 진동 횟수
  let SPEED_MULT = 1;      // 추출 속도 배수(작을수록 빠름) · 슬라이더로 실시간 조절
  const DEFAULT_NAME = "rp_chat";
  const VER = (() => { try { return "v" + chrome.runtime.getManifest().version; } catch (e) { return "v2.14.0"; } })();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const NBSP = String.fromCharCode(160);
  const SEP = "\n\n────────────────────────\n\n";

  // ── 텍스트 정규화 ──
  function cleanText(t) {
    if (!t) return "";
    return t
      .split(NBSP).join(" ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "") // 제로 위드 스페이스 제거
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();
  }

  // ── 가상 스크롤(content-visibility: auto) 강제 렌더링 오버라이드 ──
  let forceRenderStyle = null;
  function enableForceRender() {
    if (!forceRenderStyle || !document.contains(forceRenderStyle)) {
      forceRenderStyle = document.createElement("style");
      forceRenderStyle.id = "__rp_force_render";
      forceRenderStyle.textContent = `
        [data-turn-key], [data-message-id], details, .chat-viewer-scrollbar-autohide,
        .chat-viewer-scrollbar-autohide *, [data-capture-selectable], [data-capture-selectable] *,
        main, main *, [role='log'], [role='log'] * {
          content-visibility: visible !important;
          contain-intrinsic-size: auto none !important;
          contain: none !important;
          overflow-anchor: auto !important;
        }
      `;
      document.documentElement.appendChild(forceRenderStyle);
    }

    try {
      const candidates = document.querySelectorAll("[data-turn-key], [data-message-id], [class*='message'], [class*='turn']");
      candidates.forEach((el) => {
        if (el.style) {
          el.style.setProperty("content-visibility", "visible", "important");
          el.style.setProperty("contain-intrinsic-size", "none", "important");
          el.style.setProperty("contain", "none", "important");
        }
      });
    } catch (e) {}
  }

  function disableForceRender() {
    if (forceRenderStyle && document.contains(forceRenderStyle)) {
      forceRenderStyle.remove();
      forceRenderStyle = null;
    }
  }

  // ── 스크롤러 & 리스트 탐색 엔진 ──
  function scoreOf(el) {
    let n = 0;
    for (const c of el.children) {
      if (c.getAttribute("aria-hidden") === "true" || c.id === ID || c.closest("#" + ID)) continue;
      if (c.matches("script, style, noscript, svg, iframe")) continue;
      if (c.querySelector("details, [data-turn-key], [data-message-id]") ||
          c.matches("[data-turn-key], [data-message-id], details, [class*='message'], [class*='turn']") ||
          (c.innerText || "").trim().length > 30) {
        n++;
      }
    }
    return n;
  }

  function findList(root) {
    if (!root) return document.body;
    let best = root, score = scoreOf(root);
    root.querySelectorAll("*").forEach((el) => {
      if (el.id === ID || el.closest("#" + ID)) return;
      if (el.matches("script, style, noscript, svg, iframe")) return;
      const sc = scoreOf(el);
      if (sc > score) { score = sc; best = el; }
    });
    return best;
  }

  function findScroller() {
    // 1순위: 티팟 등 고유 뷰어
    const explicit = document.querySelector("[data-capture-selectable], .chat-viewer-scrollbar-autohide");
    if (explicit) {
      const s = getComputedStyle(explicit);
      if (/(auto|scroll)/.test(s.overflowY) && explicit.scrollHeight > explicit.clientHeight + 40) {
        return explicit;
      }
    }

    // 2순위: 턴/메시지 점수가 높은 스크롤 컨테이너
    const all = [...document.querySelectorAll("*")].filter((el) => {
      if (el.id === ID || el.closest("#" + ID)) return false;
      const s = getComputedStyle(el);
      return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 60;
    });

    if (all.length > 0) {
      return all.sort((a, b) => scoreOf(b) - scoreOf(a) || b.scrollHeight - a.scrollHeight)[0];
    }

    // 3순위: flex-col-reverse
    const rev = all.find((el) => {
      const fd = getComputedStyle(el).flexDirection;
      return fd === "column-reverse" || /flex-col-reverse/.test(el.className || "");
    });
    if (rev) return rev;

    return document.scrollingElement || document.documentElement;
  }

  let scroller = findScroller();
  function ensureScroller() {
    if (!scroller || !document.contains(scroller)) scroller = findScroller();
    return scroller;
  }

  // ── 무손실 턴 텍스트 추출 (innerText + DOM Tree Fallback) ──
  function extractTurnText(el) {
    if (!el || el.matches("script, style, noscript, svg, iframe")) return "";

    if (el.style && el.style.contentVisibility) {
      el.style.setProperty("content-visibility", "visible", "important");
      el.style.setProperty("contain-intrinsic-size", "none", "important");
    }

    if (expandChk && expandChk.checked) {
      try {
        if (el.tagName === "DETAILS") el.open = true;
        el.querySelectorAll("details").forEach((d) => (d.open = true));
      } catch (e) {}
    }

    // 1차 시도: innerText
    let t = cleanText(el.innerText || "");
    if (t.length >= 2) return t;

    // 2차 시도: 강제 reflow 후 innerText
    try { void el.offsetHeight; } catch (e) {}
    t = cleanText(el.innerText || "");
    if (t.length >= 2) return t;

    // 3차 시도: 하위 블록/텍스트 노드 구조적 순회
    try {
      const parts = [];
      const blocks = el.querySelectorAll("p, [class*='prose'], [class*='bubble'], [class*='message'], [class*='content'], pre, blockquote, div, span");
      if (blocks.length > 0) {
        for (const b of blocks) {
          if (b.matches("script, style, noscript, svg, iframe")) continue;
          if (b.children.length === 0 && (b.textContent || "").trim().length > 0) {
            const raw = cleanText(b.textContent);
            if (raw && !parts.includes(raw)) parts.push(raw);
          }
        }
      }
      if (parts.length > 0) return parts.join("\n").trim();
    } catch (e) {}

    return cleanText(el.textContent || "");
  }

  // ── 캡처 및 중복 제거 ──
  let seen = new Set(), blocks = [];
  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return h + ":" + s.length;
  }

  function captureElements(elements) {
    for (const el of elements) {
      if (!el || el.getAttribute("aria-hidden") === "true" || el.id === ID || el.closest("#" + ID)) continue;
      if (el.matches("script, style, noscript, svg, iframe")) continue;
      const t = extractTurnText(el);
      if (t.length < 2) continue;
      const k = hash(t);
      if (!seen.has(k)) {
        seen.add(k);
        blocks.push(t);
      }
    }
  }

  function captureVisible() {
    ensureScroller();
    const open = expandChk.checked;
    try { document.querySelectorAll("details").forEach((d) => (d.open = open)); } catch (e) {}

    // 1. TeapotChat: data-turn-key
    const turnKeys = [...scroller.querySelectorAll("[data-turn-key]")].filter((el) => !el.closest("#" + ID));
    if (turnKeys.length > 0) {
      captureElements(turnKeys);
      return;
    }

    // 2. Caveduck 및 기타: list.children
    const list = findList(scroller);
    if (list && list.children.length > 0) {
      captureElements([...list.children]);
    }
  }

  // ── 대화 상태 시그니처 ──
  function getChatSignature() {
    ensureScroller();
    const list = findList(scroller);
    const turnKeys = scroller.querySelectorAll("[data-turn-key]");
    const count = turnKeys.length > 0 ? turnKeys.length : (list ? list.children.length : 0);
    const sh = Math.round(scroller.scrollHeight || 0);
    const f = list && list.firstElementChild ? (list.firstElementChild.innerText || "").slice(0, 40) : "";
    return {
      count,
      sh,
      f,
      key: count + "|" + sh + "|" + f,
    };
  }

  // ── 적응형 대기 ──
  async function settle(maxMs) {
    const cap = Math.round(maxMs * SPEED_MULT);
    const t0 = performance.now();
    let lastLen = -1, stable = 0;
    while (performance.now() - t0 < cap) {
      await raf();
      if (stopFlag) break;
      ensureScroller();
      let len = 0;
      try { len = (scroller.innerText || scroller.textContent || "").length; } catch (e) { break; }
      if (len === lastLen) stable++; else stable = 0;
      lastLen = len;
      if (stable >= 2) break;
    }
  }

  let busy = false, stopFlag = false;

  // ── 양방향 스크롤 극단값 측정 및 강한 진동 (모든 플랫폼 로더 활성화) ──
  async function oscillate() {
    ensureScroller();
    scroller.scrollTop = -1e9; await sleep(60); const a1 = scroller.scrollTop;
    scroller.scrollTop = 1e9; await sleep(60); const a2 = scroller.scrollTop;
    const min = Math.min(a1, a2);
    const ch = scroller.clientHeight || 500;
    const jump = Math.max(Math.round(ch * 0.6), 250);

    for (let k = 0; k < OSC; k++) {
      scroller.scrollTop = min;
      try {
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        scroller.dispatchEvent(new Event("wheel", { bubbles: true }));
      } catch (e) {}
      await sleep(Math.round(DWELL * SPEED_MULT * 0.6));
      if (stopFlag) return;

      // 아래로 이동하여 인피니트 로더 / IntersectionObserver 재진입 유도
      scroller.scrollTop = min + jump;
      try {
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      } catch (e) {}
      await sleep(Math.round(200 * SPEED_MULT));

      scroller.scrollTop = min;
      try {
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      } catch (e) {}
      await sleep(Math.round(DWELL * SPEED_MULT * 0.4));
    }
  }

  // ── ①/▶ 전체 로딩 (auto=false: ■ 정지까지 / auto=true: 자동 판정 종료) ──
  async function preload(auto) {
    enableForceRender();
    let i = 0;
    const MAX = 50000;
    let lastKey = "", stable = 0;

    while (!stopFlag && i < MAX) {
      i++;
      await oscillate();
      if (stopFlag) break;

      // 네트워크/DB 지연 응답 대기 및 데이터 증가 관측
      const pollStart = performance.now();
      let prevSig = getChatSignature();

      while (performance.now() - pollStart < Math.round(1100 * SPEED_MULT)) {
        await sleep(150);
        if (stopFlag) break;
        const curSig = getChatSignature();
        if (curSig.count > prevSig.count || curSig.sh > prevSig.sh + 30) {
          prevSig = curSig;
          stable = 0; // 새 데이터 감지 즉시 카운트 리셋
        }
      }

      const sig = getChatSignature();
      if (auto) {
        if (sig.key === lastKey) {
          stable++;
        } else {
          stable = 0;
          lastKey = sig.key;
        }
        setStatus("자동 로딩… " + i + "회 · " + sig.count + "개 턴 감지 (완료 판정 " + stable + "/" + AUTO_STABLE + ")");
        if (stable >= AUTO_STABLE) break;
      } else {
        setStatus("로딩 중… " + i + "회 · " + sig.count + "개 턴 감지 (충분하면 ■ 정지)");
      }
    }

    if (!auto) {
      const finalSig = getChatSignature();
      setStatus("로딩 정지 · " + finalSig.count + "개 턴 감지됨. ②로 추출하세요.");
    }
  }

  // ── 전 턴 무손실 스윗 캡처 ──
  async function sweepCapture() {
    enableForceRender();
    ensureScroller();
    seen = new Set();
    blocks = [];

    // 시작 메시지(Intro / Start Setting)가 상단 별도 블록에 있는 경우 선행 수집
    const introEl = scroller.querySelector(".pt-4, [class*='start-message'], [data-start-message]");
    if (introEl && !introEl.matches("[data-turn-key]") && !introEl.querySelector("[data-turn-key]")) {
      const introText = cleanText(introEl.innerText || introEl.textContent || "");
      if (introText.length > 5) {
        seen.add(hash(introText));
        blocks.push(introText);
      }
    }

    // 양방향 스크롤 극단값 측정
    scroller.scrollTop = -1e9; await sleep(80); const a1 = scroller.scrollTop;
    scroller.scrollTop = 1e9; await sleep(80); const a2 = scroller.scrollTop;
    const min = Math.min(a1, a2), max = Math.max(a1, a2);
    const ch = scroller.clientHeight || 500;
    const step = Math.max(Math.round(ch * 0.5), 250);

    let pos = min;
    scroller.scrollTop = min;
    await settle(150);
    captureVisible();

    let s = 0;
    while (pos < max - 2 && s < 10000 && !stopFlag) {
      s++;
      pos = Math.min(pos + step, max);
      scroller.scrollTop = pos;
      try { scroller.dispatchEvent(new Event("scroll", { bubbles: true })); } catch (e) {}
      await sleep(Math.round(100 * SPEED_MULT));
      captureVisible();
      const pct = Math.round(((pos - min) / ((max - min) || 1)) * 100);
      setStatus("무손실 검증 수집 " + pct + "% · " + blocks.length + "개 턴 확보");
    }

    scroller.scrollTop = max;
    await settle(150);
    captureVisible();

    scroller.scrollTop = max;
    disableForceRender();
    setStatus("수집 완료 · " + blocks.length + "개 턴 추출됨. 저장 중…");
  }

  // ── ZIP(무압축 store) 생성 ──
  function crc32(bytes) {
    const table = crc32._t || (crc32._t = (() => {
      const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t;
    })());
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function makeZip(files) {
    const enc = new TextEncoder();
    const chunks = []; let offset = 0;
    const u16 = (v) => new Uint8Array([v & 255, (v >> 8) & 255]);
    const u32 = (v) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
    const push = (arr) => { chunks.push(arr); offset += arr.length; };
    const recs = [];
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const size = data.length;
      const localOffset = offset;
      push(u32(0x04034b50)); push(u16(20)); push(u16(0x0800)); push(u16(0));
      push(u16(0)); push(u16(0)); push(u32(crc)); push(u32(size)); push(u32(size));
      push(u16(name.length)); push(u16(0)); push(name); push(data);
      recs.push({ name, crc, size, localOffset });
    }
    const cdStart = offset;
    for (const r of recs) {
      push(u32(0x02014b50)); push(u16(20)); push(u16(20)); push(u16(0x0800)); push(u16(0));
      push(u16(0)); push(u16(0)); push(u32(r.crc)); push(u32(r.size)); push(u32(r.size));
      push(u16(r.name.length)); push(u16(0)); push(u16(0)); push(u16(0)); push(u16(0));
      push(u32(0)); push(u32(r.localOffset)); push(r.name);
    }
    const cdSize = offset - cdStart;
    push(u32(0x06054b50)); push(u16(0)); push(u16(0)); push(u16(recs.length)); push(u16(recs.length));
    push(u32(cdSize)); push(u32(cdStart)); push(u16(0));
    let total = 0; for (const c of chunks) total += c.length;
    const out = new Uint8Array(total); let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  function dlBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function packByCount(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
  function packBySize(arr, maxChars) {
    const out = []; let cur = [], len = 0;
    for (const b of arr) {
      const add = (cur.length ? SEP.length : 0) + b.length;
      if (cur.length && len + add > maxChars) { out.push(cur); cur = []; len = 0; }
      cur.push(b); len += (cur.length > 1 ? SEP.length : 0) + b.length;
    }
    if (cur.length) out.push(cur);
    return out;
  }
  // 사용자 파일명 정리 (금지 문자 제거)
  function safeName(s) {
    let out = (s || "").trim();
    const bad = ["\\", "/", ":", "*", "?", "\"", "<", ">", "|"];
    for (const ch of bad) out = out.split(ch).join("_");
    out = out.split("\n").join("_").split("\r").join("_").split("\t").join("_");
    out = out.slice(0, 80).trim();
    return out || DEFAULT_NAME;
  }
  function escapeHtml(s) {
    return (s || "").split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");
  }
  function htmlDoc(text, title) {
    return "<!doctype html><html lang='ko'><head><meta charset='utf-8'>" +
      "<title>" + escapeHtml(title) + "</title>" +
      "<style>body{font-family:'Apple SD Gothic Neo','Malgun Gothic','Segoe UI',sans-serif;max-width:780px;margin:40px auto;padding:0 24px;color:#2b2b2b;}" +
      "pre{white-space:pre-wrap;word-break:break-word;font:14px/1.7 inherit;margin:0;}</style>" +
      "</head><body><pre>" + escapeHtml(text) + "</pre></body></html>";
  }
  function printPdf(groups, base) {
    const sections = groups.map((g, i) => {
      const brk = i < groups.length - 1 ? "page-break-after:always;" : "";
      return "<pre style='white-space:pre-wrap;word-break:break-word;font:13px/1.7 inherit;margin:0;" + brk + "'>" + escapeHtml(g.join(SEP)) + "</pre>";
    }).join("");
    const html = "<!doctype html><html lang='ko'><head><meta charset='utf-8'><title>" + escapeHtml(base) + "</title>" +
      "<style>@page{margin:18mm;}body{font-family:'Apple SD Gothic Neo','Malgun Gothic','Segoe UI',sans-serif;color:#222;margin:0;}</style>" +
      "</head><body>" + sections + "</body></html>";
    let ifr = document.getElementById("__rp_print");
    if (ifr) ifr.remove();
    ifr = document.createElement("iframe");
    ifr.id = "__rp_print";
    ifr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;";
    document.body.appendChild(ifr);
    const doc = ifr.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    setTimeout(() => { try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch (e) { setStatus("⚠ 인쇄 실패: " + (e && e.message)); } }, 500);
    return true;
  }
  function saveAll() {
    if (!blocks.length) { setStatus("❌ 추출된 블록이 없습니다. ②를 먼저 실행하세요."); return; }
    const unit = selUnit.value;
    const num = parseInt(numInput.value, 10);
    const base = safeName(nameInput.value);
    const fmt = selFmt.value;
    let groups;
    if (unit === "none") groups = [blocks];
    else if (unit === "count") groups = packByCount(blocks, (num > 0 ? num : 50));
    else groups = packBySize(blocks, (num > 0 ? num : 600000));
    const chars = blocks.reduce((s, b) => s + b.length, 0);
    if (fmt === "pdf") {
      printPdf(groups, base);
      setStatus("✓ 인쇄 창 열림 · 대상에서 'PDF로 저장' 선택 · " + blocks.length + "개 턴" + (groups.length > 1 ? " · " + groups.length + "구간(페이지 분리)" : ""));
      nameInput.value = DEFAULT_NAME;
      return;
    }
    const ext = fmt === "md" ? "md" : fmt === "html" ? "html" : "txt";
    const mime = fmt === "md" ? "text/markdown;charset=utf-8" : fmt === "html" ? "text/html;charset=utf-8" : "text/plain;charset=utf-8";
    const make = (g) => fmt === "html" ? htmlDoc(g.join(SEP), base) : g.join(SEP);
    if (groups.length === 1) {
      dlBlob(base + "." + ext, new Blob([make(groups[0])], { type: mime }));
      setStatus("✓ 저장 완료 · " + blocks.length + "개 턴 · 1파일(." + ext + ") · 약 " + chars.toLocaleString() + "자");
    } else {
      const enc = new TextEncoder();
      const files = groups.map((g, i) => ({
        name: base + "/" + base + "_part" + String(i + 1).padStart(2, "0") + "of" + groups.length + "." + ext,
        data: enc.encode(make(g)),
      }));
      const zip = makeZip(files);
      dlBlob(base + ".zip", new Blob([zip], { type: "application/zip" }));
      setStatus("✓ 저장 완료 · " + blocks.length + "개 턴 · " + groups.length + "파일(ZIP·." + ext + ") · 약 " + chars.toLocaleString() + "자");
    }
    nameInput.value = DEFAULT_NAME;
  }

  // ── 실행 가드 ──
  async function run(fn) {
    if (busy) return;
    busy = true; stopFlag = false; setButtons(true);
    try {
      await fn();
    } catch (e) {
      setStatus("⚠ 오류: " + ((e && e.message) || String(e)));
      console.error("[앵챗추출기]", e);
    } finally {
      disableForceRender();
      busy = false;
      setButtons(false);
    }
  }

  // ── 패널 UI (Cloud Dancer 톤 & Emil Kowalski 인터랙션 가이드) ──
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Apple SD Gothic Neo','Malgun Gothic',sans-serif";
  const INK = "#44413A", LABEL = "#A8A395", SOFT = "#6E695D", FAINT = "#BCB6A6", LINE = "#E0DCD0";
  const field = "display:block;width:100%;box-sizing:border-box;padding:8px 11px;background:#FAF9F4;color:" + INK + ";border:1px solid #D7D2C6;border-radius:10px;outline:none;font:500 13px/1.3 " + FONT + ";transition:border-color 140ms ease-out,box-shadow 140ms ease-out;";

  const st = document.createElement("style");
  st.textContent = `
    @keyframes __rp_fadeIn {
      from { opacity: 0; transform: scale(0.96) translateY(8px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
    @keyframes __rp_fadeOut {
      to { opacity: 0; transform: scale(0.97) translateY(6px); }
    }
    #__rp_panel {
      animation: __rp_fadeIn 200ms cubic-bezier(0.23, 1, 0.32, 1);
      user-select: none;
    }
    #__rp_panel.__rp_closing {
      animation: __rp_fadeOut 150ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
    }
    #__rp_panel input[type=text]:focus,
    #__rp_panel input[type=number]:focus {
      border-color: #A89F8C !important;
      box-shadow: 0 0 0 3px rgba(122, 112, 92, 0.14) !important;
    }
    #__rp_panel .__rp_btn {
      display: block !important;
      width: 100% !important;
      margin: 0 0 8px 0 !important;
      padding: 10px 12px !important;
      border-radius: 10px !important;
      font: 600 13px/1.1 ${FONT} !important;
      text-align: center !important;
      cursor: pointer !important;
      -webkit-appearance: none !important;
      appearance: none !important;
      box-sizing: border-box !important;
      transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1), background 140ms ease-out, box-shadow 140ms ease-out, opacity 140ms ease-out !important;
    }
    #__rp_panel .__rp_btn:active {
      transform: scale(0.975) !important;
    }
    #__rp_panel .__rp_auto {
      border: 1px solid #38352D !important;
      background: #44413A !important;
      color: #FAF8F2 !important;
      font-weight: 700 !important;
      box-shadow: 0 1px 3px rgba(64, 58, 42, 0.18) !important;
    }
    #__rp_panel .__rp_auto:hover {
      background: #4E4B42 !important;
      box-shadow: 0 2px 5px rgba(64, 58, 42, 0.22) !important;
    }
    #__rp_panel .__rp_sec {
      border: 1px solid #CBC5B7 !important;
      background: #E8E4D9 !important;
      color: #3A3830 !important;
      box-shadow: 0 1px 2px rgba(64, 58, 42, 0.05) !important;
    }
    #__rp_panel .__rp_sec:hover {
      background: #DFDACD !important;
      box-shadow: 0 2px 4px rgba(64, 58, 42, 0.08) !important;
    }
    #__rp_panel .__rp_stop {
      border: 1px solid #DFCBC0 !important;
      background: #F1E7E1 !important;
      color: #A0473A !important;
      box-shadow: 0 1px 2px rgba(120, 70, 55, 0.05) !important;
    }
    #__rp_panel .__rp_stop:hover {
      background: #EBDCD4 !important;
      box-shadow: 0 2px 4px rgba(120, 70, 55, 0.08) !important;
    }
    #__rp_panel .__rp_btn:disabled {
      opacity: 0.45 !important;
      cursor: not-allowed !important;
      transform: none !important;
    }
    #__rp_panel .__rp_row {
      display: flex !important;
      gap: 8px !important;
    }
    #__rp_panel .__rp_row .__rp_btn {
      margin: 0 !important;
    }
    #__rp_panel input[type=range] {
      -webkit-appearance: none !important;
      appearance: none !important;
      width: 100% !important;
      height: 4px !important;
      border-radius: 3px !important;
      background: #DCD8CC !important;
      outline: none !important;
      margin: 0 !important;
      padding: 0 !important;
      cursor: pointer !important;
      box-sizing: border-box !important;
    }
    #__rp_panel input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none !important;
      appearance: none !important;
      width: 16px !important;
      height: 16px !important;
      border-radius: 50% !important;
      background: #44413A !important;
      border: 2px solid #FAF8F2 !important;
      box-shadow: 0 1px 3px rgba(64, 58, 42, 0.25) !important;
      cursor: pointer !important;
      transition: transform 120ms ease-out, box-shadow 120ms ease-out !important;
    }
    #__rp_panel input[type=range]::-webkit-slider-thumb:hover {
      transform: scale(1.15) !important;
      box-shadow: 0 2px 6px rgba(64, 58, 42, 0.35) !important;
    }
    #__rp_panel input[type=range]::-webkit-slider-thumb:active {
      transform: scale(1.25) !important;
    }
    #__rp_panel input[type=range]::-moz-range-thumb {
      width: 16px !important;
      height: 16px !important;
      border-radius: 50% !important;
      background: #44413A !important;
      border: 2px solid #FAF8F2 !important;
      box-shadow: 0 1px 3px rgba(64, 58, 42, 0.25) !important;
      cursor: pointer !important;
      transition: transform 120ms ease-out, box-shadow 120ms ease-out !important;
    }
    #__rp_panel input[type=range]::-moz-range-thumb:hover {
      transform: scale(1.15) !important;
    }
    #__rp_panel input[type=range]::-moz-range-thumb:active {
      transform: scale(1.25) !important;
    }
    /* ── 커스텀 셀렉트 UI ── */
    #__rp_panel .__rp_cselect_wrap {
      position: relative;
      flex: 1;
      min-width: 0;
    }
    #__rp_panel .__rp_cselect_btn {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      width: 100% !important;
      box-sizing: border-box !important;
      padding: 8px 11px !important;
      background: #FAF9F4 !important;
      color: ${INK} !important;
      border: 1px solid #D7D2C6 !important;
      border-radius: 10px !important;
      outline: none !important;
      font: 500 13px/1.3 ${FONT} !important;
      cursor: pointer !important;
      text-align: left !important;
      transition: border-color 140ms ease-out, box-shadow 140ms ease-out, background 140ms ease-out, transform 120ms ease-out !important;
    }
    #__rp_panel .__rp_cselect_btn:hover {
      background: #FDFCF8 !important;
      border-color: #C5BFB1 !important;
    }
    #__rp_panel .__rp_cselect_btn:active {
      transform: scale(0.985) !important;
    }
    #__rp_panel .__rp_cselect_wrap.open .__rp_cselect_btn {
      border-color: #A89F8C !important;
      box-shadow: 0 0 0 3px rgba(122, 112, 92, 0.14) !important;
      background: #FAF9F4 !important;
    }
    #__rp_panel .__rp_cselect_arr {
      flex: none;
      margin-left: 6px;
      color: ${SOFT};
      transition: transform 180ms cubic-bezier(0.23, 1, 0.32, 1) !important;
    }
    #__rp_panel .__rp_cselect_wrap.open .__rp_cselect_arr {
      transform: rotate(180deg) !important;
    }
    #__rp_panel .__rp_cselect_menu {
      position: absolute;
      left: 0;
      right: 0;
      top: calc(100% + 5px);
      z-index: 1000;
      background: #FAF9F4;
      border: 1px solid #D7D2C6;
      border-radius: 10px;
      box-shadow: 0 10px 28px rgba(64, 58, 42, 0.16), 0 2px 6px rgba(64, 58, 42, 0.08);
      padding: 4px;
      box-sizing: border-box;
      transform-origin: top center;
      opacity: 0;
      transform: scale(0.96) translateY(-4px);
      pointer-events: none;
      transition: opacity 120ms ease-out, transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
    }
    #__rp_panel .__rp_cselect_wrap.open .__rp_cselect_menu {
      opacity: 1;
      transform: scale(1) translateY(0);
      pointer-events: auto;
      transition: opacity 160ms ease-out, transform 160ms cubic-bezier(0.23, 1, 0.32, 1);
    }
    #__rp_panel .__rp_cselect_opt {
      padding: 7px 9px;
      font-size: 12.5px;
      font-weight: 500;
      color: ${INK};
      border-radius: 7px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: background 100ms ease-out, color 100ms ease-out;
      line-height: 1.3;
    }
    #__rp_panel .__rp_cselect_opt:hover {
      background: #EFECE3;
      color: #2B2924;
    }
    #__rp_panel .__rp_cselect_opt.selected {
      background: #E5E0D2;
      font-weight: 600;
      color: #2B2924;
    }
    #__rp_panel .__rp_cselect_opt svg {
      flex: none;
      margin-left: 6px;
    }
    #__rp_panel #__rp_x {
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      cursor: pointer;
      color: ${FAINT};
      font-size: 14px;
      line-height: 1;
      transition: background 120ms ease-out, color 120ms ease-out, transform 120ms ease-out;
    }
    #__rp_panel #__rp_x:hover {
      background: #E4E0D4;
      color: ${INK};
    }
    #__rp_panel #__rp_x:active {
      transform: scale(0.92);
    }
    #__rp_panel .__rp_btn:focus-visible,
    #__rp_panel .__rp_cselect_btn:focus-visible,
    #__rp_panel input:focus-visible {
      outline: 2px solid #A89F8C;
      outline-offset: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      #__rp_panel,
      #__rp_panel *,
      #__rp_panel *::before,
      #__rp_panel *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }
  `;
  document.documentElement.appendChild(st);

  const panel = document.createElement("div");
  panel.id = ID;
  panel.style.cssText =
    "position:fixed;z-index:2147483647;right:20px;bottom:20px;width:292px;padding:16px;" +
    "background:#EFEDE5;color:" + INK + ";font:13px/1.5 " + FONT + ";" +
    "border:1px solid #DCD8CC;border-radius:16px;" +
    "box-shadow:0 12px 36px rgba(64,58,42,.18),0 2px 8px rgba(64,58,42,.08);";

  const rowS = "display:flex;align-items:center;gap:10px;margin-bottom:9px";
  const rlbl = "flex:none;width:60px;font-size:11px;font-weight:600;letter-spacing:.02em;color:" + LABEL;
  const ctl = field + "flex:1;min-width:0;margin:0";
  const card = "background:#F4F2EA;border:1px solid #E4E0D4;border-radius:12px;padding:12px;margin-bottom:14px;position:relative";

  panel.innerHTML =
    "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:13px'>" +
    "<span style='display:flex;align-items:baseline;gap:8px'><span style='width:8px;height:8px;border-radius:2px;background:#44413A;align-self:center'></span><span style='font-size:14px;font-weight:600;letter-spacing:-.01em;color:" + INK + "'>앵챗추출기</span>" + (VER ? "<span style='font-size:10px;font-weight:600;letter-spacing:.02em;color:" + FAINT + ";transform:translateY(-0.5px)'>" + VER + "</span>" : "") + "</span>" +
    "<span id='__rp_x' title='닫기'>✕</span></div>" +
    "<div style='" + card + "'>" +
    "<div style='" + rowS + "'><span style='" + rlbl + "'>파일 이름</span><input id='__rp_name' type='text' value='" + DEFAULT_NAME + "' style='" + ctl + "'></div>" +
    "<div style='" + rowS + "'><span style='" + rlbl + "'>파일 형식</span><div id='__rp_fmt_wrap' class='__rp_cselect_wrap'></div></div>" +
    "<div style='" + rowS + "'><span style='" + rlbl + "'>분할 기준</span><div id='__rp_unit_wrap' class='__rp_cselect_wrap'></div></div>" +
    "<div id='__rp_numrow' style='" + rowS + ";margin-bottom:0'><span style='" + rlbl + "'></span><input id='__rp_num' type='number' min='1' value='600000' style='" + ctl + "'><span id='__rp_suffix' style='font-size:12px;color:" + SOFT + ";white-space:nowrap;flex:none'>자마다</span></div>" +
    "<label style='display:flex;align-items:center;gap:8px;margin:12px 0 0;font-size:12px;color:#54514A;cursor:pointer'><input id='__rp_expand' type='checkbox' checked style='width:15px;height:15px;accent-color:" + INK + ";cursor:pointer;flex:none'><span>접힌 토글까지 모두 펼쳐 추출</span></label>" +
    "<div style='height:1px;background:" + LINE + ";margin:12px 0 0'></div>" +
    "<div style='margin:11px 0 0'>" +
    "<div style='font-size:11px;font-weight:600;letter-spacing:.02em;color:" + LABEL + ";margin-bottom:8px'>추출 속도</div>" +
    "<input id='__rp_speed' type='range' min='0' max='4' step='1' value='2'>" +
    "<div style='display:flex;align-items:center;margin-top:7px;font-size:9.5px;letter-spacing:.02em;color:" + FAINT + "'><span style='flex:1;text-align:left'>느림·안전</span><span id='__rp_spdlbl' style='flex:1;text-align:center;font-size:11px;font-weight:700;color:" + INK + "'>보통</span><span style='flex:1;text-align:right'>빠름</span></div>" +
    "</div>" +
    "</div>" +
    "<button id='__rp_auto' class='__rp_btn __rp_auto'>자동 추출</button>" +
    "<div style='height:1px;background:" + LINE + ";margin:13px 2px'></div>" +
    "<div class='__rp_row' style='margin-bottom:8px'><button id='__rp_load' class='__rp_btn __rp_sec'>① 전체 로딩</button><button id='__rp_ext' class='__rp_btn __rp_sec'>② 추출·저장</button></div>" +
    "<button id='__rp_stop' class='__rp_btn __rp_stop'>정지</button>" +
    "<div id='__rp_status' style='margin-top:12px;font-size:11.5px;line-height:1.45;white-space:pre-line;color:" + SOFT + "'>준비됨</div>" +
    "";
  document.body.appendChild(panel);

  const nameInput = panel.querySelector("#__rp_name");
  const numInput = panel.querySelector("#__rp_num");
  const numRow = panel.querySelector("#__rp_numrow");
  const suffix = panel.querySelector("#__rp_suffix");
  const expandChk = panel.querySelector("#__rp_expand");
  const spInput = panel.querySelector("#__rp_speed");
  const spLbl = panel.querySelector("#__rp_spdlbl");
  const bAuto = panel.querySelector("#__rp_auto");
  const bLoad = panel.querySelector("#__rp_load");
  const bExt = panel.querySelector("#__rp_ext");
  const bStop = panel.querySelector("#__rp_stop");
  const statusEl = panel.querySelector("#__rp_status");

  function setStatus(m) { statusEl.textContent = m; }
  function setButtons(running) {
    [bAuto, bLoad, bExt].forEach((b) => { b.disabled = running; });
  }

  // ── 커스텀 셀렉트 컴포넌트 생성자 ──
  const checkSvg = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5L4.8 8.8L9.5 3.5" stroke="#44413A" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const arrowSvg = '<svg class="__rp_cselect_arr" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function createCustomSelect(wrapEl, options, defaultValue, onChange) {
    let currentVal = defaultValue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "__rp_cselect_btn";

    const labelSpan = document.createElement("span");
    labelSpan.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const defaultOpt = options.find((o) => o.value === defaultValue) || options[0];
    labelSpan.textContent = defaultOpt ? defaultOpt.label : "";

    btn.appendChild(labelSpan);
    btn.insertAdjacentHTML("beforeend", arrowSvg);

    const menu = document.createElement("div");
    menu.className = "__rp_cselect_menu";

    function renderOptions() {
      menu.innerHTML = "";
      options.forEach((opt) => {
        const item = document.createElement("div");
        item.className = "__rp_cselect_opt" + (opt.value === currentVal ? " selected" : "");
        item.textContent = opt.label;
        if (opt.value === currentVal) {
          item.insertAdjacentHTML("beforeend", checkSvg);
        }
        item.onclick = (e) => {
          e.stopPropagation();
          setVal(opt.value);
          close();
        };
        menu.appendChild(item);
      });
    }

    function open() {
      document.querySelectorAll("#" + ID + " .__rp_cselect_wrap.open").forEach((el) => {
        if (el !== wrapEl) el.classList.remove("open");
      });
      wrapEl.classList.add("open");
    }
    function close() {
      wrapEl.classList.remove("open");
    }
    function toggle() {
      if (wrapEl.classList.contains("open")) close();
      else open();
    }

    btn.onclick = (e) => {
      e.stopPropagation();
      toggle();
    };

    function setVal(v) {
      currentVal = v;
      const found = options.find((o) => o.value === v);
      if (found) labelSpan.textContent = found.label;
      renderOptions();
      if (typeof onChange === "function") onChange(v);
      if (typeof selObj.onchange === "function") selObj.onchange();
    }

    renderOptions();
    wrapEl.appendChild(btn);
    wrapEl.appendChild(menu);

    const selObj = {
      get value() { return currentVal; },
      set value(v) { setVal(v); },
      onchange: null,
      close,
    };
    return selObj;
  }

  document.addEventListener("click", (e) => {
    if (!panel.contains(e.target)) {
      panel.querySelectorAll(".__rp_cselect_wrap.open").forEach((el) => el.classList.remove("open"));
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      panel.querySelectorAll(".__rp_cselect_wrap.open").forEach((el) => el.classList.remove("open"));
    }
  });

  const selFmt = createCustomSelect(
    panel.querySelector("#__rp_fmt_wrap"),
    [
      { value: "txt", label: "텍스트 (.txt)" },
      { value: "md", label: "마크다운 (.md)" },
      { value: "html", label: "HTML (.html)" },
      { value: "pdf", label: "PDF (.pdf · 인쇄→PDF)" },
    ],
    "txt"
  );

  const selUnit = createCustomSelect(
    panel.querySelector("#__rp_unit_wrap"),
    [
      { value: "none", label: "분할 안 함" },
      { value: "chars", label: "글자 수마다" },
      { value: "count", label: "메시지 개수마다" },
    ],
    "chars"
  );

  function syncUnit() {
    const v = selUnit.value;
    numRow.style.display = v === "none" ? "none" : "flex";
    suffix.textContent = v === "count" ? "개마다" : "자마다";
    const n = parseInt(numInput.value, 10);
    if (v === "count" && (!n || n > 5000)) numInput.value = "50";
    if (v === "chars" && (!n || n < 1000)) numInput.value = "600000";
  }
  selUnit.onchange = syncUnit;
  syncUnit();

  const SPEED_LEVELS = [
    { name: "매우 느림", mult: 2 },
    { name: "느림", mult: 1.4 },
    { name: "보통", mult: 1 },
    { name: "빠름", mult: 0.7 },
    { name: "매우 빠름", mult: 0.45 },
  ];
  function syncSpeed() {
    const lv = SPEED_LEVELS[parseInt(spInput.value, 10)] || SPEED_LEVELS[2];
    SPEED_MULT = lv.mult;
    spLbl.textContent = lv.name;
  }
  spInput.oninput = syncSpeed;
  syncSpeed();

  panel.querySelector("#__rp_x").onclick = () => {
    panel.classList.add("__rp_closing");
    panel.__rp_closeTimer = setTimeout(() => {
      panel.__rp_closeTimer = null;
      panel.classList.remove("__rp_closing");
      panel.style.display = "none";
    }, 150);
  };
  bStop.onclick = () => { stopFlag = true; setStatus("정지 요청…"); };
  bAuto.onclick = () => run(async () => { await preload(true); if (stopFlag) return; await sweepCapture(); saveAll(); });
  bLoad.onclick = () => run(() => preload(false));
  bExt.onclick = () => run(async () => { await sweepCapture(); saveAll(); });

  setStatus("• '자동 추출'을 누르면 한 번에 끝\n• 수동은 ① 전체 로딩 후 ② 추출·저장");
})();
