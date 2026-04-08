const API = 'https://jd-resume-tailor.mangeshbide1.workers.dev';

// State
let session = { jdText: '', gaps: [], currentIdx: 0, answers: {} };

// DOM refs
const $ = (s) => document.querySelector(s);
const chatArea = $('#chatArea');
const welcome = $('#welcome');
const urlInput = $('#urlInput');
const chatInputBar = $('#chatInputBar');
const chatInput = $('#chatInput');
const profileModal = $('#profileModal');
const profileForm = $('#profileForm');
const expList = $('#expList');
const eduList = $('#eduList');

// --- Profile (localStorage) ---

function loadProfile() {
  return JSON.parse(localStorage.getItem('resume_profile') || 'null');
}

function saveProfile(p) {
  localStorage.setItem('resume_profile', JSON.stringify(p));
}

function collectFormProfile() {
  const f = profileForm;
  const experience = [...expList.querySelectorAll('.card')].map(c => ({
    company: c.querySelector('.exp-co').value,
    role: c.querySelector('.exp-role').value,
    startDate: c.querySelector('.exp-sd').value,
    endDate: c.querySelector('.exp-ed').value,
    bullets: c.querySelector('.exp-bl').value.split('\n').map(b => b.trim()).filter(Boolean),
  }));
  const education = [...eduList.querySelectorAll('.card')].map(c => ({
    institution: c.querySelector('.edu-inst').value,
    degree: c.querySelector('.edu-deg').value,
    year: c.querySelector('.edu-yr').value,
  }));
  const links = f.links.value.trim()
    ? f.links.value.trim().split('\n').map(l => {
        const [label, url] = l.split('|').map(s => s.trim());
        return { label, url };
      }).filter(l => l.url)
    : [];
  return {
    name: f.name.value.trim(),
    title: f.title.value.trim(),
    email: f.email.value.trim(),
    phone: f.phone.value.trim(),
    location: f.location.value.trim(),
    summary: f.summary.value.trim(),
    skills: f.skills.value.split(',').map(s => s.trim()).filter(Boolean),
    experience, education,
    certifications: f.certs.value.split(',').map(s => s.trim()).filter(Boolean),
    links,
  };
}

function fillForm(p) {
  if (!p) return;
  const f = profileForm;
  f.name.value = p.name || '';
  f.title.value = p.title || '';
  f.email.value = p.email || '';
  f.phone.value = p.phone || '';
  f.location.value = p.location || '';
  f.summary.value = p.summary || '';
  f.skills.value = (p.skills || []).join(', ');
  f.certs.value = (p.certifications || []).join(', ');
  f.links.value = (p.links || []).map(l => `${l.label} | ${l.url}`).join('\n');
  expList.innerHTML = '';
  (p.experience || []).forEach(e => addExpCard(e));
  eduList.innerHTML = '';
  (p.education || []).forEach(e => addEduCard(e));
}

function addExpCard(d = {}) {
  const c = document.createElement('div');
  c.className = 'card';
  c.innerHTML = `<button type="button" class="x">&times;</button>
    <div class="row"><div class="field"><label>Company</label><input class="exp-co" value="${d.company || ''}" placeholder="Acme Inc"></div>
    <div class="field"><label>Role</label><input class="exp-role" value="${d.role || ''}" placeholder="Engineer"></div></div>
    <div class="row"><div class="field"><label>Start</label><input class="exp-sd" value="${d.startDate || ''}" placeholder="Jan 2020"></div>
    <div class="field"><label>End</label><input class="exp-ed" value="${d.endDate || ''}" placeholder="Present"></div></div>
    <div class="field"><label>Bullets <span class="dim">(one per line)</span></label><textarea class="exp-bl" rows="3" placeholder="Led migration...">${(d.bullets || []).join('\n')}</textarea></div>`;
  c.querySelector('.x').onclick = () => c.remove();
  expList.appendChild(c);
}

function addEduCard(d = {}) {
  const c = document.createElement('div');
  c.className = 'card';
  c.innerHTML = `<button type="button" class="x">&times;</button>
    <div class="row"><div class="field"><label>Institution</label><input class="edu-inst" value="${d.institution || ''}" placeholder="MIT"></div>
    <div class="field"><label>Degree</label><input class="edu-deg" value="${d.degree || ''}" placeholder="B.S. CS"></div></div>
    <div class="field"><label>Year</label><input class="edu-yr" value="${d.year || ''}" placeholder="2020"></div>`;
  c.querySelector('.x').onclick = () => c.remove();
  eduList.appendChild(c);
}

// --- Chat ---

function msg(text, type = 'ai', label = '') {
  welcome.style.display = 'none';
  const d = document.createElement('div');
  d.className = `msg msg-${type}`;
  d.innerHTML = (label ? `<div class="msg-label">${label}</div>` : '') + text;
  chatArea.appendChild(d);
  chatArea.scrollTop = chatArea.scrollHeight;
  return d;
}

function loading() {
  const d = msg('<div class="dots"><span></span><span></span><span></span></div>', 'ai');
  d.id = 'loading';
  return d;
}

function stopLoading() { document.getElementById('loading')?.remove(); }

// --- API ---

async function api(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// --- Analyze ---

async function analyze() {
  const input = urlInput.value.trim();
  if (!input) return;
  const profile = loadProfile();
  if (!profile) { profileModal.classList.add('on'); return; }

  const isUrl = /^https?:\/\//.test(input);
  msg(isUrl ? `Analyzing: ${input}` : 'Analyzing pasted JD...', 'user');
  loading();

  try {
    const body = isUrl ? { url: input, profile } : { text: input, profile };
    const data = await api('/api/analyze', body);
    stopLoading();

    session.jdText = data.jdText;
    session.gaps = data.gaps || [];
    session.currentIdx = 0;
    session.answers = {};

    msg(`<strong>${data.jobTitle}</strong> at <strong>${data.company}</strong><br>
      Requirements: ${(data.keyRequirements || []).map(r => `<em>${r}</em>`).join(', ')}`, 'sys');

    if (session.gaps.length === 0) {
      msg("Your profile covers all requirements! Let's generate your tailored resume.", 'ai');
      showGenButton();
    } else {
      askNextQuestion();
    }
  } catch (e) {
    stopLoading();
    msg(e.message, 'sys');
  }
}

function askNextQuestion() {
  const g = session.gaps[session.currentIdx];
  msg(`<span class="q-counter">Q${session.currentIdx + 1} of ${session.gaps.length}</span><br>
    <strong>${g.skill}:</strong> ${g.question}`, 'ai', 'Honesty Check');
  chatInputBar.style.display = 'flex';
  chatInput.focus();
}

async function sendAnswer() {
  const answer = chatInput.value.trim();
  if (!answer) return;
  chatInput.value = '';
  msg(answer, 'user');

  const g = session.gaps[session.currentIdx];
  session.answers[g.skill] = answer;
  session.currentIdx++;

  if (session.currentIdx >= session.gaps.length) {
    chatInputBar.style.display = 'none';
    msg("All questions answered! Ready to generate your tailored resume.", 'ai');
    showGenButton();
  } else {
    askNextQuestion();
  }
}

// --- Generate ---

function showGenButton() {
  const btn = document.createElement('button');
  btn.className = 'btn-gen';
  btn.textContent = 'Generate Tailored Resume';
  btn.onclick = generate;
  chatArea.appendChild(btn);
  chatArea.scrollTop = chatArea.scrollHeight;
}

async function generate() {
  const btn = chatArea.querySelector('.btn-gen');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }
  loading();

  try {
    const profile = loadProfile();
    const data = await api('/api/tailor', {
      profile,
      jdText: session.jdText,
      answers: session.answers,
    });
    stopLoading();

    const resume = data.resume;
    buildPDF(resume);
    msg(`Resume downloaded as <strong>${resume.name || 'resume'}.pdf</strong>`, 'sys');
    if (btn) btn.remove();
  } catch (e) {
    stopLoading();
    msg(e.message, 'sys');
    if (btn) { btn.disabled = false; btn.textContent = 'Generate Tailored Resume'; }
  }
}

// --- PDF (pdfmake, runs in browser) ---

function buildPDF(r) {
  const contactLine = [r.email, r.phone, r.location].filter(Boolean).join('  |  ');

  const content = [];

  // Header
  content.push({ text: r.name || '', style: 'name', alignment: 'center' });
  content.push({ text: r.title || '', style: 'title', alignment: 'center', margin: [0, 2, 0, 2] });
  content.push({ text: contactLine, style: 'contact', alignment: 'center', margin: [0, 0, 0, 8] });
  content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#999999' }], margin: [0, 0, 0, 8] });

  // Summary
  if (r.summary) {
    content.push({ text: 'PROFESSIONAL SUMMARY', style: 'section' });
    content.push({ text: r.summary, style: 'body', margin: [0, 4, 0, 8] });
  }

  // Experience
  if (r.experience?.length) {
    content.push({ text: 'EXPERIENCE', style: 'section' });
    r.experience.forEach(exp => {
      content.push({
        columns: [
          { text: exp.role || '', style: 'jobTitle', width: '*' },
          { text: `${exp.startDate || ''} - ${exp.endDate || ''}`, style: 'dates', width: 'auto', alignment: 'right' },
        ],
        margin: [0, 6, 0, 0],
      });
      content.push({ text: exp.company || '', style: 'company', margin: [0, 1, 0, 3] });
      if (exp.bullets?.length) {
        content.push({ ul: exp.bullets.map(b => ({ text: b, style: 'bullet' })), margin: [8, 0, 0, 4] });
      }
    });
  }

  // Skills
  if (r.skills?.length) {
    content.push({ text: 'SKILLS', style: 'section', margin: [0, 6, 0, 4] });
    content.push({ text: r.skills.join('  \u2022  '), style: 'body', margin: [0, 0, 0, 8] });
  }

  // Education
  if (r.education?.length) {
    content.push({ text: 'EDUCATION', style: 'section', margin: [0, 6, 0, 4] });
    r.education.forEach(edu => {
      content.push({
        columns: [
          { text: edu.degree || '', style: 'jobTitle', width: '*' },
          { text: edu.year || '', style: 'dates', width: 'auto', alignment: 'right' },
        ],
      });
      content.push({ text: edu.institution || '', style: 'company', margin: [0, 1, 0, 4] });
    });
  }

  // Certifications
  if (r.certifications?.length) {
    content.push({ text: 'CERTIFICATIONS', style: 'section', margin: [0, 6, 0, 4] });
    content.push({ ul: r.certifications.map(c => ({ text: c, style: 'bullet' })), margin: [8, 0, 0, 4] });
  }

  const dd = {
    content,
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 40],
    defaultStyle: { font: 'Roboto' },
    styles: {
      name: { fontSize: 20, bold: true, color: '#1a1a1a' },
      title: { fontSize: 11, color: '#555' },
      contact: { fontSize: 9, color: '#666' },
      section: { fontSize: 11, bold: true, color: '#1a1a1a', decoration: 'underline', margin: [0, 8, 0, 4] },
      jobTitle: { fontSize: 10, bold: true, color: '#222' },
      company: { fontSize: 10, italics: true, color: '#444' },
      dates: { fontSize: 9, color: '#666' },
      body: { fontSize: 10, color: '#333', lineHeight: 1.4 },
      bullet: { fontSize: 9.5, color: '#333', lineHeight: 1.3 },
    },
  };

  const filename = `${(r.name || 'resume').replace(/\s+/g, '_')}_tailored.pdf`;
  pdfMake.createPdf(dd).download(filename);
}

// --- Resume Upload & Parse ---

const uploadZone = $('#uploadZone');
const dropZone = $('#dropZone');
const resumeFile = $('#resumeFile');
const resumeText = $('#resumeText');
const parseBtn = $('#parseBtn');
const parseStatus = $('#parseStatus');

function showUploadZone() {
  uploadZone.style.display = '';
  profileForm.style.display = 'none';
}

function showEditForm() {
  uploadZone.style.display = 'none';
  profileForm.style.display = '';
}

// Extract text from PDF using local pdf.js (with timeout)
async function extractPDFText(file) {
  const arrayBuffer = await file.arrayBuffer();

  if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js not loaded');

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

  // Race against a 15s timeout so it never hangs
  const pdfPromise = pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000));
  const pdf = await Promise.race([pdfPromise, timeout]);

  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map(item => item.str).join(' ') + '\n';
  }
  return text.trim();
}

async function parseResume() {
  let text = '';

  parseBtn.disabled = true;

  try {
    if (resumeFile.files && resumeFile.files.length > 0) {
      const file = resumeFile.files[0];

      if (file.name.toLowerCase().endsWith('.pdf')) {
        parseStatus.textContent = 'Extracting text from ' + file.name + '...';
        parseStatus.className = 'parse-status';
        try {
          text = await extractPDFText(file);
        } catch (e) {
          // pdf.js failed — send raw base64 to Worker instead
          parseStatus.textContent = 'Local parse failed, sending to AI...';
          const buf = await file.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const b64 = btoa(binary);
          const data = await api('/api/parse-resume', { pdf_base64: b64 });
          saveProfile(data.profile);
          fillForm(data.profile);
          showEditForm();
          parseStatus.textContent = '';
          parseBtn.disabled = false;
          return;
        }
      } else {
        text = await file.text();
      }
    } else if (resumeText.value.trim()) {
      text = resumeText.value.trim();
    }
  } catch (e) {
    parseStatus.textContent = 'Failed to read file: ' + (e.message || e);
    parseStatus.className = 'parse-status error';
    parseBtn.disabled = false;
    return;
  }

  if (!text || text.length < 20) {
    parseStatus.textContent = 'Upload a PDF or paste your resume text first.';
    parseStatus.className = 'parse-status error';
    parseBtn.disabled = false;
    return;
  }

  parseStatus.textContent = 'AI is parsing your resume...';
  parseStatus.className = 'parse-status';

  try {
    const data = await api('/api/parse-resume', { text });
    saveProfile(data.profile);
    fillForm(data.profile);
    showEditForm();
    parseStatus.textContent = '';
  } catch (e) {
    parseStatus.textContent = 'Parse failed: ' + (e.message || e);
    parseStatus.className = 'parse-status error';
  }
  parseBtn.disabled = false;
}

// Drag & drop (click handled by <label for="resumeFile">)
resumeFile.onchange = () => {
  if (resumeFile.files.length) {
    dropZone.querySelector('p').textContent = resumeFile.files[0].name;
  }
};
dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('over'); };
dropZone.ondragleave = () => dropZone.classList.remove('over');
dropZone.ondrop = (e) => {
  e.preventDefault();
  dropZone.classList.remove('over');
  if (e.dataTransfer.files.length) {
    resumeFile.files = e.dataTransfer.files;
    dropZone.querySelector('p').textContent = e.dataTransfer.files[0].name;
  }
};

parseBtn.onclick = parseResume;

// --- Events ---

$('#analyzeBtn').onclick = analyze;
urlInput.onkeydown = (e) => { if (e.key === 'Enter') analyze(); };
$('#sendBtn').onclick = sendAnswer;
chatInput.onkeydown = (e) => { if (e.key === 'Enter') sendAnswer(); };

$('#profileBtn').onclick = () => {
  const p = loadProfile();
  if (p) {
    fillForm(p);
    showEditForm();
  } else {
    showUploadZone();
  }
  profileModal.classList.add('on');
};
$('#closeModal').onclick = () => profileModal.classList.remove('on');
profileModal.onclick = (e) => { if (e.target === profileModal) profileModal.classList.remove('on'); };

$('#reuploadBtn').onclick = showUploadZone;

profileForm.onsubmit = (e) => {
  e.preventDefault();
  saveProfile(collectFormProfile());
  profileModal.classList.remove('on');
  msg('Profile saved!', 'sys');
};

$('#addExp').onclick = () => addExpCard();
$('#addEdu').onclick = () => addEduCard();

// Init
if (!loadProfile()) {
  profileModal.classList.add('on');
  showUploadZone();
}
