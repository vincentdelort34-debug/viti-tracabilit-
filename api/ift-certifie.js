// ══════════════════════════════════════════════════════
//  API IFT Certifié — Proxy vers ecoagri.agriculture.gouv.fr
//  Vercel Serverless Function
// ══════════════════════════════════════════════════════

const IFT_API_BASE = 'https://alim.agriculture.gouv.fr/ift-api/api';

// Mapping catégories VitiPilot → typeTraitementIdMetier ecoagri
const TYPE_TRAITEMENT_MAP = {
  'Herbicide': 'T1',
  'Fongicide': 'T2',
  'Fongicide cuivre': 'T2',
  'Insecticide': 'T3',
  'Biocontrôle': 'T4',
  'Autre': 'T5'
};

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { action, campagne, amm, dose, categorie, cultureId } = req.body;

    // Action 1 : Rechercher la culture "vigne" dans le référentiel
    if (action === 'cultures') {
      const filtre = req.body.filtre || 'vigne';
      const url = `${IFT_API_BASE}/cultures?campagneIdMetier=${campagne || new Date().getFullYear()}&filtre=${encodeURIComponent(filtre)}`;
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      const data = await r.json();
      return res.status(200).json(data);
    }

    // Action 2 : Rechercher les types de traitement
    if (action === 'types') {
      const url = `${IFT_API_BASE}/types-traitements`;
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      const data = await r.json();
      return res.status(200).json(data);
    }

    // Action 3 : Calculer IFT certifié
    if (action === 'certifier') {
      if (!campagne || !amm || !dose) {
        return res.status(400).json({ error: 'Paramètres manquants: campagne, amm, dose' });
      }
      const typeTraitement = TYPE_TRAITEMENT_MAP[categorie] || 'T2';
      // Culture ID pour la vigne — par défaut 1210 (Vigne à raisin de cuve)
      const culture = cultureId || '1210';

      const params = new URLSearchParams({
        campagneIdMetier: campagne,
        numeroAmmIdMetier: amm.replace(/[^0-9]/g, ''), // Garder que les chiffres
        cultureIdMetier: culture,
        typeTraitementIdMetier: typeTraitement,
        dose: dose.toString()
      });

      const url = `${IFT_API_BASE}/ift/traitement/certifie?${params}`;
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });

      if (!r.ok) {
        const errText = await r.text();
        // Fallback : essayer en non certifié pour avoir au moins le calcul
        const urlNC = `${IFT_API_BASE}/ift/traitement?${params}`;
        const r2 = await fetch(urlNC, { headers: { 'Accept': 'application/json' } });
        if (r2.ok) {
          const data2 = await r2.json();
          return res.status(200).json({
            ...data2,
            certifie: false,
            message: 'Calcul non certifié (produit/culture non reconnu pour certification)',
            erreurCertification: errText
          });
        }
        return res.status(r.status).json({ error: 'Erreur API ecoagri', details: errText });
      }

      const data = await r.json();
      // La réponse certifiée contient un identifiant de vérification
      const verificationUrl = data.id
        ? `https://ecoagri.agriculture.gouv.fr/ift/verifier-traitement-ift/${data.id}`
        : null;

      return res.status(200).json({
        ...data,
        certifie: true,
        verificationUrl,
        qrData: verificationUrl || `https://ecoagri.agriculture.gouv.fr/ift/verifier-traitement-ift`
      });
    }

    // Action 4 : Certifier un bilan complet (tous les traitements d'un domaine/campagne)
    if (action === 'bilan') {
      const traitements = req.body.traitements || [];
      const results = [];
      const errors = [];

      for (const t of traitements) {
        try {
          const typeTraitement = TYPE_TRAITEMENT_MAP[t.categorie] || 'T2';
          const culture = cultureId || '1210';
          const ammClean = (t.amm || '').replace(/[^0-9]/g, '');
          if (!ammClean || !t.dose) {
            errors.push({ id: t.id, error: 'AMM ou dose manquant' });
            continue;
          }
          const params = new URLSearchParams({
            campagneIdMetier: campagne || new Date().getFullYear().toString(),
            numeroAmmIdMetier: ammClean,
            cultureIdMetier: culture,
            typeTraitementIdMetier: typeTraitement,
            dose: t.dose.toString()
          });
          const url = `${IFT_API_BASE}/ift/traitement/certifie?${params}`;
          const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
          if (r.ok) {
            const data = await r.json();
            results.push({
              traitementId: t.id,
              ...data,
              certifie: true,
              verificationUrl: data.id
                ? `https://ecoagri.agriculture.gouv.fr/ift/verifier-traitement-ift/${data.id}`
                : null
            });
          } else {
            errors.push({ id: t.id, error: await r.text() });
          }
        } catch (e) {
          errors.push({ id: t.id, error: e.message });
        }
      }
      return res.status(200).json({ results, errors, total: traitements.length });
    }

    return res.status(400).json({ error: 'Action inconnue. Utilisez: cultures, types, certifier, bilan' });

  } catch (e) {
    console.error('IFT certifie error:', e);
    return res.status(500).json({ error: e.message });
  }
}
