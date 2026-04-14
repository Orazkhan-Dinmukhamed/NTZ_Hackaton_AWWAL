// api/projects.js — Returns all projects (admin panel list)
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

  try {
    const { data, error } = await supabase
      .from('projects')
      .select(`
        id,
        full_name,
        iin,
        whatsapp,
        project_name,
        description,
        file_url,
        status,
        ai_analysis,
        ai_summary,
        rejection_reason,
        created_at
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.status(200).json({ projects: data || [] });
  } catch (err) {
    console.error('Projects error:', err);
    return res.status(500).json({ error: err.message });
  }
};
