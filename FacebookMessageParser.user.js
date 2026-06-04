// ==UserScript==
// @name         Facebook Message Parser
// @namespace    https://github.com/BelaSzombathelyi/FacebookMessageParser
// @version      0.1.0
// @description  Export the opened Facebook Messenger conversation to a Markdown file.
// @author       BelaSzombathelyi
// @match        *://*.facebook.com/messages/*
// @match        *://*.messenger.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const BUTTON_ID = 'facebook-message-parser-export';
  const STATUS_ID = 'facebook-message-parser-status';
  const STYLE_ID = 'facebook-message-parser-style';
  const MAX_SCROLL_ATTEMPTS = 30;
  const SCROLL_DELAY_MS = 750;

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function normalizeWhitespace(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizeText(value) {
    return normalizeWhitespace(value)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
  }

  function escapeMarkdown(value) {
    return String(value || '').replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
  }

  function sanitizeFilename(value) {
    return String(value || 'messenger-export')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'messenger-export';
  }

  function isVisible(element) {
    return !!element && element.getClientRects().length > 0;
  }

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function looksLikeDateLabel(value) {
    return /(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i.test(value);
  }

  function looksLikeTime(value) {
    return /\b\d{1,2}:\d{2}(?:\s?[APMapm]{2})?\b/.test(value);
  }

  function looksLikeStatusLine(value) {
    return /^(seen by|sent|delivered|active now|you replied to|replying to)/i.test(value);
  }

  function getConversationRoot() {
    return document.querySelector('div[role="main"]') || document.body;
  }

  function getConversationTitle(root) {
    const candidates = [
      root.querySelector('h1'),
      root.querySelector('h2'),
      document.querySelector('[role="banner"] h1'),
      document.querySelector('[role="banner"] h2')
    ];

    for (const candidate of candidates) {
      const text = normalizeText(candidate && candidate.textContent);
      if (text) {
        return text;
      }
    }

    return 'Messenger conversation';
  }

  function getMessageRows(root) {
    return Array.from(root.querySelectorAll('div[role="row"]')).filter((row) => {
      if (!isVisible(row)) {
        return false;
      }

      if (row.querySelector('[contenteditable="true"]')) {
        return false;
      }

      return normalizeText(row.innerText).length > 0;
    });
  }

  function getScrollableContainer(root) {
    const candidates = [root, ...root.querySelectorAll('div')];
    let best = null;

    for (const element of candidates) {
      if (!isVisible(element)) {
        continue;
      }

      if (element.scrollHeight <= element.clientHeight + 100) {
        continue;
      }

      const rowCount = element.querySelectorAll('div[role="row"]').length;
      if (!rowCount) {
        continue;
      }

      if (!best || rowCount > best.rowCount) {
        best = { element, rowCount };
      }
    }

    return best ? best.element : null;
  }

  async function loadOlderMessages(root, onStatus) {
    const scroller = getScrollableContainer(root);
    if (!scroller) {
      return;
    }

    let stableIterations = 0;
    let previousSignature = '';

    for (let attempt = 1; attempt <= MAX_SCROLL_ATTEMPTS && stableIterations < 3; attempt += 1) {
      const rows = getMessageRows(root);
      const signature = rows.slice(0, 3).map((row) => normalizeText(row.innerText)).join('|');

      if (signature === previousSignature) {
        stableIterations += 1;
      } else {
        stableIterations = 0;
        previousSignature = signature;
      }

      if (scroller.scrollTop === 0 && stableIterations >= 2) {
        break;
      }

      onStatus(`Loading earlier messages… (${attempt}/${MAX_SCROLL_ATTEMPTS})`);
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await delay(SCROLL_DELAY_MS);
    }
  }

  function getPrimaryBubble(row) {
    const candidates = Array.from(
      row.querySelectorAll('div[tabindex="-1"], div[dir="auto"], span[dir="auto"], abbr')
    ).filter((element) => isVisible(element) && normalizeText(element.innerText || element.textContent));

    return candidates.sort((left, right) => {
      const leftLength = normalizeText(left.innerText || left.textContent).length;
      const rightLength = normalizeText(right.innerText || right.textContent).length;
      return rightLength - leftLength;
    })[0] || row;
  }

  function isOutgoingRow(row, root) {
    const bubble = getPrimaryBubble(row);
    const bubbleRect = bubble.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();

    if (bubbleRect.width === 0 || rootRect.width === 0) {
      return /you sent|you replied/i.test(row.getAttribute('aria-label') || '');
    }

    return bubbleRect.left > rootRect.left + rootRect.width * 0.45;
  }

  function extractTextLines(row) {
    const walker = document.createTreeWalker(
      row,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          const value = normalizeWhitespace(node.textContent);

          if (!parent || !value) {
            return NodeFilter.FILTER_REJECT;
          }

          if (!isVisible(parent)) {
            return NodeFilter.FILTER_REJECT;
          }

          if (parent.closest('button, [role="button"], script, style, noscript, svg')) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const lines = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
      lines.push(normalizeWhitespace(currentNode.textContent));
      currentNode = walker.nextNode();
    }

    return unique(lines);
  }

  function extractTimestampCandidates(row) {
    const values = [];
    const elements = row.querySelectorAll('abbr, [title], [data-tooltip-content], [aria-label]');

    for (const element of elements) {
      for (const value of [
        element.getAttribute('title'),
        element.getAttribute('data-tooltip-content'),
        element.getAttribute('aria-label'),
        element.textContent
      ]) {
        const normalized = normalizeText(value);
        if (normalized && (looksLikeTime(normalized) || looksLikeDateLabel(normalized))) {
          values.push(normalized);
        }
      }
    }

    return unique(values);
  }

  function detectSender(row, lines, isOutgoing, state) {
    if (isOutgoing) {
      return 'You';
    }

    const header = row.querySelector('h3, h4, strong');
    const headerText = normalizeText(header && header.textContent);
    if (headerText && !looksLikeDateLabel(headerText) && !looksLikeTime(headerText)) {
      state.lastIncomingSender = headerText;
      return headerText;
    }

    const candidate = lines[0];
    if (
      lines.length > 1 &&
      candidate &&
      candidate.length < 80 &&
      !looksLikeDateLabel(candidate) &&
      !looksLikeTime(candidate)
    ) {
      state.lastIncomingSender = candidate;
      return candidate;
    }

    return state.lastIncomingSender || 'Unknown';
  }

  function detectTimestamp(lines, timestampCandidates, currentDateLabel) {
    const timeLine = lines.find((line) => looksLikeTime(line));
    const candidate = timestampCandidates.find((value) => looksLikeTime(value) || looksLikeDateLabel(value)) || timeLine;

    if (!candidate) {
      return currentDateLabel || 'Unknown date';
    }

    if (currentDateLabel && looksLikeTime(candidate) && !candidate.toLowerCase().includes(currentDateLabel.toLowerCase())) {
      return `${currentDateLabel} ${candidate}`;
    }

    return candidate;
  }

  function getAttachmentLabels(row) {
    return unique(
      Array.from(row.querySelectorAll('img[alt], video[aria-label], a[href]'))
        .map((element) =>
          normalizeText(
            element.getAttribute('alt') ||
              element.getAttribute('aria-label') ||
              element.textContent
          )
        )
        .filter((value) => value && !/profile picture|open photo|messenger/i.test(value))
    );
  }

  function buildMessageText(lines, sender, currentDateLabel, timestampCandidates, title, row) {
    const ignored = new Set([sender, currentDateLabel, title, ...timestampCandidates]);
    const messageLines = lines.filter((line) => {
      if (!line || ignored.has(line)) {
        return false;
      }

      if (looksLikeStatusLine(line)) {
        return false;
      }

      if (looksLikeDateLabel(line) && line === currentDateLabel) {
        return false;
      }

      return true;
    });

    if (messageLines.length) {
      return messageLines.join('\n');
    }

    const attachmentLabels = getAttachmentLabels(row);
    if (attachmentLabels.length) {
      return attachmentLabels.map((value) => `[Attachment] ${value}`).join('\n');
    }

    return '';
  }

  function isDateSeparator(lines, row) {
    if (row.querySelector('abbr')) {
      return false;
    }

    return lines.length > 0 && lines.length <= 2 && lines.every((line) => looksLikeDateLabel(line) || looksLikeTime(line));
  }

  function parseLoadedConversation() {
    const root = getConversationRoot();
    const title = getConversationTitle(root);
    const rows = getMessageRows(root);
    const state = { lastIncomingSender: '' };
    const messages = [];
    let currentDateLabel = '';

    for (const row of rows) {
      const lines = extractTextLines(row);
      if (!lines.length) {
        continue;
      }

      if (isDateSeparator(lines, row)) {
        currentDateLabel = lines.join(' ');
        continue;
      }

      const outgoing = isOutgoingRow(row, root);
      const timestampCandidates = extractTimestampCandidates(row);
      const sender = detectSender(row, lines, outgoing, state);
      const timestamp = detectTimestamp(lines, timestampCandidates, currentDateLabel);
      const text = buildMessageText(lines, sender, currentDateLabel, timestampCandidates, title, row);

      if (!text) {
        continue;
      }

      messages.push({ sender, timestamp, text });
    }

    return {
      conversationTitle: title,
      exportedAt: new Date().toISOString(),
      url: window.location.href,
      messageCount: messages.length,
      messages
    };
  }

  function buildMarkdown(exportData) {
    const header = [
      '# Messenger export',
      '',
      `- Conversation: ${escapeMarkdown(exportData.conversationTitle)}`,
      `- Exported at: ${escapeMarkdown(exportData.exportedAt)}`,
      `- Source: ${escapeMarkdown(exportData.url)}`,
      `- Message count: ${exportData.messageCount}`,
      '',
      '## Messages',
      ''
    ];

    const body = exportData.messages.flatMap((message, index) => [
      `### ${index + 1}. ${escapeMarkdown(message.sender)} — ${escapeMarkdown(message.timestamp)}`,
      '',
      ...normalizeText(message.text)
        .split('\n')
        .map((line) => line ? `${escapeMarkdown(line)}` : ''),
      ''
    ]);

    return [...header, ...body].join('\n').trim() + '\n';
  }

  function downloadMarkdown(filename, contents) {
    const blob = new Blob([contents], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = filename;
    link.click();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID} {
        position: fixed;
        right: 24px;
        bottom: 24px;
        z-index: 2147483647;
        border: none;
        border-radius: 999px;
        padding: 12px 18px;
        background: #1877f2;
        color: #fff;
        font-size: 14px;
        font-weight: 600;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
        cursor: pointer;
      }

      #${BUTTON_ID}[disabled] {
        cursor: wait;
        opacity: 0.75;
      }

      #${STATUS_ID} {
        position: fixed;
        right: 24px;
        bottom: 74px;
        z-index: 2147483647;
        max-width: 320px;
        border-radius: 12px;
        padding: 10px 14px;
        background: rgba(24, 119, 242, 0.92);
        color: #fff;
        font-size: 13px;
        line-height: 1.4;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
      }
    `;

    document.head.appendChild(style);
  }

  function setStatus(message) {
    let status = document.getElementById(STATUS_ID);
    if (!status) {
      status = document.createElement('div');
      status.id = STATUS_ID;
      document.body.appendChild(status);
    }

    status.textContent = message;

    if (message) {
      window.clearTimeout(setStatus.timeoutId);
      setStatus.timeoutId = window.setTimeout(() => {
        const currentStatus = document.getElementById(STATUS_ID);
        if (currentStatus) {
          currentStatus.remove();
        }
      }, 5000);
    }
  }

  async function exportConversation() {
    const button = document.getElementById(BUTTON_ID);
    if (!button) {
      return;
    }

    button.disabled = true;

    try {
      const root = getConversationRoot();
      setStatus('Loading visible conversation history…');
      await loadOlderMessages(root, setStatus);

      setStatus('Extracting messages…');
      const exportData = parseLoadedConversation();
      if (!exportData.messages.length) {
        throw new Error('No exportable messages were found in the current conversation.');
      }

      const markdown = buildMarkdown(exportData);
      const filename = `${sanitizeFilename(exportData.conversationTitle)}-${new Date().toISOString().slice(0, 10)}.md`;

      downloadMarkdown(filename, markdown);
      setStatus(`Exported ${exportData.messageCount} messages to ${filename}`);
    } catch (error) {
      console.error('[FacebookMessageParser]', error);
      setStatus(error.message || 'Export failed.');
    } finally {
      button.disabled = false;
    }
  }

  function ensureButton() {
    if (document.getElementById(BUTTON_ID) || !document.body) {
      return;
    }

    ensureStyle();

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Export chat to Markdown';
    button.addEventListener('click', exportConversation);
    document.body.appendChild(button);
  }

  function install() {
    ensureButton();
    const observer = new MutationObserver(() => ensureButton());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  const exportedApi = {
    buildMarkdown,
    normalizeText,
    parseLoadedConversation,
    sanitizeFilename
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportedApi;
  }

  if (typeof window !== 'undefined') {
    window.FacebookMessageParser = exportedApi;
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    install();
  }
})();
