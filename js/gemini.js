// This is a fully client-side version: 
// there is no backend, so the Gemini API key is supplied by the person using the site and stored only in this browser's localStorage. 
// It is sent directly from the browser to Google's API on every request. 
// Never hardcode a real key into this file.

const API_KEY_STORAGE = "translate-genie-api-key";
const MODEL_STORAGE = "translate-genie-model";
const DEFAULT_MODEL = "gemini-3.6-flash";
// Used only as a retry fallback when the primary model is rate-limited or overloaded (429 / 503) — intentionally NOT read from MODEL_STORAGE, since that key holds the user's chosen primary model.
const FALLBACK_MODEL = "gemini-3.1-flash-lite";

// Lite TTS model — Google's own guidance recommends it specifically for "read-aloud features" like this one (vs. the full gemini-3.8-flash-tts, which trades speed/cost for extra acting nuance we don't need here).
const TTS_MODEL = "gemini-3.8-flash-lite-tts";
const TTS_VOICE = "Kore";

// ---------------------------------------------------------------------------
// Request queue
// ---------------------------------------------------------------------------
// Every Gemini call in this app (translateText, paraphraseText — including calls fired from language-select, swap, and paraphrase-style buttons) goes through callGemini(). Without any spacing, a user who clicks several actions in quick succession 
// (e.g. trying two paraphrase styles back to back) can send multiple requests within the same second, which blows through the free tier's ~10 requests/minute cap and forces every one of them onto the weaker fallback model.

// To fix that at the source, every call is funneled through a single queue that (a) runs requests one at a time, never in parallel, and (b) enforces a minimum gap between the *start* of one request and the start of the next. 
// 6.5s of spacing caps this app at ~9 requests/minute, safely under a 10 RPM limit, while still letting normal, human-paced use feel instant — the wait only kicks in when calls are fired faster than that.

// If your key's rate limit is different, adjust REQUEST_MIN_INTERVAL_MS accordingly (e.g. 60000 / your-RPM-limit, with a small safety margin).
const REQUEST_MIN_INTERVAL_MS = 6500;

let queueTail = Promise.resolve();
let lastRequestStart = 0;

function scheduleRequest(task) {
  const scheduled = queueTail.then(async () => {
    const wait = Math.max(0, lastRequestStart + REQUEST_MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastRequestStart = Date.now();
    return task();
  });
  // Keep the chain alive even if this request throws, so later queued requests still run instead of getting stuck behind a rejected promise.
  queueTail = scheduled.then(
    () => {},
    () => {}
  );
  return scheduled;
}

// Separate, much lighter queue just for TTS ("Listen") requests. 
// Gemini bills and rate-limits audio output on its own quota bucket, distinct from the text quota the translate/paraphrase queue above is pacing for — so gating a "click to hear this word" button behind the same 6.5s spacing would make it feel sluggish for no real quota benefit. 
// This only guards against literal double-fires (e.g. a fast double-click), not general pacing across a whole minute.

const TTS_MIN_INTERVAL_MS = 400;
let ttsQueueTail = Promise.resolve();
let lastTtsStart = 0;

function scheduleTts(task) {
  const scheduled = ttsQueueTail.then(async () => {
    const wait = Math.max(0, lastTtsStart + TTS_MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastTtsStart = Date.now();
    return task();
  });
  ttsQueueTail = scheduled.then(
    () => {},
    () => {}
  );
  return scheduled;
}

const BASE_SYSTEM_INSTRUCTION = `You are Translate Genie, an AI translation engine embedded inside a study tool for university Translation Studies students.

Your ONLY purpose is translation, language detection, and (when explicitly asked) paraphrasing of already-translated text. You are not a general-purpose chatbot.

Rules you must always follow:
- Preserve meaning, context, and tone unless a different style is explicitly requested.
- Do not add explanations, greetings, or commentary such as "Here is your translation", "Sure!", or "I hope this helps." Return only what is asked for in the requested format.
- Preserve names, numbers, dates, technical terminology, and formatting wherever practical.
- Handle idioms according to context; prefer natural target-language expression over literal word-for-word translation when literal translation would distort meaning.
- Never invent information, names, references, or context that is not present in the source text.
- Treat greetings, short phrases, single words, questions, and casual sentences as legitimate translation content — never respond to them conversationally.
- Always respond with strictly valid JSON matching the schema you are given for the current task, with no Markdown code fences and no text outside the JSON object.`;

export function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || "";
}

export function setApiKey(key) {
  localStorage.setItem(API_KEY_STORAGE, key.trim());
}

export function clearApiKey() {
  localStorage.removeItem(API_KEY_STORAGE);
}

export function hasApiKey() {
  return getApiKey().length > 0;
}

function getModel() {
  return localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL;
}

function getFallbackModel() {
  return FALLBACK_MODEL;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GeminiError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

function buildUrl(model, apiKey) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

// The actual network call + retry/fallback logic for a single translationtask. 
// This is always invoked through the queue (see callGemini below), so by the time it runs it already has the minimum spacing it needs — it does not need to know about the queue itself.
async function executeGeminiCall({ systemInstruction, prompt, temperature = 0.3 }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new GeminiError("MISSING_API_KEY");
  }

  const primaryUrl = buildUrl(getModel(), apiKey);
  const fallbackUrl = buildUrl(getFallbackModel(), apiKey);

  const body = {
    system_instruction: {
      parts: [{ text: `${BASE_SYSTEM_INSTRUCTION}\n\n${systemInstruction ?? ""}` }],
    },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      responseMimeType: "application/json",
    },
  };

  const MAX_ATTEMPTS = 5;
  // Once a retryable error (429/503) hits the primary model, switch to the fallback model for the remaining attempts rather than hammering the same overloaded/rate-limited model again.
  let useFallback = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const url = useFallback ? fallbackUrl : primaryUrl;

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      if (attempt === MAX_ATTEMPTS) throw new GeminiError("NETWORK_ERROR", networkErr);
      await sleep(attempt * 500);
      continue;
    }

    if (response.ok) {
      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new GeminiError("EMPTY_RESPONSE", data);
      try {
        return JSON.parse(text);
      } catch {
        const cleaned = text.replace(/```json|```/g, "").trim();
        return JSON.parse(cleaned);
      }
    }

    const errBody = await response.text().catch(() => "");
    const retryable = response.status === 503 || response.status === 429;

    if (!retryable || attempt === MAX_ATTEMPTS) {
      if (response.status === 401 || response.status === 400) {
        throw new GeminiError("INVALID_KEY_OR_REQUEST", errBody);
      }
      if (response.status === 403) throw new GeminiError("FORBIDDEN", errBody);
      if (response.status === 429) throw new GeminiError("RATE_LIMIT", errBody);
      if (response.status === 503) throw new GeminiError("SERVICE_UNAVAILABLE", errBody);
      throw new GeminiError("REQUEST_FAILED", errBody);
    }

    useFallback = true;
    // Exponential-ish backoff on top of the queue's own spacing, since a 429/503 here means the account is already under pressure.
    await sleep(attempt * 1000);
  }
}

// Public entry point used by translateText / paraphraseText below. 
// Every call is routed through the queue so that, no matter how many UI actions the user fires in quick succession, requests actually reach Google's API one at a time and at least REQUEST_MIN_INTERVAL_MS apart.
function callGemini(args) {
  return scheduleRequest(() => executeGeminiCall(args));
}

export function friendlyErrorMessage(err) {
  const code = err?.code || "UNKNOWN";
  switch (code) {
    case "MISSING_API_KEY":
      return "Add your Gemini API key in Settings before translating.";
    case "INVALID_KEY_OR_REQUEST":
      return "That API key looks invalid or the request was rejected. Double-check the key in Settings.";
    case "FORBIDDEN":
      return "This key doesn't have access to the Gemini API. Check that the Generative Language API is enabled for it.";
    case "RATE_LIMIT":
      return "You've hit Gemini's rate limit. Please wait a moment and try again.";
    case "SERVICE_UNAVAILABLE":
      return "Gemini is temporarily overloaded. Please try again in a moment.";
    case "NETWORK_ERROR":
      return "Couldn't reach Gemini — check your internet connection and try again.";
    default:
      return "Unable to complete the translation right now. Please try again.";
  }
}

// sourceLanguage is optional. 
// When the caller already knows it (e.g. the swap action, which is translating back from a language the app just produced), pass it and the model translates directly from that language.
// When it's omitted (e.g. the very first translation of a fresh message, where the user has only picked a *target* language), the model detects the source language itself as part of this same request — no separate detection call needed. 
// Either way, the response always includes "sourceLanguage" so the app has one consistent place to read it from.
export async function translateText({ text, sourceLanguage, targetLanguage, studyMode }) {
  const autoDetect = !sourceLanguage;

  const taskInstruction = autoDetect
    ? `Task: first detect the source language of the user's text (its common English name, e.g. "Tamil", "English", "Sinhala", "French"), then translate it into ${targetLanguage}.`
    : `Task: translate the user's text from ${sourceLanguage} to ${targetLanguage}. Set "sourceLanguage" in your response to "${sourceLanguage}" exactly.`;

  const schema = studyMode
    ? `{ "sourceLanguage": string, "translatedText": string, "keyTerms": string, "alternativeTranslation": string }
"keyTerms" should briefly note important terminology, idioms, or cultural expressions relevant to this translation. "alternativeTranslation" should offer one reasonable alternative rendering of the same source text. Both are for a Translation Studies student's learning benefit — do not invent content that isn't linguistically grounded in the source text.`
    : `{ "sourceLanguage": string, "translatedText": string }`;

  return callGemini({
    systemInstruction: `${taskInstruction} Prioritize semantic accuracy over word-for-word translation. Respond with JSON matching exactly: ${schema}`,
    prompt: `${autoDetect ? "" : `Source language: ${sourceLanguage}\n`}Target language: ${targetLanguage}\nText to translate:\n${text}`,
    temperature: 0.2,
  });
}

export async function paraphraseText({ text, language, style }) {
  return callGemini({
    systemInstruction: `Task: paraphrase the given ${language} text in a "${style}" style/register. The meaning must remain exactly the same as the input — only wording, structure, and tone may change. This is paraphrasing, not translation: the input and output are both in ${language}. Respond with JSON: { "paraphrasedText": string }`,
    prompt: `Text to paraphrase (${language}), style: ${style}\n\n${text}`,
    temperature: 0.6,
  });
}

// Text-to-speech via Gemini's dedicated TTS model. Unlike callGemini above, this expects AUDIO output, not JSON — Gemini TTS models auto-detect the input language, so no language parameter is needed, and they treat the text as a verbatim transcript to read aloud (exactly what a pronunciation button wants — no "say cheerfully:"-style prompting).
//
// Returns { base64Pcm, sampleRate }: raw 16-bit PCM audio, base64-encoded, plus the sample rate read back from the response's mimeType (falling back to 24000 Hz, Gemini TTS's documented default, if it's ever absent). 
// The caller is responsible for turning that into something playable (e.g. wrapping it in a WAV header) — this module only talks to the API.
export function synthesizeSpeech(text) {
  return scheduleTts(() => executeSynthesizeSpeech(text));
}

async function executeSynthesizeSpeech(text) {
  const apiKey = getApiKey();
  if (!apiKey) throw new GeminiError("MISSING_API_KEY");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } },
    },
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    throw new GeminiError("NETWORK_ERROR", networkErr);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    if (response.status === 429) throw new GeminiError("RATE_LIMIT", errBody);
    if (response.status === 503) throw new GeminiError("SERVICE_UNAVAILABLE", errBody);
    throw new GeminiError("REQUEST_FAILED", errBody);
  }

  const data = await response.json();
  const part = data?.candidates?.[0]?.content?.parts?.[0];
  const base64Pcm = part?.inlineData?.data;
  const mimeType = part?.inlineData?.mimeType || "";
  if (!base64Pcm) throw new GeminiError("EMPTY_RESPONSE", data);

  const rateMatch = mimeType.match(/rate=(\d+)/);
  const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

  return { base64Pcm, sampleRate };
}