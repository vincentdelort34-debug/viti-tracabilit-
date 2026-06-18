// Vercel Serverless Function — Proxy Claude Vision + E-phy + Cadastre
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { image, mimeType, mode, query } = req.body;

    // MODE E-PHY
    if (mode === 'ephy' && query) {
      try {
        const r = await fetch(`https://ephy.anses.fr/api/produit/?search=${encodeURIComponent(query)}&culture=vigne&page_size=10`, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'VitiTrace/1.0' }
        });
        if (r.ok) {
          const data = await r.json();
          return res.status(200).json({ source: 'ephy', results: data.results || [] });
        }
      } catch(e) {}
      return res.status(200).json({ source: 'ephy', results: [] });
    }

    if (!image) return res.status(400).json({ error: 'Image manquante' });

    // MODE CADASTRE — analyse relevé de propriété / plan cadastral
    if (mode === 'cadastre') {
      const prompt = `Tu es un expert foncier français. Analyse ce document cadastral, relevé de propriété, ou plan parcellaire.
Extrait toutes les informations disponibles sur les parcelles.
Retourne UNIQUEMENT un JSON valide sans markdown :
{
  "type_document": "relevé de propriété|plan cadastral|attestation|autre",
  "commune": "nom de la commune",
  "proprietaire": "nom du propriétaire si visible",
  "parcelles": [
    {
      "code": "référence cadastrale ex: 340225 A 0207",
      "section": "section cadastrale ex: A, B, ZA",
      "numero": "numéro de parcelle",
      "nom": "lieu-dit ou nom si disponible",
      "surface_ha": 1.5,
      "nature": "vigne|prairie|bois|bâti|autre",
      "commune": "commune de la parcelle"
    }
  ],
  "surface_totale_ha": 0,
  "info": "résumé des informations extraites du document"
}
Si le document ne contient pas de coordonnées GPS, indique-le dans info.
Si tu ne reconnais pas de parcelles cadastrales, retourne parcelles:[] avec info explicatif.`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
          max_tokens: 2000,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: image } },
            { type: 'text', text: prompt }
          ]}]
        })
      });

      if (!response.ok) throw new Error('API Claude: ' + response.status);
      const data = await response.json();
      const text = data.content.map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
      let result;
      try { result = JSON.parse(text); }
      catch(e) { const m = text.match(/\{[\s\S]*\}/); result = m ? JSON.parse(m[0]) : { parcelles: [], info: text }; }
      return res.status(200).json(result);
    }

    // MODE SCAN ETIQUETTE (défaut)
    const prompt = `Tu es un expert phytosanitaire français spécialisé en viticulture.
Analyse cette étiquette de produit phytosanitaire et extrait toutes les informations visibles.
Retourne UNIQUEMENT un JSON valide sans markdown :
{
  "nom": "nom commercial exact",
  "fabricant": "nom du fabricant",
  "amm": "numéro AMM FR-XXXX-XXXX",
  "categorie": "Fongicide|Fongicide cuivre|Insecticide|Herbicide|Biocontrole|Acaricide",
  "matiere_active": "matière active avec concentration",
  "dose_vigne": "dose pour vigne en nombre",
  "dose_unite": "kg/ha ou L/ha",
  "dose_max": "dose max par application",
  "nb_applications": "nb max par an",
  "dar": 0,
  "znt": 5,
  "restriction_horaire": "restrictions",
  "cibles": "maladies/ravageurs",
  "epi": "équipements protection",
  "phrases_h": "phrases danger H",
  "date_peremption": "YYYY-MM-DD si visible",
  "volume_contenant": "ex: 1kg 5L",
  "confiance": 85
}
DAR = délai avant récolte en jours. ZNT = zone non traitée en mètres.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
        max_tokens: 1500,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: image } },
          { type: 'text', text: prompt }
        ]}]
      })
    });

    if (!response.ok) throw new Error('API Claude: ' + response.status);
    const data = await response.json();
    const text = data.content.map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    let result;
    try { result = JSON.parse(text); }
    catch(e) { const m = text.match(/\{[\s\S]*\}/); if (m) result = JSON.parse(m[0]); else throw new Error('Réponse non parseable'); }
    result.dar = parseInt(result.dar) || 0;
    result.znt = parseInt(result.znt) || 5;
    return res.status(200).json(result);

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
