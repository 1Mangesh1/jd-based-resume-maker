interface Env {
  AI: Ai;
  TAVILY_API_KEY: string;
}

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// --- Tavily ---

async function fetchJD(url: string, apiKey: string): Promise<string> {
  // Try extract
  try {
    const res = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, urls: [url] }),
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      if (data.results?.[0]?.raw_content) {
        return cleanText(data.results[0].raw_content);
      }
    }
  } catch {}

  // Fallback: search
  try {
    const path = new URL(url).pathname;
    const query = path.replace(/[-_/]/g, ' ').replace(/\d{6,}/g, '').trim() + ' job description';

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'advanced',
        include_raw_content: true,
        max_results: 3,
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      const pathSlice = path.slice(0, 40);
      const best = data.results?.find((r: any) => r.url?.includes(pathSlice)) || data.results?.[0];
      const text = best?.raw_content || best?.content;
      if (typeof text === 'string' && text.length > 50) {
        return cleanText(text);
      }
    }
  } catch {}

  throw new Error('Could not extract JD. Please paste the job description text instead.');
}

function cleanText(raw: string): string {
  let t = raw;
  t = t.replace(/!\[.*?\]\(.*?\)/g, '');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  t = t.replace(/^https?:\/\/\S+$/gm, '');
  t = t.replace(/blob:\S+/g, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.replace(/ {2,}/g, ' ');
  t = t.split('\n').map(l => l.trim()).filter(l => l.length === 0 || l.length > 3).join('\n');
  return t.length > 6000 ? t.slice(0, 6000) : t.trim();
}

// --- AI ---

async function runAI(ai: Ai, system: string, prompt: string): Promise<string> {
  const res = await ai.run(MODEL as BaseAiTextGenerationModels, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    max_tokens: 4096,
    temperature: 0.3,
  });

  if (typeof res === 'string') return res;
  if (res && typeof res === 'object') {
    const r = res as Record<string, unknown>;
    // Workers AI returns { response: string | object }
    if (r.response !== undefined && r.response !== null) {
      if (typeof r.response === 'string') return r.response;
      // Some models return response as parsed object already
      return JSON.stringify(r.response);
    }
    if (typeof r.result === 'string') return r.result;
    if (typeof r.text === 'string') return r.text;
    return JSON.stringify(res);
  }
  return String(res ?? '');
}

function parseJSON(raw: string): any {
  const str = typeof raw === 'string' ? raw : String(raw ?? '');
  const fenced = str.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenced ? fenced[1].trim() : (str.match(/\{[\s\S]*\}/) || ['{}'])[0];
  return JSON.parse(jsonStr);
}

// --- Routes ---

async function handleAnalyze(body: any, env: Env) {
  let jdText: string;
  if (body.text && body.text.length > 30) {
    jdText = body.text;
  } else if (body.url) {
    jdText = await fetchJD(body.url, env.TAVILY_API_KEY);
  } else {
    return json({ error: 'Provide a URL or paste the JD text.' }, 400);
  }

  const profileStr = JSON.stringify(body.profile || {});

  const raw = await runAI(
    env.AI,
    'You are a career analyst. Respond ONLY with valid JSON, no markdown.',
    `Analyze this job description against the candidate profile.

JOB DESCRIPTION:
${jdText}

CANDIDATE PROFILE:
${profileStr}

Return JSON:
{
  "jobTitle": "extracted job title",
  "company": "extracted company name",
  "keyRequirements": ["top 5-8 requirements from JD"],
  "gaps": [
    {
      "id": "gap_1",
      "skill": "skill name",
      "question": "Friendly, specific question asking if they have this experience"
    }
  ]
}

Rules:
- Identify 3-5 skills/requirements NOT clearly in the profile
- Skip requirements the profile clearly covers
- Be specific and conversational in questions
- If no gaps, return empty gaps array`
  );

  try {
    const analysis = parseJSON(raw);
    return json({
      jdText,
      jobTitle: analysis.jobTitle || 'Position',
      company: analysis.company || 'Company',
      keyRequirements: analysis.keyRequirements || [],
      gaps: (analysis.gaps || []).map((g: any, i: number) => ({
        id: g.id || `gap_${i + 1}`,
        skill: g.skill || `Requirement ${i + 1}`,
        question: g.question || 'Do you have experience with this?',
      })),
    });
  } catch {
    return json({ error: 'AI parsing failed. Preview: ' + raw.slice(0, 200) }, 500);
  }
}

async function handleTailor(body: any, env: Env) {
  const { profile, jdText, answers } = body;
  if (!profile || !jdText) {
    return json({ error: 'profile and jdText are required' }, 400);
  }

  const answersStr = Object.entries(answers || {})
    .map(([skill, answer]) => `- ${skill}: ${answer}`)
    .join('\n') || 'No additional answers.';

  const raw = await runAI(
    env.AI,
    'You are an expert resume writer. Respond ONLY with valid JSON, no markdown.',
    `Tailor this resume for the job description.

JOB DESCRIPTION:
${jdText}

PROFILE:
${JSON.stringify(profile)}

GAP ANSWERS:
${answersStr}

Return JSON:
{
  "name": "${profile.name || ''}",
  "title": "tailored title for this role",
  "email": "${profile.email || ''}",
  "phone": "${profile.phone || ''}",
  "location": "${profile.location || ''}",
  "summary": "2-3 sentence tailored summary",
  "experience": [
    { "company": "...", "role": "...", "startDate": "...", "endDate": "...", "bullets": ["achievement bullet 1"] }
  ],
  "skills": ["most relevant first"],
  "education": [{ "institution": "...", "degree": "...", "year": "..." }],
  "certifications": ["..."]
}

Rules:
- Rewrite summary for this specific role
- Reorder and rewrite bullets to emphasize relevant experience
- If candidate said "No" to a gap, do NOT add that skill
- Do NOT fabricate experience
- Put most relevant skills first`
  );

  try {
    const resume = parseJSON(raw);
    // Fill in any missing fields from profile
    resume.name = resume.name || profile.name || '';
    resume.email = resume.email || profile.email || '';
    resume.phone = resume.phone || profile.phone || '';
    resume.location = resume.location || profile.location || '';
    resume.summary = resume.summary || profile.summary || '';
    resume.experience = resume.experience || profile.experience || [];
    resume.skills = resume.skills || profile.skills || [];
    resume.education = resume.education || profile.education || [];
    resume.certifications = resume.certifications || profile.certifications || [];
    return json({ resume });
  } catch {
    return json({ error: 'AI parsing failed. Preview: ' + raw.slice(0, 200) }, 500);
  }
}

async function handleParseResume(body: any, env: Env) {
  let resumeText = '';

  if (body.pdf_base64) {
    // Decode base64 PDF, extract readable text from bytes
    const binary = atob(body.pdf_base64);
    let raw = '';
    for (let i = 0; i < binary.length; i++) {
      const code = binary.charCodeAt(i);
      if (code >= 32 && code < 127) raw += binary[i];
      else if (code === 10 || code === 13) raw += '\n';
      else raw += ' ';
    }
    // Filter PDF internal commands, keep readable text
    resumeText = raw.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 3 && !/^\d+ \d+ obj/.test(l) && !/^\/\w+/.test(l)
        && !/^stream|endstream|endobj|xref|trailer/.test(l) && !/^</.test(l))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
  } else if (body.text && typeof body.text === 'string') {
    resumeText = body.text;
  }

  if (resumeText.length < 20) {
    return json({ error: 'Resume text is too short or missing.' }, 400);
  }

  resumeText = resumeText.length > 8000 ? resumeText.slice(0, 8000) : resumeText;

  const raw = await runAI(
    env.AI,
    'You are a resume parser. Extract structured data from resume text. Respond ONLY with valid JSON, no markdown.',
    `Parse this resume into structured JSON.

RESUME TEXT:
${resumeText}

Return JSON:
{
  "name": "full name",
  "title": "professional title or most recent job title",
  "email": "email address",
  "phone": "phone number",
  "location": "city, state/country",
  "summary": "professional summary if present, otherwise write a 2-sentence summary based on the resume",
  "skills": ["skill1", "skill2"],
  "experience": [
    {
      "company": "company name",
      "role": "job title",
      "startDate": "start date",
      "endDate": "end date or Present",
      "bullets": ["achievement 1", "achievement 2"]
    }
  ],
  "education": [
    { "institution": "school name", "degree": "degree", "year": "graduation year" }
  ],
  "certifications": ["cert1", "cert2"],
  "links": [{ "label": "LinkedIn", "url": "https://..." }]
}

Rules:
- Extract ALL experience entries, not just the most recent
- Keep bullet points as-is from the resume
- If a field is not found, use empty string or empty array
- Parse dates as they appear (e.g., "Jan 2020", "2020-01")
- Extract ALL skills mentioned anywhere in the resume`
  );

  try {
    const profile = parseJSON(raw);
    profile.name = profile.name || '';
    profile.title = profile.title || '';
    profile.email = profile.email || '';
    profile.phone = profile.phone || '';
    profile.location = profile.location || '';
    profile.summary = profile.summary || '';
    profile.skills = profile.skills || [];
    profile.experience = profile.experience || [];
    profile.education = profile.education || [];
    profile.certifications = profile.certifications || [];
    profile.links = profile.links || [];
    return json({ profile });
  } catch {
    return json({ error: 'Failed to parse resume. Preview: ' + raw.slice(0, 200) }, 500);
  }
}

// --- Main ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    try {
      if (request.method !== 'POST') {
        return json({ error: 'POST only' }, 405);
      }

      const body = await request.json();

      if (url.pathname === '/api/parse-resume') return handleParseResume(body, env);
      if (url.pathname === '/api/analyze') return handleAnalyze(body, env);
      if (url.pathname === '/api/tailor') return handleTailor(body, env);

      return json({ error: 'Not found' }, 404);
    } catch (err: any) {
      return json({ error: err.message || 'Internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
