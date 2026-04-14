// api/status.js — GET /api/status?id=<uuid>
// Lightweight endpoint for status polling from the submission app
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id is required' });

  try {
    const { data, error } = await supabase
      .from('projects')
      .select('id, status, rejection_reason, ai_summary, created_at')
      .eq('id', id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Not found' });

    return res.status(200).json({
      id:               data.id,
      status:           data.status,
      rejection_reason: data.rejection_reason,
      ai_summary:       data.ai_summary,
      created_at:       data.created_at,
    });
  } catch (err) {
    console.error('Status error:', err);
    return res.status(500).json({ error: err.message });
  }
};
