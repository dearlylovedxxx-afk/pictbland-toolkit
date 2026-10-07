// ==UserScript==
// @name         pictBLand 小説TXTツール
// @namespace    local.pictbland.novel-text-tools
// @version      0.3.19
// @description  pictBLandツールを1つのボタンに統合。小説TXT化・画像一括保存・保存検索に対応します。
// @match        https://pictbland.net/*
// @run-at       document-idle
// @noframes
// @grant        GM.download
// @grant        GM.xmlhttpRequest
// @require      https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
// @connect      pictbland.net
// @connect      *.pictbland.net
// @updateURL    https://raw.githubusercontent.com/dearlylovedxxx-afk/pictbland-toolkit/main/PictBLand_Novel_Tools.meta.js
// @downloadURL  https://raw.githubusercontent.com/dearlylovedxxx-afk/pictbland-toolkit/main/PictBLand_Novel_Tools.user.js
// ==/UserScript==

(() => {
  'use strict';
  if (window.__pictblandNovelTextToolsV010) return;
  window.__pictblandNovelTextToolsV010 = true;

  const ROOT_ID = 'pbnt-root';
  const BUTTON_ID = 'pbnt-button';
  const STYLE_ID = 'pbnt-style';

  let overlay = null;
  let pagesHost = null;
  let statusNode = null;
  let metaToggle = null;
  let indentModeSelect = null;
  let dialogueSpacingToggle = null;
  let titleInput = null;
  let original = null;

  function normalizeNewlines(text) {
    return String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0085\u2028\u2029]/g, '\n');
  }

  function normalizeTxtPunctuation(text) {
    return String(text ?? '')
      .replace(/\u203C\uFE0F?/g, '！！')
      .replace(/\u2049\uFE0F?/g, '！？')
      .replace(/\u2047\uFE0F?/g, '？？')
      .replace(/\u2048\uFE0F?/g, '？！')
      .replace(/\u2757\uFE0F?/g, '！')
      .replace(/\u2753\uFE0F?/g, '？')
      .replace(/!/g, '！')
      .replace(/\?/g, '？');
  }

  function cleanupPlainText(text, maxBreaks = 3) {
    const re = new RegExp('\\n{' + (maxBreaks + 1) + ',}', 'g');
    return normalizeNewlines(text)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(re, '\n'.repeat(maxBreaks))
      .replace(/^\n+|\n+$/g, '');
  }

  function renderedDocumentText() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll(
      'script,style,noscript,svg,canvas,iframe,#' + ROOT_ID + ',#' + BUTTON_ID
    ).forEach(node => node.remove());

    clone.querySelectorAll('ruby').forEach(ruby => {
      const reading = [...ruby.querySelectorAll('rt')]
        .map(rt => rt.textContent || '')
        .join('')
        .trim();
      const copy = ruby.cloneNode(true);
      copy.querySelectorAll('rt,rp').forEach(n => n.remove());
      const base = (copy.textContent || '').trim();
      ruby.replaceWith(document.createTextNode(base));
    });

    const blockTags = new Set([
      'ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DIV','DL','DT','DD','FIELDSET','FIGCAPTION',
      'FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LI','MAIN',
      'NAV','OL','P','PRE','SECTION','TABLE','TBODY','THEAD','TFOOT','TR','UL','BUTTON'
    ]);
    const ignoredTags = new Set(['IMG','PICTURE','SOURCE','VIDEO','AUDIO']);

    const out = [];
    const pushBreak = () => {
      if (!out.length || out[out.length - 1] !== '\n') out.push('\n');
    };

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        out.push(node.nodeValue || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName;
      if (ignoredTags.has(tag)) return;
      if (tag === 'BR' || tag === 'HR') {
        pushBreak();
        return;
      }

      const block = blockTags.has(tag);
      if (block) pushBreak();
      for (const child of node.childNodes) walk(child);
      if (block) pushBreak();
    }

    walk(clone);
    return normalizeNewlines(out.join(''))
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{5,}/g, '\n\n\n\n');
  }

  function parseMarker(line) {
    const compact = String(line || '').replace(/\u00a0/g, ' ').trim();
    if (!compact || compact.length > 100) return null;

    const match = compact.match(/(\d+)\s*\/\s*(\d+)/);
    if (!match) return null;

    const page = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isInteger(page) || !Number.isInteger(total) || page < 1 || total < 1 || page > total || total > 500) {
      return null;
    }

    const rest = compact
      .replace(match[0], '')
      .replace(/[|｜・·\s]/g, '');
    if (rest && !/^(?:前のページ)?(?:次のページ)?$/.test(rest)) return null;

    return { page, total };
  }

  function cleanExtractedSegment(lines) {
    const navOnly = /^(?:前のページ|次のページ|前頁|次頁|前へ|次へ|作品に戻る|縦狭|縦普|縦広|横極|横狭|横普|無|ゴ|明)(?:\s*[>＞›»〈<])?$/;
    const out = lines
      .map(line => String(line || '').replace(/[ \t]+$/g, ''))
      .filter(line => !navOnly.test(line.trim()));

    return cleanupPlainText(out.join('\n'), 3);
  }

  function extractPagesFromDocument() {
    const snapshot = renderedDocumentText();
    const lines = snapshot.split('\n');
    const markers = [];

    for (let i = 0; i < lines.length; i++) {
      const info = parseMarker(lines[i]);
      if (info) markers.push({ index: i, ...info });
    }

    if (!markers.length) {
      throw new Error('ページ番号（例：1 / 3）を見つけられませんでした。小説作品ページか確認してください。');
    }

    const byTotal = new Map();
    for (const marker of markers) {
      if (!byTotal.has(marker.total)) byTotal.set(marker.total, []);
      byTotal.get(marker.total).push(marker);
    }

    const rankedTotals = [...byTotal.entries()]
      .map(([total, list]) => ({
        total,
        list,
        distinct: new Set(list.map(m => m.page)).size
      }))
      .filter(g => g.list.some(m => m.page === 1))
      .sort((a, b) => (b.distinct * 1000 + b.list.length) - (a.distinct * 1000 + a.list.length));

    if (!rankedTotals.length) throw new Error('小説ページの区切りを判定できませんでした。');

    const chosen = rankedTotals[0];
    const chosenMarkers = chosen.list;
    const markerIndexes = new Set(chosenMarkers.map(m => m.index));
    const pages = [];

    for (let page = 1; page <= chosen.total; page++) {
      const occurrences = chosenMarkers.filter(m => m.page === page).map(m => m.index).sort((a, b) => a - b);
      const candidates = [];

      for (let j = 0; j < occurrences.length - 1; j++) {
        const start = occurrences[j] + 1;
        const end = occurrences[j + 1];
        let hasOtherMarker = false;
        for (let k = start; k < end; k++) {
          if (markerIndexes.has(k)) {
            hasOtherMarker = true;
            break;
          }
        }
        if (hasOtherMarker) continue;

        const text = cleanExtractedSegment(lines.slice(start, end));
        const score = text.replace(/\s/g, '').length;
        if (score >= 1) candidates.push({ text, score });
      }

      if (!candidates.length && occurrences.length) {
        const start = occurrences[0] + 1;
        const nextMarker = chosenMarkers
          .map(m => m.index)
          .filter(i => i > occurrences[0])
          .sort((a, b) => a - b)[0] ?? lines.length;
        const text = cleanExtractedSegment(lines.slice(start, nextMarker));
        const score = text.replace(/\s/g, '').length;
        if (score >= 1) candidates.push({ text, score });
      }

      candidates.sort((a, b) => b.score - a.score);
      pages.push(candidates[0]?.text || '');
    }

    const nonEmpty = pages.filter(Boolean);
    if (!nonEmpty.length) throw new Error('本文を抽出できませんでした。');

    return {
      pages,
      markerTotal: chosen.total,
      markerCount: chosenMarkers.length
    };
  }

  function extractTitle() {
    const generic = /(?:pictbland\.net|pictBLand|同人\s*[・･]?\s*BL|小説投稿SNS|イラスト\s*[・･]?\s*小説投稿SNS)/i;
    const reject = /^(?:R18|R-18|鍵付|編集|表紙を表示|小|中|大|ステキ！?|ブクマ|非公開|前へ|次へ|前頁|次頁|コメント|プロフィールタグ)$/;

    // まず作品本文の「1 / n」より上にある、見た目が見出しらしい要素を探す。
    const all = [...document.querySelectorAll('body *')];
    const marker = all.find(el => /^\s*1\s*\/\s*\d+\s*$/.test((el.textContent || '').trim()));
    const markerY = marker ? marker.getBoundingClientRect().top + window.scrollY : Infinity;

    const candidates = [];
    const seen = new Set();

    for (const el of all) {
      if (!(el instanceof HTMLElement)) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 2 || text.length > 180 || seen.has(text)) continue;
      if (generic.test(text) || reject.test(text) || /\b\d+\s*\/\s*\d+\b/.test(text)) continue;
      if (/^(?:投稿日|文字数|ステキ数|フォロー|タグ|プロフィール|メッセージ)/.test(text)) continue;
      if (text.includes('pictBLandへようこそ')) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 10) continue;
      const y = rect.top + window.scrollY;
      if (y >= markerY || y < 80) continue;

      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize) || 0;
      const weight = parseInt(style.fontWeight, 10) || (style.fontWeight === 'bold' ? 700 : 400);
      const tag = el.tagName;
      const cls = String(el.className || '');

      let score = 0;
      if (/^H[1-6]$/.test(tag)) score += 120;
      if (/title|subject|headline|item[_-]?name/i.test(cls)) score += 100;
      if (size >= 24) score += 90;
      else if (size >= 20) score += 65;
      else if (size >= 17) score += 25;
      if (weight >= 700) score += 45;
      else if (weight >= 600) score += 25;
      if (el.children.length === 0) score += 20;
      if (text.length <= 80) score += 15;

      if (score >= 60) {
        candidates.push({ text, score, y });
        seen.add(text);
      }
    }

    candidates.sort((a, b) => b.score - a.score || a.y - b.y);
    if (candidates[0]?.text) return candidates[0].text;

    // セマンティック見出しを次点として使う。
    const heading = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .find(text => text && text.length <= 180 && !generic.test(text) && !reject.test(text));
    if (heading) return heading;

    // サイト共通タイトルは採用しない。
    const meta = document.querySelector('meta[property="og:title"]')?.content?.trim();
    if (meta && !generic.test(meta)) return meta;

    const docTitle = (document.title || '').trim();
    if (docTitle && !generic.test(docTitle)) return docTitle;

    return 'pictBLand小説';
  }

  function extractAuthor() {
    const metaAuthor = document.querySelector('meta[name="author"]')?.content?.trim();
    if (metaAuthor) return metaAuthor;

    const links = [...document.querySelectorAll('a[href]')];
    const candidate = links.find(a => {
      try {
        const u = new URL(a.href, location.href);
        return /^\/users\/[^/]+\/?$/.test(u.pathname) && (a.textContent || '').trim();
      } catch {
        return false;
      }
    });
    return (candidate?.textContent || '').trim();
  }

  // 画像保存側でも、小説TXTとまったく同じ作品タイトル判定を使う。
  window.__pictblandNovelExtractTitle = extractTitle;

  function normalizePictMarkup(text) {
    let out = normalizeNewlines(text);
    out = out.replace(/\[\[rb:([\s\S]*?)\s*>\s*([^\]]*?)\]\]/g, (_, base) => base.trim());

    // ページ送りなどのUI文字列は本文として保存しない。
    const navOnly = /^(?:前のページ|次のページ|前頁|次頁|前へ|次へ|作品に戻る)(?:\s*[>＞›»〈<])?$/;
    out = out
      .split('\n')
      .filter(line => !navOnly.test(line.trim()))
      .join('\n');

    return cleanupPlainText(out, 3);
  }

  function safeFileName(name) {
    const cleaned = String(name || 'pictBLand小説')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '＿')
      .replace(/[. ]+$/g, '')
      .trim();
    return (cleaned || 'pictBLand小説').slice(0, 140) + '.txt';
  }

  function isNovelHeading(line) {
    const s = line.trim();
    if (!s || Array.from(s).length > 40) return false;
    return /^(?:第.{1,18}[章話節幕部編]|序章|終章|序幕|終幕|幕間|間章|前書き|まえがき|後書き|あとがき|プロローグ|エピローグ|Prologue|Epilogue|Chapter\s*[0-9０-９]+|CHAPTER\s*[0-9０-９]+|[0-9０-９]+[.．、]\s*\S+)/i.test(s);
  }

  function isDialogueLike(line) {
    return /^[「『（【〔［〈《“‘〝〟…‥―—─・※＊*#◇◆○●◎△▲▽▼□■☆★♪♩♬]/.test(line.trimStart());
  }

  function formatNovelText(text, addDialogueSpacing, indentMode) {
    const rawLines = normalizeNewlines(text).split('\n').map(line => line.replace(/[ \t　]+$/g, ''));
    const prepared = [];

    for (let i = 0; i < rawLines.length; i++) {
      const raw = rawLines[i];
      if (!raw.trim()) {
        prepared.push('');
        continue;
      }

      const hadIndent = /^[ \t\u00a0　]+/.test(raw);
      const visible = raw.replace(/^[ \t\u00a0　]+/g, '');
      const heading = isNovelHeading(visible);
      const special = isDialogueLike(visible);

      let shouldIndent = false;
      if (!heading && !special) {
        if (indentMode === 'blank') {
          shouldIndent = i === 0 || !rawLines[i - 1]?.trim() || hadIndent;
        } else {
          shouldIndent = true;
        }
      }
      prepared.push(shouldIndent ? '　' + visible : visible);
    }

    const spaced = [];
    for (const line of prepared) {
      if (!line) {
        if (spaced.length && spaced[spaced.length - 1] !== '') spaced.push('');
        continue;
      }

      const heading = isNovelHeading(line);
      if (heading && spaced.length && spaced[spaced.length - 1] !== '') spaced.push('');

      if (addDialogueSpacing && spaced.length) {
        let j = spaced.length - 1;
        while (j >= 0 && spaced[j] === '') j--;
        if (j >= 0 && spaced[spaced.length - 1] !== '') {
          const prev = spaced[j];
          if (!isNovelHeading(prev) && !heading && isDialogueLike(prev) !== isDialogueLike(line)) {
            spaced.push('');
          }
        }
      }

      spaced.push(line);
      if (heading) spaced.push('');
    }

    return normalizeNewlines(spaced.join('\n'))
      .replace(/\n{4,}/g, '\n\n\n')
      .replace(/^\n+|\n+$/g, '');
  }

  function buildOutput() {
    if (!original || !pagesHost) return '';
    const pages = [...pagesHost.querySelectorAll('.pbnt-page')]
      .filter(card => card.querySelector('.pbnt-include')?.checked)
      .map(card => cleanupPlainText(card.querySelector('textarea')?.value || '', 3))
      .filter(Boolean);

    const parts = [];
    if (metaToggle?.checked) {
      parts.push(titleInput?.value.trim() || original.title || '無題');
      if (original.author) parts.push(`作者：${original.author}`);
      parts.push('');
    }

    parts.push(pages.join('\n\n\n\n\n\n'));
    return normalizeTxtPunctuation(
      normalizeNewlines(parts.join('\n'))
        .replace(/[ \t]+\n/g, '\n')
        .replace(/^\n+|\n+$/g, '')
    ) + '\n';
  }

  function drawPages(pages) {
    pagesHost.replaceChildren();

    pages.forEach((page, index) => {
      const text = normalizePictMarkup(page);
      const card = document.createElement('section');
      card.className = 'pbnt-page';

      const head = document.createElement('div');
      head.className = 'pbnt-page-head';

      const label = document.createElement('label');
      const include = document.createElement('input');
      include.type = 'checkbox';
      include.checked = true;
      include.className = 'pbnt-include';
      label.append(include, document.createTextNode(` ページ ${index + 1} を保存`));

      const chars = document.createElement('span');
      chars.textContent = `${Array.from(text).length.toLocaleString('ja-JP')}字`;

      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.spellcheck = false;
      textarea.setAttribute('aria-label', `ページ${index + 1} 本文`);
      textarea.addEventListener('input', () => {
        chars.textContent = `${Array.from(textarea.value).length.toLocaleString('ja-JP')}字`;
      });

      include.addEventListener('change', () => {
        card.classList.toggle('pbnt-excluded', !include.checked);
      });

      head.append(label, chars);
      card.append(head, textarea);
      pagesHost.append(card);
    });
  }

  function restorePages() {
    if (!original) return;
    drawPages(original.pages);
    statusNode.textContent = '抽出時の本文に戻しました。';
  }

  function formatAllPages() {
    if (!pagesHost) return;
    const cards = [...pagesHost.querySelectorAll('.pbnt-page')];

    for (const card of cards) {
      const textarea = card.querySelector('textarea');
      if (!textarea) continue;
      textarea.value = formatNovelText(
        textarea.value,
        !!dialogueSpacingToggle?.checked,
        indentModeSelect?.value || 'blank'
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const indentLabel = indentModeSelect?.value === 'blank' ? '空行の後だけ字下げ' : '改行ごとに字下げ';
    statusNode.textContent = dialogueSpacingToggle?.checked
      ? `小説向けに整形しました（${indentLabel}／会話と地の文の切り替わりに空行あり）。`
      : `小説向けに整形しました（${indentLabel}）。`;
  }

  async function copyText() {
    const text = buildOutput();
    if (!text.trim()) return;

    try {
      await navigator.clipboard.writeText(text);
      statusNode.textContent = '編集後の本文をコピーしました。';
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      statusNode.textContent = ok ? '編集後の本文をコピーしました。' : 'コピーできませんでした。';
    }
  }

  function downloadText() {
    if (!original) return;
    const text = buildOutput();
    if (!text.trim()) {
      statusNode.textContent = '保存する本文がありません。';
      return;
    }

    const file = new File([text], safeFileName(titleInput?.value.trim() || original.title), { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    statusNode.textContent = 'TXTをダウンロードしました。';
  }

  async function shareText() {
    if (!original) return;
    const text = buildOutput();
    if (!text.trim()) {
      statusNode.textContent = '共有する本文がありません。';
      return;
    }

    const file = new File([text], safeFileName(titleInput?.value.trim() || original.title), { type: 'text/plain;charset=utf-8' });
    if (!navigator.share || !navigator.canShare?.({ files: [file] })) {
      statusNode.textContent = 'このブラウザではファイル共有に対応していません。ダウンロードをお使いください。';
      return;
    }

    try {
      await navigator.share({ files: [file], title: titleInput?.value.trim() || original.title || 'pictBLand小説' });
      statusNode.textContent = '共有シートへ渡しました。';
    } catch (err) {
      statusNode.textContent = err?.name === 'AbortError'
        ? '共有をキャンセルしました。'
        : `共有できませんでした：${err?.message || err}`;
    }
  }

  function openEditor() {
    overlay.classList.add('pbnt-open');
    pagesHost.replaceChildren();
    statusNode.textContent = 'ページ内から小説本文を抽出中…';

    try {
      const extracted = extractPagesFromDocument();
      const title = extractTitle();
      const author = extractAuthor();

      original = {
        title,
        author,
        pages: extracted.pages.map(normalizePictMarkup),
        url: location.href
      };

      if (titleInput) titleInput.value = title;
      drawPages(original.pages);
      const totalChars = original.pages.reduce((sum, page) => sum + Array.from(page).length, 0);
      statusNode.textContent =
        `取得成功：${original.pages.length}ページ／${totalChars.toLocaleString('ja-JP')}字` +
        `（ページ区切り ${extracted.markerCount}個検出）`;
    } catch (err) {
      original = null;
      statusNode.textContent = `取得失敗：${err?.message || err}`;
      const help = document.createElement('div');
      help.className = 'pbnt-error';
      help.textContent = 'この表示と作品ページのスクリーンショットを教えてください。pictBLand側の構造に合わせて修正します。';
      pagesHost.append(help);
    }
  }

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID}{position:fixed;right:14px;bottom:max(76px,env(safe-area-inset-bottom));z-index:2147483000;border:0;border-radius:999px;padding:11px 15px;background:#7356a8;color:#fff;font:700 14px/1.2 -apple-system,BlinkMacSystemFont,'Noto Sans JP',sans-serif;box-shadow:0 4px 16px #0003}
      #${ROOT_ID}{display:none;position:fixed;inset:0;z-index:2147483646;background:#f4f6f8;color:#202124;font-family:-apple-system,BlinkMacSystemFont,'Noto Sans JP',sans-serif;overflow:auto;-webkit-overflow-scrolling:touch}
      #${ROOT_ID}.pbnt-open{display:block}
      #${ROOT_ID} *{box-sizing:border-box}
      .pbnt-header{position:sticky;top:0;z-index:3;background:#fff;border-bottom:1px solid #dfe3e8;padding:10px 12px;box-shadow:0 2px 8px #0000000d}
      .pbnt-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:980px;margin:auto}
      .pbnt-bar strong{font-size:16px;margin-right:auto}
      .pbnt-bar button{border:1px solid #ccd2d9;background:#fff;color:#202124;border-radius:8px;padding:8px 10px;font:inherit;font-weight:600}
      .pbnt-bar .pbnt-primary{background:#7356a8;color:#fff;border-color:#7356a8}
      .pbnt-meta{max-width:980px;margin:8px auto 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:12px;color:#59636e}
      .pbnt-meta select,.pbnt-meta input[type=text]{font:inherit;border:1px solid #ccd2d9;border-radius:7px;padding:5px;background:#fff;color:#202124}
      .pbnt-status{max-width:980px;margin:7px auto 0;font-size:12px;color:#59636e;overflow-wrap:anywhere}
      .pbnt-pages{max-width:980px;margin:0 auto;padding:12px 10px 80px}
      .pbnt-page{background:#fff;border:1px solid #dfe3e8;border-radius:10px;margin:0 0 12px;padding:10px;transition:opacity .15s}
      .pbnt-page.pbnt-excluded{opacity:.46}
      .pbnt-page-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:7px;font-size:13px;font-weight:700}
      .pbnt-page-head span{font-size:11px;color:#727d88;font-weight:400}
      .pbnt-page textarea{display:block;width:100%;min-height:46vh;resize:vertical;border:1px solid #ccd2d9;border-radius:8px;padding:12px;background:#fff;color:#202124;font:15px/1.8 ui-monospace,SFMono-Regular,Menlo,'Noto Sans JP',monospace;white-space:pre-wrap}
      .pbnt-error{background:#fff3f3;color:#b42318;border:1px solid #f3c3c3;border-radius:8px;padding:12px}
      @media(max-width:600px){
        #${BUTTON_ID}{right:12px;bottom:max(76px,env(safe-area-inset-bottom));padding:10px 13px}
        .pbnt-header{padding:8px}
        .pbnt-bar{gap:6px}
        .pbnt-bar button{padding:7px 8px;font-size:12px}
        .pbnt-bar strong{width:100%;font-size:15px}
        .pbnt-meta{font-size:11px}
        .pbnt-pages{padding:10px 7px 70px}
        .pbnt-page{padding:8px}
        .pbnt-page textarea{min-height:52vh;font-size:14px;line-height:1.75}
      }
    `;
    document.head.append(style);
  }

  function buildUi() {
    if (document.getElementById(ROOT_ID)) return;
    injectCss();

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '📖 小説TXT';
    button.addEventListener('click', openEditor);

    overlay = document.createElement('div');
    overlay.id = ROOT_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const header = document.createElement('header');
    header.className = 'pbnt-header';

    const bar = document.createElement('div');
    bar.className = 'pbnt-bar';

    const title = document.createElement('strong');
    title.textContent = '📖 pictBLand 小説TXT';

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = '↩ 原文に戻す';
    restore.addEventListener('click', restorePages);

    const format = document.createElement('button');
    format.type = 'button';
    format.textContent = '📖 小説向け整形';
    format.addEventListener('click', formatAllPages);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'コピー';
    copy.addEventListener('click', copyText);

    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'pbnt-primary';
    download.textContent = '⬇️ ダウンロード';
    download.addEventListener('click', downloadText);

    const share = document.createElement('button');
    share.type = 'button';
    share.textContent = '📤 共有して保存';
    share.addEventListener('click', shareText);

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '閉じる';
    close.addEventListener('click', () => overlay.classList.remove('pbnt-open'));

    bar.append(title, restore, format, copy, download, share, close);

    const meta = document.createElement('div');
    meta.className = 'pbnt-meta';

    const titleLabel = document.createElement('label');
    titleLabel.append(document.createTextNode('ファイル名：'));
    titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.placeholder = '作品タイトル';
    titleInput.setAttribute('aria-label', 'TXTファイル名');
    titleInput.style.minWidth = '220px';
    titleInput.style.maxWidth = '100%';
    titleLabel.append(titleInput);

    const metaLabel = document.createElement('label');
    metaToggle = document.createElement('input');
    metaToggle.type = 'checkbox';
    metaToggle.checked = false;
    metaLabel.append(metaToggle, document.createTextNode(' タイトル・作者名をTXT先頭に入れる'));

    const indentLabel = document.createElement('label');
    indentLabel.append(document.createTextNode('字下げ：'));
    indentModeSelect = document.createElement('select');
    indentModeSelect.append(
      new Option('空行の後だけ', 'blank'),
      new Option('改行ごと', 'line')
    );
    indentModeSelect.value = 'blank';
    indentLabel.append(indentModeSelect);

    const dialogueLabel = document.createElement('label');
    dialogueSpacingToggle = document.createElement('input');
    dialogueSpacingToggle.type = 'checkbox';
    dialogueSpacingToggle.checked = false;
    dialogueLabel.append(dialogueSpacingToggle, document.createTextNode(' 整形時、会話と地の文の間を1行空ける'));

    const hint = document.createElement('span');
    hint.textContent = '不要なページはチェックOFF／一部分だけ消す場合は本文を直接編集';

    meta.append(titleLabel, metaLabel, indentLabel, dialogueLabel, hint);

    statusNode = document.createElement('div');
    statusNode.className = 'pbnt-status';
    statusNode.textContent = 'まだ抽出していません。';

    pagesHost = document.createElement('main');
    pagesHost.className = 'pbnt-pages';

    header.append(bar, meta, statusNode);
    overlay.append(header, pagesHost);
    document.body.append(button, overlay);
  }

  function init() {
    if (!document.body) {
      requestAnimationFrame(init);
      return;
    }

    // 検索ページでも同じuserscriptを動かすため、小説TXT UIは作品詳細ページだけに出す。
    if (/^\/items\/detail\//.test(location.pathname)) buildUi();
  }

  init();
})();



// ---- Saved pictBLand searches + cross-search newest feed (v0.2.0) ----
(() => {
  'use strict';
  if (window.__pictblandSavedSearchWordsV020) return;
  window.__pictblandSavedSearchWordsV020 = true;

  const STORAGE_KEY = 'pictbland-saved-search-words-v1';
  const FEED_EXCLUDE_TAGS_KEY = 'pictbland-saved-search-feed-exclude-tags-v1';
  const BUTTON_ID = 'pbsw-button';
  const ROOT_ID = 'pbsw-root';
  const MAX_SAVED = 200;
  const FEED_STEP = 50;
  const SEARCH_CONCURRENCY = 1;
  const DETAIL_CONCURRENCY = 3;

  let root = null;
  let quickInput = null;

  let feedOpen = false;
  let feedLoading = false;
  let feedGeneration = 0;
  let feedAbort = null;
  let feedStates = [];
  let feedWorks = new Map();
  let feedVisibleCount = FEED_STEP;
  let feedObserver = null;
  let detailQueue = [];
  let detailActive = 0;
  let feedAutoExpandTimer = null;
  let feedExcludeTags = readExcludeTags();

  function currentSearch() {
    const m = location.pathname.match(/^\/tags\/index\/(.*)$/);
    if (!m) return null;
    let raw = m[1] || '';
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch {}
    const word = decoded.replace(/^\++|\++$/g, '').trim();
    return word ? {word, href: location.pathname + location.search} : null;
  }

  function searchHrefForWord(word) {
    const clean = String(word || '').trim();
    if (!clean) return '';
    const encoded = encodeURIComponent(clean)
      .replace(/%20/g, '+')
      .replace(/%2B/gi, '+')
      .replace(/%2D/gi, '-');
    return '/tags/index/+' + encoded.replace(/^\++|\++$/g, '') + '+';
  }

  function readSaved() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(value)) return [];
      return value.filter(x => x && typeof x.word === 'string' && x.word.trim());
    } catch {
      return [];
    }
  }

  function writeSaved(rows) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(0, MAX_SAVED)));
    render();
  }

  function normalizeExcludeTag(value) {
    return String(value || '').trim().replace(/^#+/, '').normalize('NFKC').toLocaleLowerCase('ja-JP');
  }

  function parseExcludeTags(value) {
    const parts = String(value || '').split(/[\n,、]+/).map(x => x.trim()).filter(Boolean);
    const unique = new Map();
    for (const raw of parts) {
      const key = normalizeExcludeTag(raw);
      if (!key || unique.has(key)) continue;
      unique.set(key, raw.replace(/^#+/, '').trim());
    }
    return [...unique.values()];
  }

  function readExcludeTags() {
    try {
      const value = JSON.parse(localStorage.getItem(FEED_EXCLUDE_TAGS_KEY) || '[]');
      return Array.isArray(value) ? parseExcludeTags(value.join('\n')) : [];
    } catch {
      return [];
    }
  }

  function saveExcludeTags(tags) {
    feedExcludeTags = parseExcludeTags((tags || []).join('\n'));
    try { localStorage.setItem(FEED_EXCLUDE_TAGS_KEY, JSON.stringify(feedExcludeTags)); } catch {}
  }

  function excludedTagSet() {
    return new Set(feedExcludeTags.map(normalizeExcludeTag).filter(Boolean));
  }

  function excludedByTag(work) {
    if (!feedExcludeTags.length || !Array.isArray(work?.tags) || !work.tags.length) return false;
    const blocked = excludedTagSet();
    return work.tags.some(tag => blocked.has(normalizeExcludeTag(tag)));
  }

  function syncExcludeUi() {
    if (!root) return;
    const input = root.querySelector('.pbsw-feed-exclude-input');
    const summary = root.querySelector('.pbsw-feed-exclude-summary');
    if (input && document.activeElement !== input) input.value = feedExcludeTags.join(', ');
    if (summary) summary.textContent = feedExcludeTags.length
      ? '🚫 除外タグ ' + feedExcludeTags.length + '件'
      : '🚫 除外タグなし';
  }

  function applyExcludeInput() {
    const input = root?.querySelector('.pbsw-feed-exclude-input');
    if (!input) return;
    saveExcludeTags(parseExcludeTags(input.value));
    feedVisibleCount = FEED_STEP;
    syncExcludeUi();
    renderFeed();
  }

  function saveWord(word, href='') {
    const clean = String(word || '').trim();
    if (!clean) return;
    const rows = readSaved();
    const existing = rows.find(x => x.word === clean);
    const name = prompt(existing ? 'この検索語は保存済みです。表示名を変更しますか？' : '保存名を入力してください。', existing?.name || clean);
    if (name === null || !name.trim()) return;
    const now = Date.now();
    const resolvedHref = href || existing?.href || searchHrefForWord(clean);
    if (existing) {
      existing.name = name.trim();
      existing.href = resolvedHref;
      existing.updatedAt = now;
    } else {
      rows.unshift({id: crypto.randomUUID(), name: name.trim(), word: clean, href: resolvedHref, createdAt: now, updatedAt: now});
    }
    writeSaved(rows);
  }

  function saveCurrent() {
    const current = currentSearch();
    if (!current) return;
    saveWord(current.word, current.href);
  }

  function runSearch(word, href='') {
    const target = href || searchHrefForWord(word);
    if (!target) return;
    if (root) root.classList.remove('open');
    location.assign(new URL(target, location.origin).href);
  }

  function runQuickSearch() {
    const word = quickInput?.value?.trim() || '';
    if (!word) return;
    runSearch(word);
  }

  function saveQuickSearch() {
    const word = quickInput?.value?.trim() || '';
    if (!word) return;
    saveWord(word, searchHrefForWord(word));
  }

  function rename(id) {
    const rows = readSaved(), row = rows.find(x => x.id === id);
    if (!row) return;
    const name = prompt('保存名を変更', row.name || row.word);
    if (name === null || !name.trim()) return;
    row.name = name.trim();
    row.updatedAt = Date.now();
    writeSaved(rows);
  }

  function remove(id) {
    const rows = readSaved(), row = rows.find(x => x.id === id);
    if (!row || !confirm('「' + (row.name || row.word) + '」を削除しますか？')) return;
    writeSaved(rows.filter(x => x.id !== id));
  }

  function move(id, delta) {
    const rows = readSaved();
    const i = rows.findIndex(x => x.id === id), j = i + delta;
    if (i < 0 || j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    writeSaved(rows);
  }

  function firstSearchHref(row) {
    const target = row?.href || searchHrefForWord(row?.word || '');
    if (!target) return '';
    const u = new URL(target, location.origin);
    for (const key of ['ctop','page','p','offset']) u.searchParams.delete(key);
    return u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
  }

  function requestHtml(url, signal) {
    const abs = new URL(url, location.origin).href;
    const gm = globalThis.GM?.xmlhttpRequest || globalThis.GM?.xmlHttpRequest;

    if (typeof gm !== 'function') {
      return fetch(abs, {
        method:'GET',
        credentials:'include',
        redirect:'follow',
        signal,
        headers:{Accept:'text/html,application/xhtml+xml'}
      }).then(async response => {
        if (response.status === 429) throw new Error('429：pictBLandのアクセス制限です');
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return {html:await response.text(), url:response.url || abs};
      });
    }

    return new Promise((resolve,reject) => {
      let settled=false;
      let handle=null;

      const finish=(ok,value)=>{
        if(settled)return;
        settled=true;
        signal?.removeEventListener?.('abort',onAbort);
        ok?resolve(value):reject(value instanceof Error?value:new Error(String(value||'取得失敗')));
      };

      const onAbort=()=>{
        try{handle?.abort?.();}catch{}
        const err=new Error('取得を中止しました');
        err.name='AbortError';
        finish(false,err);
      };

      if(signal?.aborted){
        onAbort();
        return;
      }
      signal?.addEventListener?.('abort',onAbort,{once:true});

      try{
        handle=gm({
          method:'GET',
          url:abs,
          responseType:'text',
          anonymous:false,
          nocache:true,
          timeout:30000,
          headers:{
            Accept:'text/html,application/xhtml+xml',
            Referer:location.href
          },
          onload:res=>{
            const status=Number(res?.status||0);
            if(status===429){finish(false,new Error('429：pictBLandのアクセス制限です'));return;}
            if(status<200||status>=400){finish(false,new Error('HTTP '+status));return;}
            const html=String(res?.responseText ?? res?.response ?? '');
            if(!html.trim()){finish(false,new Error('HTMLが空でした'));return;}
            finish(true,{html,url:res?.finalUrl||res?.responseURL||abs});
          },
          onerror:err=>finish(false,new Error('GM通信エラー：'+String(err?.error||err?.message||'取得失敗'))),
          ontimeout:()=>finish(false,new Error('取得がタイムアウトしました')),
          onabort:()=>onAbort()
        });

        if(handle&&typeof handle.then==='function'){
          handle.then(res=>{
            if(settled)return;
            const status=Number(res?.status||0);
            if(status===429){finish(false,new Error('429：pictBLandのアクセス制限です'));return;}
            if(status<200||status>=400){finish(false,new Error('HTTP '+status));return;}
            const html=String(res?.responseText ?? res?.response ?? '');
            if(!html.trim()){finish(false,new Error('HTMLが空でした'));return;}
            finish(true,{html,url:res?.finalUrl||res?.responseURL||abs});
          }).catch(err=>{
            if(err?.name==='AbortError')finish(false,err);
            else finish(false,new Error('GM通信エラー：'+String(err?.message||err)));
          });
        }
      }catch(err){
        finish(false,err);
      }
    });
  }

  function compactText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function itemIdFromHref(href) {
    try {
      const u = new URL(href, location.origin);
      return u.origin === location.origin ? (u.pathname.match(/^\/items\/(?:detail|index|view)\/(\d+)/)?.[1] || '') : '';
    } catch {
      return '';
    }
  }

  function itemIdFromAny(value) {
    const s = String(value || '');
    let m = s.match(/(?:https?:\/\/pictbland\.net)?\/items\/(?:detail|index|view)\/(\d+)/i);
    if (m) return m[1];
    m = s.match(/["']?(?:item[_-]?id|itemId)["']?\s*[:=]\s*["']?(\d{2,})/i);
    return m ? m[1] : '';
  }

  function deepRoots(doc) {
    const roots = [doc];
    const queue = [doc];
    const seen = new Set(queue);
    while (queue.length) {
      const rootNode = queue.shift();
      let elements = [];
      try { elements = [...rootNode.querySelectorAll('*')]; } catch {}
      for (const el of elements) {
        const shadow = el.shadowRoot;
        if (shadow && !seen.has(shadow)) {
          seen.add(shadow);
          roots.push(shadow);
          queue.push(shadow);
        }
      }
    }
    return roots;
  }

  function collectItemCandidates(doc) {
    const found = new Map();
    const add = (id, el, source='') => {
      if (!/^\d+$/.test(String(id || ''))) return;
      const key = String(id);
      if (!found.has(key)) found.set(key, {id:key, elements:[], sources:[]});
      const row = found.get(key);
      if (el && !row.elements.includes(el)) row.elements.push(el);
      if (source && !row.sources.includes(source)) row.sources.push(source);
    };

    for (const rootNode of deepRoots(doc)) {
      let elements = [];
      try { elements = [...rootNode.querySelectorAll('*')]; } catch {}
      for (const el of elements) {
        const values = [];
        const attrs = [
          'href','data-href','data-url','data-link','data-path','onclick',
          'data-item-id','data-item_id','data-itemid','data-id','id'
        ];
        for (const name of attrs) {
          const v = el.getAttribute?.(name);
          if (v) values.push(name + '=' + v);
        }
        for (const attr of [...(el.attributes || [])]) {
          if (!/^data-/i.test(attr.name)) continue;
          if (!values.some(x => x.startsWith(attr.name + '='))) values.push(attr.name + '=' + attr.value);
        }
        for (const value of values) {
          const id = itemIdFromAny(value);
          if (id) add(id, el, value.slice(0,160));
        }
      }

      let html = '';
      try { html = rootNode instanceof Document ? rootNode.documentElement?.outerHTML || '' : rootNode.innerHTML || ''; } catch {}
      const re = /(?:https?:\/\/pictbland\.net)?\/items\/(?:detail|index|view)\/(\d+)/gi;
      let m;
      while ((m = re.exec(html))) add(m[1], null, 'html-regex');
      const re2 = /["']?(?:item[_-]?id|itemId)["']?\s*[:=]\s*["']?(\d{2,})/gi;
      while ((m = re2.exec(html))) add(m[1], null, 'item-id-regex');
    }

    return [...found.values()];
  }

  function itemHref(id) {
    return '/items/detail/' + encodeURIComponent(id);
  }

  function itemIdsInside(el) {
    const ids = new Set();
    if (!el) return ids;

    const inspect = node => {
      if (!node?.getAttribute) return;
      for (const attr of [...(node.attributes || [])]) {
        const id = itemIdFromAny(attr.value);
        if (id) ids.add(id);
        if (ids.size > 2) return;
      }
    };

    inspect(el);
    if (ids.size > 2) return ids;

    let nodes = [];
    try { nodes = [...(el.querySelectorAll?.('*') || [])]; } catch {}
    for (const node of nodes) {
      inspect(node);
      if (ids.size > 2) break;
    }
    return ids;
  }

  function workCardFor(anchor, id) {
    if (!anchor) return null;
    let node = anchor;
    let best = null;

    // Walk upward only while the container belongs to this one work.
    // Stop before a list/grid/page container that contains multiple work IDs.
    for (let depth = 0; node && depth < 10; depth++) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const ids = itemIdsInside(node);
        if (ids.size === 1 && ids.has(String(id))) {
          best = node;
          const textLen = compactText(node.textContent || '').length;
          if (/^(ARTICLE|LI)$/i.test(node.tagName) || /card|item|work|post|entry/i.test(String(node.className || ''))) {
            if (textLen > 0) break;
          }
        } else if (ids.size > 1) {
          break;
        }
      }
      node = node.parentElement;
      if (!node || node === document.body || node === document.documentElement) break;
    }
    return best;
  }

  function imageUrlFrom(card) {
    const img = card?.querySelector?.('img');
    if (!img) return '';
    const candidates = [
      img.getAttribute('src'),
      img.getAttribute('data-src'),
      img.getAttribute('data-original'),
      img.getAttribute('data-lazy-src'),
      img.getAttribute('data-url')
    ];
    const srcset = String(img.getAttribute('srcset') || '').split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean);
    for (const raw of [...candidates, ...srcset]) {
      if (!raw || /^data:|^blob:/i.test(raw)) continue;
      try { return new URL(raw, location.origin).href; } catch {}
    }
    return '';
  }

  function tagsFrom(rootNode) {
    const out = [];
    const seen = new Set();
    for (const a of rootNode?.querySelectorAll?.('a[href*="/tags/index/"]') || []) {
      let tag = compactText(a.textContent).replace(/^#/, '');
      if (!tag) {
        try {
          const u = new URL(a.getAttribute('href') || '', location.origin);
          const raw = u.pathname.match(/^\/tags\/index\/(.*)$/)?.[1] || '';
          tag = decodeURIComponent(raw).replace(/^\++|\++$/g, '').trim();
        } catch {}
      }
      const key = normalizeExcludeTag(tag);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
    return out;
  }

  function parseDateFromText(text) {
    const s = compactText(text);
    let m = s.match(/(20\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (!m) m = s.match(/(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?/);
    if (!m) return {text:'', time:0};
    const y=Number(m[1]), mo=Number(m[2])-1, d=Number(m[3]), h=Number(m[4]||0), mi=Number(m[5]||0);
    const time = +new Date(y,mo,d,h,mi,0,0);
    return {text:m[0], time:Number.isFinite(time)?time:0};
  }

  function dateFrom(rootNode) {
    const timeEl = rootNode?.querySelector?.('time[datetime]');
    if (timeEl) {
      const raw = timeEl.getAttribute('datetime') || '';
      const time = Date.parse(raw);
      if (Number.isFinite(time)) return {text:compactText(timeEl.textContent) || new Date(time).toLocaleString('ja-JP'), time};
    }
    return parseDateFromText(rootNode?.textContent || '');
  }

  function metricFromText(text, names) {
    const source = compactText(text);
    for (const name of names) {
      let m = source.match(new RegExp(name + '[^0-9０-９]{0,10}([0-9０-９,，]+)', 'i'));
      if (!m) m = source.match(new RegExp('([0-9０-９,，]+)[^0-9０-９]{0,6}' + name, 'i'));
      if (!m) continue;
      const n = Number(m[1].replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0)-0xFEE0)).replace(/[，,]/g,''));
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function titleFrom(card, anchors, id) {
    const reject = /^(?:詳細|続きを読む|作品を見る|画像|小説|漫画|イラスト|ステキ!?|ブクマ|ブックマーク)$/i;
    const candidates = [];
    if (!card) return '作品 ' + id;
    for (const el of card?.querySelectorAll?.('h1,h2,h3,h4,strong,[class*="title"],[class*="subject"]') || []) {
      const t = compactText(el.textContent);
      if (t && t.length <= 180 && !reject.test(t)) candidates.push(t);
    }
    for (const a of anchors) {
      const t = compactText(a.textContent);
      if (t && t.length <= 180 && !reject.test(t)) candidates.push(t);
      const alt = compactText(a.querySelector('img')?.getAttribute('alt'));
      if (alt && alt.length <= 180 && !reject.test(alt)) candidates.push(alt);
    }
    return candidates.sort((a,b)=>b.length-a.length)[0] || ('作品 ' + id);
  }

  function authorFrom(rootNode) {
    for (const a of rootNode?.querySelectorAll?.('a[href]') || []) {
      try {
        const u = new URL(a.getAttribute('href') || '', location.origin);
        if (!/^\/users\/[^/]+\/?$/.test(u.pathname)) continue;
        const name = compactText(a.textContent);
        if (name) return {name, href:u.pathname};
      } catch {}
    }
    return {name:'', href:''};
  }

  function captionFrom(rootNode, title, authorName, tags) {
    const tagSet = new Set((tags || []).map(compactText));
    const candidates = [];
    for (const el of rootNode?.querySelectorAll?.('p,[class*="caption"],[class*="description"],[class*="comment"],[class*="summary"]') || []) {
      const t = compactText(el.textContent);
      if (!t || t === title || t === authorName || tagSet.has(t) || t.length < 8 || t.length > 800) continue;
      if (/^(?:投稿日|更新日|ステキ|ブクマ|ブックマーク|タグ|閲覧)/.test(t)) continue;
      candidates.push(t);
    }
    return candidates.sort((a,b)=>b.length-a.length)[0] || '';
  }

  function minimalSearchWork(id, state, orderIndex) {
    return {
      id:String(id),
      href:itemHref(id),
      title:'作品 ' + id,
      thumb:'',
      authorName:'',
      authorHref:'',
      dateText:'',
      dateTime:0,
      caption:'',
      tags:[],
      sukiCount:null,
      bookmarkCount:null,
      matches:new Set([state.row.name || state.row.word]),
      detailLoaded:false,
      detailQueued:false,
      detailLoading:false,
      searchOrder:orderIndex
    };
  }

  function normalizeSearchWork(card, anchors, id, state, orderIndex) {
    const tags = tagsFrom(card);
    const title = titleFrom(card, anchors, id);
    const author = authorFrom(card);
    const date = dateFrom(card);
    const text = compactText(card?.textContent || '');
    return {
      id,
      href:itemHref(id),
      title,
      thumb:imageUrlFrom(card),
      authorName:author.name,
      authorHref:author.href,
      dateText:date.text,
      dateTime:date.time,
      caption:captionFrom(card,title,author.name,tags),
      tags,
      sukiCount:metricFromText(text,['ステキ!?','ステキ','いいね']),
      bookmarkCount:metricFromText(text,['ブクマ','ブックマーク']),
      matches:new Set([state.row.name || state.row.word]),
      detailLoaded:false,
      detailQueued:false,
      detailLoading:false,
      searchOrder:orderIndex
    };
  }

  function findNextHref(doc, currentUrl) {
    const direct = doc.querySelector('link[rel="next"][href],a[rel="next"][href]');
    if (direct?.getAttribute('href')) {
      try {
        const u = new URL(direct.getAttribute('href'), currentUrl);
        if (u.origin === location.origin) return u.href;
      } catch {}
    }

    const candidates = [];
    for (const a of doc.querySelectorAll('a[href]')) {
      const text = compactText(a.textContent);
      if (!/(?:^|\s)(?:次|次へ|次のページ|NEXT|Next)(?:\s|$|[>＞»›])/i.test(text)) continue;
      try {
        const u = new URL(a.getAttribute('href'), currentUrl);
        if (u.origin !== location.origin || !/^\/tags\/index\//.test(u.pathname)) continue;
        candidates.push(u.href);
      } catch {}
    }
    return candidates[0] || '';
  }

  function parseSearchPage(html, pageUrl, state) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const candidates = collectItemCandidates(doc);
    const works = [];
    let orderIndex = 0;
    for (const candidate of candidates) {
      const id = candidate.id;
      const els = candidate.elements || [];
      const anchor = els.find(el => el?.matches?.('a[href]')) || els[0] || null;

      let card = anchor ? workCardFor(anchor,id) : null;
      if (!card && anchor) card = anchor.parentElement || anchor;

      // If the ID only appeared inside serialized JS/HTML, locate a nearby
      // DOM node carrying that same ID/path and use it as the card seed.
      if (!card) {
        for (const rootNode of deepRoots(doc)) {
          let hit = null;
          try {
            hit = [...rootNode.querySelectorAll('*')].find(el => {
              for (const attr of [...(el.attributes || [])]) {
                if (itemIdFromAny(attr.value) === id) return true;
              }
              return false;
            });
          } catch {}
          if (hit) { card = workCardFor(hit,id) || hit.parentElement || hit; break; }
        }
      }

      const anchors = [];
      try {
        if (card) for (const a of card.querySelectorAll('a[href]')) if (itemIdFromAny(a.getAttribute('href')||'') === id) anchors.push(a);
      } catch {}
      if (anchor?.matches?.('a[href]') && !anchors.includes(anchor)) anchors.unshift(anchor);

      if (card || anchor) works.push(normalizeSearchWork(card || anchor,anchors,id,state,orderIndex++));
      else works.push(minimalSearchWork(id,state,orderIndex++));
    }

    const pageText = compactText(doc.body?.textContent || '');
    const title = compactText(doc.title || '');
    const empty = /(?:該当|検索).{0,20}(?:ありません|0件|見つかりません)|作品.{0,12}0件/i.test(pageText);
    const hrefSamples = [];
    for (const rootNode of deepRoots(doc)) {
      let elements=[];
      try { elements=[...rootNode.querySelectorAll('*')]; } catch {}
      for (const el of elements) {
        for (const attr of [...(el.attributes||[])]) {
          const value=String(attr.value||'');
          if (!/(?:item|tag|search|detail|view)/i.test(value)) continue;
          const sample=attr.name+'='+value.slice(0,180);
          if (!hrefSamples.includes(sample)) hrefSamples.push(sample);
          if (hrefSamples.length>=16) break;
        }
        if (hrefSamples.length>=16) break;
      }
      if (hrefSamples.length>=16) break;
    }

    return {
      works,
      nextHref:findNextHref(doc,pageUrl),
      pageText,
      title,
      empty,
      hrefSamples
    };
  }

  function renderedSearchHtml(url, signal) {
    const abs = new URL(url, location.origin).href;
    return new Promise((resolve,reject) => {
      const iframe = document.createElement('iframe');
      let settled=false;
      let timer=null;
      let poll=null;

      iframe.setAttribute('aria-hidden','true');
      iframe.tabIndex=-1;
      // Keep the iframe inside the visual viewport so pictBLand's lazy/render
      // observers treat the search page as visible. It stays fully transparent,
      // non-interactive, and below our tool overlay.
      iframe.style.cssText='position:fixed!important;inset:0!important;width:100vw!important;height:100dvh!important;border:0!important;opacity:.001!important;pointer-events:none!important;z-index:2147480000!important;background:#fff!important;';

      const cleanup=()=>{
        clearTimeout(timer);
        clearInterval(poll);
        signal?.removeEventListener?.('abort',onAbort);
        try{iframe.remove();}catch{}
      };
      const finish=(ok,value)=>{
        if(settled)return;
        settled=true;
        cleanup();
        ok?resolve(value):reject(value instanceof Error?value:new Error(String(value||'描画取得失敗')));
      };
      const onAbort=()=>{
        const err=new Error('取得を中止しました');
        err.name='AbortError';
        finish(false,err);
      };

      if(signal?.aborted){onAbort();return;}
      signal?.addEventListener?.('abort',onAbort,{once:true});

      timer=setTimeout(()=>{
        try{
          const doc=iframe.contentDocument;
          let html=doc?.documentElement?.outerHTML||'';
          try{
            const shadowParts=[];
            for(const rootNode of deepRoots(doc)){
              if(rootNode===doc)continue;
              shadowParts.push('<div data-pbsw-shadow-root="1">'+String(rootNode.innerHTML||'')+'</div>');
            }
            if(shadowParts.length)html+=shadowParts.join('');
          }catch{}
          const finalUrl=iframe.contentWindow?.location?.href||abs;
          if(html.trim()) finish(true,{html,url:finalUrl,timedOut:true});
          else finish(false,new Error('検索ページの描画がタイムアウトしました'));
        }catch{
          finish(false,new Error('検索ページの描画がタイムアウトしました'));
        }
      },12000);

      iframe.addEventListener('load',()=>{
        let stableTicks=0;
        let lastCount=-1;
        poll=setInterval(()=>{
          try{
            const doc=iframe.contentDocument;
            if(!doc?.documentElement)return;
            const count=collectItemCandidates(doc).length;
            const text=compactText(doc.body?.textContent||'');
            const isEmpty=/(?:該当|検索).{0,20}(?:ありません|0件|見つかりません)|作品.{0,12}0件/i.test(text);

            if(count===lastCount)stableTicks++;
            else stableTicks=0;
            lastCount=count;

            // Nudge the inner page a little while waiting. Some pictBLand lists
            // are rendered/lazy-loaded only after viewport/scroll observers run.
            if(!count){
              try{
                const win=iframe.contentWindow;
                const max=Math.max(0,(doc.documentElement?.scrollHeight||doc.body?.scrollHeight||0)-(win?.innerHeight||800));
                const y=Math.min(max,Math.max(0,(win?.scrollY||0)+220));
                win?.scrollTo?.(0,y);
              }catch{}
            }

            // Wait a little after dynamic rendering settles. An actually empty
            // result page can finish without any item links.
            if((count>0&&stableTicks>=3)||(isEmpty&&stableTicks>=2)){
              try{iframe.contentWindow?.scrollTo?.(0,0);}catch{}
              let html=doc.documentElement.outerHTML;
              try {
                const shadowParts=[];
                for(const rootNode of deepRoots(doc)){
                  if(rootNode===doc)continue;
                  shadowParts.push('<div data-pbsw-shadow-root="1">'+String(rootNode.innerHTML||'')+'</div>');
                }
                if(shadowParts.length) html += shadowParts.join('');
              }catch{}
              const finalUrl=iframe.contentWindow?.location?.href||abs;
              finish(true,{html,url:finalUrl,timedOut:false});
            }
          }catch(err){
            finish(false,new Error('検索ページDOMを読めませんでした：'+String(err?.message||err)));
          }
        },350);
      },{once:true});

      try{
        (document.body||document.documentElement).append(iframe);
        iframe.src=abs;
      }catch(err){
        finish(false,err);
      }
    });
  }

  function absolutePageUrl(url) {
    try { return new URL(url, location.origin).href; } catch { return String(url || ''); }
  }

  async function fetchSearchState(state, url, generation) {
    if (!url || generation !== feedGeneration || feedAbort?.signal.aborted) return false;

    const pageUrl = absolutePageUrl(url);
    state.seenPages ||= new Set();
    state.loadedIds ||= new Set();

    if (!pageUrl || state.seenPages.has(pageUrl)) {
      state.done = true;
      state.nextHref = '';
      return false;
    }
    state.seenPages.add(pageUrl);

    const before = state.loadedIds.size;
    try {
      // First try a normal same-site request. pictBLand may return only the
      // application shell here, so if no work cards exist, fall back to an
      // on-screen transparent same-origin iframe and read the rendered DOM.
      let response = await requestHtml(pageUrl, feedAbort.signal);
      if (generation !== feedGeneration) return false;
      let parsed = parseSearchPage(response.html,response.url,state);

      if (!parsed.works.length && !parsed.empty) {
        response = await renderedSearchHtml(pageUrl,feedAbort.signal);
        if (generation !== feedGeneration) return false;
        parsed = parseSearchPage(response.html,response.url,state);
      }

      if (!parsed.works.length && !parsed.empty) {
        const hint = [parsed.title,parsed.pageText.slice(0,100)].filter(Boolean).join(' ／ ');
        const links = (parsed.hrefSamples||[]).slice(0,6).join(' , ');
        throw new Error(
          '検索ページは開けましたが作品カードを判定できません'
          + (hint ? '：'+hint : '')
          + (links ? ' ／ リンク候補：'+links : '')
        );
      }

      for (const work of parsed.works) {
        if (work?.id) state.loadedIds.add(String(work.id));
      }
      state.pagesFetched = Number(state.pagesFetched || 0) + 1;

      const next = parsed.nextHref ? absolutePageUrl(parsed.nextHref) : '';
      state.nextHref = next && !state.seenPages.has(next) ? next : '';
      state.done = !state.nextHref;
      state.error = '';
      mergeWorks(parsed.works);

      // If a page yielded no new IDs, following pagination further is unsafe:
      // it is usually a repeated/looping page rather than genuinely new data.
      if (parsed.works.length && state.loadedIds.size === before) {
        state.done = true;
        state.nextHref = '';
      }
      return state.loadedIds.size > before;
    } catch (e) {
      if (e?.name === 'AbortError') return false;
      state.error = String(e?.message || e);
      return false;
    }
  }

  function mergeWorks(works) {
    for (const work of works || []) {
      const old = feedWorks.get(work.id);
      if (!old) {
        feedWorks.set(work.id, work);
        continue;
      }
      for (const name of work.matches) old.matches.add(name);
      if (!old.thumb && work.thumb) old.thumb = work.thumb;
      if (!old.authorName && work.authorName) { old.authorName = work.authorName; old.authorHref = work.authorHref; }
      if (!old.caption && work.caption) old.caption = work.caption;
      if (!old.tags.length && work.tags.length) old.tags = work.tags;
      if (!old.dateTime && work.dateTime) { old.dateTime = work.dateTime; old.dateText = work.dateText; }
      if (old.sukiCount == null && work.sukiCount != null) old.sukiCount = work.sukiCount;
      if (old.bookmarkCount == null && work.bookmarkCount != null) old.bookmarkCount = work.bookmarkCount;
    }
  }

  function allSortedWorks() {
    return [...feedWorks.values()].sort((a,b) => {
      if ((b.dateTime||0) !== (a.dateTime||0)) return (b.dateTime||0) - (a.dateTime||0);
      const bi = Number(b.id), ai = Number(a.id);
      if (Number.isFinite(bi) && Number.isFinite(ai) && bi !== ai) return bi-ai;
      return (a.searchOrder||0) - (b.searchOrder||0);
    });
  }

  function sortedWorks() {
    return allSortedWorks().filter(work => !excludedByTag(work));
  }

  async function mapLimit(items, limit, worker) {
    let index = 0;
    const runners = Array.from({length:Math.min(limit,items.length)}, async () => {
      while (index < items.length) {
        const item = items[index++];
        await worker(item);
      }
    });
    await Promise.allSettled(runners);
  }

  function stateCoverage(state) {
    return Number(state?.loadedIds?.size || 0);
  }

  function coverageComplete(target) {
    return feedStates.every(state =>
      !!state.error || !!state.done || stateCoverage(state) >= target
    );
  }

  async function ensureCoverage(target, generation) {
    let rounds = 0;
    while (generation === feedGeneration && !feedAbort?.signal.aborted && !coverageComplete(target)) {
      const targets = feedStates.filter(state =>
        !state.error && !state.done && state.nextHref && stateCoverage(state) < target
      );
      if (!targets.length) break;

      let roundProgress = false;
      await mapLimit(targets, SEARCH_CONCURRENCY, async state => {
        const before = stateCoverage(state);
        await fetchSearchState(state,state.nextHref,generation);
        if (stateCoverage(state) > before || state.done || state.error) roundProgress = true;
        if (generation === feedGeneration) renderFeed();
      });

      // Hard stop against broken pagination loops.
      if (!roundProgress || ++rounds >= 30) break;
    }
  }

  async function expandFeed() {
    if (feedLoading || !feedOpen) return;
    const generation = feedGeneration;
    const target = feedVisibleCount + FEED_STEP;
    feedLoading = true;
    renderFeed();

    await ensureCoverage(target,generation);
    if (generation !== feedGeneration) return;

    feedVisibleCount = target;
    feedLoading = false;
    renderFeed();
  }

  async function fetchDetail(work, signal) {
    const response = await requestHtml(work.href, signal);
    const doc = new DOMParser().parseFromString(response.html, 'text/html');
    const bodyText = compactText(doc.body?.textContent || '');

    const tags = tagsFrom(doc);
    if (tags.length) work.tags = tags;

    const author = authorFrom(doc);
    if (author.name) { work.authorName = author.name; work.authorHref = author.href; }

    const ogTitle = compactText(doc.querySelector('meta[property="og:title"]')?.getAttribute('content'));
    const headingTitle = compactText(doc.querySelector('h1,h2,[class*="title"],[class*="subject"]')?.textContent);
    const title = ogTitle || headingTitle;
    if (title && !/pictBLand/i.test(title)) work.title = title.replace(/\s*[|｜-]\s*pictBLand.*$/i,'').trim() || work.title;

    const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
    if (!work.thumb && ogImage) {
      try { work.thumb = new URL(ogImage,response.url).href; } catch {}
    }

    const date = dateFrom(doc);
    if (date.time) { work.dateTime = date.time; work.dateText = date.text; }

    const descriptionMeta = compactText(
      doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="description"]')?.getAttribute('content')
    );
    const candidateCaption = captionFrom(doc,work.title,work.authorName,work.tags);
    const caption = candidateCaption || descriptionMeta;
    if (caption && !/pictBLandへようこそ/i.test(caption)) work.caption = caption;

    const suki = metricFromText(bodyText,['ステキ!?','ステキ','いいね']);
    const bookmark = metricFromText(bodyText,['ブクマ','ブックマーク']);
    if (suki != null) work.sukiCount = suki;
    if (bookmark != null) work.bookmarkCount = bookmark;
  }

  function resetDetailQueue() {
    detailQueue = [];
    detailActive = 0;
  }

  function enqueueDetail(work, generation) {
    if (!work || work.detailLoaded || work.detailLoading || work.detailQueued) return;
    work.detailQueued = true;
    detailQueue.push({work,generation});
    pumpDetailQueue();
  }

  function pumpDetailQueue() {
    while (detailActive < DETAIL_CONCURRENCY && detailQueue.length) {
      const job = detailQueue.shift();
      const work = job.work;
      work.detailQueued = false;
      if (job.generation !== feedGeneration || feedAbort?.signal.aborted || work.detailLoaded || work.detailLoading) continue;
      work.detailLoading = true;
      detailActive++;
      fetchDetail(work,feedAbort.signal).then(() => {
        if (job.generation !== feedGeneration) return;
        work.detailLoaded = true;
        if (excludedByTag(work)) renderFeed();
        else updateFeedCard(work);
      }).catch(e => {
        if (e?.name !== 'AbortError') {
          work.detailLoaded = true;
          updateFeedCard(work);
        }
      }).finally(() => {
        work.detailLoading = false;
        detailActive = Math.max(0,detailActive-1);
        const status = root?.querySelector('.pbsw-feed-status');
        if (status) status.textContent = feedStatusText();
        pumpDetailQueue();
      });
    }
  }

  function feedStatusText() {
    const total = feedStates.length;
    const ok = feedStates.filter(s => !s.error).length;
    const bad = feedStates.filter(s => s.error).length;
    const visible = sortedWorks().length;
    const excluded = Math.max(0,feedWorks.size-visible);
    const detailed = [...feedWorks.values()].filter(w => w.detailLoaded).length;
    const detailText = visible ? ' ／ 詳細 ' + detailed.toLocaleString('ja-JP') + '/' + feedWorks.size.toLocaleString('ja-JP') : '';
    const target = feedVisibleCount;
    const covered = feedStates.filter(s => s.error || s.done || stateCoverage(s) >= target).length;
    const coverageText = total ? ' ／ 横断同期 ' + covered + '/' + total + '条件（各最大' + target + '件）' : '';
    return feedLoading
      ? '全保存検索を日付順に揃えています… 現在 ' + visible.toLocaleString('ja-JP') + '作品' + coverageText + detailText + (excluded ? '（除外 ' + excluded + '）' : '')
      : '保存検索 ' + ok + '/' + total + '件取得 ／ 表示候補 ' + visible.toLocaleString('ja-JP') + '作品' + coverageText + detailText + (excluded ? ' ／ 除外 ' + excluded + '作品' : '') + (bad ? ' ／ 失敗 ' + bad + '件' : '');
  }

  function renderCoverageBreakdown() {
    const box = root?.querySelector('.pbsw-feed-coverage');
    if (!box) return;
    box.replaceChildren();
    for (const state of feedStates) {
      const chip = document.createElement('span');
      const name = state.row?.name || state.row?.word || '保存検索';
      const count = stateCoverage(state);
      chip.textContent = name + ' ' + count + '件' + (state.error ? ' ⚠️' : state.done ? ' ✓' : count >= feedVisibleCount ? ' ✓' : ' …');
      if (state.error) chip.title = state.error;
      box.append(chip);
    }
  }

  function metricLabel(work) {
    const bits = [];
    if (work.sukiCount != null) bits.push('♥ ' + Number(work.sukiCount).toLocaleString('ja-JP'));
    if (work.bookmarkCount != null) bits.push('🔖 ' + Number(work.bookmarkCount).toLocaleString('ja-JP'));
    return bits.length ? bits.join('  ') : '詳細取得中…';
  }

  function createFeedCard(work) {
    const card = document.createElement('article');
    card.className = 'pbsw-feed-card';
    card.dataset.workId = work.id;

    const thumb = document.createElement('a');
    thumb.className = 'pbsw-feed-thumb';
    thumb.href = work.href;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = work.title;
    if (work.thumb) img.src = work.thumb;
    else img.classList.add('empty');
    thumb.append(img);

    const info = document.createElement('div');
    info.className = 'pbsw-feed-info';

    const top = document.createElement('div');
    top.className = 'pbsw-feed-top';
    const title = document.createElement('a');
    title.className = 'pbsw-feed-title';
    title.href = work.href;
    title.textContent = work.title;
    const metric = document.createElement('span');
    metric.className = 'pbsw-feed-metric';
    metric.textContent = metricLabel(work);
    top.append(title,metric);

    const author = document.createElement(work.authorHref ? 'a' : 'span');
    author.className = 'pbsw-feed-author';
    if (work.authorHref) author.href = work.authorHref;
    author.textContent = work.authorName || '作者取得中…';

    const date = document.createElement('div');
    date.className = 'pbsw-feed-date';
    date.textContent = work.dateText || '';

    const caption = document.createElement('p');
    caption.className = 'pbsw-feed-caption';
    caption.textContent = work.caption || '作品情報を取得中…';

    const tags = document.createElement('div');
    tags.className = 'pbsw-feed-tags';
    for (const tag of work.tags.slice(0,10)) {
      const a = document.createElement('a');
      a.href = searchHrefForWord(tag);
      a.textContent = '#' + tag;
      tags.append(a);
    }

    const matches = document.createElement('div');
    matches.className = 'pbsw-feed-matches';
    const names = [...work.matches];
    for (const name of names.slice(0,4)) {
      const chip = document.createElement('span');
      chip.textContent = name;
      matches.append(chip);
    }
    if (names.length > 4) {
      const more = document.createElement('span');
      more.textContent = '+' + (names.length-4);
      matches.append(more);
    }

    info.append(top,author,date,caption,tags,matches);
    card.append(thumb,info);
    return card;
  }

  function updateFeedCard(work) {
    const card = root?.querySelector('.pbsw-feed-card[data-work-id="' + CSS.escape(work.id) + '"]');
    if (!card) return;
    const metric = card.querySelector('.pbsw-feed-metric');
    if (metric) metric.textContent = metricLabel(work);
    const title = card.querySelector('.pbsw-feed-title');
    if (title) title.textContent = work.title;
    const author = card.querySelector('.pbsw-feed-author');
    if (author) author.textContent = work.authorName || '作者不明';
    const date = card.querySelector('.pbsw-feed-date');
    if (date) date.textContent = work.dateText || '';
    const caption = card.querySelector('.pbsw-feed-caption');
    if (caption) caption.textContent = work.caption || '説明なし';
    const img = card.querySelector('.pbsw-feed-thumb img');
    if (img && work.thumb && !img.getAttribute('src')) { img.src = work.thumb; img.classList.remove('empty'); }
    const tags = card.querySelector('.pbsw-feed-tags');
    if (tags) {
      tags.replaceChildren();
      for (const tag of work.tags.slice(0,10)) {
        const a = document.createElement('a');
        a.href = searchHrefForWord(tag);
        a.textContent = '#' + tag;
        tags.append(a);
      }
    }
  }

  function observeFeedCards(works,generation) {
    feedObserver?.disconnect();

    // Always start the first visible batch immediately. This avoids iOS Safari
    // cases where IntersectionObserver on a fixed nested scroller never fires.
    for (const work of works.slice(0,12)) enqueueDetail(work,generation);

    if (!('IntersectionObserver' in window)) return;

    feedObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = entry.target?.dataset?.workId;
        const work = id ? feedWorks.get(id) : null;
        if (work) enqueueDetail(work,generation);
        feedObserver?.unobserve(entry.target);
      }
    }, {root,rootMargin:'700px 0px',threshold:0.01});

    for (const card of root.querySelectorAll('.pbsw-feed-card')) {
      const id = card.dataset.workId;
      const work = id ? feedWorks.get(id) : null;
      if (work?.detailLoaded || work?.detailLoading || work?.detailQueued) continue;
      feedObserver.observe(card);
    }
  }

  function renderFeed() {
    if (!root) return;
    syncExcludeUi();
    const status = root.querySelector('.pbsw-feed-status');
    if (status) status.textContent = feedStatusText();

    renderCoverageBreakdown();

    const errors = root.querySelector('.pbsw-feed-errors');
    if (errors) {
      const failed = feedStates.filter(s => s.error);
      errors.replaceChildren();
      errors.hidden = !failed.length;
      for (const state of failed) {
        const row = document.createElement('div');
        row.className = 'pbsw-feed-error-row';
        const name = document.createElement('strong');
        name.textContent = state.row?.name || state.row?.word || '保存検索';
        const msg = document.createElement('span');
        msg.textContent = state.error;
        row.append(name,msg);
        errors.append(row);
      }
    }

    const works = sortedWorks();
    const visible = works.slice(0,feedVisibleCount);
    const grid = root.querySelector('.pbsw-feed-grid');
    grid.replaceChildren();

    if (!works.length && !feedLoading) {
      const p = document.createElement('p');
      p.className = 'pbsw-empty';
      p.textContent = feedWorks.size && feedExcludeTags.length
        ? '取得した作品はすべて除外タグに一致しました。'
        : '該当する新着作品がありません。';
      grid.append(p);
    } else {
      for (const work of visible) grid.append(createFeedCard(work));
    }

    const showMore = root.querySelector('.pbsw-feed-show-more');
    const older = root.querySelector('.pbsw-feed-load-older');
    const refresh = root.querySelector('.pbsw-feed-refresh');
    const hasHidden = works.length > feedVisibleCount;
    const hasOlder = feedStates.some(s => !s.error && !s.done && s.nextHref);
    showMore.hidden = !hasHidden;
    older.hidden = hasHidden || !hasOlder || feedLoading;
    refresh.disabled = feedLoading;
    showMore.disabled = feedLoading;
    older.disabled = feedLoading;

    if (!feedLoading) observeFeedCards(visible,feedGeneration);
  }

  async function refreshFeed() {
    const rows = readSaved();
    feedAbort?.abort();
    feedAbort = new AbortController();
    feedGeneration++;
    const generation = feedGeneration;
    feedLoading = true;
    feedWorks = new Map();
    feedVisibleCount = FEED_STEP;
    feedStates = rows.map(row => ({
      row,
      nextHref:firstSearchHref(row),
      done:false,
      error:'',
      loadedIds:new Set(),
      seenPages:new Set(),
      pagesFetched:0
    }));
    feedObserver?.disconnect();
    resetDetailQueue();
    renderFeed();

    // To guarantee the first N global results, each individual saved search
    // must contribute up to N newest works (or reach its end). Otherwise an
    // unseen page from one condition can contain works newer than visible rows
    // from another condition.
    await ensureCoverage(feedVisibleCount,generation);

    if (generation !== feedGeneration) return;
    feedLoading = false;
    renderFeed();
  }

  async function loadOlderFeed() {
    await expandFeed();
  }

  function showManagePage() {
    if (!root) return;
    const manage = root.querySelector('.pbsw-manage-page');
    const feed = root.querySelector('.pbsw-feed-page');
    if (feed) { feed.hidden = true; feed.style.setProperty('display','none','important'); }
    if (manage) { manage.hidden = false; manage.style.setProperty('display','block','important'); }
  }

  function showFeedPage() {
    if (!root) return;
    const manage = root.querySelector('.pbsw-manage-page');
    const feed = root.querySelector('.pbsw-feed-page');
    if (manage) { manage.hidden = true; manage.style.setProperty('display','none','important'); }
    if (feed) { feed.hidden = false; feed.style.setProperty('display','block','important'); }
  }

  function openFeed() {
    build();
    if (!root) return;
    feedOpen = true;
    root.classList.add('open');
    showFeedPage();
    root.scrollTop = 0;
    void refreshFeed();
  }

  function closeFeed() {
    feedAbort?.abort();
    feedObserver?.disconnect();
    clearTimeout(feedAutoExpandTimer);
    resetDetailQueue();
    feedOpen = false;
    if (!root) return;
    showManagePage();
    root.scrollTop = 0;
    render();
  }

  function render() {
    if (!root || feedOpen) return;
    const rows = readSaved();
    const list = root.querySelector('.pbsw-list');
    const current = currentSearch();
    const saveCurrentBtn = root.querySelector('.pbsw-save-current');
    const newestBtn = root.querySelector('.pbsw-newest-open');
    root.querySelector('.pbsw-current').textContent = current
      ? '現在の検索語：' + current.word
      : '検索語を入力するか、保存済みの検索語をタップしてください。';
    saveCurrentBtn.hidden = !current;
    newestBtn.disabled = !rows.length;
    list.replaceChildren();

    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'pbsw-empty';
      p.textContent = '保存した検索語はまだありません。上の入力欄から検索・保存できます。';
      list.append(p);
      return;
    }

    rows.forEach((row,index) => {
      const card = document.createElement('article');
      card.className = 'pbsw-card';

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'pbsw-open';
      open.title = 'タップして検索';
      open.addEventListener('click',()=>runSearch(row.word,row.href));
      const name = document.createElement('strong');
      name.textContent = row.name || row.word;
      const word = document.createElement('span');
      word.textContent = '🔎 ' + row.word;
      open.append(name,word);

      const actions = document.createElement('div');
      actions.className = 'pbsw-actions';
      const make=(label,fn,disabled=false)=>{
        const b=document.createElement('button');
        b.type='button';b.textContent=label;b.disabled=disabled;b.addEventListener('click',fn);return b;
      };
      actions.append(
        make('🔎 検索する',()=>runSearch(row.word,row.href)),
        make('名前変更',()=>rename(row.id)),
        make('↑',()=>move(row.id,-1),index===0),
        make('↓',()=>move(row.id,1),index===rows.length-1),
        make('削除',()=>remove(row.id))
      );
      card.append(open,actions);
      list.append(card);
    });
  }

  function build() {
    if (!document.body || root) return;

    const style = document.createElement('style');
    style.textContent = `
      #${BUTTON_ID}{position:fixed;right:14px;bottom:max(76px,env(safe-area-inset-bottom));z-index:2147483000;border:0;border-radius:999px;padding:11px 15px;background:#5b4a8d;color:#fff;font:700 14px/1.2 -apple-system,BlinkMacSystemFont,'Noto Sans JP',sans-serif;box-shadow:0 4px 16px #0003}
      #${ROOT_ID}{display:none;position:fixed;inset:0;z-index:2147483646;background:#f4f6f8;color:#202124;overflow:auto;-webkit-overflow-scrolling:touch;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Noto Sans JP',sans-serif}
      #${ROOT_ID}.open{display:block}
      #${ROOT_ID} *{box-sizing:border-box}
      #${ROOT_ID} a{color:inherit}
      #${ROOT_ID} .pbsw-wrap{max-width:1080px;margin:auto;padding:18px 14px 80px}
      #${ROOT_ID} .pbsw-head,#${ROOT_ID} .pbsw-feed-head{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;background:#fff;border:1px solid #ded9e8;border-radius:12px;padding:14px;margin-bottom:12px;position:sticky;top:0;z-index:2}
      #${ROOT_ID} h2{font-size:18px;margin:0}
      #${ROOT_ID} button,#${ROOT_ID} input{font:inherit;border:1px solid #cfc8dc;border-radius:8px;background:#fff;color:#2d2640;padding:9px 10px}
      #${ROOT_ID} button:disabled{opacity:.45}
      #${ROOT_ID} .pbsw-current{flex:1 1 100%;font-size:12px;color:#6b6478}
      #${ROOT_ID} .pbsw-quick{display:flex;gap:7px;flex:1 1 100%;flex-wrap:wrap}
      #${ROOT_ID} .pbsw-quick input{flex:1 1 260px;min-width:0}
      #${ROOT_ID} .pbsw-search,#${ROOT_ID} .pbsw-save-current,#${ROOT_ID} .pbsw-newest-open,#${ROOT_ID} .pbsw-feed-refresh{background:#7356a8;color:#fff;border-color:#7356a8;font-weight:700}
      #${ROOT_ID} .pbsw-card{background:#fff;border:1px solid #ded9e8;border-radius:12px;padding:10px;margin-bottom:10px}
      #${ROOT_ID} .pbsw-open{display:flex;width:100%;text-align:left;flex-direction:column;gap:4px;border:0;background:transparent;padding:5px;cursor:pointer}
      #${ROOT_ID} .pbsw-open strong{font-size:15px}
      #${ROOT_ID} .pbsw-open span{font-size:12px;color:#716b7b;overflow-wrap:anywhere}
      #${ROOT_ID} .pbsw-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
      #${ROOT_ID} .pbsw-actions button{font-size:12px;padding:7px 9px}
      #${ROOT_ID} .pbsw-empty{background:#fff;border:1px solid #ded9e8;border-radius:12px;padding:18px;color:#716b7b}
      #${ROOT_ID} .pbsw-feed-status{flex:1 1 100%;font-size:12px;color:#716b7b}
      #${ROOT_ID} .pbsw-feed-coverage{flex:1 1 100%;display:flex;gap:5px;flex-wrap:wrap}
      #${ROOT_ID} .pbsw-feed-coverage span{font-size:10px;color:#625a70;background:#f0edf4;border-radius:999px;padding:3px 7px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${ROOT_ID} .pbsw-feed-errors{flex:1 1 100%;background:#fff2f2;border:1px solid #efcaca;border-radius:9px;padding:8px 10px;color:#8a3b3b}
      #${ROOT_ID} .pbsw-feed-errors[hidden]{display:none}
      #${ROOT_ID} .pbsw-feed-error-row{display:flex;gap:8px;align-items:flex-start;font-size:11px;line-height:1.45}
      #${ROOT_ID} .pbsw-feed-error-row+ .pbsw-feed-error-row{margin-top:5px}
      #${ROOT_ID} .pbsw-feed-error-row strong{flex:0 0 auto;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${ROOT_ID} .pbsw-feed-error-row span{overflow-wrap:anywhere}
      #${ROOT_ID} .pbsw-feed-filter{flex:1 1 100%;background:#faf9fc;border:1px solid #ded9e8;border-radius:9px;padding:8px 10px}
      #${ROOT_ID} .pbsw-feed-filter summary{cursor:pointer;font-weight:700}
      #${ROOT_ID} .pbsw-feed-filter-row{display:flex;gap:7px;margin-top:8px}
      #${ROOT_ID} .pbsw-feed-exclude-input{flex:1;min-width:0}
      #${ROOT_ID} .pbsw-feed-filter-note{margin:6px 0 0;color:#7b7388;font-size:11px}
      #${ROOT_ID} .pbsw-feed-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
      #${ROOT_ID} .pbsw-feed-card{display:grid;grid-template-columns:128px minmax(0,1fr);background:#fff;border:1px solid #ded9e8;border-radius:12px;overflow:hidden;min-width:0}
      #${ROOT_ID} .pbsw-feed-thumb{display:block;background:#ece8f2;min-height:128px}
      #${ROOT_ID} .pbsw-feed-thumb img{display:block;width:100%;height:100%;min-height:128px;object-fit:cover;background:#ece8f2}
      #${ROOT_ID} .pbsw-feed-thumb img.empty{visibility:hidden}
      #${ROOT_ID} .pbsw-feed-info{padding:10px;min-width:0}
      #${ROOT_ID} .pbsw-feed-top{display:flex;gap:7px;align-items:flex-start}
      #${ROOT_ID} .pbsw-feed-title{font-weight:800;text-decoration:none;line-height:1.35;overflow-wrap:anywhere;flex:1}
      #${ROOT_ID} .pbsw-feed-metric{font-size:11px;color:#755096;white-space:nowrap;font-weight:700}
      #${ROOT_ID} .pbsw-feed-author{display:block;margin-top:5px;color:#675f74;text-decoration:none;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${ROOT_ID} .pbsw-feed-date{font-size:11px;color:#8c8595;margin-top:2px}
      #${ROOT_ID} .pbsw-feed-caption{font-size:12px;line-height:1.5;color:#494251;margin:7px 0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
      #${ROOT_ID} .pbsw-feed-tags{display:flex;gap:5px;flex-wrap:wrap;max-height:44px;overflow:hidden}
      #${ROOT_ID} .pbsw-feed-tags a{font-size:11px;color:#7356a8;text-decoration:none;overflow-wrap:anywhere}
      #${ROOT_ID} .pbsw-feed-matches{display:flex;gap:4px;flex-wrap:wrap;margin-top:8px}
      #${ROOT_ID} .pbsw-feed-matches span{font-size:10px;color:#645c70;background:#f0edf4;border-radius:999px;padding:3px 6px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${ROOT_ID} .pbsw-feed-more{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;padding:18px 0}
      #${ROOT_ID} .pbsw-feed-more button{font-weight:700}
      @media(max-width:650px){
        #${BUTTON_ID}{right:12px;padding:10px 13px}
        #${ROOT_ID} .pbsw-wrap{padding:10px 8px 70px}
        #${ROOT_ID} h2{font-size:16px}
        #${ROOT_ID} .pbsw-feed-grid{grid-template-columns:1fr}
        #${ROOT_ID} .pbsw-feed-card{grid-template-columns:112px minmax(0,1fr)}
        #${ROOT_ID} .pbsw-feed-thumb,#${ROOT_ID} .pbsw-feed-thumb img{min-height:112px}
      }
    `;
    document.head.append(style);

    const button=document.createElement('button');
    button.id=BUTTON_ID;
    button.type='button';
    button.textContent='🔖 検索';
    button.addEventListener('click',openPanel);

    root=document.createElement('section');
    root.id=ROOT_ID;
    root.innerHTML=`
      <div class="pbsw-wrap pbsw-manage-page">
        <div class="pbsw-head">
          <h2>🔖 pictBLand 保存検索</h2>
          <button type="button" class="pbsw-newest-open">🆕 保存検索の新着</button>
          <button type="button" class="pbsw-save-current">現在の検索語を保存</button>
          <button type="button" class="pbsw-close">閉じる</button>
          <div class="pbsw-current"></div>
          <div class="pbsw-quick">
            <input class="pbsw-input" type="search" placeholder="検索語を入力">
            <button type="button" class="pbsw-search">🔎 検索</button>
            <button type="button" class="pbsw-save-input">この語を保存</button>
          </div>
        </div>
        <div class="pbsw-list"></div>
      </div>
      <div class="pbsw-wrap pbsw-feed-page" hidden>
        <div class="pbsw-feed-head">
          <button type="button" class="pbsw-feed-back">← 保存検索へ</button>
          <h2>🆕 保存検索の新着</h2>
          <button type="button" class="pbsw-feed-refresh">更新</button>
          <div class="pbsw-feed-status"></div>
          <div class="pbsw-feed-coverage"></div>
          <div class="pbsw-feed-errors" hidden></div>
          <details class="pbsw-feed-filter">
            <summary class="pbsw-feed-exclude-summary">🚫 除外タグなし</summary>
            <div class="pbsw-feed-filter-row">
              <input type="text" class="pbsw-feed-exclude-input" placeholder="例：女体化, パロディ, R-18">
              <button type="button" class="pbsw-feed-exclude-apply">適用</button>
            </div>
            <p class="pbsw-feed-filter-note">カンマまたは改行区切り。作品タグと完全一致した場合に除外します。</p>
          </details>
        </div>
        <div class="pbsw-feed-grid"></div>
        <div class="pbsw-feed-more">
          <button type="button" class="pbsw-feed-show-more" hidden>次の50件を表示</button>
          <button type="button" class="pbsw-feed-load-older" hidden>さらに過去の新着を取得</button>
        </div>
      </div>
    `;

    quickInput=root.querySelector('.pbsw-input');
    root.querySelector('.pbsw-save-current').addEventListener('click',saveCurrent);
    root.querySelector('.pbsw-search').addEventListener('click',runQuickSearch);
    root.querySelector('.pbsw-save-input').addEventListener('click',saveQuickSearch);
    root.querySelector('.pbsw-close').addEventListener('click',closePanel);
    root.querySelector('.pbsw-newest-open').addEventListener('click',openFeed);
    root.querySelector('.pbsw-feed-back').addEventListener('click',closeFeed);
    root.querySelector('.pbsw-feed-refresh').addEventListener('click',()=>void refreshFeed());
    root.querySelector('.pbsw-feed-exclude-apply').addEventListener('click',applyExcludeInput);
    root.querySelector('.pbsw-feed-exclude-input').addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.preventDefault();applyExcludeInput();}
    });
    root.querySelector('.pbsw-feed-show-more').addEventListener('click',()=>void expandFeed());
    root.querySelector('.pbsw-feed-load-older').addEventListener('click',()=>void expandFeed());
    quickInput.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.preventDefault();runQuickSearch();}
    });

    root.addEventListener('scroll',()=>{
      if(!feedOpen || feedLoading) return;
      clearTimeout(feedAutoExpandTimer);
      feedAutoExpandTimer=setTimeout(()=>{
        if(!feedOpen || feedLoading) return;
        const remaining=root.scrollHeight-root.scrollTop-root.clientHeight;
        if(remaining<700) void expandFeed();
      },120);
    },{passive:true});

    document.body.append(button,root);
    syncExcludeUi();
    render();
  }

  function openPanel() {
    build();
    if (!root) return;
    feedAbort?.abort();
    feedObserver?.disconnect();
    clearTimeout(feedAutoExpandTimer);
    resetDetailQueue();
    feedOpen=false;
    root.classList.add('open');
    showManagePage();
    root.scrollTop=0;
    render();
    setTimeout(()=>quickInput?.focus(),0);
  }

  function closePanel() {
    feedAbort?.abort();
    feedObserver?.disconnect();
    resetDetailQueue();
    feedOpen=false;
    if(root){
      showManagePage();
      root.classList.remove('open');
    }
  }

  function countSaved() {
    return readSaved().length;
  }

  window.__pictblandSavedSearchUi={
    open:openPanel,
    close:closePanel,
    render,
    count:countSaved,
    storageKey:STORAGE_KEY,
    openNewest:openFeed
  };

  if(document.body)build();
  else addEventListener('DOMContentLoaded',build,{once:true});
})();



// ---- pictBLand image saver (v0.3.8) ----
(() => {
  'use strict';
  if (window.__pictblandImageSaverV038) return;
  window.__pictblandImageSaverV038 = true;

  const ROOT_ID = 'pbi-root';
  const BUTTON_ID = 'pbi-button';
  const STYLE_ID = 'pbi-style';

  let root = null;
  let statusNode = null;
  let listNode = null;
  let titleInput = null;
  let found = [];

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function isItemPage() {
    return /^\/items\/detail\/\d+/.test(location.pathname);
  }

  function itemId() {
    return location.pathname.match(/^\/items\/detail\/(\d+)/)?.[1] || '';
  }

  function expectedCount() {
    const text = document.body?.innerText || '';
    const m = text.match(/画像枚数\s*[：:]\s*(\d+)\s*枚/);
    return m ? Number(m[1]) : 0;
  }

  function isImageWork() {
    if (!isItemPage()) return false;
    const text = document.body?.innerText || '';
    return /画像枚数\s*[：:]\s*\d+\s*枚/.test(text) || /アルバムを表示/.test(text);
  }

  function safeBaseName(name) {
    const cleaned = String(name || ('pictBLand_' + itemId()))
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '＿')
      .replace(/[. ]+$/g, '')
      .trim();
    return (cleaned || ('pictBLand_' + itemId())).slice(0, 120);
  }

  function extractTitle() {
    const shared = window.__pictblandNovelExtractTitle;
    if (typeof shared === 'function') {
      try {
        const title = shared();
        if (title && title.trim()) return title.trim();
      } catch {}
    }

    // 念のため共通関数がまだ準備できていない場合だけ最低限のフォールバック。
    const docTitle = (document.title || '')
      .replace(/\s*[|｜-]\s*pictBLand.*$/i, '')
      .trim();
    return docTitle || ('pictBLand_' + itemId());
  }

  function normalizeImageUrl(raw) {
    if (!raw) return '';
    let value = String(raw).trim().replace(/&amp;/g, '&');
    if (!value || value.startsWith('data:') || value.startsWith('blob:')) return '';
    if (value.startsWith('//')) value = location.protocol + value;

    try {
      const u = new URL(value, location.href);
      if (!/^https?:$/.test(u.protocol)) return '';
      if (!/^img\d*\.pictbland\.net$/i.test(u.hostname)) return '';
      if (!/^\/items\//i.test(u.pathname)) return '';
      return u.href;
    } catch {
      return '';
    }
  }

  function addSrcset(value, add) {
    String(value || '').split(',').forEach(part => {
      const url = part.trim().split(/\s+/)[0];
      if (url) add(url);
    });
  }

  function collectLinkedImageUrls() {
    const rows = [];
    const seen = new Set();

    const add = raw => {
      const url = normalizeImageUrl(raw);
      if (!url) return;
      let key = url;
      try {
        const u = new URL(url);
        key = u.origin + u.pathname;
      } catch {}
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(url);
    };

    document.querySelectorAll('a[href]').forEach(a => add(a.href));

    const id = itemId();
    if (id) {
      const strict = rows.filter(url => {
        try {
          const p = new URL(url).pathname;
          return new RegExp('(?:/|_)' + id + '(?:[_.\\/-]|$)').test(p);
        } catch {
          return false;
        }
      });
      if (strict.length) return strict;
    }

    return rows;
  }

  function collectImageUrls() {
    const rows = [];
    const seen = new Set();

    const add = raw => {
      const url = normalizeImageUrl(raw);
      if (!url) return;
      let key = url;
      try {
        const u = new URL(url);
        key = u.origin + u.pathname;
      } catch {}
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(url);
    };

    document.querySelectorAll('img').forEach(img => {
      add(img.currentSrc);
      add(img.src);
      ['data-src','data-original','data-lazy-src','data-url','data-image'].forEach(attr => add(img.getAttribute(attr)));
      addSrcset(img.getAttribute('srcset'), add);
    });

    document.querySelectorAll('source').forEach(source => {
      addSrcset(source.getAttribute('srcset'), add);
      add(source.getAttribute('src'));
    });

    document.querySelectorAll('a[href]').forEach(a => add(a.href));

    document.querySelectorAll('[style*="background"]').forEach(el => {
      const style = el.getAttribute('style') || '';
      const re = /url\((['"]?)(.*?)\1\)/g;
      let m;
      while ((m = re.exec(style))) add(m[2]);
    });

    try {
      performance.getEntriesByType('resource').forEach(entry => add(entry.name));
    } catch {}

    const html = document.documentElement?.innerHTML || '';
    const re = /(?:https?:)?\/\/img\d*\.pictbland\.net\/items\/[^"'()<>\s\\]+/gi;
    let m;
    while ((m = re.exec(html))) add(m[0]);

    const id = itemId();
    if (id) {
      const strict = rows.filter(url => {
        try {
          const p = new URL(url).pathname;
          return new RegExp('(?:/|_)' + id + '(?:[_.\\/-]|$)').test(p);
        } catch {
          return false;
        }
      });
      if (strict.length) return strict;
    }

    return rows;
  }

  function imageDimensions(url) {
    return new Promise(resolve => {
      const img = new Image();
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        resolve(value);
      };
      const timer = setTimeout(() => finish({width:0,height:0,area:0}), 8000);
      img.onload = () => {
        const width = img.naturalWidth || 0;
        const height = img.naturalHeight || 0;
        finish({width,height,area:width * height});
      };
      img.onerror = () => finish({width:0,height:0,area:0});
      img.referrerPolicy = 'strict-origin-when-cross-origin';
      img.src = url;
    });
  }

  async function preferOriginalSet(urls, expected) {
    if (!expected || urls.length <= expected || urls.length % expected !== 0) {
      return {urls, filtered:false, rawCount:urls.length};
    }

    const setCount = urls.length / expected;
    if (setCount < 2 || setCount > 6) {
      return {urls, filtered:false, rawCount:urls.length};
    }

    const sets = [];
    for (let s = 0; s < setCount; s++) {
      const part = urls.slice(s * expected, (s + 1) * expected);
      const dims = await Promise.all(part.map(imageDimensions));
      const usable = dims.filter(d => d.area > 0);
      const areas = usable.map(d => d.area).sort((a,b) => a-b);
      const medianArea = areas.length ? areas[Math.floor(areas.length / 2)] : 0;
      const totalArea = usable.reduce((sum,d) => sum + d.area, 0);
      const known = usable.length;
      sets.push({part, medianArea, totalArea, known, index:s});
    }

    sets.sort((a,b) =>
      b.medianArea - a.medianArea ||
      b.totalArea - a.totalArea ||
      b.known - a.known ||
      b.index - a.index
    );

    const best = sets[0];
    if (!best || best.known < Math.max(1, Math.ceil(expected * 0.5))) {
      return {urls, filtered:false, rawCount:urls.length};
    }

    return {
      urls: best.part,
      filtered: true,
      rawCount: urls.length,
      chosenSet: best.index + 1,
      setCount
    };
  }

  async function revealAlbum() {
    const nodes = [...document.querySelectorAll('button,a,input,[role="button"]')];
    const target = nodes.find(el => {
      const text = ((el.textContent || '') + ' ' + (el.getAttribute?.('value') || '') + ' ' + (el.getAttribute?.('aria-label') || '')).trim();
      return /クリックしてアルバムを表示|アルバムを表示/.test(text);
    });

    if (target) {
      try { target.click(); } catch {}
      await sleep(700);
    }

    const oldY = window.scrollY;
    const maxY = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    if (maxY > innerHeight * 2) {
      for (const ratio of [0.25, 0.5, 0.75, 1]) {
        window.scrollTo(0, Math.floor(maxY * ratio));
        await sleep(120);
      }
      window.scrollTo(0, oldY);
      await sleep(120);
    }
  }

  function extFromUrl(url) {
    try {
      const ext = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
      if (ext && ['jpg','jpeg','png','gif','webp','avif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
    } catch {}
    return 'jpg';
  }

  function buildFileName(index, total) {
    const base = safeBaseName(titleInput?.value || extractTitle());
    const width = Math.max(2, String(total).length);
    const no = String(index + 1).padStart(width, '0');
    return base + '_' + no + '.png';
  }

  function buildZipName(label='') {
    const base = safeBaseName(titleInput?.value || extractTitle());
    return base + (label ? '_' + label : '') + '.zip';
  }

  function gmXhrBlob(url) {
    const fn = globalThis.GM?.xmlhttpRequest || globalThis.GM?.xmlHttpRequest;
    if (typeof fn !== 'function') return Promise.reject(new Error('GM.xmlhttpRequest が利用できません'));

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (ok, value) => {
        if (settled) return;
        settled = true;
        ok ? resolve(value) : reject(value instanceof Error ? value : new Error(String(value || '取得失敗')));
      };

      const timer = setTimeout(() => done(false, new Error('画像取得がタイムアウトしました')), 45000);

      try {
        const maybe = fn({
          method: 'GET',
          url,
          responseType: 'blob',
          anonymous: false,
          nocache: true,
          headers: {
            Referer: location.href
          },
          onload: res => {
            clearTimeout(timer);
            if (res.status >= 200 && res.status < 300 && res.response) done(true, res.response);
            else done(false, new Error('HTTP ' + res.status));
          },
          onerror: err => {
            clearTimeout(timer);
            done(false, new Error(err?.error || err?.message || '画像取得に失敗しました'));
          },
          ontimeout: () => {
            clearTimeout(timer);
            done(false, new Error('画像取得がタイムアウトしました'));
          }
        });
        if (maybe && typeof maybe.then === 'function') {
          maybe.then(res => {
            if (settled) return;
            clearTimeout(timer);
            if (res?.status >= 200 && res?.status < 300 && res.response) done(true, res.response);
          }).catch(err => {
            if (settled) return;
            clearTimeout(timer);
            done(false, err);
          });
        }
      } catch (err) {
        clearTimeout(timer);
        done(false, err);
      }
    });
  }

  async function getBlob(url) {
    try {
      const blob = await gmXhrBlob(url);
      if (blob instanceof Blob && blob.size) return blob;
    } catch {}

    const res = await fetch(url, {
      credentials: 'include',
      referrer: location.href,
      cache: 'no-store'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.blob();
  }

  async function blobToPng(blob) {
    if (!(blob instanceof Blob) || !blob.size) {
      throw new Error('画像データが空です');
    }
    if (blob.type === 'image/png') return blob;

    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const node = new Image();
        node.onload = () => resolve(node);
        node.onerror = () => reject(new Error('画像のデコードに失敗しました'));
        node.src = objectUrl;
      });

      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!width || !height) throw new Error('画像サイズを取得できませんでした');

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d', {alpha:true});
      if (!ctx) throw new Error('PNG変換用Canvasを作成できませんでした');

      ctx.drawImage(img, 0, 0, width, height);

      const png = await new Promise((resolve, reject) => {
        canvas.toBlob(
          result => result ? resolve(result) : reject(new Error('PNG変換に失敗しました')),
          'image/png'
        );
      });

      return png;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function getPngBlob(url) {
    const original = await getBlob(url);
    return await blobToPng(original);
  }

  function saveBlob(blob, name) {
    return new Promise((resolve, reject) => {
      try {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = name;
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
        setTimeout(resolve, 120);
      } catch (err) {
        reject(err);
      }
    });
  }

  async function saveOne(row, index, total) {
    const name = buildFileName(index, total);

    try {
      const png = await getPngBlob(row.url);
      await saveBlob(png, name);
      return {ok:true};
    } catch (err) {
      return {ok:false, error:err};
    }
  }


  async function saveRowsAsZip(entries, zipName) {
    if (!entries.length) {
      statusNode.textContent = 'ZIPに入れる画像がありません。';
      return;
    }

    if (!globalThis.fflate?.zipSync) {
      statusNode.textContent = 'ZIP機能を読み込めませんでした。スクリプトを再読み込みしてください。';
      return;
    }

    const files = {};
    let ok = 0;
    let failed = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      statusNode.textContent =
        'ZIP準備中… ' + (i + 1) + ' / ' + entries.length + '（PNG変換）';

      try {
        const png = await getPngBlob(entry.row.url);
        const bytes = new Uint8Array(await png.arrayBuffer());
        files[buildFileName(entry.index, found.length)] = bytes;
        ok++;
      } catch {
        failed++;
      }

      // iOSでUIが固まらないように一度イベントループへ返す。
      await sleep(0);
    }

    if (!ok) {
      statusNode.textContent = 'ZIPに追加できる画像がありませんでした。';
      return;
    }

    statusNode.textContent = 'ZIPを書き出し中… ' + ok + '枚';

    try {
      // PNGは既に圧縮済みなのでZIP側はlevel 0。
      // JSZipよりメモリ負荷と処理時間を抑えやすい。
      const zipped = globalThis.fflate.zipSync(files, {level: 0});
      const blob = new Blob([zipped], {type:'application/zip'});
      await saveBlob(blob, zipName);

      statusNode.textContent = failed
        ? 'ZIP保存完了：' + ok + '枚／失敗 ' + failed + '枚'
        : 'ZIP保存完了：' + ok + '枚';
    } catch (err) {
      statusNode.textContent =
        'ZIP作成に失敗しました：' + (err?.message || err || '不明なエラー');
    }
  }

  async function saveSelectedZip() {
    const entries = selectedRows().map(x => ({row:x.row,index:x.index}));
    const btn = root?.querySelector('.pbi-zip-selected');
    if (btn) btn.disabled = true;
    try {
      await saveRowsAsZip(entries, buildZipName('選択'));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function saveRangeZip() {
    if (!found.length) {
      statusNode.textContent = '保存できる画像がありません。';
      return;
    }

    const {start, end} = readRange();
    const entries = found.slice(start - 1, end).map((row, offset) => ({
      row,
      index: start - 1 + offset
    }));

    const btn = root?.querySelector('.pbi-zip-range');
    if (btn) btn.disabled = true;
    try {
      await saveRowsAsZip(entries, buildZipName(start + '-' + end));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function selectedRows() {
    return [...listNode.querySelectorAll('.pbi-card')].map((card, index) => ({
      index,
      checked: !!card.querySelector('.pbi-check')?.checked,
      row: found[index]
    })).filter(x => x.checked && x.row);
  }

  function readRange() {
    const startInput = root?.querySelector('.pbi-range-start');
    const endInput = root?.querySelector('.pbi-range-end');
    const total = found.length;

    let start = Number(startInput?.value || 1);
    let end = Number(endInput?.value || total || 1);

    if (!Number.isFinite(start)) start = 1;
    if (!Number.isFinite(end)) end = total || 1;

    start = Math.max(1, Math.min(total || 1, Math.floor(start)));
    end = Math.max(1, Math.min(total || 1, Math.floor(end)));

    if (start > end) [start, end] = [end, start];

    if (startInput) startInput.value = String(start);
    if (endInput) endInput.value = String(end);

    return {start, end};
  }

  async function saveRange() {
    if (!found.length) {
      statusNode.textContent = '保存できる画像がありません。';
      return;
    }

    const {start, end} = readRange();
    const rows = found.slice(start - 1, end).map((row, offset) => ({
      row,
      index: start - 1 + offset
    }));

    const btn = root.querySelector('.pbi-save-range');
    if (btn) btn.disabled = true;

    let ok = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i++) {
      const entry = rows[i];
      statusNode.textContent =
        start + '〜' + end + '枚目を保存中… ' + (i + 1) + ' / ' + rows.length;
      const result = await saveOne(entry.row, entry.index, found.length);
      if (result.ok) ok++;
      else failed++;
      await sleep(180);
    }

    if (btn) btn.disabled = false;
    statusNode.textContent = failed
      ? start + '〜' + end + '枚目：' + ok + '枚保存／失敗 ' + failed + '枚'
      : start + '〜' + end + '枚目を保存しました（' + ok + '枚）。';
  }

  async function saveSelected() {
    const selected = selectedRows();
    if (!selected.length) {
      statusNode.textContent = '保存する画像を選択してください。';
      return;
    }

    const saveBtn = root.querySelector('.pbi-save-selected');
    if (saveBtn) saveBtn.disabled = true;

    let ok = 0;
    let failed = 0;

    for (let i = 0; i < selected.length; i++) {
      const entry = selected[i];
      statusNode.textContent = '保存中… ' + (i + 1) + ' / ' + selected.length;
      const result = await saveOne(entry.row, entry.index, found.length);
      if (result.ok) ok++;
      else failed++;
      await sleep(180);
    }

    if (saveBtn) saveBtn.disabled = false;
    statusNode.textContent = failed
      ? '保存完了：' + ok + '枚／失敗 ' + failed + '枚。失敗した画像は各カードの「画像を開く」から確認できます。'
      : '保存完了：' + ok + '枚';
  }

  function render() {
    listNode.replaceChildren();

    if (!found.length) {
      const empty = document.createElement('div');
      empty.className = 'pbi-empty';
      empty.textContent = '作品画像をまだ検出できていません。';
      listNode.append(empty);
      return;
    }

    found.forEach((row, index) => {
      const card = document.createElement('article');
      card.className = 'pbi-card';

      const preview = document.createElement('img');
      preview.className = 'pbi-preview';
      preview.src = row.url;
      preview.alt = '画像 ' + (index + 1);
      preview.loading = 'lazy';
      preview.referrerPolicy = 'strict-origin-when-cross-origin';

      const info = document.createElement('div');
      info.className = 'pbi-info';

      const label = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = true;
      check.className = 'pbi-check';
      const strong = document.createElement('strong');
      strong.textContent = '画像 ' + (index + 1);
      label.append(check, strong);

      const file = document.createElement('div');
      file.className = 'pbi-file';
      file.textContent = buildFileName(index, found.length);

      const actions = document.createElement('div');
      actions.className = 'pbi-actions';

      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = '⬇️ この1枚を保存';
      save.addEventListener('click', async () => {
        save.disabled = true;
        statusNode.textContent = '画像 ' + (index + 1) + ' を保存中…';
        const result = await saveOne(row, index, found.length);
        save.disabled = false;
        statusNode.textContent = result.ok
          ? '画像 ' + (index + 1) + ' を保存しました。'
          : '保存失敗：' + (result.error?.message || result.error || '不明なエラー');
      });

      const open = document.createElement('a');
      open.href = row.url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.textContent = '画像を開く';

      actions.append(save, open);
      info.append(label, file, actions);
      card.append(preview, info);
      listNode.append(card);
    });
  }

  async function detect() {
    statusNode.textContent = 'アルバムを確認して画像を検出中…';
    await revealAlbum();

    const detectedTitle = extractTitle();
    if (titleInput && detectedTitle) {
      titleInput.value = detectedTitle;
    }

    const expected = expectedCount();
    const linkedUrls = collectLinkedImageUrls();
    const rawUrls = collectImageUrls();

    let picked;
    let sourceNote = '';

    if (expected && rawUrls.length === expected * 2) {
      // 実ページ上で「前半=表示用、後半=同内容の原寸側」と並ぶケース。
      // 作品枚数のちょうど2倍なら後半だけを採用する。
      picked = {
        urls: rawUrls.slice(expected),
        filtered: true,
        rawCount: rawUrls.length,
        forcedSecondHalf: true
      };
      sourceNote = '（後半の原寸候補を採用）';
    } else if (expected && linkedUrls.length === expected) {
      picked = {
        urls: linkedUrls,
        filtered: true,
        rawCount: rawUrls.length,
        originalLinks: true
      };
      sourceNote = '（原寸リンクを採用）';
    } else {
      if (expected && rawUrls.length > expected && rawUrls.length % expected === 0) {
        statusNode.textContent = '表示用画像と原寸画像を判定中… ' + rawUrls.length + '件';
      }
      picked = await preferOriginalSet(rawUrls, expected);
    }

    found = picked.urls.map(url => ({url}));
    render();

    const rangeStart = root?.querySelector('.pbi-range-start');
    const rangeEnd = root?.querySelector('.pbi-range-end');
    if (rangeStart) {
      rangeStart.max = String(Math.max(1, found.length));
      if (!rangeStart.value || Number(rangeStart.value) > found.length) rangeStart.value = '1';
    }
    if (rangeEnd) {
      rangeEnd.max = String(Math.max(1, found.length));
      rangeEnd.value = String(Math.max(1, found.length));
    }

    if (!found.length) {
      statusNode.textContent = '作品画像を検出できませんでした。作品ページを一度表示し直してから「再検出」を押してください。';
    } else if (picked.forcedSecondHalf || picked.originalLinks) {
      statusNode.textContent =
        '検出：' + found.length + ' / ' + expected + '枚 ' + sourceNote;
    } else if (picked.filtered) {
      statusNode.textContent =
        '検出：' + found.length + ' / ' + expected + '枚' +
        '（候補 ' + picked.rawCount + '件から高解像度側を採用）';
    } else if (expected && found.length < expected) {
      statusNode.textContent = '検出：' + found.length + ' / ' + expected + '枚。まだ読み込まれていない画像がある可能性があります。';
    } else {
      statusNode.textContent = '検出：' + found.length + (expected ? ' / ' + expected : '') + '枚';
    }
  }

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + BUTTON_ID + '{position:fixed;right:14px;bottom:max(76px,env(safe-area-inset-bottom));z-index:2147483000;border:0;border-radius:999px;padding:11px 15px;background:#7356a8;color:#fff;font:700 14px/1.2 -apple-system,BlinkMacSystemFont,"Noto Sans JP",sans-serif;box-shadow:0 4px 16px #0003}',
      '#' + ROOT_ID + '{display:none;position:fixed;inset:0;z-index:2147483646;background:#f4f6f8;color:#202124;overflow:auto;-webkit-overflow-scrolling:touch;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Noto Sans JP",sans-serif}',
      '#' + ROOT_ID + '.open{display:block}',
      '#' + ROOT_ID + ' *{box-sizing:border-box}',
      '#' + ROOT_ID + ' .pbi-head{position:sticky;top:0;z-index:3;background:#fff;border-bottom:1px solid #dfe3e8;padding:10px 12px;box-shadow:0 2px 8px #0000000d}',
      '#' + ROOT_ID + ' .pbi-bar{max-width:980px;margin:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '#' + ROOT_ID + ' .pbi-bar strong{font-size:16px;margin-right:auto}',
      '#' + ROOT_ID + ' button,#' + ROOT_ID + ' input{font:inherit}',
      '#' + ROOT_ID + ' button{border:1px solid #ccd2d9;background:#fff;color:#202124;border-radius:8px;padding:8px 10px;font-weight:600}',
      '#' + ROOT_ID + ' .pbi-primary{background:#7356a8;color:#fff;border-color:#7356a8}',
      '#' + ROOT_ID + ' .pbi-meta{max-width:980px;margin:8px auto 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;color:#59636e}',
      '#' + ROOT_ID + ' .pbi-meta input[type=text]{min-width:220px;max-width:100%;border:1px solid #ccd2d9;border-radius:7px;padding:6px}',
      '#' + ROOT_ID + ' .pbi-range{max-width:980px;margin:8px auto 0;display:flex;gap:7px;align-items:center;flex-wrap:wrap;font-size:12px;color:#59636e}',
      '#' + ROOT_ID + ' .pbi-range input[type=number]{width:72px;border:1px solid #ccd2d9;border-radius:7px;padding:6px;background:#fff;color:#202124}',
      '#' + ROOT_ID + ' .pbi-status{max-width:980px;margin:7px auto 0;font-size:12px;color:#59636e;overflow-wrap:anywhere}',
      '#' + ROOT_ID + ' .pbi-list{max-width:980px;margin:0 auto;padding:12px 10px 80px;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}',
      '#' + ROOT_ID + ' .pbi-card{background:#fff;border:1px solid #dfe3e8;border-radius:10px;padding:9px;min-width:0}',
      '#' + ROOT_ID + ' .pbi-preview{display:block;width:100%;height:260px;object-fit:contain;background:#eef0f3;border-radius:7px}',
      '#' + ROOT_ID + ' .pbi-info{padding-top:8px}',
      '#' + ROOT_ID + ' .pbi-info label{display:flex;gap:7px;align-items:center}',
      '#' + ROOT_ID + ' .pbi-file{font-size:11px;color:#747d87;overflow-wrap:anywhere;margin:5px 0 7px}',
      '#' + ROOT_ID + ' .pbi-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}',
      '#' + ROOT_ID + ' .pbi-actions a{font-size:12px;color:#5b4690;text-decoration:underline}',
      '#' + ROOT_ID + ' .pbi-empty{grid-column:1/-1;background:#fff;border:1px solid #dfe3e8;border-radius:10px;padding:18px;color:#6a727b}',
      '@media(max-width:600px){#' + ROOT_ID + ' .pbi-head{padding:8px}#' + ROOT_ID + ' .pbi-bar strong{width:100%;font-size:15px}#' + ROOT_ID + ' .pbi-bar button{font-size:12px;padding:7px 8px}#' + ROOT_ID + ' .pbi-list{grid-template-columns:1fr;padding:10px 7px 70px}#' + ROOT_ID + ' .pbi-preview{height:auto;max-height:70vh}}'
    ].join('');
    document.head.append(style);
  }

  function build() {
    if (!document.body || root) return;
    injectCss();

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '🖼️ 画像保存';
    button.addEventListener('click', openPanel);

    root = document.createElement('section');
    root.id = ROOT_ID;
    root.innerHTML =
      '<div class="pbi-head">' +
        '<div class="pbi-bar">' +
          '<strong>🖼️ pictBLand 画像保存</strong>' +
          '<button type="button" class="pbi-detect">🔄 再検出</button>' +
          '<button type="button" class="pbi-select-all">全部選択</button>' +
          '<button type="button" class="pbi-clear-all">全部解除</button>' +
          '<button type="button" class="pbi-save-selected">⬇️ 選択をPNG保存</button>' +
          '<button type="button" class="pbi-zip-selected pbi-primary">📦 選択をZIP</button>' +
          '<button type="button" class="pbi-close">閉じる</button>' +
        '</div>' +
        '<div class="pbi-meta"><label>ファイル名：<input type="text" class="pbi-title" placeholder="作品タイトル"></label><span>保存形式はPNG。01・02…の連番で保存します。</span></div>' +
        '<div class="pbi-range"><strong>保存範囲：</strong><input type="number" class="pbi-range-start" min="1" value="1"><span>〜</span><input type="number" class="pbi-range-end" min="1" value="1"><span>枚目</span><button type="button" class="pbi-save-range">⬇️ PNG保存</button><button type="button" class="pbi-zip-range pbi-primary">📦 この範囲をZIP</button></div>' +
        '<div class="pbi-status">まだ検出していません。</div>' +
      '</div>' +
      '<main class="pbi-list"></main>';

    statusNode = root.querySelector('.pbi-status');
    listNode = root.querySelector('.pbi-list');
    titleInput = root.querySelector('.pbi-title');

    root.querySelector('.pbi-detect').addEventListener('click', detect);
    root.querySelector('.pbi-save-selected').addEventListener('click', saveSelected);
    root.querySelector('.pbi-zip-selected').addEventListener('click', saveSelectedZip);
    root.querySelector('.pbi-save-range').addEventListener('click', saveRange);
    root.querySelector('.pbi-zip-range').addEventListener('click', saveRangeZip);
    root.querySelector('.pbi-select-all').addEventListener('click', () => {
      listNode.querySelectorAll('.pbi-check').forEach(x => x.checked = true);
    });
    root.querySelector('.pbi-clear-all').addEventListener('click', () => {
      listNode.querySelectorAll('.pbi-check').forEach(x => x.checked = false);
    });
    root.querySelector('.pbi-close').addEventListener('click', closePanel);

    document.body.append(button, root);
  }

  async function openPanel() {
    build();
    if (!root) return;
    root.classList.add('open');
    if (titleInput) titleInput.value = extractTitle();
    if (!found.length) await detect();
  }

  function closePanel() {
    root?.classList.remove('open');
  }

  window.__pictblandImageSaveUi = {
    open: openPanel,
    close: closePanel,
    detect,
    isImageWork,
    count: () => found.length
  };

  if (isItemPage()) {
    if (document.body) build();
    else addEventListener('DOMContentLoaded', build, {once:true});
  }
})();


// ---- Unified pictBLand tools shell (v0.3.0) ----
(() => {
  'use strict';
  if (window.__pictblandUnifiedToolsV030) return;
  window.__pictblandUnifiedToolsV030 = true;

  const BAR_ID='pictbland-tools-unified-bar';
  const LAUNCH_ID='pictbland-tools-unified-launch';
  const PLACEHOLDER_ID='pictbland-tools-unified-placeholder';
  const OFFSET=76;
  let active='';

  function isNovelPage() {
    return /^\/items\/detail\//.test(location.pathname);
  }

  function novelUi() {
    return {
      button:document.getElementById('pbnt-button'),
      overlay:document.getElementById('pbnt-root')
    };
  }

  function searchUi() {
    return window.__pictblandSavedSearchUi || null;
  }

  function imageUi() {
    return window.__pictblandImageSaveUi || null;
  }

  function hideNovel() {
    novelUi().overlay?.classList.remove('pbnt-open');
  }

  function hideSearch() {
    searchUi()?.close?.();
  }

  function hideImage() {
    imageUi()?.close?.();
  }

  function hidePlaceholder() {
    document.getElementById(PLACEHOLDER_ID)?.classList.remove('open');
  }

  function showPlaceholder(message) {
    const p=document.getElementById(PLACEHOLDER_ID);
    if(!p)return;
    p.textContent=message;
    p.classList.add('open');
  }

  function paintTabs() {
    const bar=document.getElementById(BAR_ID);
    if(!bar)return;
    for(const b of bar.querySelectorAll('[data-tool-tab]')) b.classList.toggle('active',b.dataset.toolTab===active);
  }

  function openNovel() {
    active='novel';
    paintTabs();
    hidePlaceholder();
    hideSearch();
    hideImage();
    if(!isNovelPage()){
      hideNovel();
      showPlaceholder('📖 小説TXTはpictBLandの小説作品ページで利用できます。');
      return;
    }
    const n=novelUi();
    if(!n.button||!n.overlay){
      showPlaceholder('小説TXT機能を準備中です。少し待ってからもう一度お試しください。');
      return;
    }
    if(n.overlay.querySelector('.pbnt-page')) n.overlay.classList.add('pbnt-open');
    else n.button.click();
  }

  function openSearch() {
    active='search';
    paintTabs();
    hidePlaceholder();
    hideNovel();
    hideImage();
    const s=searchUi();
    if(!s?.open){
      showPlaceholder('保存検索機能を準備中です。少し待ってからもう一度お試しください。');
      return;
    }
    s.open();
  }

  function openImage() {
    active='image';
    paintTabs();
    hidePlaceholder();
    hideNovel();
    hideSearch();
    if(!isNovelPage()){
      hideImage();
      showPlaceholder('🖼️ 画像保存はpictBLandの作品詳細ページで利用できます。');
      return;
    }
    const i=imageUi();
    if(!i?.open){
      showPlaceholder('画像保存機能を準備中です。少し待ってからもう一度お試しください。');
      return;
    }
    i.open();
  }

  function switchTo(tab) {
    if(tab==='novel')openNovel();
    else if(tab==='image')openImage();
    else openSearch();
  }

  function closeAll() {
    hidePlaceholder();
    hideNovel();
    hideSearch();
    hideImage();
    document.getElementById(BAR_ID)?.classList.remove('open');
  }

  function openShell() {
    document.getElementById(BAR_ID)?.classList.add('open');
    switchTo(isNovelPage()?(imageUi()?.isImageWork?.()?'image':'novel'):'search');
  }

  function build() {
    if(!document.body||document.getElementById(BAR_ID))return;

    const style=document.createElement('style');
    style.textContent=`
      #pbnt-button,#pbsw-button,#pbi-button{display:none!important}
      #pbnt-root,#pbsw-root,#pbi-root{top:${OFFSET}px!important;right:0!important;bottom:0!important;left:0!important;height:auto!important}
      #${LAUNCH_ID}{position:fixed;right:14px;bottom:max(76px,env(safe-area-inset-bottom));z-index:2147483001;border:0;border-radius:999px;padding:12px 16px;background:#7356a8;color:#fff;font:700 14px/1.2 -apple-system,BlinkMacSystemFont,'Noto Sans JP',sans-serif;box-shadow:0 4px 18px #0004}
      #${BAR_ID}{display:none;position:fixed;top:0;left:0;right:0;height:${OFFSET}px;z-index:2147483647;background:#fff;color:#202124;border-bottom:1px solid #dfe3e8;box-shadow:0 2px 9px #0002;padding:max(7px,env(safe-area-inset-top)) 8px 7px;font-family:-apple-system,BlinkMacSystemFont,'Noto Sans JP',sans-serif}
      #${BAR_ID}.open{display:flex;align-items:flex-end;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch}
      #${BAR_ID} .pt-title{font-weight:800;font-size:14px;white-space:nowrap;margin:0 3px 5px 2px}
      #${BAR_ID} [data-tool-tab],#${BAR_ID} .pt-close,#${BAR_ID} [data-ncb-slot] button{flex:0 0 auto;border:1px solid #cec7dc;background:#fff;color:#33294a;border-radius:9px;padding:9px 10px;font:700 12px/1 -apple-system,BlinkMacSystemFont,'Noto Sans JP',sans-serif}
      #${BAR_ID} [data-tool-tab].active{background:#7356a8;color:#fff;border-color:#7356a8}
      #${BAR_ID} [data-ncb-slot]{display:flex;flex:0 0 auto}
      #${BAR_ID} .pt-close{margin-left:auto}
      #${PLACEHOLDER_ID}{display:none;position:fixed;top:${OFFSET}px;right:0;bottom:0;left:0;z-index:2147483645;background:#f4f6f8;color:#5f586a;padding:36px 20px;text-align:center;font:14px/1.8 -apple-system,BlinkMacSystemFont,'Noto Sans JP',sans-serif}
      #${PLACEHOLDER_ID}.open{display:block}
      @media(max-width:600px){
        #${BAR_ID}{gap:5px;padding-left:6px;padding-right:6px}
        #${BAR_ID} .pt-title{display:none}
        #${BAR_ID} [data-tool-tab],#${BAR_ID} .pt-close,#${BAR_ID} [data-ncb-slot] button{font-size:11px;padding:8px 7px}
        #${LAUNCH_ID}{right:12px;padding:11px 14px}
      }
    `;
    document.head.append(style);

    const launch=document.createElement('button');
    launch.id=LAUNCH_ID;
    launch.type='button';
    launch.textContent='🧰 pictBLandツール';
    launch.addEventListener('click',openShell);

    const bar=document.createElement('div');
    bar.id=BAR_ID;

    const title=document.createElement('div');
    title.className='pt-title';
    title.textContent='pictBLandツール';

    const novel=document.createElement('button');
    novel.type='button';
    novel.dataset.toolTab='novel';
    novel.textContent='📖 小説TXT';
    novel.addEventListener('click',()=>switchTo('novel'));

    const image=document.createElement('button');
    image.type='button';
    image.dataset.toolTab='image';
    image.textContent='🖼️ 画像保存';
    image.addEventListener('click',()=>switchTo('image'));

    const search=document.createElement('button');
    search.type='button';
    search.dataset.toolTab='search';
    search.textContent='🔖 保存検索';
    search.addEventListener('click',()=>switchTo('search'));

    const cloudSlot=document.createElement('span');
    cloudSlot.dataset.ncbSlot='pictbland';

    const close=document.createElement('button');
    close.type='button';
    close.className='pt-close';
    close.textContent='閉じる';
    close.addEventListener('click',closeAll);

    bar.append(title,novel,image,search,cloudSlot,close);

    const placeholder=document.createElement('div');
    placeholder.id=PLACEHOLDER_ID;

    document.body.append(launch,bar,placeholder);
  }

  if(document.body)build();
  else addEventListener('DOMContentLoaded',build,{once:true});
})();
