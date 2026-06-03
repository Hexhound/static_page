# Olhar Factual — deploy guide

This folder **is** the website. Copy its contents to a Git repo, push, and point a host at
it. No build step, no framework. Below is the full first-deploy walkthrough.

```
index.html        ← main page (X feed + waitlist) — site entry point
Sobre.html  Fontes.html  Contato.html  FAQ.html
of-tokens.css     ← design system (shared by every page)
tweets.json       ← posts the feed renders (auto-refreshed — step 4)
x-fetcher/        ← the hourly tweet updater (tooling, not a served page)
README.md         ← this file
```

---

## Before you start — fill in 2 keys
These are the only things that need editing. You can deploy first and add them after; until
then the forms work in demo mode (validate + show success but send nothing) and tweets are
whatever is in `tweets.json` right now.

1. **Web3Forms key** (captures waitlist + contact emails) — get a free key at
   https://web3forms.com (just type your email, no signup). Paste it into the
   `WEB3FORMS_KEY = ''` line in **both** `index.html` and `Contato.html`.
2. **RapidAPI key** (refreshes tweets) — from https://rapidapi.com/alexanderxbx/api/twitter-api45,
   subscribe to the free plan, copy the key. This one goes in a repo *secret* (step 4),
   **not** in the files.

---

## Step 1 — put the files in a Git repo
From inside this `site/` folder:

```bash
git init
git add .
git commit -m "Olhar Factual — initial site"
git branch -M main
git remote add origin https://github.com/<voce>/<repo>.git
git push -u origin main
```

(Everything in this folder goes to the repo **root** — `index.html` at the top level.)

## Step 2 — turn on GitHub Pages
Repo → **Settings → Pages** → *Source*: **Deploy from a branch** → Branch: **main** / **/(root)**
→ Save. After ~1 minute your site is live at `https://<voce>.github.io/<repo>/`.

## Step 3 — custom domain (optional)
Settings → Pages → **Custom domain** → type your domain → Save. Then at your domain registrar:
- subdomain (e.g. `www`): add a **CNAME** record pointing to `<voce>.github.io`
- apex (e.g. `olharfactual.com.br`): add GitHub's **A records** (shown on that Pages screen)

GitHub adds a `CNAME` file and provisions HTTPS automatically.

## Step 4 — auto-refresh the tweets hourly
1. Move the workflow into place: `x-fetcher/fetch-x.yml` → **`.github/workflows/fetch-x.yml`**
   (leave `x-fetcher/fetch.mjs` where it is).
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**:
   name `RAPIDAPI_KEY`, value = your key from step "Before you start".
3. Commit & push. Then **Actions** tab → **Fetch X posts** → **Run workflow** to fill
   `tweets.json` immediately. After that it runs **hourly** on its own and commits the file —
   Pages redeploys automatically.

Details / troubleshooting: `x-fetcher/README.md`.

---

## Pre-flight checklist
- [ ] `WEB3FORMS_KEY` set in `index.html` **and** `Contato.html`
- [ ] Files pushed to the repo root; `index.html` loads at the Pages URL
- [ ] (optional) Custom domain + DNS configured
- [ ] `fetch-x.yml` moved to `.github/workflows/`
- [ ] `RAPIDAPI_KEY` secret added; workflow ran once and updated `tweets.json`
- [ ] Submit a test on the waitlist + contact forms → confirm the email arrives in your inbox

## Notes
- **Cloudflare Pages** works too: connect the repo, build command = none, output dir = `/`.
  The GitHub Action still updates tweets (Cloudflare redeploys on each commit).
- Cover images load from X's CDN, so they appear once the site is served over the web.
- Free-tier limits to keep in mind: Web3Forms ~250 submissions/month; RapidAPI 1000
  requests/month (hourly ≈ 720, safely under).
