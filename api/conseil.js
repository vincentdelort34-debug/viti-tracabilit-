// Vercel Serverless Function — Conseil IA diagnostic phyto vigne
// Fichier : api/conseil.js dans le repo GitHub

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { image, mimeType, contexte, bbch, stock, region } = req.body;
    if (!image) return res.status(400).json({ error: 'Image manquante' });

    const prompt = `Tu es un ingénieur agronome expert en viticulture française et protection phytosanitaire des vignes.

CONTEXTE :
- Région : ${region || 'Sud de la France'}
- Stade phénologique : ${bbch || 'Non précisé'}
- Type observé : ${contexte || 'Non précisé'}
- Produits disponibles en stock : ${stock || 'Non renseigné'}

Analyse cette photo de vigne et fournis un diagnostic complet.
Retourne UNIQUEMENT un objet JSON valide sans markdown :

{
  "diagnostic": "nom de la maladie/ravageur/adventice identifiée",
  "nom_scientifique": "nom latin si applicable",
  "emoji": "emoji représentatif de la maladie (ex: 🍄 🐛 🌿)",
  "gravite": "faible|moyen|élevé",
  "confiance": 85,
  "description": "description détaillée des symptômes observés et impact potentiel sur la vigne (3-4 phrases)",
  "conditions": "conditions climatiques favorables au développement de cette maladie",
  "produits_recommandes": [
    {
      "nom": "nom commercial du produit",
      "matiere_active": "matière active principale",
      "fabricant": "fabricant si connu",
      "dose": "dose recommandée en nombre",
      "unite": "kg/ha ou L/ha",
      "dar": 21,
      "znt": 5,
      "ab": true,
      "en_stock": false,
      "note": "conseil d'utilisation spécifique"
    }
  ],
  "conseils_agronomiques": [
    {
      "emoji": "🌡️",
      "titre": "titre court du conseil",
      "texte": "explication détaillée"
    }
  ],
  "urgence_traitement": "immédiat|sous 48h|préventif|non nécessaire",
  "stade_optimal_traitement": "stade BBCH recommandé pour intervenir",
  "risque_contamination": "description du risque de propagation"
}

Pour les produits recommandés :
- Vérifier si le nom correspond à un produit en stock (champ en_stock = true si correspond)
- Donner 2-3 produits en ordre de préférence
- Privilégier les biocontrôles/produits AB si efficaces
- Adapter au stade phénologique (respect DAR avant récolte)
- Inclure des alternatives conventionnelles et AB

Si la photo ne montre pas de symptômes phytosanitaires clairs, indiquer "Aucun symptôme détecté" dans diagnostic.`;

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
      else throw new Error('Réponse IA non parseable');
    }

    return res.status(200).json(result);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
