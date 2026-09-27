# 🧞 Translate Genie — Plain HTML/CSS/JS Edition

**Translate beyond words. Understand beyond language.**

This is a framework-free version of Translate Genie: just HTML, CSS, and
vanilla JavaScript (ES modules) — no Node.js, no build step, no npm install.
It's the same translation-only chat assistant for Translation Studies
students, focused on Tamil, English, and Sinhala.

## The one important difference from the Next.js version

This version has **no backend**, so there's nowhere to hide a Gemini API key
on a server. Instead, **you enter your own API key** in the app's Settings
panel. It's saved only in your browser's `localStorage` and is sent straight
from your browser to Google's API each time you translate.

That means:
- Never open this site (as hosted by you) and enter your real key if the
  page is public and someone else could load the same origin — anyone who
  can run JavaScript on that page could read `localStorage`.
- It's ideal for **personal, local use** — running it on your own machine,
  or on a private/password-protected host only you use.
- If you want to share this tool with other people, each person should add
  their *own* key in their *own* browser — don't bake your key into the code
  and publish it.

## Getting a Gemini API key

1. Go to [Google AI Studio → Get API key](https://aistudio.google.com/app/apikey)
   and sign in with your Google account.
2. Click **Create API key**. If prompted, choose or create a Google Cloud
   project — the free option is enough for this app.
3. Copy the key. It's a long string starting with `AIza...`.
4. Open Translate Genie, click **API Key** in the header, paste the key into
   the field, and click **Save key**.
5. That's it — the app will use it for every translation from this browser.
   You can return to that panel anytime to update or clear it.

This same walkthrough is built into the app itself under the **API Key**
button, along with a link straight to the Google AI Studio page.

Google's Gemini free tier is generous for personal study use but has a
requests-per-minute limit — if translations suddenly start failing, wait a
minute and try again.

## Running it locally

Because the app uses ES modules (`<script type="module">`), most browsers
require it to be served over `http://`, not opened directly as a `file://`
path. Any static file server works. For example:

```bash
# Python (already on most systems)
cd translate-genie-html
python3 -m http.server 8080
# then open http://localhost:8080

# or, if you have Node installed
npx serve translate-genie-html
```

Or use a code editor's built-in static server (e.g. VS Code's "Live Server"
extension).

## Features

- Automatic source-language detection, then asks which language to translate into
- Quick-select Tamil / English / Sinhala, plus a searchable "Other" option
- Translation-only output — no "Here is your translation!" filler
- Swap-languages button to reverse a translation's direction instantly
- Copy-to-clipboard on every result
- Optional paraphrasing (Casual, Professional, Formal, Academic, Simple,
  Natural, Creative) — clearly labelled as paraphrasing, never as another translation
- Quick Translation (default) vs. Study Mode, which adds key terms and an
  alternative rendering
- Session history saved to `localStorage`, with a clear-history option
- Your uploaded Genie character with floating/breathing idle animation and a
  thinking state while Gemini works
- Dark, glassmorphic, purple-and-gold theme, fully responsive
- Bring-your-own Gemini API key, stored only in your browser

## File structure

```text
translate-genie-html/
├── index.html          # Structure and modals (About / History / API Key)
├── css/
│   └── styles.css      # The whole visual theme
├── js/
│   ├── gemini.js        # Talks to the Gemini API directly from the browser;
│   │                     # reads/writes the API key in localStorage
│   └── app.js            # Chat state machine and all DOM rendering
├── assets/
│   ├── genie-idle.png     # Your uploaded character, idle state
│   └── genie-thinking.png # Your uploaded character, thinking state
└── README.md
```

## Replacing the Genie character

Drop new images at `assets/genie-idle.png` and `assets/genie-thinking.png`
(same filenames) — no code changes needed.

## Changing the model

By default the app uses `gemini-2.0-flash`. If you want to try a different
one (e.g. `gemini-2.5-flash` or `gemini-1.5-flash`), open your browser's dev
console on the page and run:

```js
localStorage.setItem("translate-genie-model", "gemini-2.5-flash");
```

then reload the page.

## A note for students

AI-generated translations are a study aid, not a substitute for expert
judgment — always double-check academic, legal, technical, or culturally
sensitive translations.
