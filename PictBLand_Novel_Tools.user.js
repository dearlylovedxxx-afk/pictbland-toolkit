// ==UserScript==
// @name         pictBLand 小説TXTツール
// @namespace    local.pictbland.novel-text-tools
// @version      0.2.0
// @description  pictBLandツールを1つのボタンに統合。小説TXT化と保存検索・クイック検索に対応します。
// @match        https://pictbland.net/*
// @run-at       document-idle
// @grant        none
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



// ---- Saved pictBLand search words (v0.1.9) ----
(() => {
  'use strict';
  if (window.__pictblandSavedSearchWordsV019) return;
  window.__pictblandSavedSearchWordsV019 = true;

  const STORAGE_KEY = 'pictbland-saved-search-words-v1';
  const BUTTON_ID = 'pbsw-button';
  const ROOT_ID = 'pbsw-root';
  const MAX_SAVED = 200;
  let root = null;
  let quickInput = null;

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
    // pictBLandの既知の検索URL形式：/tags/index/+検索語+
    // 空白は + にし、検索演算子として入力された + / - はそのまま残す。
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

  function render() {
    if (!root) return;
    const rows = readSaved();
    const list = root.querySelector('.pbsw-list');
    const current = currentSearch();
    const saveCurrentBtn = root.querySelector('.pbsw-save-current');
    root.querySelector('.pbsw-current').textContent = current
      ? '現在の検索語：' + current.word
      : '検索語を入力するか、保存済みの検索語をタップしてください。';
    saveCurrentBtn.hidden = !current;
    list.replaceChildren();

    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'pbsw-empty';
      p.textContent = '保存した検索語はまだありません。上の入力欄から検索・保存できます。';
      list.append(p);
      return;
    }

    rows.forEach((row, index) => {
      const card = document.createElement('article');
      card.className = 'pbsw-card';

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'pbsw-open';
      open.title = 'タップして検索';
      open.addEventListener('click', () => runSearch(row.word, row.href));
      const name = document.createElement('strong');
      name.textContent = row.name || row.word;
      const word = document.createElement('span');
      word.textContent = '🔎 ' + row.word;
      open.append(name, word);

      const actions = document.createElement('div');
      actions.className = 'pbsw-actions';
      const make = (label, fn, disabled=false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.disabled = disabled;
        b.addEventListener('click', fn);
        return b;
      };
      actions.append(
        make('🔎 検索する', () => runSearch(row.word, row.href)),
        make('名前変更', () => rename(row.id)),
        make('↑', () => move(row.id, -1), index === 0),
        make('↓', () => move(row.id, 1), index === rows.length - 1),
        make('削除', () => remove(row.id))
      );

      card.append(open, actions);
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
      #${ROOT_ID} .pbsw-wrap{max-width:820px;margin:auto;padding:18px 14px 80px}
      #${ROOT_ID} .pbsw-head{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;background:#fff;border:1px solid #ded9e8;border-radius:12px;padding:14px;margin-bottom:12px;position:sticky;top:0;z-index:2}
      #${ROOT_ID} h2{font-size:18px;margin:0}
      #${ROOT_ID} button,#${ROOT_ID} input{font:inherit;border:1px solid #cfc8dc;border-radius:8px;background:#fff;color:#2d2640;padding:9px 10px}
      #${ROOT_ID} button:disabled{opacity:.45}
      #${ROOT_ID} .pbsw-current{flex:1 1 100%;font-size:12px;color:#6b6478}
      #${ROOT_ID} .pbsw-quick{display:flex;gap:7px;flex:1 1 100%;flex-wrap:wrap}
      #${ROOT_ID} .pbsw-quick input{flex:1 1 260px;min-width:0}
      #${ROOT_ID} .pbsw-search,#${ROOT_ID} .pbsw-save-current{background:#7356a8;color:#fff;border-color:#7356a8;font-weight:700}
      #${ROOT_ID} .pbsw-card{background:#fff;border:1px solid #ded9e8;border-radius:12px;padding:10px;margin-bottom:10px}
      #${ROOT_ID} .pbsw-open{display:flex;width:100%;text-align:left;flex-direction:column;gap:4px;border:0;background:transparent;padding:5px;cursor:pointer}
      #${ROOT_ID} .pbsw-open strong{font-size:15px}
      #${ROOT_ID} .pbsw-open span{font-size:12px;color:#716b7b;overflow-wrap:anywhere}
      #${ROOT_ID} .pbsw-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
      #${ROOT_ID} .pbsw-actions button{font-size:12px;padding:7px 9px}
      #${ROOT_ID} .pbsw-empty{background:#fff;border:1px solid #ded9e8;border-radius:12px;padding:18px;color:#716b7b}
      @media(max-width:600px){#${BUTTON_ID}{right:12px;padding:10px 13px}#${ROOT_ID} .pbsw-wrap{padding:10px 8px 70px}#${ROOT_ID} h2{font-size:16px}}
    `;
    document.head.append(style);

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '🔖 検索';
    button.addEventListener('click', () => {
      render();
      root.classList.add('open');
      setTimeout(() => quickInput?.focus(), 0);
    });

    root = document.createElement('section');
    root.id = ROOT_ID;
    root.innerHTML = '<div class="pbsw-wrap"><div class="pbsw-head"><h2>🔖 pictBLand 保存検索</h2><button type="button" class="pbsw-save-current">現在の検索語を保存</button><button type="button" class="pbsw-close">閉じる</button><div class="pbsw-current"></div><div class="pbsw-quick"><input class="pbsw-input" type="search" placeholder="検索語を入力"><button type="button" class="pbsw-search">🔎 検索</button><button type="button" class="pbsw-save-input">この語を保存</button></div></div><div class="pbsw-list"></div></div>';
    quickInput = root.querySelector('.pbsw-input');
    root.querySelector('.pbsw-save-current').addEventListener('click', saveCurrent);
    root.querySelector('.pbsw-search').addEventListener('click', runQuickSearch);
    root.querySelector('.pbsw-save-input').addEventListener('click', saveQuickSearch);
    root.querySelector('.pbsw-close').addEventListener('click', () => root.classList.remove('open'));
    quickInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runQuickSearch();
      }
    });

    document.body.append(button, root);
    render();
  }

  function openPanel() {
    build();
    if (!root) return;
    render();
    root.classList.add('open');
    setTimeout(() => quickInput?.focus(), 0);
  }

  function closePanel() {
    root?.classList.remove('open');
  }

  function countSaved() {
    return readSaved().length;
  }

  window.__pictblandSavedSearchUi = {open:openPanel, close:closePanel, render, count:countSaved, storageKey:STORAGE_KEY};

  if (document.body) build();
  else addEventListener('DOMContentLoaded', build, {once:true});
})();


// ---- Unified pictBLand tools shell (v0.2.0) ----
(() => {
  'use strict';
  if (window.__pictblandUnifiedToolsV020) return;
  window.__pictblandUnifiedToolsV020 = true;

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

  function hideNovel() {
    novelUi().overlay?.classList.remove('pbnt-open');
  }

  function hideSearch() {
    searchUi()?.close?.();
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
    const s=searchUi();
    if(!s?.open){
      showPlaceholder('保存検索機能を準備中です。少し待ってからもう一度お試しください。');
      return;
    }
    s.open();
  }

  function switchTo(tab) {
    if(tab==='novel')openNovel();
    else openSearch();
  }

  function closeAll() {
    hidePlaceholder();
    hideNovel();
    hideSearch();
    document.getElementById(BAR_ID)?.classList.remove('open');
  }

  function openShell() {
    document.getElementById(BAR_ID)?.classList.add('open');
    switchTo(isNovelPage()?'novel':'search');
  }

  function build() {
    if(!document.body||document.getElementById(BAR_ID))return;

    const style=document.createElement('style');
    style.textContent=`
      #pbnt-button,#pbsw-button{display:none!important}
      #pbnt-root,#pbsw-root{top:${OFFSET}px!important;right:0!important;bottom:0!important;left:0!important;height:auto!important}
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

    bar.append(title,novel,search,cloudSlot,close);

    const placeholder=document.createElement('div');
    placeholder.id=PLACEHOLDER_ID;

    document.body.append(launch,bar,placeholder);
  }

  if(document.body)build();
  else addEventListener('DOMContentLoaded',build,{once:true});
})();
