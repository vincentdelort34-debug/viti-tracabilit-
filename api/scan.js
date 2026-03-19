// Vercel Serverless Function — Proxy Claude Vision API
// Fichier : api/scan.js dans le repo GitHub

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { image, mimeType } = req.body;
    if (!image) return res.status(400).json({ error: 'Image manquante' });

    const prompt = `Expert phytosanitaire français. Analyse cette étiquette de produit phytosanitaire.
Retourne UNIQUEMENT un objet JSON valide, sans markdown, sans texte avant ou après :
{
  "nom": "nom commercial exact",
  "fabricant": "nom du fabricant",
  "amm": "numéro AMM FR-XXXX-XXXX",
  "categorie": "Fongicide|Insecticide|Herbicide|Fongicide cuivre|Biocontrôle",
  "dose_vigne": "dose recommandée vigne (nombre uniquement)",
  "dose_unite": "kg/ha ou L/ha",
  "nb_applications": "nombre max applications par an",
  "dar": 0,
  "znt": 0,
  "restriction_horaire": "restrictions d'application si mentionnées",
  "cibles": "maladies ou ravageurs ciblés",
  "epi": "équipements protection individuelle requis",
  "phrases_h": "phrases de danger H (ex: H302, H400)",
  "date_peremption": "date si visible YYYY-MM-DD",
  "confiance": 85
}
Si une information n'est pas visible sur l'étiquette, mettre chaîne vide "" ou 0 pour les nombres.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: image } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const text = data.content.map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    const result = JSON.parse(text);
    return res.status(200).json(result);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
