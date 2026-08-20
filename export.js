(() => {
  const ID = "__rp_panel";
  if (document.getElementById(ID)) {
    const existing = document.getElementById(ID);
    if (existing.__rp_closeTimer) { clearTimeout(existing.__rp_closeTimer); existing.__rp_closeTimer = null; }
    existing.classList.remove("__rp_closing");
    existing.style.display = "block";
    return;
  }

  // ══ 자동 모드 설정 (키우면 더 보수적) ══
  const AUTO_STABLE = 8;   // 높이/메시지가 이 횟수 연속 안 늘어야 “최상단” 판정
  const DWELL = 700;       // 끝에 핀 후 로딩 대기(ms)
  const OSC = 2;           // 한 사이클당 진동 횟수
  let SPEED_MULT = 1;      // 추출 속도 배수(작을수록 빠름) · 슬라이더로 실시간 조절
  const DEFAULT_NAME = "rp_chat";
  const VER = (() => { try { return "v" + chrome.runtime.getManifest().version; } catch (e) { return ""; } })();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const NBSP = String.fromCharCode(160);
  const SEP = "\n\n────────────────────────\n\n";
  const IS_TEAPOT_HOST = /(^|\.)teapotchat\.com$/i.test(location.hostname) && /^\/chat\//.test(location.pathname);
  const IS_CAVEDUCK_HOST = /(^|\.)caveduck\.io$/i.test(location.hostname) && /^\/(?:[a-z]{2}\/)?talk\//i.test(location.pathname);

  function hasStructuredTurnDOM(root = document) {
    const turns = [...root.querySelectorAll("[data-turn-key]")];
    if (!turns.length) return false;
    const sample = turns.slice(0, Math.min(3, turns.length));
    return sample.some((turn) => turn.querySelector("[data-capture-speaker]"));
  }

  // ── 스크롤러 / 리스트 ──
  function findScroller() {
    if (IS_TEAPOT_HOST || hasStructuredTurnDOM()) {
      const turn = document.querySelector("[data-turn-key]");
      for (let el = turn && turn.parentElement; el; el = el.parentElement) {
        const s = getComputedStyle(el);
        if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 200) return el;
      }
      const known = document.querySelector(".chat-viewer-scrollbar-autohide");
      if (known) return known;
    }
    const all = [...document.querySelectorAll("*")].filter((el) => {
      const s = getComputedStyle(el);
      return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 200;
    });
    const rev = all.find((el) => {
      const fd = getComputedStyle(el).flexDirection;
      return fd === "column-reverse" || /flex-col-reverse/.test(el.className || "");
    });
    if (rev) return rev;
    return all.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || document.scrollingElement;
  }
  function scoreOf(el) {
    let n = 0;
    for (const c of el.children) {
      if (c.querySelector("details") || (c.innerText || "").trim().length > 50) n++;
    }
    return n;
  }
  function findList(root) {
    let best = root, score = scoreOf(root);
    root.querySelectorAll("*").forEach((el) => { const sc = scoreOf(el); if (sc > score) { score = sc; best = el; } });
    return best;
  }
  let scroller = findScroller();
  function ensureScroller() {
    if (!scroller || !document.contains(scroller)) scroller = findScroller();
    return scroller;
  }
  function usesTopLoadingStrategy() {
    const root = ensureScroller();
    if (!root) return false;
    if (IS_TEAPOT_HOST) return true;
    if (!hasStructuredTurnDOM(root)) return false;
    const style = getComputedStyle(root);
    return style.flexDirection !== "column-reverse" && !/flex-col-reverse/.test(root.className || "");
  }
  function detectPlatform() {
    const host = location.hostname || "현재 페이지";
    if (IS_TEAPOT_HOST) return { name: host, mode: "안정형 상단 로딩" };
    if (IS_CAVEDUCK_HOST) return { name: host, mode: "역방향 카드 로딩" };
    if (hasStructuredTurnDOM()) return { name: host, mode: usesTopLoadingStrategy() ? "상단 로딩 자동 인식" : "구조형 대화 인식" };
    const root = ensureScroller();
    const reversed = root && (getComputedStyle(root).flexDirection === "column-reverse" || /flex-col-reverse/.test(root.className || ""));
    return { name: host, mode: reversed ? "역방향 스크롤 인식" : "일반 스크롤 인식" };
  }

  // ── 캡처 ──
  let seen = new Set(), blocks = [];
  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return h + ":" + s.length; }
  const stripNbsp = (t) => t.split(NBSP).join(" ");
  function domText(root, includeDetails) {
    const out = [];
    const blockTags = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "DT", "DD", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"]);
    const skipTags = new Set(["BUTTON", "CANVAS", "INPUT", "NOSCRIPT", "SCRIPT", "SELECT", "STYLE", "SVG", "TEXTAREA"]);
    const newline = () => { if (out.length && out[out.length - 1] !== "\n") out.push("\n"); };
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { out.push(node.nodeValue || ""); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const tag = el.tagName;
      if (el.id === ID || skipTags.has(tag) || el.hidden || el.getAttribute("aria-hidden") === "true") return;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      if (tag === "BR") { newline(); return; }
      if (tag === "DETAILS" && !includeDetails && !el.open) {
        const summary = el.querySelector(":scope > summary");
        if (summary) visit(summary);
        newline();
        return;
      }
      const block = blockTags.has(tag);
      if (block) newline();
      if (tag === "LI") out.push("- ");
      for (const child of el.childNodes) visit(child);
      if (block) newline();
    };
    visit(root);
    return stripNbsp(out.join(""))
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  function structuredIntroSpeakers() {
    if (!hasStructuredTurnDOM()) return [];
    const root = ensureScroller();
    if (!root) return [];
    const marked = [...root.querySelectorAll('[data-message-id^="start-"] [data-capture-speaker="llm"], #test-start-message [data-capture-speaker="llm"]')];
    const candidates = marked.length ? marked : [...root.querySelectorAll('[data-capture-speaker="llm"]')]
      .filter((el) => !el.closest('[data-turn-key]'));
    return [...new Set(candidates)].filter((el) => !el.closest('[data-turn-key]'));
  }
  function captureStructuredTurns() {
    if (!hasStructuredTurnDOM()) return false;
    const turns = [...document.querySelectorAll("[data-turn-key]")];
    if (!turns.length) return false;
    const next = [];
    const contentKeys = new Set();
    const add = (text) => {
      const clean = text.trim();
      if (clean.length < 2) return;
      const k = hash(clean);
      if (!contentKeys.has(k)) { contentKeys.add(k); next.push(clean); }
    };
    for (const intro of structuredIntroSpeakers()) add(domText(intro, expandChk.checked));
    const keys = new Set();
    for (const turn of turns) {
      const key = turn.getAttribute("data-turn-key") || "";
      if (key && keys.has(key)) continue;
      if (key) keys.add(key);
      const speakers = [...turn.querySelectorAll("[data-capture-speaker]")]
        .filter((el) => el.closest("[data-turn-key]") === turn);
      const parts = (speakers.length ? speakers : [turn])
        .map((el) => domText(el, expandChk.checked))
        .filter((text) => text.length >= 2);
      const text = parts.join("\n\n").trim();
      add(text);
    }
    blocks = next;
    seen = new Set(blocks.map(hash));
    return true;
  }
  function genericTurnCards(root = ensureScroller()) {
    if (!root) return [];
    const list = findList(root);
    if (!list) return [];
    const children = [...list.children].filter((el) => {
      if (el.id === ID || el.closest("#" + ID)) return false;
      if (["IMG", "NOSCRIPT", "SCRIPT", "STYLE", "SVG"].includes(el.tagName)) return false;
      return (el.innerText || "").trim().length >= 2 || !!el.querySelector("details");
    });
    if (IS_CAVEDUCK_HOST) {
      const messageCards = children.filter((el) => /^chat-message-/i.test(el.id || ""));
      if (messageCards.length) return messageCards;
    }
    return children;
  }
  function messageCount() {
    return hasStructuredTurnDOM()
      ? document.querySelectorAll("[data-turn-key]").length + structuredIntroSpeakers().length
      : genericTurnCards().length;
  }
  function captureVisible() {
    ensureScroller();
    const open = expandChk.checked;
    try { scroller.querySelectorAll("details").forEach((d) => (d.open = open)); } catch (e) {} // 체크면 펼쳐서 본문 포함, 해제면 접어서 요약만
    if (captureStructuredTurns()) return;
    for (const c of genericTurnCards(scroller)) {
      let t = "";
      try { t = domText(c, open); } catch (e) { continue; }
      if (t.length < 2) continue;
      const k = hash(t);
      if (!seen.has(k)) { seen.add(k); blocks.push(t); }
    }
  }

  // ── 적응형 대기 ──
  async function settle(maxMs) {
    const cap = Math.round(maxMs * SPEED_MULT);
    const t0 = performance.now(); let lastLen = -1, stable = 0;
    while (performance.now() - t0 < cap) {
      await raf();
      if (stopFlag) break;
      ensureScroller();
      let len = 0;
      try { len = (hasStructuredTurnDOM(scroller) ? scroller.textContent : scroller.innerText).length; } catch (e) { break; }
      if (len === lastLen) stable++; else stable = 0;
      lastLen = len;
      if (stable >= 2) break;
    }
  }

  let busy = false, stopFlag = false, activeStage = "idle";

  // ── 강한 진동: 끝 → 뷰포트 한 칸 아래 → 다시 끝 (OSC회 반복) ──
  const topLoaderSleep = (ms) => sleep(Math.round(ms * Math.max(1, SPEED_MULT)));
  function expectedWarning(message) {
    const error = new Error(message);
    error.__rpExpected = true;
    return error;
  }
  function signalTopLoaderIntent(delta) {
    try {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -Math.abs(delta), bubbles: true, cancelable: true, view: window }));
      scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", code: "PageUp", bubbles: true, cancelable: true, view: window }));
    } catch (e) {}
  }
  async function dragAwayFromBottom(distance) {
    const ch = scroller.clientHeight || 500;
    const max = Math.max(0, scroller.scrollHeight - ch);
    if (max <= 24 || scroller.scrollTop < max - 24) return true;

    signalTopLoaderIntent(distance);
    scroller.scrollTop = Math.max(0, max - Math.min(48, distance));
    await raf();
    await raf();
    await topLoaderSleep(110);

    const frames = 10;
    for (let frame = 1; frame <= frames && !stopFlag; frame++) {
      const freshMax = Math.max(0, scroller.scrollHeight - (scroller.clientHeight || ch));
      const target = Math.max(0, freshMax - distance);
      const progress = frame / frames;
      const eased = 1 - Math.pow(1 - progress, 2);
      scroller.scrollTop = Math.round(freshMax + (target - freshMax) * eased);
      if (frame === 5) signalTopLoaderIntent(distance);
      await raf();
      await topLoaderSleep(22);
    }
    await topLoaderSleep(360);
    const freshMax = Math.max(0, scroller.scrollHeight - (scroller.clientHeight || ch));
    return freshMax <= 24 || scroller.scrollTop < freshMax - 24;
  }
  async function detachBottomFollow() {
    const ch = scroller.clientHeight || 500;
    for (let attempt = 0; attempt < 4 && !stopFlag; attempt++) {
      const max = Math.max(0, scroller.scrollHeight - ch);
      if (max <= 24 || scroller.scrollTop < max - 24) return true;
      const nudge = Math.min(max, Math.max(220, Math.round(ch * (0.45 + attempt * 0.15))));
      if (await dragAwayFromBottom(nudge)) return true;
    }
    const max = Math.max(0, scroller.scrollHeight - (scroller.clientHeight || 500));
    return max <= 24 || scroller.scrollTop < max - 24;
  }
  async function moveTopLoadingChatToTop() {
    const ch = scroller.clientHeight || 500;
    if (!(await detachBottomFollow())) return false;
    await topLoaderSleep(360);

    let snaps = 0, stalled = 0, previousHeight = scroller.scrollHeight;
    for (let i = 0; i < 1200 && !stopFlag; i++) {
      const current = scroller.scrollTop;
      if (current <= 4) {
        scroller.scrollTop = 0;
        await topLoaderSleep(850);
        if (scroller.scrollTop <= 4) return true;
        previousHeight = scroller.scrollHeight;
        continue;
      }

      const nearTop = current < ch * 4;
      const step = nearTop
        ? Math.max(160, Math.min(280, Math.round(ch * 0.5)))
        : Math.max(320, Math.min(560, Math.round(ch * 0.95)));
      const target = Math.max(0, current - step);
      const frames = nearTop ? 5 : 3;
      signalTopLoaderIntent(step);
      for (let frame = 1; frame <= frames && !stopFlag; frame++) {
        const progress = frame / frames;
        scroller.scrollTop = Math.round(current + (target - current) * progress);
        await raf();
        await topLoaderSleep(nearTop ? 24 : 18);
      }
      await topLoaderSleep(nearTop ? 120 : 70);

      const next = scroller.scrollTop;
      const nextHeight = scroller.scrollHeight;
      const loadedOlder = nextHeight > previousHeight + 20;
      previousHeight = nextHeight;
      if (loadedOlder) {
        snaps = 0;
        stalled = 0;
        await topLoaderSleep(420);
        continue;
      }
      if (next > current + Math.max(300, ch * 0.8)) {
        snaps++;
        if (snaps > 3 || !(await detachBottomFollow())) return false;
        await topLoaderSleep(420);
        continue;
      }
      snaps = 0;
      if (next >= current - 8) {
        stalled++;
        if (stalled > 4) return false;
        await topLoaderSleep(280);
      } else {
        stalled = 0;
      }
    }
    return scroller.scrollTop <= 4;
  }
  async function oscillate() {
    ensureScroller();
    const ch = scroller.clientHeight || 500;
    if (usesTopLoadingStrategy()) {
      const bounce = Math.max(72, Math.min(140, Math.round(ch * 0.2)));
      if (!(await moveTopLoadingChatToTop())) throw expectedWarning("채팅 영역의 하단 자동 추적을 해제하지 못했습니다. 채팅 영역을 위로 살짝 스크롤한 뒤 다시 시도하세요.");
      scroller.scrollTop = bounce;
      await topLoaderSleep(260);
      if (!(await moveTopLoadingChatToTop())) throw expectedWarning("채팅 영역의 상단 고정이 풀렸습니다. 채팅 영역을 위로 살짝 스크롤한 뒤 다시 시도하세요.");
      await topLoaderSleep(520);
      return;
    }
    for (let k = 0; k < OSC; k++) {
      scroller.scrollTop = -1e9;            // 가장 오래된 쪽 극단
      await sleep(Math.round(DWELL * SPEED_MULT));
      if (stopFlag) return;
      scroller.scrollTop = scroller.scrollTop + ch; // 한 칸 아래로 크게
      await sleep(Math.round(220 * SPEED_MULT));
    }
    scroller.scrollTop = -1e9;
    await sleep(Math.round(260 * SPEED_MULT));
  }

  // ── ①/▶ 전체 로딩 (auto=false: ■ 정지까지 / auto=true: 자동 판정 종료) ──
  async function preload(auto) {
    let i = 0; const MAX = 50000;
    let last = "", stable = 0;
    while (!stopFlag && i < MAX) {
      i++;
      await oscillate();
      if (stopFlag) break;
      const sh = Math.round(scroller.scrollHeight);
      const d = messageCount();
      const structured = hasStructuredTurnDOM(scroller);
      const firstTurn = structured ? document.querySelector("[data-turn-key]") : null;
      const intro = structured ? structuredIntroSpeakers()[0] : null;
      const cards = structured ? [] : genericTurnCards(scroller);
      const f = cards[0];
      const firstMark = intro
        ? ((intro.closest("[data-message-id]") || {}).dataset?.messageId || "start") + ":" + (intro.textContent || "").length
        : (firstTurn ? firstTurn.getAttribute("data-turn-key") : (f ? (f.innerText || f.textContent || "").slice(0, 60) : ""));
      const m = sh + "|" + d + "|" + firstMark;
      if (auto) {
        if (m === last) stable++; else { stable = 0; last = m; }
        setStatus(
          "대화 시작점에서 마지막으로 확인 중\n" +
          "메시지 " + d.toLocaleString() + "개 · 변화 없음 " + stable + "/" + AUTO_STABLE + "\n" +
          "바로 저장",
          ["정지", "② 추출·저장"]
        );
        if (stable >= AUTO_STABLE) break;
      } else {
        setStatus(
          "대화 시작점에서 이전 대화를 계속 확인 중\n" +
          "메시지 " + d.toLocaleString() + "개 · 확인 " + i.toLocaleString() + "회\n" +
          "충분히 불러왔다면",
          ["정지", "② 추출·저장"]
        );
      }
    }
  }

  // ── 수집 스윗 ──
  async function sweepCapture() {
    scroller = findScroller();
    seen = new Set(); blocks = [];
    if (usesTopLoadingStrategy()) {
      let reachedTop = false;
      for (let attempt = 0; attempt < 6 && !stopFlag; attempt++) {
        if (!(await moveTopLoadingChatToTop())) throw expectedWarning("채팅 목록의 시작점으로 이동하지 못했습니다. 채팅 영역을 위로 살짝 스크롤한 뒤 다시 시도하세요.");
        await settle(700);
        captureVisible();
        const hasStartContent = structuredIntroSpeakers().length || document.querySelector("[data-turn-key]");
        if (scroller.scrollTop <= 2 && hasStartContent) { reachedTop = true; break; }
        await topLoaderSleep(220);
      }
      if (!reachedTop && !stopFlag) throw expectedWarning("대화의 시작 부분이 아직 로드되지 않았습니다. 먼저 전체 로딩을 실행해 주세요.");

      const ch = scroller.clientHeight || 500;
      const step = Math.max(ch * 0.8, 300);
      let pos = scroller.scrollTop;
      let max = Math.max(0, scroller.scrollHeight - ch);
      let s = 0;
      while (pos < max - 2 && s < 8000 && !stopFlag) {
        s++;
        max = Math.max(0, scroller.scrollHeight - ch);
        pos = Math.min(pos + step, max);
        scroller.scrollTop = pos;
        await settle(350);
        captureVisible();
        const pct = Math.round((pos / (max || 1)) * 100);
        setStatus("대화를 파일로 정리하는 중\n진행 " + pct + "% · " + blocks.length.toLocaleString() + "개 수집");
      }
      max = Math.max(0, scroller.scrollHeight - ch);
      scroller.scrollTop = max;
      await settle(350);
      captureVisible();
      setStatus("대화 수집 완료 · 파일 저장 중\n" + blocks.length.toLocaleString() + "개 수집됨");
      return;
    }
    scroller.scrollTop = -1e9; await sleep(120); const a1 = scroller.scrollTop;
    scroller.scrollTop = 1e9; await sleep(120); const a2 = scroller.scrollTop;
    const min = Math.min(a1, a2), max = Math.max(a1, a2);
    const ch = scroller.clientHeight || 500; const step = Math.max(ch * 0.8, 300);
    let pos = min; scroller.scrollTop = min; await settle(350); captureVisible();
    let s = 0;
    while (pos < max - 2 && s < 8000 && !stopFlag) {
      s++; pos = Math.min(pos + step, max); scroller.scrollTop = pos; await settle(350); captureVisible();
      const pct = Math.round(((pos - min) / ((max - min) || 1)) * 100);
      setStatus("대화를 파일로 정리하는 중\n진행 " + pct + "% · " + blocks.length.toLocaleString() + "개 수집");
    }
    scroller.scrollTop = max; await settle(350); captureVisible();
    scroller.scrollTop = 0;
    setStatus("대화 수집 완료 · 파일 저장 중\n" + blocks.length.toLocaleString() + "개 수집됨");
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
    setTimeout(() => { try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch (e) { setStatus("인쇄 창을 열지 못했습니다\n" + (e && e.message)); } }, 500);
    return true;
  }
  function saveAll() {
    if (!blocks.length) { setStatus("저장할 대화를 찾지 못했습니다.", ["① 전체 로딩", "② 추출·저장"]); return; }
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
      setStatus("인쇄 창을 열었습니다.\n대상에서 PDF로 저장을 선택하세요.\n대화 " + blocks.length.toLocaleString() + "개" + (groups.length > 1 ? " · " + groups.length.toLocaleString() + "구간" : ""));
      nameInput.value = DEFAULT_NAME;
      return;
    }
    const ext = fmt === "md" ? "md" : fmt === "html" ? "html" : "txt";
    const mime = fmt === "md" ? "text/markdown;charset=utf-8" : fmt === "html" ? "text/html;charset=utf-8" : "text/plain;charset=utf-8";
    const make = (g) => fmt === "html" ? htmlDoc(g.join(SEP), base) : g.join(SEP);
    if (groups.length === 1) {
      dlBlob(base + "." + ext, new Blob([make(groups[0])], { type: mime }));
      setStatus("저장 완료\n대화 " + blocks.length.toLocaleString() + "개 · 1파일(." + ext + ")\n약 " + chars.toLocaleString() + "자");
    } else {
      const enc = new TextEncoder();
      const files = groups.map((g, i) => ({
        name: base + "/" + base + "_part" + String(i + 1).padStart(2, "0") + "of" + groups.length + "." + ext,
        data: enc.encode(make(g)),
      }));
      const zip = makeZip(files);
      dlBlob(base + ".zip", new Blob([zip], { type: "application/zip" }));
      setStatus("저장 완료\n대화 " + blocks.length.toLocaleString() + "개 · " + groups.length.toLocaleString() + "파일(ZIP · ." + ext + ")\n약 " + chars.toLocaleString() + "자");
    }
    nameInput.value = DEFAULT_NAME; // 다운로드 시작 후 파일명 리셋
  }

  // ── 실행 가드 ──
  function showStoppedStatus(stage) {
    if (stage === "loading") {
      setStatus(
        "작업이 중단되었습니다.\n" +
        "메시지 " + messageCount().toLocaleString() + "개 확인",
        ["② 추출·저장"]
      );
      return;
    }
    setStatus("작업이 중단되었습니다.\n파일은 저장되지 않았습니다.");
  }
  async function run(fn, initialStage) {
    if (busy) return;
    busy = true; stopFlag = false; activeStage = initialStage; setButtons(true);
    try {
      await fn();
    } catch (e) {
      const message = (e && e.message) || String(e);
      if (e && e.__rpExpected) {
        setStatus("자동 진행을 잠시 멈췄습니다\n" + message + "\n안내대로 조정한 뒤 다시 실행하세요.");
      } else {
        setStatus("예상하지 못한 오류가 발생했습니다\n" + message);
        console.error("[앵챗추출기]", e);
      }
    }
    const stopped = stopFlag, stoppedStage = activeStage;
    busy = false; activeStage = "idle"; setButtons(false);
    if (stopped) showStoppedStatus(stoppedStage);
  }

  // ── 패널 UI (Cloud Dancer 톤 & Emil Kowalski 인터랙션 가이드) ──
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Apple SD Gothic Neo','Malgun Gothic',sans-serif";
  const INK = "#44413A", LABEL = "#A8A395", SOFT = "#6E695D", FAINT = "#BCB6A6", LINE = "#E0DCD0";
  const field = "display:block;width:100%;box-sizing:border-box;padding:8px 11px;background:#FAF9F4;color:" + INK + ";border:1px solid #D7D2C6;border-radius:10px;outline:none;font:500 13px/1.3 " + FONT + ";transition:border-color 140ms ease-out,box-shadow 140ms ease-out;";

  // 호스트 페이지 간섭 방지 및 고품질 애니메이션 스타일시트
  const st = document.createElement("style");
  st.textContent = `
    @keyframes __rp_fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes __rp_fadeOut {
      to { opacity: 0; }
    }
    #${ID} {
      animation: __rp_fadeIn 160ms cubic-bezier(0.23, 1, 0.32, 1);
      user-select: none;
      transform: scale(var(--rp-scale, 1));
      transform-origin: bottom right;
    }
    #${ID}.__rp_closing {
      animation: __rp_fadeOut 150ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
    }
    #${ID} input[type=text]:focus,
    #${ID} input[type=number]:focus {
      border-color: #A89F8C !important;
      box-shadow: 0 0 0 3px rgba(122, 112, 92, 0.14) !important;
    }
    #${ID} .__rp_btn {
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
    #${ID} .__rp_btn:active {
      transform: scale(0.975) !important;
    }
    #${ID} .__rp_auto {
      border: 1px solid #38352D !important;
      background: #44413A !important;
      color: #FAF8F2 !important;
      font-weight: 700 !important;
      box-shadow: 0 1px 3px rgba(64, 58, 42, 0.18) !important;
    }
    #${ID} .__rp_auto:hover {
      background: #4E4B42 !important;
      box-shadow: 0 2px 5px rgba(64, 58, 42, 0.22) !important;
    }
    #${ID} .__rp_sec {
      border: 1px solid #CBC5B7 !important;
      background: #E8E4D9 !important;
      color: #3A3830 !important;
      box-shadow: 0 1px 2px rgba(64, 58, 42, 0.05) !important;
    }
    #${ID} .__rp_sec:hover {
      background: #DFDACD !important;
      box-shadow: 0 2px 4px rgba(64, 58, 42, 0.08) !important;
    }
    #${ID} .__rp_stop {
      border: 1px solid #DFCBC0 !important;
      background: #F1E7E1 !important;
      color: #A0473A !important;
      box-shadow: 0 1px 2px rgba(120, 70, 55, 0.05) !important;
    }
    #${ID} .__rp_stop:hover {
      background: #EBDCD4 !important;
      box-shadow: 0 2px 4px rgba(120, 70, 55, 0.08) !important;
    }
    #${ID} .__rp_btn:disabled {
      opacity: 0.45 !important;
      cursor: not-allowed !important;
      transform: none !important;
    }
    #${ID} .__rp_row {
      display: flex !important;
      gap: 8px !important;
    }
    #${ID} .__rp_row .__rp_btn {
      margin: 0 !important;
    }
    #${ID} .__rp_check_label {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin: 12px 0 0;
      font-size: 12px;
      color: #54514A;
      cursor: pointer;
      position: relative;
    }
    #${ID} .__rp_check_input {
      position: absolute !important;
      width: 1px !important;
      height: 1px !important;
      margin: -1px !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }
    #${ID} .__rp_check_box {
      width: 16px;
      height: 16px;
      flex: none;
      margin-top: 1px;
      border: 1px solid #AFA99A;
      border-radius: 4px;
      background: #FAF9F4;
      box-sizing: border-box;
      position: relative;
      transition: background 120ms ease-out, border-color 120ms ease-out, box-shadow 120ms ease-out;
    }
    #${ID} .__rp_check_box::after {
      content: "";
      position: absolute;
      left: 5px;
      top: 2px;
      width: 4px;
      height: 8px;
      border: solid #FAF8F2;
      border-width: 0 2px 2px 0;
      transform: rotate(45deg) scale(0.6);
      opacity: 0;
      transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1), opacity 100ms ease-out;
    }
    #${ID} .__rp_check_input:checked + .__rp_check_box {
      background: ${INK};
      border-color: ${INK};
    }
    #${ID} .__rp_check_input:checked + .__rp_check_box::after {
      transform: rotate(45deg) scale(1);
      opacity: 1;
    }
    #${ID} .__rp_check_input:focus-visible + .__rp_check_box {
      outline: 2px solid #A89F8C;
      outline-offset: 2px;
    }
    #${ID} .__rp_status_card {
      margin-top: 12px;
      padding: 10px 11px;
      border: 1px solid #DDD8CB;
      border-radius: 10px;
      background: #F7F5EE;
      font-size: 11.5px;
      line-height: 1.45;
      color: ${SOFT};
    }
    #${ID} .__rp_status_actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 7px;
    }
    #${ID} .__rp_action_chip {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 8px;
      border: 1px solid #D4CFC2;
      border-radius: 999px;
      background: #ECE8DD;
      color: ${INK};
      font-size: 10.5px;
      font-weight: 700;
      line-height: 1;
      white-space: nowrap;
    }
    #${ID} .__rp_action_sep {
      color: ${FAINT};
      font-size: 11px;
    }
    #${ID} .__rp_resize {
      position: absolute;
      z-index: 2147483647;
      touch-action: none;
    }
    #${ID} .__rp_resize[data-dir="n"] { top: -6px; left: 14px; right: 14px; height: 12px; cursor: ns-resize; }
    #${ID} .__rp_resize[data-dir="s"] { bottom: -6px; left: 14px; right: 14px; height: 12px; cursor: ns-resize; }
    #${ID} .__rp_resize[data-dir="w"] { left: -6px; top: 14px; bottom: 14px; width: 12px; cursor: ew-resize; }
    #${ID} .__rp_resize[data-dir="e"] { right: -6px; top: 14px; bottom: 14px; width: 12px; cursor: ew-resize; }
    #${ID} .__rp_resize[data-dir="nw"] { top: -7px; left: -7px; width: 18px; height: 18px; cursor: nwse-resize; }
    #${ID} .__rp_resize[data-dir="ne"] { top: -7px; right: -7px; width: 18px; height: 18px; cursor: nesw-resize; }
    #${ID} .__rp_resize[data-dir="sw"] { bottom: -7px; left: -7px; width: 18px; height: 18px; cursor: nesw-resize; }
    #${ID} .__rp_resize[data-dir="se"] { bottom: -7px; right: -7px; width: 18px; height: 18px; cursor: nwse-resize; }
    #${ID} input[type=range] {
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
    #${ID} input[type=range]::-webkit-slider-thumb {
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
    #${ID} input[type=range]::-webkit-slider-thumb:hover {
      transform: scale(1.15) !important;
      box-shadow: 0 2px 6px rgba(64, 58, 42, 0.35) !important;
    }
    #${ID} input[type=range]::-webkit-slider-thumb:active {
      transform: scale(1.25) !important;
    }
    #${ID} input[type=range]::-moz-range-thumb {
      width: 16px !important;
      height: 16px !important;
      border-radius: 50% !important;
      background: #44413A !important;
      border: 2px solid #FAF8F2 !important;
      box-shadow: 0 1px 3px rgba(64, 58, 42, 0.25) !important;
      cursor: pointer !important;
      transition: transform 120ms ease-out, box-shadow 120ms ease-out !important;
    }
    #${ID} input[type=range]::-moz-range-thumb:hover {
      transform: scale(1.15) !important;
    }
    #${ID} input[type=range]::-moz-range-thumb:active {
      transform: scale(1.25) !important;
    }
    /* ── 커스텀 셀렉트 UI ── */
    #${ID} .__rp_cselect_wrap {
      position: relative;
      flex: 1;
      min-width: 0;
    }
    #${ID} .__rp_cselect_btn {
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
    #${ID} .__rp_cselect_btn:hover {
      background: #FDFCF8 !important;
      border-color: #C5BFB1 !important;
    }
    #${ID} .__rp_cselect_btn:active {
      transform: scale(0.985) !important;
    }
    #${ID} .__rp_cselect_wrap.open .__rp_cselect_btn {
      border-color: #A89F8C !important;
      box-shadow: 0 0 0 3px rgba(122, 112, 92, 0.14) !important;
      background: #FAF9F4 !important;
    }
    #${ID} .__rp_cselect_arr {
      flex: none;
      margin-left: 6px;
      color: ${SOFT};
      transition: transform 180ms cubic-bezier(0.23, 1, 0.32, 1) !important;
    }
    #${ID} .__rp_cselect_wrap.open .__rp_cselect_arr {
      transform: rotate(180deg) !important;
    }
    #${ID} .__rp_cselect_menu {
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
    #${ID} .__rp_cselect_wrap.open .__rp_cselect_menu {
      opacity: 1;
      transform: scale(1) translateY(0);
      pointer-events: auto;
      transition: opacity 160ms ease-out, transform 160ms cubic-bezier(0.23, 1, 0.32, 1);
    }
    #${ID} .__rp_cselect_opt {
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
    #${ID} .__rp_cselect_opt:hover {
      background: #EFECE3;
      color: #2B2924;
    }
    #${ID} .__rp_cselect_opt.selected {
      background: #E5E0D2;
      font-weight: 600;
      color: #2B2924;
    }
    #${ID} .__rp_cselect_opt svg {
      flex: none;
      margin-left: 6px;
    }
    #${ID} #__rp_x {
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
    #${ID} #__rp_x:hover {
      background: #E4E0D4;
      color: ${INK};
    }
    #${ID} #__rp_x:active {
      transform: scale(0.92);
    }
    #${ID} .__rp_btn:focus-visible,
    #${ID} .__rp_cselect_btn:focus-visible,
    #${ID} input:focus-visible {
      outline: 2px solid #A89F8C;
      outline-offset: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      #${ID},
      #${ID} *,
      #${ID} *::before,
      #${ID} *::after {
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
    "box-shadow:0 12px 36px rgba(64,58,42,.18),0 2px 8px rgba(64,58,42,.08);--rp-scale:1;";

  const rowS = "display:flex;align-items:center;gap:10px;margin-bottom:9px";
  const rlbl = "flex:none;width:60px;font-size:11px;font-weight:600;letter-spacing:.02em;color:" + LABEL;
  const ctl = field + "flex:1;min-width:0;margin:0";
  const card = "background:#F4F2EA;border:1px solid #E4E0D4;border-radius:12px;padding:12px;margin-bottom:14px;position:relative";
  const platform = detectPlatform();

  panel.innerHTML =
    "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:13px'>" +
    "<span style='display:flex;align-items:baseline;gap:8px'><span style='width:8px;height:8px;border-radius:2px;background:#44413A;align-self:center'></span><span style='font-size:14px;font-weight:600;letter-spacing:-.01em;color:" + INK + "'>앵챗추출기</span>" + (VER ? "<span style='font-size:10px;font-weight:600;letter-spacing:.02em;color:" + FAINT + ";transform:translateY(-0.5px)'>" + VER + "</span>" : "") + "</span>" +
    "<span id='__rp_x' title='닫기'>✕</span></div>" +
    "<div style='background:#E7E3D8;border:1px solid #D9D4C7;border-radius:10px;padding:8px 10px;margin-bottom:11px'>" +
    "<div style='display:flex;align-items:center;justify-content:space-between;gap:10px'><span style='font-size:10.5px;font-weight:600;letter-spacing:.02em;color:" + LABEL + "'>인식된 플랫폼</span><strong style='font-size:12px;color:" + INK + ";font-weight:700'>" + platform.name + "</strong></div>" +
    "<div style='margin-top:2px;text-align:right;font-size:10.5px;color:" + SOFT + "'>" + platform.mode + "</div></div>" +
    "<div style='" + card + "'>" +
    "<div style='" + rowS + "'><span style='" + rlbl + "'>파일 이름</span><input id='__rp_name' type='text' value='" + DEFAULT_NAME + "' style='" + ctl + "'></div>" +
    "<div style='" + rowS + "'><span style='" + rlbl + "'>파일 형식</span><div id='__rp_fmt_wrap' class='__rp_cselect_wrap'></div></div>" +
    "<div style='" + rowS + "'><span style='" + rlbl + "'>분할 기준</span><div id='__rp_unit_wrap' class='__rp_cselect_wrap'></div></div>" +
    "<div id='__rp_numrow' style='" + rowS + ";margin-bottom:0'><span style='" + rlbl + "'></span><input id='__rp_num' type='number' min='1' value='600000' style='" + ctl + "'><span id='__rp_suffix' style='font-size:12px;color:" + SOFT + ";white-space:nowrap;flex:none'>자마다</span></div>" +
    "<label class='__rp_check_label'><input id='__rp_expand' class='__rp_check_input' type='checkbox' checked><span class='__rp_check_box' aria-hidden='true'></span><span>상태창·위젯 등 접힌 토글도 펼쳐서 추출</span></label>" +
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
    "<div id='__rp_status' class='__rp_status_card'>준비됨</div>" +
    "";
  document.body.appendChild(panel);

  for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
    const handle = document.createElement("div");
    handle.className = "__rp_resize";
    handle.dataset.dir = dir;
    handle.setAttribute("aria-hidden", "true");
    panel.appendChild(handle);
  }

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

  function setStatus(m, actions = []) {
    statusEl.replaceChildren();
    String(m).split("\n").forEach((line, index) => {
      const row = document.createElement("div");
      row.textContent = line;
      row.style.cssText = index === 0
        ? "font-weight:650;color:" + INK + ";letter-spacing:-.005em"
        : "margin-top:2px;color:" + SOFT;
      statusEl.appendChild(row);
    });
    if (actions.length) {
      const actionRow = document.createElement("div");
      actionRow.className = "__rp_status_actions";
      actions.forEach((label, index) => {
        if (index) {
          const sep = document.createElement("span");
          sep.className = "__rp_action_sep";
          sep.textContent = "→";
          actionRow.appendChild(sep);
        }
        const chip = document.createElement("span");
        chip.className = "__rp_action_chip";
        chip.textContent = label;
        actionRow.appendChild(chip);
      });
      statusEl.appendChild(actionRow);
    }
  }
  function setButtons(running) {
    [bAuto, bLoad, bExt].forEach((b) => { b.disabled = running; });
  }

  // ── 패널 비례 크기 조절: 우측 하단 고정, 8방향 포인터 입력 ──
  const MIN_PANEL_SCALE = 0.58, MAX_PANEL_SCALE = 1.1;
  let panelScale = 1, resizing = false;
  const clampScale = (value) => Math.max(MIN_PANEL_SCALE, Math.min(MAX_PANEL_SCALE, value));
  function viewportScaleLimit() {
    const width = panel.offsetWidth || 326;
    const height = panel.offsetHeight || 1;
    return clampScale(Math.min(MAX_PANEL_SCALE, (innerWidth - 32) / width, (innerHeight - 32) / height));
  }
  function setPanelScale(value, respectViewport = true) {
    const limit = respectViewport ? viewportScaleLimit() : MAX_PANEL_SCALE;
    panelScale = clampScale(Math.min(value, limit));
    panel.style.setProperty("--rp-scale", panelScale.toFixed(3));
  }
  function fitPanelToViewport() {
    const limit = viewportScaleLimit();
    if (panelScale > limit) setPanelScale(limit, false);
  }
  panel.querySelectorAll(".__rp_resize").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (resizing || (event.button !== undefined && event.button !== 0)) return;
      resizing = true;
      event.preventDefault();
      const dir = handle.dataset.dir || "se";
      const startX = event.clientX, startY = event.clientY, startScale = panelScale;
      const rect = panel.getBoundingClientRect();
      const startWidth = Math.max(1, rect.width), startHeight = Math.max(1, rect.height);
      handle.setPointerCapture(event.pointerId);

      const move = (next) => {
        const dx = next.clientX - startX, dy = next.clientY - startY;
        const changes = [];
        if (dir.includes("w")) changes.push(-dx / startWidth);
        if (dir.includes("e")) changes.push(dx / startWidth);
        if (dir.includes("n")) changes.push(-dy / startHeight);
        if (dir.includes("s")) changes.push(dy / startHeight);
        const change = changes.reduce((sum, value) => sum + value, 0) / Math.max(1, changes.length);
        setPanelScale(startScale * (1 + change));
      };
      const finish = () => {
        resizing = false;
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
    });
  });
  const panelResizeObserver = new ResizeObserver(fitPanelToViewport);
  panelResizeObserver.observe(panel);
  window.addEventListener("resize", fitPanelToViewport, { passive: true });
  requestAnimationFrame(fitPanelToViewport);

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

  // 외부 클릭 및 Escape 키 처리
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
    "none"
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
  bStop.onclick = () => {
    if (!busy) {
      setStatus("진행 중인 작업이 없습니다.");
      return;
    }
    stopFlag = true;
    setStatus("작업을 중단하는 중입니다.\n잠시만 기다려 주세요.");
  };
  bAuto.onclick = () => run(async () => {
    await preload(true);
    if (stopFlag) return;
    activeStage = "collecting";
    await sweepCapture();
    if (!stopFlag) saveAll();
  }, "loading");
  bLoad.onclick = () => run(() => preload(false), "loading");
  bExt.onclick = () => run(async () => { await sweepCapture(); if (!stopFlag) saveAll(); }, "collecting");

  setStatus("준비되었습니다.\n자동 또는 수동 방식을 선택하세요.");
})();
