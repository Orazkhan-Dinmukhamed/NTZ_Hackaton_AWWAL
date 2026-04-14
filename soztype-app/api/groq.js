export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, model, max_tokens } = req.body;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.groq_api_key1}`,
      },
      body: JSON.stringify({
        model: model || 'llama-3.1-70b-versatile',
        messages,
        max_tokens: max_tokens || 1200,
        temperature: 0.3,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Groq API error:', data);
      return res.status(500).json({ error: data });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
