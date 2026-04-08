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

async function runAI(ai: Ai, system: string, prompt: string, temp = 0.3): Promise<string> {
  const res = await ai.run(MODEL as BaseAiTextGenerationModels, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    max_tokens: 4096,
    temperature: temp,
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
  const intensity = Math.min(5, Math.max(1, body.intensity || 3));

  if (!profile || !jdText) {
    return json({ error: 'profile and jdText are required' }, 400);
  }

  const answersStr = Object.entries(answers || {})
    .map(([skill, answer]) => `- ${skill}: ${answer}`)
    .join('\n') || 'No additional answers.';

  const intensityGuide: Record<number, string> = {
    1: 'MINIMAL changes: only reorder sections and skills. Keep ALL bullet text exactly as-is. Do NOT rewrite anything.',
    2: 'CONSERVATIVE: reorder sections and skills for relevance. Only tweak 1-2 words per bullet to add JD keywords. Keep the original voice.',
    3: 'BALANCED: reorder for relevance, rewrite bullets to naturally include JD keywords while keeping the original achievements and metrics.',
    4: 'AGGRESSIVE: significantly rewrite bullets to maximize JD keyword matches. Emphasize relevant experience heavily. Still keep all entries.',
    5: 'FULL REWRITE: completely rewrite summary and all bullets optimized for this specific JD. Maximize ATS keyword matches. Keep all entries but rewrite everything.',
  };

  // Map intensity 1-5 to AI temperature 0.1-0.6
  const aiTemp = 0.1 + (intensity - 1) * 0.125;

  const raw = await runAI(
    env.AI,
    'You are an expert resume writer. Respond ONLY with valid JSON, no markdown.',
    `Tailor this resume for the job description.

INTENSITY LEVEL: ${intensity}/5 — ${intensityGuide[intensity]}

JOB DESCRIPTION:
${jdText}

FULL ORIGINAL PROFILE:
${JSON.stringify(profile)}

GAP ANSWERS FROM CANDIDATE:
${answersStr}

Return JSON with the COMPLETE resume — every experience, project, education entry:
{
  "name": "${profile.name || ''}",
  "title": "tailored title matching the JD role",
  "email": "${profile.email || ''}",
  "phone": "${profile.phone || ''}",
  "location": "${profile.location || ''}",
  "links": ${JSON.stringify(profile.links || [])},
  "summary": "rewrite the summary to align with this specific JD - 2-3 sentences",
  "experience": [
    { "company": "...", "role": "...", "startDate": "...", "endDate": "...", "bullets": ["ALL bullets - reworded to emphasize JD-relevant achievements"] }
  ],
  "projects": [
    { "name": "...", "tech": "...", "bullets": ["..."], "link": "..." }
  ],
  "skills": ["reorder: most JD-relevant first, but keep ALL original skills"],
  "skillsText": "Reorder the categorized skills so JD-relevant categories come first. Keep the Category: skill1, skill2 format. Keep ALL skills.",
  "education": ${JSON.stringify(profile.education || [])},
  "certifications": ${JSON.stringify(profile.certifications || [])}
}

CRITICAL RULES:
- Include ALL experience entries from the original - do NOT drop any
- Include ALL projects with their FULL original details (name, tech stack, ALL bullets, links) - do NOT make them generic
- Include ALL education entries with scores
- Keep ALL bullet points — reword based on intensity level but keep the substance, metrics, and specifics
- Projects must keep their specific technical details and achievements - NEVER replace with generic descriptions
- Reorder skills so JD-relevant ones come first, but keep ALL skills
- Reorder experience bullets so the most relevant are first
- Add keywords from gap answers naturally into existing bullets where the candidate confirmed experience
- Do NOT fabricate new experience or bullets
- Do NOT remove content - the output should be as comprehensive as the input
- If candidate said "No" to a gap, do NOT add that skill
- Follow the INTENSITY LEVEL guide strictly`
    , aiTemp);

  try {
    const resume = parseJSON(raw);
    resume.name = resume.name || profile.name || '';
    resume.email = resume.email || profile.email || '';
    resume.phone = resume.phone || profile.phone || '';
    resume.location = resume.location || profile.location || '';
    resume.links = resume.links || profile.links || [];
    resume.summary = resume.summary || profile.summary || '';
    resume.experience = resume.experience || profile.experience || [];
    resume.projects = resume.projects || profile.projects || [];
    resume.skills = resume.skills || profile.skills || [];
    resume.skillsText = resume.skillsText || profile.skillsText || '';
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
    'You are a resume parser. Extract EVERY detail from the resume. Respond ONLY with valid JSON, no markdown.',
    `Parse this resume COMPLETELY into structured JSON. Do NOT skip anything.

RESUME TEXT:
${resumeText}

Return JSON:
{
  "name": "full name",
  "title": "professional title or most recent job title",
  "email": "email address",
  "phone": "phone number",
  "location": "city, state/country",
  "summary": "copy the FULL summary/professional summary exactly as written",
  "skills": ["every single skill mentioned as flat array"],
  "skillsText": "Preserve the EXACT categorized skills text as written, e.g.:\nLanguages: Python, JavaScript\nBackend: Django, FastAPI\nCloud: AWS, EC2, S3\n(one category per line, keep all categories exactly as in the resume)",
  "experience": [
    {
      "company": "company name with location if given",
      "role": "exact job title",
      "startDate": "start date as written",
      "endDate": "end date as written",
      "bullets": ["copy EVERY bullet point exactly as written in the resume - do NOT summarize or skip any"]
    }
  ],
  "projects": [
    {
      "name": "project name",
      "tech": "tech stack used",
      "bullets": ["every bullet exactly as written"],
      "link": "project link if any"
    }
  ],
  "education": [
    { "institution": "full school name with location", "degree": "full degree name", "year": "year range or graduation year", "score": "GPA/percentage if mentioned" }
  ],
  "certifications": ["cert1", "cert2"],
  "links": [{ "label": "LinkedIn", "url": "url" }, { "label": "GitHub", "url": "url" }, { "label": "Portfolio", "url": "url" }]
}

CRITICAL RULES:
- Extract EVERY experience entry - interns, trainees, ALL of them
- Copy ALL bullet points VERBATIM - do not summarize, shorten or skip any
- Extract ALL projects with their full descriptions
- Extract ALL education entries (degree, diploma, etc.)
- Extract ALL links (LinkedIn, GitHub, portfolio, etc.)
- Extract ALL skills - every single one mentioned anywhere
- If skills are categorized (Languages, Backend, Cloud, etc.), flatten into one array but keep all
- Copy the summary EXACTLY as written, word for word
- Do NOT skip or truncate anything`
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
    profile.skillsText = profile.skillsText || '';
    profile.experience = profile.experience || [];
    profile.projects = profile.projects || [];
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
