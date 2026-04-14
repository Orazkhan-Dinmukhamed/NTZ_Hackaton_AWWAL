// api/analyze.js — POST /api/analyze { id }
// Runs LLaMA via Groq (validation) + LLaMA via Groq (summary), saves to DB
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function stripCodeFences(text) {
  return String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

function extractBalancedJson(text) {
  const s = stripCodeFences(text);
  const start = s.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in AI response');

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  if (end === -1) {
    console.warn('Unclosed JSON detected, attempting repair...');
    return repairJson(s.slice(start));
  }

  return s.slice(start, end + 1);
}

function repairJson(truncated) {
  let inString = false;
  let escaped = false;
  const stack = [];

  for (let i = 0; i < truncated.length; i++) {
    const ch = truncated[i];

    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }
    if (ch === '{') stack.push('}');
    if (ch === '[') stack.push(']');
    if (ch === '}') stack.pop();
    if (ch === ']') stack.pop();
  }

  let repaired = truncated;
  if (inString) repaired += '"';
  repaired += stack.reverse().join('');

  return repaired;
}

function safeJsonParse(text) {
  let jsonStr;
  try {
    jsonStr = extractBalancedJson(text);
  } catch (extractErr) {
    console.error('JSON extraction failed. Raw response:\n', text);
    throw new Error(`Failed to extract JSON: ${extractErr.message}`);
  }

  try {
    return JSON.parse(jsonStr);
  } catch (parseErr) {
    console.error('JSON parse failed. Extracted string:\n', jsonStr);
    throw new Error('AI returned invalid JSON even after repair');
  }
}

// Критерии: ключ → { русское название, максимальный балл, порог для passed }
// passed = true если набрано >= passThreshold баллов из max
const CRITERIA_META = {
  strategic_relevance:  { label: 'Стратегическая релевантность',  max: 20, passThreshold: 10 },
  goal_and_tasks:       { label: 'Цель и задачи',                  max: 10, passThreshold: 5  },
  scientific_novelty:   { label: 'Научная новизна',                max: 15, passThreshold: 8  },
  practical_use:        { label: 'Практическая применимость',      max: 20, passThreshold: 10 },
  result_specificity:   { label: 'Конкретность результатов',       max: 15, passThreshold: 8  },
  socioeconomic_effect: { label: 'Социально-экономический эффект', max: 10, passThreshold: 5  },
  feasibility:          { label: 'Реалистичность исполнения',      max: 10, passThreshold: 5  },
};

function normalizeValidationResult(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Validation response is not a valid object');
  }

  const rawCriteria = obj.criteria && typeof obj.criteria === 'object' ? obj.criteria : {};
  const criteria = {};
  let computedScore = 0;

  for (const [key, meta] of Object.entries(CRITERIA_META)) {
    const c = rawCriteria[key] || {};
    const cScore = Math.max(0, Math.min(meta.max, Math.round(Number(c.score) || 0)));

    criteria[key] = {
      label:   meta.label,
      score:   cScore,
      max:     meta.max,
      passed:  cScore >= meta.passThreshold,
      comment: typeof c.comment === 'string' ? c.comment.trim() : '',
    };

    computedScore += cScore;
  }

  const modelScore = Math.max(0, Math.min(100, Math.round(Number(obj.score) || 0)));
  const finalScore = computedScore > 0 ? computedScore : modelScore;
  const finalStatus = finalScore >= 70 ? 'approved' : 'rejected';

  return {
    status:   finalStatus,
    score:    finalScore,
    errors:   Array.isArray(obj.errors)   ? obj.errors.map(String)   : [],
    warnings: Array.isArray(obj.warnings) ? obj.warnings.map(String) : [],
    summary:  typeof obj.summary === 'string' ? obj.summary.trim() : '',
    criteria,
  };
}

// ── Groq LLaMA (groq_api) — structural validation ─────────────────────────────

async function runValidation(project) {
  const GROQ_API_KEY = process.env.groq_api;
  const parsedTextSnippet = String(project.parsed_text || '').slice(0, 4000);

  const prompt = `
Ты эксперт по научным проектам и грантам. Проведи детальную валидацию следующего научного проекта.

=== ДАННЫЕ ПРОЕКТА ===
Название: ${project.project_name}
Описание: ${project.description || '(не указано)'}

=== ТЕКСТ ДОКУМЕНТА (фрагмент) ===
${parsedTextSnippet}

=== КРИТЕРИИ ОЦЕНКИ (итого 100 баллов) ===
Оцени каждый критерий честно по шкале от 0 до максимума. Сложи все баллы — это итоговый score.

1. СТРАТЕГИЧЕСКАЯ РЕЛЕВАНТНОСТЬ (макс. 20 баллов)
   — насколько проект соответствует актуальным научным, государственным или отраслевым приоритетам

2. ЦЕЛЬ И ЗАДАЧИ (макс. 10 баллов)
   — чёткость формулировки цели (1-3 предложения), конкретность и измеримость задач (оптимально 3-10)

3. НАУЧНАЯ НОВИЗНА (макс. 15 баллов)
   — наличие оригинального вклада, отличие от существующих решений, обоснование новизны

4. ПРАКТИЧЕСКАЯ ПРИМЕНИМОСТЬ (макс. 20 баллов)
   — реальность внедрения результатов, наличие целевой аудитории или индустриального партнёра

5. КОНКРЕТНОСТЬ РЕЗУЛЬТАТОВ (макс. 15 баллов)
   — результаты измеримы, указаны сроки, форматы (статьи, патенты, прототипы и т.д.)

6. СОЦИАЛЬНО-ЭКОНОМИЧЕСКИЙ ЭФФЕКТ (макс. 10 баллов)
   — наличие экономического, экологического или социального эффекта с обоснованием

7. РЕАЛИСТИЧНОСТЬ ИСПОЛНЕНИЯ (макс. 10 баллов)
   — команда, сроки, бюджет и ресурсы соответствуют масштабу проекта

ИТОГ: score = сумма баллов по всем 7 критериям (от 0 до 100).
Статус: score >= 70 → "approved", score < 70 → "rejected".

ВАЖНО: Верни ТОЛЬКО валидный JSON. Без markdown, без пояснений, без текста до или после.
Все строковые значения — в одну строку без переносов.
ВСЕ текстовые поля (comment, summary, errors, warnings) ТОЛЬКО на русском языке. Английский запрещён.

{
  "status": "approved",
  "score": 0,
  "errors": [],
  "warnings": [],
  "summary": "краткое резюме валидации",
  "criteria": {
    "strategic_relevance":  { "score": 0, "max": 20, "comment": "комментарий" },
    "goal_and_tasks":       { "score": 0, "max": 10, "comment": "комментарий" },
    "scientific_novelty":   { "score": 0, "max": 15, "comment": "комментарий" },
    "practical_use":        { "score": 0, "max": 20, "comment": "комментарий" },
    "result_specificity":   { "score": 0, "max": 15, "comment": "комментарий" },
    "socioeconomic_effect": { "score": 0, "max": 10, "comment": "комментарий" },
    "feasibility":          { "score": 0, "max": 10, "comment": "комментарий" }
  }
}
`;

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`Validation attempt ${attempt}/3...`);

      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'moonshotai/kimi-k2-instruct',
          messages: [
            {
              role: 'system',
              content: 'Ты эксперт по научным проектам. Отвечай ТОЛЬКО валидным JSON без markdown и пояснений. КРИТИЧЕСКИ ВАЖНО: все поля "comment", "summary", "errors", "warnings" пиши ИСКЛЮЧИТЕЛЬНО на русском языке. Никакого английского.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 4096,
          temperature: 0,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Groq validation API error ${resp.status}: ${errText}`);
      }

      const data = await resp.json();
      const rawText = data?.choices?.[0]?.message?.content || '';

      if (!rawText.trim()) {
        throw new Error('Groq validation returned empty response');
      }

      const parsed = safeJsonParse(rawText);
      return normalizeValidationResult(parsed);

    } catch (err) {
      console.error(`Validation attempt ${attempt} failed:`, err.message);
      lastError = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }

  throw lastError || new Error('Validation failed after 3 attempts');
}

// ── Groq LLaMA (groq) — human-readable summary ────────────────────────────────

async function runGroqSummary(project, validationResult) {
  const prompt = `
Ты аналитик научных проектов. Напиши краткое профессиональное резюме для следующего проекта.

Название проекта: ${project.project_name}
Описание: ${project.description || '(не указано)'}
AI-оценка: ${validationResult.score}/100
Статус валидации: ${validationResult.status}
Ключевые ошибки: ${(validationResult.errors || []).join('; ') || 'нет'}

Напиши резюме на русском языке (3-5 предложений). Укажи:
- В чём суть проекта
- Какова его научная ценность
- Каковы основные риски или недостатки
- Общую рекомендацию

Только текст, без заголовков и маркированных списков.
`;

  const GROQ_KEY = process.env.groq || process.env.GROQ_API_KEY;

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'system',
          content: 'Ты профессиональный аналитик научных проектов. Пиши чётко, структурированно и на русском языке.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 600,
      temperature: 0.5,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`Groq summary API error ${resp.status}: ${errText}`);
    return 'Не удалось сгенерировать резюме.';
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || 'Резюме недоступно.';
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

  try {
    const { id } = req.body || {};
    if (!id) return sendJson(res, 400, { error: 'id is required' });

    const { data: project, error: fetchError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;
    if (!project) return sendJson(res, 404, { error: 'Project not found' });

    const validationResult = await runValidation(project);
    const groqSummary = await runGroqSummary(project, validationResult);

    const { error: updateError } = await supabase
      .from('projects')
      .update({
        ai_analysis: validationResult,
        ai_summary: groqSummary,
        status: validationResult.status,
      })
      .eq('id', id);

    if (updateError) throw updateError;

    return sendJson(res, 200, {
      success: true,
      analysis: validationResult,
      summary: groqSummary,
    });
  } catch (err) {
    console.error('Analyze error:', err);
    return sendJson(res, 500, { error: err.message || 'Analysis failed' });
  }
};