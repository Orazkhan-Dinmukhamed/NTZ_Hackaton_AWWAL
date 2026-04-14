// api/approve.js — POST /api/approve  { id }
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    const { error } = await supabase
      .from('projects')
      .update({ status: 'approved', rejection_reason: null })
      .eq('id', id);

    if (error) throw error;

    return res.status(200).json({ success: true, message: 'Проект одобрен' });
  } catch (err) {
    console.error('Approve error:', err);
    return res.status(500).json({ error: err.message });
  }
};
