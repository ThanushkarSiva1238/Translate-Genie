import {
  translateText,
  paraphraseText,
  synthesizeSpeech,
  getApiKey,
  setApiKey,
  clearApiKey,
  hasApiKey,
  friendlyErrorMessage,
} from "./gemini.js";

const PRIMARY_LANGUAGES = ["Tamil", "English", "Sinhala"];
// This list feeds both the "Other" search on the first language prompt and the full "Translate to" picker used to change a translation's target language afterward. 
// Free-text entry (Enter on an unmatched search) always works too — this list is just what's suggested, not a hard limit; Gemini can translate plenty of languages that aren't in it.
const COMMON_LANGUAGES = [
  "Tamil", "English", "Sinhala", "Hindi", "Malayalam", "Telugu", "Kannada", "Bengali",
  "Urdu", "Punjabi", "Gujarati", "Marathi", "Nepali", "Sindhi",
  "Arabic", "Hebrew", "Persian", "Turkish", "Kurdish",
  "Chinese", "Japanese", "Korean", "Vietnamese", "Thai", "Indonesian", "Malay",
  "Filipino", "Burmese", "Khmer", "Lao", "Mongolian",
  "French", "German", "Spanish", "Italian", "Portuguese", "Dutch",
  "Swedish", "Norwegian", "Danish", "Finnish", "Icelandic",
  "Polish", "Czech", "Slovak", "Hungarian", "Romanian", "Bulgarian",
  "Greek", "Russian", "Ukrainian", "Croatian", "Serbian",
  "Swahili", "Amharic", "Zulu", "Afrikaans", "Somali", "Hausa", "Yoruba",
];
const PARAPHRASE_STYLES = ["Casual", "Professional", "Formal", "Academic", "Simple", "Natural", "Creative"];
const WELCOME_TEXT = "Hi, I am Translate Genie, your translation supporter. What would you like to translate...?";
const HISTORY_KEY = "translate-genie-history";
const RECENT_LANG_KEY = "translate-genie-recent-languages";
const MAX_RECENT_LANGUAGES = 6;

// Maps the app's language names to BCP-47 codes so the browser's built-in text-to-speech picks a voice for the right language instead of guessing. 
// Voice availability (especially for Tamil/Sinhala) depends on the user's OS/browser, not on this app — if no matching voice is installed, the browser falls back to its default voice for that code.
const LANGUAGE_SPEECH_CODES = {
  Tamil: "ta-IN",
  English: "en-US",
  Sinhala: "si-LK",
  Hindi: "hi-IN",
  Malayalam: "ml-IN",
  Telugu: "te-IN",
  Kannada: "kn-IN",
  Bengali: "bn-IN",
  Arabic: "ar-SA",
  Chinese: "zh-CN",
  Japanese: "ja-JP",
  Korean: "ko-KR",
  French: "fr-FR",
  German: "de-DE",
  Spanish: "es-ES",
  Italian: "it-IT",
  Portuguese: "pt-PT",
  Russian: "ru-RU",
};

const SPEAKER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 9v6h4l5 5V4L8 9H4z" fill="currentColor"/><path d="M16.2 8.8a5 5 0 0 1 0 6.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M18.8 6.2a9 9 0 0 1 0 11.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

// Speaks text using Gemini's TTS model first (natural voice, correct pronunciation even for Tamil/Sinhala), falling back to the browser's free built-in speechSynthesis if the Gemini call fails for any reason (offline, rate-limited, key issue, unsupported browser, etc.) — the Listen button should never just go dead.
// `button`, if given, gets a transient "loading" class while the Gemini request is in flight and a "speaking" class for the duration of playback, and acts as a toggle: clicking an active button stops playback instead of restarting it. Only one thing (speechSynthesis utterance or <audio> element) ever plays at a time, whichever button it came from.
let currentAudioEl = null;

function stopAllPlayback() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  if (currentAudioEl) {
    currentAudioEl.pause();
    currentAudioEl.src = "";
    currentAudioEl = null;
  }
  document.querySelectorAll(".speak-btn.speaking, .speak-btn.loading").forEach((b) => {
    b.classList.remove("speaking", "loading");
  });
}

function speakWithBrowserVoice(text, languageName, button) {
  if (!("speechSynthesis" in window)) {
    showToast("Text-to-speech isn't supported in this browser.");
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  const code = LANGUAGE_SPEECH_CODES[languageName];
  if (code) utterance.lang = code;
  if (button) {
    button.classList.add("speaking");
    utterance.onend = () => button.classList.remove("speaking");
    utterance.onerror = () => button.classList.remove("speaking");
  }
  window.speechSynthesis.speak(utterance);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function writeAsciiString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// Gemini TTS returns bare 16-bit signed little-endian PCM, mono — not a playable file. Wrapping it in a minimal 44-byte WAV header lets a plain <audio> element play it with no decoding library needed.
function pcmToWavBlob(base64Pcm, sampleRate) {
  const pcmBytes = base64ToUint8Array(base64Pcm);
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;

  const buffer = new ArrayBuffer(44 + pcmBytes.length);
  const view = new DataView(buffer);

  writeAsciiString(view, 0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeAsciiString(view, 8, "WAVE");
  writeAsciiString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAsciiString(view, 36, "data");
  view.setUint32(40, pcmBytes.length, true);
  new Uint8Array(buffer, 44).set(pcmBytes);

  return new Blob([buffer], { type: "audio/wav" });
}

async function playPronunciation(text, languageName, button) {
  if (!text) return;
  const wasActive = button?.classList.contains("speaking") || button?.classList.contains("loading");
  stopAllPlayback();
  if (wasActive) return; // clicking an already-active speaker just stops it

  if (button) button.classList.add("loading");

  try {
    const { base64Pcm, sampleRate } = await synthesizeSpeech(text);
    // Another click may have stopped playback (clearing "loading") while
    // this request was in flight — don't resurrect stale audio underneath it.
    if (button && !button.classList.contains("loading")) return;

    const blob = pcmToWavBlob(base64Pcm, sampleRate);
    const url = URL.createObjectURL(blob);
    const audioEl = new Audio(url);
    currentAudioEl = audioEl;
    if (button) {
      button.classList.remove("loading");
      button.classList.add("speaking");
    }
    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (currentAudioEl === audioEl) currentAudioEl = null;
      button?.classList.remove("speaking");
    };
    audioEl.addEventListener("ended", cleanup);
    audioEl.addEventListener("error", cleanup);
    await audioEl.play();
  } catch (err) {
    console.warn("[translate-genie] Gemini TTS failed, falling back to browser voice:", err);
    if (button) button.classList.remove("loading");
    speakWithBrowserVoice(text, languageName, button);
  }
}

// Builds a small speaker icon button. getText/getLanguage are functions (not plain values) so the button always reads whatever text is current at the moment it's clicked — important since translation cards update their contents in place (e.g. after Swap).
function speakerButton(getText, getLanguage, label = "Listen to pronunciation") {
  const btn = el("button", "speak-btn");
  btn.type = "button";
  btn.innerHTML = SPEAKER_ICON;
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.addEventListener("click", () => playPronunciation(getText(), getLanguage(), btn));
  return btn;
}

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const qs = (id) => document.getElementById(id);
const el = (tag, className, children) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (children) for (const c of children) node.append(c);
  return node;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let pending = null; // { text, sourceLanguage, promptId }
let isProcessing = false;
let studyMode = false;
let swappingId = null;
let history = loadHistory();
let recentLanguages = loadRecentLanguages();
let thinkingEl = null;
const cardControllers = new Map(); // messageId -> { setResult(result) }

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const chatMessages = qs("chat-messages");
const input = qs("chat-input");
const sendBtn = qs("send-btn");
const clearInputBtn = qs("clear-input-btn");
const wordCountEl = qs("word-count");
const modeSwitch = qs("mode-switch");
const newBtn = qs("new-btn");
const historyBtn = qs("history-btn");
const settingsBtn = qs("settings-btn");
const aboutBtn = qs("about-btn");
const toastEl = qs("toast");
const languagePickerModal = qs("language-picker-modal");
const languagePickerSearch = qs("language-picker-search");
const languagePickerList = qs("language-picker-list");

// ---------------------------------------------------------------------------
// Genie avatar helper
// ---------------------------------------------------------------------------
function genieAvatar(width = 36, height = 60, state = "idle") {
  // Note: no "float" class here — that vertical bob animation is meant for the header logo. Applying it to every message avatar made each one continuously drift up and down relative to its (static) text bubble, so the row never looked level. "breathe" (a subtle scale pulse, no vertical movement) is kept for a bit of life without breaking alignment.
  const wrap = el("div", `genie-avatar breathe${state === "thinking" ? " thinking" : ""}`);
  wrap.style.width = width + "px";
  wrap.style.height = height + "px";
  const img = document.createElement("img");
  img.src = state === "thinking" ? "assets/genie-thinking.png" : "assets/genie-idle.png";
  img.alt = "";
  wrap.append(img);
  return wrap;
}
function genieAvatar1(width = 36, height = 60) {
  // Note: 
  // no "float" class here — that vertical bob animation is meant for the header logo.
  // Applying it to every message avatar made each one continuously drift up and down relative to its (static) text bubble, so the row never looked level. "breathe" (a subtle scale pulse, no vertical movement) is kept for a bit of life without breaking alignment.
  const wrap = el("div", "genie-avatar");
  wrap.style.width = width + "px";
  wrap.style.height = height + "px";
  const img = document.createElement("img");
  img.src = "assets/genie-offering.png";
  img.alt = "";
  wrap.append(img);
  return wrap;
}
function genieAvatar2(width = 36, height = 60) {
  const wrap = el("div", "genie-avatar");
  wrap.style.width = width + "px";
  wrap.style.height = height + "px";
  const img = document.createElement("img");
  img.src = "assets/genie-get_it.png";
  img.alt = "";
  wrap.append(img);
  return wrap;
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------
function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendTextMessage(role, text, { isError = false } = {}) {
  const row = el("div", `msg-row${role === "user" ? " user" : ""} fade-up`);
  row.append(role === "genie" ? genieAvatar(36) : el("div", "user-dot"));
  const col = el("div", "msg-col");
  const bubble = el("div", `bubble ${isError ? "error" : role} fade-up`);
  bubble.textContent = text;
  col.append(bubble);
  row.append(col);
  chatMessages.append(row);
  scrollToBottom();
  return row;
}

function appendLanguagePrompt(promptId) {
  const row = el("div", "msg-row fade-up");
  row.append(genieAvatar1(36));
  const col = el("div", "msg-col");
  const bubble = el("div", "bubble genie fade-up");
  bubble.textContent = "Which language would you like to translate this into?";
  col.append(bubble);

  const selectWrap = buildLanguageSelector(promptId, (language) => handleSelectLanguage(language));
  col.append(selectWrap);
  row.append(col);
  chatMessages.append(row);
  scrollToBottom();
  return row;
}

function buildLanguageSelector(promptId, onSelect) {
  const wrap = el("div", "lang-select fade-up");
  wrap.dataset.promptId = promptId;

  const buttons = [];
  function disableAll() {
    buttons.forEach((b) => (b.disabled = true));
  }

  PRIMARY_LANGUAGES.forEach((lang) => {
    const btn = el("button", "lang-btn");
    btn.type = "button";
    btn.textContent = lang;
    btn.addEventListener("click", () => {
      disableAll();
      onSelect(lang);
    });
    buttons.push(btn);
    wrap.append(btn);
  });

  const otherBtn = el("button", "lang-btn lang-btn--other");
  otherBtn.type = "button";
  otherBtn.textContent = "Other";
  buttons.push(otherBtn);
  wrap.append(otherBtn);

  const otherWrap = el("div", "other-lang-wrap hidden");
  const otherInput = document.createElement("input");
  otherInput.type = "text";
  otherInput.className = "other-lang-input";
  otherInput.placeholder = "Type a language, e.g. Vietnamese";
  const otherList = el("ul", "other-lang-list hidden");
  otherWrap.append(otherInput, otherList);
  wrap.append(otherWrap);

  otherBtn.addEventListener("click", () => {
    otherWrap.classList.toggle("hidden");
    if (!otherWrap.classList.contains("hidden")) otherInput.focus();
  });

  function renderMatches() {
    const query = otherInput.value.trim().toLowerCase();
    otherList.innerHTML = "";
    if (!query) {
      otherList.classList.add("hidden");
      return;
    }
    otherList.classList.remove("hidden");
    const matches = COMMON_LANGUAGES.filter(
      (l) => !PRIMARY_LANGUAGES.includes(l) && l.toLowerCase().includes(query)
    );
    if (matches.length === 0) {
      const hint = el("li", "other-lang-hint");
      hint.textContent = `Press Enter to use “${otherInput.value.trim()}”`;
      otherList.append(hint);
      return;
    }
    matches.forEach((lang) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = lang;
      btn.addEventListener("click", () => {
        disableAll();
        otherInput.disabled = true;
        onSelect(lang);
      });
      li.append(btn);
      otherList.append(li);
    });
  }

  otherInput.addEventListener("input", renderMatches);
  otherInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && otherInput.value.trim()) {
      disableAll();
      otherInput.disabled = true;
      onSelect(otherInput.value.trim());
    }
  });

  // Called externally once this prompt is no longer the active one.
  wrap.disableAll = disableAll;
  wrap.disableOther = () => (otherInput.disabled = true);

  return wrap;
}

function appendTranslationCard(result, mode) {
  const id = uid();
  const row = el("div", "msg-row1 fade-up");
  row.append(genieAvatar2(36));
  const col = el("div", "msg-col");
  col.style.maxWidth = "100%";

  const card = buildTranslationCard(id, result, mode);
  col.append(card);
  row.append(col);
  chatMessages.append(row);
  scrollToBottom();
  return id;
}

function buildTranslationCard(id, result, mode) {
  const card = el("div", "translation-card glass");

  // Direction bar
  const directionBar = el("div", "tc-direction");
  const dirText = el("div");
  dirText.style.display = "flex";
  dirText.style.gap = "6px";
  dirText.style.fontFamily = "var(--font-display)";
  const srcSpan = document.createElement("span");
  const arrowSpan = el("span", "arrow");
  arrowSpan.textContent = "→";
  const tgtSpan = document.createElement("span");
  const changeLangBtn = el("button", "change-lang-btn");
  changeLangBtn.type = "button";
  changeLangBtn.title = "Translate to a different language";
  changeLangBtn.setAttribute("aria-label", "Translate to a different language");
  changeLangBtn.innerHTML =
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  dirText.append(srcSpan, arrowSpan, tgtSpan, changeLangBtn);

  const swapBtn = el("button", "swap-btn");
  swapBtn.type = "button";
  swapBtn.title = "Swap languages";
  swapBtn.setAttribute("aria-label", "Swap languages and re-translate");
  swapBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 7h11l-3-3M17 17H6l3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  changeLangBtn.addEventListener("click", () => {
    if (!current) return;
    openLanguagePicker({
      current: current.targetLanguage,
      onSelect: (newLanguage) => handleChangeTarget(id, newLanguage),
    });
  });

  directionBar.append(dirText, swapBtn);
  card.append(directionBar);

  // Body
  const body = el("div", "tc-body");
  const origCol = el("div", "tc-original");
  const origLabelRow = el("div", "label-row");
  const origLabel = el("p", "tc-label");
  origLabel.textContent = "Original";
  const origSpeakBtn = speakerButton(() => current?.originalText, () => current?.sourceLanguage);
  origLabelRow.append(origLabel, origSpeakBtn);
  const origText = document.createElement("p");
  origCol.append(origLabelRow, origText);

  const transCol = el("div", "tc-translation");
  const transLabelRow = el("div", "label-row");
  const transLabel = el("p", "tc-label accent");
  transLabel.textContent = "Translation";
  const transSpeakBtn = speakerButton(() => current?.translatedText, () => current?.targetLanguage);
  transLabelRow.append(transLabel, transSpeakBtn);
  const transText = document.createElement("p");
  transCol.append(transLabelRow, transText);

  body.append(origCol, transCol);
  card.append(body);

  // Actions
  const actions = el("div", "tc-actions");
  const copyBtn = el("button", "tc-btn");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy";
  actions.append(copyBtn);

  const insightBtn = el("button", "tc-btn hidden");
  insightBtn.type = "button";
  insightBtn.textContent = "Translation insight";
  actions.append(insightBtn);
  card.append(actions);

  const insightBox = el("div", "tc-insight hidden");
  card.append(insightBox);

  // Paraphrase
  const ppSection = el("div", "tc-paraphrase");
  const ppLabel = el("p", "tc-label");
  ppLabel.textContent = "Improve / paraphrase";
  ppSection.append(ppLabel);

  const ppMenu = el("div", "paraphrase-menu");
  const ppButtons = new Map();
  PARAPHRASE_STYLES.forEach((style) => {
    const btn = el("button", "pp-btn");
    btn.type = "button";
    btn.textContent = style;
    ppButtons.set(style, btn);
    ppMenu.append(btn);
  });
  ppSection.append(ppMenu);

  const ppStatus = el("p", "pp-status hidden");
  ppSection.append(ppStatus);

  const ppResult = el("div", "pp-result hidden");
  const ppResultHead = el("div", "pp-result-head");
  const ppResultLabel = el("p", "tc-label accent");
  const ppResultActions = el("div", "pp-result-actions");
  const ppSpeakBtn = speakerButton(() => paraphraseCache[activeStyle], () => current?.targetLanguage);
  const ppCopyBtn = el("button", "tc-btn");
  ppCopyBtn.type = "button";
  ppCopyBtn.textContent = "Copy";
  ppCopyBtn.addEventListener("click", async () => {
    const text = activeStyle ? paraphraseCache[activeStyle] : null;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast("Paraphrase copied!");
    } catch {
      showToast("Couldn't copy — try selecting the text manually.");
    }
  });
  ppResultActions.append(ppSpeakBtn, ppCopyBtn);
  ppResultHead.append(ppResultLabel, ppResultActions);
  const ppResultText = document.createElement("p");
  ppResult.append(ppResultHead, ppResultText);
  ppSection.append(ppResult);

  card.append(ppSection);

  const paraphraseCache = {};
  let activeStyle = null;
  let ppLoading = false;
  let cardMode = mode;

  function setPpButtonsDisabled(disabled) {
    ppButtons.forEach((btn) => (btn.disabled = disabled));
  }

  async function handleParaphrase(style) {
    if (ppLoading) return;
    if (paraphraseCache[style]) {
      showParaphrase(style);
      return;
    }
    ppLoading = true;
    setPpButtonsDisabled(true);
    ppStatus.classList.remove("hidden", "error");
    ppStatus.textContent = `Rephrasing as ${style}…`;
    try {
      const data = await paraphraseText({
        text: current.translatedText,
        language: current.targetLanguage,
        style,
      });
      paraphraseCache[style] = data.paraphrasedText;
      showParaphrase(style);
      ppStatus.classList.add("hidden");
    } catch (err) {
      ppStatus.textContent = friendlyErrorMessage(err);
      ppStatus.classList.add("error");
    } finally {
      ppLoading = false;
      setPpButtonsDisabled(false);
    }
  }

  function showParaphrase(style) {
    stopAllPlayback();
    activeStyle = style;
    ppButtons.forEach((btn, s) => btn.classList.toggle("active", s === style));
    ppResultLabel.textContent = `Paraphrased — ${style}`;
    ppResultText.textContent = paraphraseCache[style];
    ppResult.classList.remove("hidden");
  }

  ppButtons.forEach((btn, style) => btn.addEventListener("click", () => handleParaphrase(style)));

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(current.translatedText);
      showToast("Translation copied!");
    } catch {
      showToast("Couldn't copy — try selecting the text manually.");
    }
  });

  insightBtn.addEventListener("click", () => {
    insightBox.classList.toggle("hidden");
    insightBtn.textContent = insightBox.classList.contains("hidden") ? "Translation insight" : "Hide insight";
  });

  swapBtn.addEventListener("click", () => handleSwap(id));

  let current = null;

  function setResult(result, mode) {
    stopAllPlayback();
    current = result;
    cardMode = mode;
    srcSpan.textContent = result.sourceLanguage;
    tgtSpan.textContent = result.targetLanguage;
    origText.textContent = result.originalText;
    transText.textContent = result.translatedText;

    insightBox.innerHTML = "";
    if (mode === "study" && (result.keyTerms || result.alternativeTranslation)) {
      insightBtn.classList.remove("hidden");
      if (result.keyTerms) {
        const box = document.createElement("div");
        const label = el("p", "tc-label");
        label.textContent = "Key terms";
        const text = document.createElement("p");
        text.textContent = result.keyTerms;
        box.append(label, text);
        insightBox.append(box);
      }
      if (result.alternativeTranslation) {
        const box = document.createElement("div");
        const label = el("p", "tc-label");
        label.textContent = "Alternative translation";
        const text = document.createElement("p");
        text.textContent = result.alternativeTranslation;
        box.append(label, text);
        insightBox.append(box);
      }
    } else {
      insightBtn.classList.add("hidden");
      insightBox.classList.add("hidden");
    }

    // Reset paraphrase state for a fresh translation (e.g. after swap).
    Object.keys(paraphraseCache).forEach((k) => delete paraphraseCache[k]);
    activeStyle = null;
    ppButtons.forEach((btn) => btn.classList.remove("active"));
    ppResult.classList.add("hidden");
  }

  setResult(result, mode);

  cardControllers.set(id, {
    setResult,
    setSwapping(state) {
      swapBtn.disabled = state;
      changeLangBtn.disabled = state;
    },
    getResult: () => current,
    getMode: () => cardMode,
  });

  return card;
}

function appendThinking1() {
  const row = el("div", "msg-row fade-up");
  row.id = "thinking-row";
  row.append(genieAvatar(36, 60, "thinking"));
  const bubble = el("div", "bubble genie thinking-bubble");
  bubble.textContent = "Translate Genie is translating…";
  row.append(bubble);
  chatMessages.append(row);
  scrollToBottom();
  thinkingEl = row;
}

function removeThinking() {
  thinkingEl?.remove();
  thinkingEl = null;
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add("hidden"), 1800);
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------
function setProcessing(state) {
  isProcessing = state;
  sendBtn.disabled = state || !!pending || !input.value.trim();
}

function handleSend() {
  const text = input.value.trim();
  // Block a new send while a language prompt from a previous message is
  // still unanswered — otherwise a second send would overwrite `pending`
  // out from under the first prompt's buttons.
  if (!text || isProcessing || pending) return;

  input.value = "";
  updateInputChrome();
  appendTextMessage("user", text);

  if (!hasApiKey()) {
    appendTextMessage("genie", friendlyErrorMessage({ code: "MISSING_API_KEY" }), { isError: true });
    openModal(qs("settings-modal"));
    return;
  }

  // No API call here: the language choices are fixed UI (Tamil/English/ Sinhala/Other), so there's nothing to ask Gemini yet. 
  // Source-language detection now happens together with the translation itself, in handleSelectLanguage below, once the user picks a target.
  const promptId = uid();
  pending = { text, promptId };
  appendLanguagePrompt(promptId);
  updateInputChrome();
}

async function handleSelectLanguage(language) {
  if (!pending || isProcessing) return;
  const { text } = pending;

  // Freeze the prompt that was just answered.
  document.querySelectorAll(".lang-select").forEach((wrap) => {
    if (wrap.dataset.promptId === pending.promptId) {
      wrap.disableAll?.();
      wrap.disableOther?.();
    }
  });
  pending = null;
  updateInputChrome();

  appendTextMessage("user", language);
  setProcessing(true);
  appendThinking1();

  try {
    // No sourceLanguage passed in: the model detects it itself as part of this same call and hands it back in data.sourceLanguage.
    const data = await translateText({ text, targetLanguage: language, studyMode });
    removeThinking();
    const result = {
      sourceLanguage: data.sourceLanguage,
      targetLanguage: language,
      originalText: text,
      translatedText: data.translatedText,
      keyTerms: data.keyTerms,
      alternativeTranslation: data.alternativeTranslation,
    };
    appendTranslationCard(result, studyMode ? "study" : "quick");
    recordRecentLanguage(language);
    pushHistory({
      id: uid(),
      originalText: text,
      sourceLanguage: data.sourceLanguage,
      targetLanguage: language,
      translatedText: data.translatedText,
      timestamp: Date.now(),
    });
  } catch (err) {
    removeThinking();
    appendTextMessage("genie", friendlyErrorMessage(err), { isError: true });
    if (err?.code === "MISSING_API_KEY") openModal(qs("settings-modal"));
  } finally {
    setProcessing(false);
  }
}

async function handleSwap(messageId) {
  const controller = cardControllers.get(messageId);
  if (!controller || swappingId) return;
  const result = controller.getResult();
  const mode = controller.getMode();

  swappingId = messageId;
  controller.setSwapping(true);
  try {
    const data = await translateText({
      text: result.translatedText,
      sourceLanguage: result.targetLanguage,
      targetLanguage: result.sourceLanguage,
      studyMode: mode === "study",
    });
    controller.setResult(
      {
        sourceLanguage: result.targetLanguage,
        targetLanguage: result.sourceLanguage,
        originalText: result.translatedText,
        translatedText: data.translatedText,
        keyTerms: data.keyTerms,
        alternativeTranslation: data.alternativeTranslation,
      },
      mode
    );
    recordRecentLanguage(result.sourceLanguage);
  } catch (err) {
    showToast(friendlyErrorMessage(err));
  } finally {
    controller.setSwapping(false);
    swappingId = null;
  }
}

// Re-translates a card's original text into a newly chosen target language — the "instant switch" the Translate-to picker offers, e.g. going straight from a Tamil translation to a Sinhala one without retyping anything.
// Unlike Swap, the source language and original text never change here.
async function handleChangeTarget(messageId, newLanguage) {
  const controller = cardControllers.get(messageId);
  if (!controller || swappingId) return;
  const result = controller.getResult();
  const mode = controller.getMode();
  if (newLanguage === result.targetLanguage) return;

  swappingId = messageId; // reuse the same single-in-flight guard as Swap
  controller.setSwapping(true);
  try {
    const data = await translateText({
      text: result.originalText,
      sourceLanguage: result.sourceLanguage,
      targetLanguage: newLanguage,
      studyMode: mode === "study",
    });
    controller.setResult(
      {
        sourceLanguage: result.sourceLanguage,
        targetLanguage: newLanguage,
        originalText: result.originalText,
        translatedText: data.translatedText,
        keyTerms: data.keyTerms,
        alternativeTranslation: data.alternativeTranslation,
      },
      mode
    );
    recordRecentLanguage(newLanguage);
  } catch (err) {
    showToast(friendlyErrorMessage(err));
  } finally {
    controller.setSwapping(false);
    swappingId = null;
  }
}

function handleNewTranslation() {
  stopAllPlayback();
  chatMessages.innerHTML = "";
  cardControllers.clear();
  pending = null;
  appendTextMessage("genie", WELCOME_TEXT);
}

// ---------------------------------------------------------------------------
// History (localStorage)
// ---------------------------------------------------------------------------
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function pushHistory(entry) {
  history = [...history, entry];
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Ignore quota / privacy-mode failures — history is a convenience only.
  }
}

function clearHistory() {
  history = [];
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {}
  renderHistoryList();
}

// ---------------------------------------------------------------------------
// Recent languages (localStorage) — powers the "Recent languages" section of the Translate-to picker, most-recently-used first.
// ---------------------------------------------------------------------------
function loadRecentLanguages() {
  try {
    const raw = localStorage.getItem(RECENT_LANG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function recordRecentLanguage(language) {
  recentLanguages = [language, ...recentLanguages.filter((l) => l !== language)].slice(
    0,
    MAX_RECENT_LANGUAGES
  );
  try {
    localStorage.setItem(RECENT_LANG_KEY, JSON.stringify(recentLanguages));
  } catch {
    // Ignore quota / privacy-mode failures — this is a convenience only.
  }
}

function renderHistoryList() {
  const list = qs("history-list");
  const clearRow = qs("history-clear-row");
  list.innerHTML = "";
  if (history.length === 0) {
    const empty = el("p", "history-empty");
    empty.textContent = "No translations saved on this device yet.";
    list.append(empty);
    clearRow.classList.add("hidden");
    return;
  }
  clearRow.classList.remove("hidden");
  history
    .slice()
    .reverse()
    .forEach((entry) => {
      const item = el("div", "history-item");
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("aria-expanded", "false");

      const meta = el("p", "meta");
      meta.textContent = `${entry.sourceLanguage} → ${entry.targetLanguage} · ${new Date(entry.timestamp).toLocaleString()}`;
      item.append(meta);

      // Collapsed preview: single-line, ellipsis-truncated (as before).
      const preview = el("div", "history-preview");
      const previewOrig = el("p", "orig");
      previewOrig.textContent = entry.originalText;
      const previewTrans = el("p", "trans");
      previewTrans.textContent = entry.translatedText;
      preview.append(previewOrig, previewTrans);
      item.append(preview);

      // Expanded view: full, unclipped source + translation, plus a copy button for the translation. Built once and toggled on click so the history list stays a quick scan until the user wants the detail.
      const full = el("div", "history-full hidden");
      const srcLabel = el("p", "tc-label");
      srcLabel.textContent = `Source (${entry.sourceLanguage})`;
      const srcText = el("p", "history-full-text");
      srcText.textContent = entry.originalText;
      const transLabel = el("p", "tc-label accent");
      transLabel.textContent = `Translation (${entry.targetLanguage})`;
      const transText = el("p", "history-full-text");
      transText.textContent = entry.translatedText;
      const copyBtn = el("button", "tc-btn history-copy-btn");
      copyBtn.type = "button";
      copyBtn.textContent = "Copy translation";
      copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation(); // don't let the click also collapse the item
        try {
          await navigator.clipboard.writeText(entry.translatedText);
          showToast("Translation copied!");
        } catch {
          showToast("Couldn't copy — try selecting the text manually.");
        }
      });
      full.append(srcLabel, srcText, transLabel, transText, copyBtn);
      item.append(full);

      function toggleExpanded() {
        const expanded = item.classList.toggle("expanded");
        preview.classList.toggle("hidden", expanded);
        full.classList.toggle("hidden", !expanded);
        item.setAttribute("aria-expanded", String(expanded));
      }
      item.addEventListener("click", toggleExpanded);
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleExpanded();
        }
      });

      list.append(item);
    });
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
function openModal(modalEl) {
  modalEl.classList.remove("hidden");
}
function closeModal(modalEl) {
  modalEl.classList.add("hidden");
}

document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal(overlay);
  });
  overlay.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(overlay));
  });
});

aboutBtn.addEventListener("click", () => openModal(qs("about-modal")));
historyBtn.addEventListener("click", () => {
  renderHistoryList();
  openModal(qs("history-modal"));
});
qs("clear-history-btn").addEventListener("click", clearHistory);

// ---------------------------------------------------------------------------
// Language picker ("Translate to") — lets a translation card's target language be changed instantly, without retyping the original text.
// ---------------------------------------------------------------------------
let languagePickerCurrent = null;
let languagePickerOnSelect = null;

function openLanguagePicker({ current, onSelect }) {
  languagePickerCurrent = current;
  languagePickerOnSelect = onSelect;
  languagePickerSearch.value = "";
  renderLanguagePickerList("");
  openModal(languagePickerModal);
  languagePickerSearch.focus();
}

function languagePickerRow(lang) {
  const row = el("button", "lang-picker-row" + (lang === languagePickerCurrent ? " current" : ""));
  row.type = "button";
  const check = el("span", "lang-picker-check");
  check.textContent = lang === languagePickerCurrent ? "✓" : "";
  const label = el("span", "lang-picker-label");
  label.textContent = lang;
  row.append(check, label);
  row.addEventListener("click", () => {
    closeModal(languagePickerModal);
    if (lang !== languagePickerCurrent) languagePickerOnSelect?.(lang);
  });
  return row;
}

function languagePickerHeading(text) {
  const h = el("p", "lang-picker-heading");
  h.textContent = text;
  return h;
}

function renderLanguagePickerList(query) {
  const q = query.trim().toLowerCase();
  languagePickerList.innerHTML = "";

  if (!q) {
    const recents = recentLanguages.filter((l) => l !== languagePickerCurrent);
    if (recents.length > 0) {
      languagePickerList.append(languagePickerHeading("Recent languages"));
      recents.forEach((lang) => languagePickerList.append(languagePickerRow(lang)));
    }
    languagePickerList.append(languagePickerHeading("All languages"));
    COMMON_LANGUAGES.forEach((lang) => languagePickerList.append(languagePickerRow(lang)));
    return;
  }

  const matches = COMMON_LANGUAGES.filter((l) => l.toLowerCase().includes(q));
  if (matches.length === 0) {
    const hint = el("p", "other-lang-hint");
    hint.textContent = `Press Enter to use “${query.trim()}”`;
    languagePickerList.append(hint);
    return;
  }
  matches.forEach((lang) => languagePickerList.append(languagePickerRow(lang)));
}

languagePickerSearch.addEventListener("input", () => renderLanguagePickerList(languagePickerSearch.value));
languagePickerSearch.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !languagePickerSearch.value.trim()) return;
  const custom = languagePickerSearch.value.trim();
  const hasMatch = COMMON_LANGUAGES.some((l) => l.toLowerCase().includes(custom.toLowerCase()));
  if (!hasMatch) {
    closeModal(languagePickerModal);
    if (custom !== languagePickerCurrent) languagePickerOnSelect?.(custom);
  }
});

// Settings / API key modal
const apiKeyInput = qs("api-key-input");
const keyStatus = qs("key-status");
const toggleKeyVisibility = qs("toggle-key-visibility");

function refreshKeyStatus() {
  keyStatus.textContent = hasApiKey() ? "Key saved in this browser" : "No key saved yet";
}

settingsBtn.addEventListener("click", () => {
  apiKeyInput.value = getApiKey();
  refreshKeyStatus();
  openModal(qs("settings-modal"));
});

qs("save-key-btn").addEventListener("click", () => {
  const value = apiKeyInput.value.trim();
  if (!value) {
    keyStatus.textContent = "Enter a key before saving.";
    return;
  }
  setApiKey(value);
  refreshKeyStatus();
  showToast("API key saved.");
});

qs("clear-key-btn").addEventListener("click", () => {
  clearApiKey();
  apiKeyInput.value = "";
  refreshKeyStatus();
  showToast("API key cleared.");
});

toggleKeyVisibility.addEventListener("click", () => {
  const showing = apiKeyInput.type === "text";
  apiKeyInput.type = showing ? "password" : "text";
  toggleKeyVisibility.textContent = showing ? "👁" : "🙈";
  toggleKeyVisibility.setAttribute("aria-label", showing ? "Show key" : "Hide key");
});

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
modeSwitch.addEventListener("click", () => {
  studyMode = !studyMode;
  modeSwitch.setAttribute("aria-checked", String(studyMode));
});
newBtn.addEventListener("click", handleNewTranslation);

// ---------------------------------------------------------------------------
// Input bar
// ---------------------------------------------------------------------------
function updateInputChrome() {
  const value = input.value;
  clearInputBtn.classList.toggle("hidden", value.length === 0);
  sendBtn.disabled = isProcessing || !!pending || !value.trim();
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  if (words > 0) {
    wordCountEl.textContent = `${words} word${words === 1 ? "" : "s"}`;
    wordCountEl.classList.remove("hidden");
  } else {
    wordCountEl.classList.add("hidden");
  }
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 128) + "px";
}

input.addEventListener("input", updateInputChrome);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});
clearInputBtn.addEventListener("click", () => {
  input.value = "";
  updateInputChrome();
  input.focus();
});
sendBtn.addEventListener("click", handleSend);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
appendTextMessage("genie", WELCOME_TEXT);
if (!hasApiKey()) {
  showToast("Add your Gemini API key to get started — see Settings.");
}