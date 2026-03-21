// Vercel Serverless Function — Proxy Claude Vision + E-phy ANSES
// Fichier : api/scan.js dans le repo GitHub

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { image, mimeType, mode, query } = req.body;

    // MODE RECHERCHE E-PHY
    if (mode === 'ephy' && query) {
      try {
        const ephyUrl = `https://ephy.anses.fr/api/produit/?search=${encodeURIComponent(query)}&culture=vigne&page_size=10`;
        const ephyRes = await fetch(ephyUrl, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'VitiTrace/1.0' }
        });
        if (ephyRes.ok) {
          const data = await ephyRes.json();
          return res.status(200).json({ source: 'ephy', results: data.results || [] });
        }
      } catch(e) {}
      return res.status(200).json({ source: 'ephy', results: [] });
    }

    // MODE SCAN IMAGE
    if (!image) return res.status(400).json({ error: 'Image manquante' });

    const prompt = `Tu es un expert phytosanitaire français spécialisé en viticulture.
Analyse cette photo d'étiquette de produit phytosanitaire et extrait TOUTES les informations visibles.
Retourne UNIQUEMENT un objet JSON valide sans markdown :
{
  "nom": "nom commercial exact",
  "fabricant": "nom complet du fabricant",
  "amm": "numéro AMM (FR-XXXX-XXXX ou tel quel)",
  "categorie": "Fongicide|Fongicide cuivre|Insecticide|Herbicide|Biocontrole|Acaricide",
  "matiere_active": "matière(s) active(s) avec concentration",
  "dose_vigne": "dose pour vigne en nombre",
  "dose_unite": "kg/ha ou L/ha ou g/ha",
  "dose_max": "dose max par application",
  "nb_applications": "nb max applications/an",
  "dar": 0,
  "znt": 5,
  "restriction_horaire": "restrictions application",
  "cibles": "maladies/ravageurs cibles ex: Mildiou Oidium Botrytis",
  "epi": "equipements protection requis",
  "phrases_h": "phrases danger H ex: H302 H400",
  "date_peremption": "YYYY-MM-DD si visible",
  "volume_contenant": "ex: 1kg 5L",
  "confiance": 85
}
Le DAR = delai avant recolte en jours. La ZNT = zone non traitee en metres.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
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
      return res.status(response.status).json({ error: 'API Claude: ' + err });
    }

    const data = await response.json();
    const text = data.content.map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    
    let result;
    try {
      result = JSON.parse(text);
    } catch(e) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) result = JSON.parse(match[0]);
      else throw new Error('Reponse IA non parseable');
    }

    result.dar = parseInt(result.dar) || 0;
    result.znt = parseInt(result.znt) || 5;

    return res.status(200).json(result);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
