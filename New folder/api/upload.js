// api/upload.js — multipart upload, PDF/DOCX parsing, Supabase Storage + DB insert
const { createClient } = require('@supabase/supabase-js');
const formidable = require('formidable');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports.config = {
  api: { bodyParser: false },
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      keepExtensions: true,
      maxFileSize: 20 * 1024 * 1024, // 20 MB
    });

    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

function getFieldValue(fields, key) {
  const value = fields[key];
  if (Array.isArray(value)) return String(value[0] || '');
  return String(value || '');
}

function makeSafeStorageKey(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  const baseName = path.basename(originalName || 'file', ext);

  const safeBase = baseName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents/diacritics
    .replace(/[^a-z0-9]+/gi, '-')     // replace everything unsafe with "-"
    .replace(/-+/g, '-')              // collapse multiple "-"
    .replace(/^-+|-+$/g, '')          // trim "-"
    .slice(0, 60) || 'file';

  return `${Date.now()}-${crypto.randomUUID()}-${safeBase}${ext}`;
}

async function extractText(filepath, ext) {
  try {
    if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const buffer = fs.readFileSync(filepath);
      const result = await pdfParse(buffer);
      return String(result.text || '').trim();
    }

    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: filepath });
      return String(result.value || '').trim();
    }

    return '';
  } catch (error) {
    console.error('Text extraction error:', error);
    return '';
  }
}

async function uploadToSupabaseStorage(storageKey, fileBuffer, mimeType) {
  const { error } = await supabase.storage
    .from('proposals')
    .upload(storageKey, fileBuffer, {
      contentType: mimeType || 'application/octet-stream',
      upsert: false,
    });

  if (error) {
    throw new Error(`Storage error: ${error.message}`);
  }

  const { data } = supabase.storage.from('proposals').getPublicUrl(storageKey);
  return data?.publicUrl || '';
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  let tempPath = '';

  try {
    const { fields, files } = await parseForm(req);

    const rawFile = files.file || files.upload || files.document;
    const file = Array.isArray(rawFile) ? rawFile[0] : rawFile;

    if (!file) {
      return sendJson(res, 400, { error: 'Файл не загружен' });
    }

    const uploadedFile = file;

    const originalName =
      uploadedFile.originalFilename ||
      uploadedFile.name ||
      'file';

    const ext = path.extname(originalName).toLowerCase();

    if (!['.pdf', '.docx'].includes(ext)) {
      return sendJson(res, 400, { error: 'Поддерживаются только PDF и DOCX файлы' });
    }

    tempPath = uploadedFile.filepath || uploadedFile.path;
    if (!tempPath) {
      return sendJson(res, 400, { error: 'Не удалось прочитать временный файл' });
    }

    const full_name = getFieldValue(fields, 'full_name').trim();
    const iin = getFieldValue(fields, 'iin').trim();
    const whatsapp = getFieldValue(fields, 'whatsapp').trim();
    const project_name = getFieldValue(fields, 'project_name').trim();
    const description = getFieldValue(fields, 'description').trim();

    if (!full_name || !iin || !whatsapp || !project_name || !description) {
      return sendJson(res, 400, { error: 'Заполните все поля' });
    }

    const parsedText = await extractText(tempPath, ext);

    const fileBuffer = fs.readFileSync(tempPath);
    const storageKey = makeSafeStorageKey(originalName);

    const publicUrl = await uploadToSupabaseStorage(
      storageKey,
      fileBuffer,
      uploadedFile.mimetype || uploadedFile.type || 'application/octet-stream'
    );

    const insertPayload = {
      full_name,
      iin,
      whatsapp,
      project_name,
      description,
      file_url: publicUrl,
      parsed_text: parsedText || '[Не удалось извлечь текст из файла]',
      status: 'pending',
      // Если хочешь хранить оригинальное имя в БД, добавь колонку original_filename
      // original_filename: originalName,
    };

    const { data: project, error: dbError } = await supabase
      .from('projects')
      .insert(insertPayload)
      .select('*')
      .single();

    if (dbError) {
      throw new Error(`DB error: ${dbError.message}`);
    }

    return sendJson(res, 200, {
      success: true,
      projectId: project.id,
      message: 'Заявка успешно отправлена!',
      file_url: publicUrl,
    });
  } catch (err) {
    console.error('Upload handler error:', err);
    return sendJson(res, 500, {
      error: err.message || 'Internal server error',
    });
  } finally {
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {}
    }
  }
};
