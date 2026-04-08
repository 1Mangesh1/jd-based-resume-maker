# JD-Based Resume Tailor - Simplified Architecture

## Architecture

```
[GitHub Pages - Static Frontend]     [Cloudflare Worker - AI Only]
  index.html / style.css / app.js  ←→  /api/analyze  (Tavily + Workers AI)
  Profile in localStorage             /api/answer   (Workers AI)
  PDF via pdfmake (browser)            /api/tailor   (Workers AI)
```

## Why This Change
- PDF generation works natively in browser with pdfmake (no server-side hacks)
- Profile stays in localStorage (no KV needed, instant, offline-capable)
- Worker is thin: just proxies Tavily + runs Workers AI
- Frontend hosted free on GitHub Pages

## Stack
- **Frontend:** Vanilla HTML/CSS/JS on GitHub Pages
- **PDF:** pdfmake (browser build - designed for this)
- **AI Backend:** Cloudflare Worker (thin API)
- **AI Model:** @cf/meta/llama-3.3-70b-instruct-fp8-fast
- **JD Extraction:** Tavily via Worker (API key stays secret)
- **Profile Storage:** localStorage

## Worker Endpoints (3 total)
1. `POST /api/analyze` - receives URL or text, calls Tavily + AI, returns gap questions
2. `POST /api/answer` - receives session + answer, returns next question or done
3. `POST /api/tailor` - receives profile + JD + answers, returns tailored resume JSON

## Frontend Files (3 total)
1. `index.html` - chat UI + profile modal
2. `style.css` - dark theme
3. `app.js` - chat logic, profile CRUD (localStorage), pdfmake PDF generation

## Flow
1. User fills profile → saved to localStorage
2. Paste JD URL → Worker fetches via Tavily, AI analyzes gaps
3. Chat Q&A → Worker runs AI for each answer
4. Generate → Worker returns tailored resume JSON → browser builds PDF with pdfmake
5. Download PDF
