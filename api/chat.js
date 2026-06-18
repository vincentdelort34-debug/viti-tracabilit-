export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[chat] ANTHROPIC_API_KEY manquante');
    return res.status(500).json({ error: 'Configuration serveur manquante (ANTHROPIC_API_KEY)' });
  }

  const { messages, system, max_tokens } = req.body;
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: max_tokens || 1000,
        system: system || undefined,
        messages,
      }),
    });

    const data = await response.json();

    // L'API Anthropic peut renvoyer { type: 'error', error: {...} }.
    // On ne masque plus l'echec derriere un 200 : on logge et on renvoie un 502 explicite.
    if (!response.ok || (data && data.type === 'error')) {
      const detail = (data && data.error && data.error.message) || ('HTTP ' + response.status);
      console.error('[chat] Erreur API Anthropic (model=' + model + '): ' + detail);
      return res.status(502).json({ error: 'Erreur API Anthropic', detail, model });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('[chat] Exception (model=' + model + '): ' + error.message);
    return res.status(500).json({ error: error.message });
  }
}
