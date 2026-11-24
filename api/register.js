// Vercel Serverless Function — Inscription + notification admin
// Utilise l'API REST Supabase directement (pas de dépendance npm)

const ADMIN_EMAIL = 'vincent.delort34@gmail.com';
const APP_URL = 'https://viti-tracabilit.vercel.app';

// Helper : appel REST Supabase avec service key
async function sbFetch(path, options = {}) {
  const url = `${process.env.SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch(e) { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Helper : Admin Auth API Supabase
async function sbAuthFetch(path, body) {
  const url = `${process.env.SUPABASE_URL}/auth/v1/admin${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch(e) { data = text; }
  return { ok: res.ok, status: res.status, data };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password, nom, domaine_nom } = req.body;
  if (!email || !password || !nom) {
    return res.status(400).json({ error: 'Email, mot de passe et nom obligatoires' });
  }

  try {
    // 1. Créer le compte Auth Supabase via admin API
    const authRes = await sbAuthFetch('/users', {
      email,
      password,
      email_confirm: true,
      user_metadata: { nom, domaine_nom: domaine_nom || '' }
    });

    if (!authRes.ok) {
      const msg = authRes.data?.msg || authRes.data?.message || JSON.stringify(authRes.data);
      if (msg && (msg.includes('already registered') || msg.includes('already been registered'))) {
        return res.status(400).json({ error: 'Cette adresse email est déjà utilisée.' });
      }
      throw new Error('Auth error: ' + msg);
    }

    const userId = authRes.data.id;

    // 2. Insérer dans pending_users
    const insertRes = await sbFetch('/pending_users', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        email,
        nom,
        domaine_nom: domaine_nom || '',
        status: 'pending',
        created_at: new Date().toISOString()
      })
    });
    if (!insertRes.ok) {
      console.error('pending_users insert error:', insertRes.data);
    }

    // 3. Générer tokens de validation
    const tokenData = Buffer.from(JSON.stringify({
      userId, email, action: 'validate', exp: Date.now() + 7*24*60*60*1000
    })).toString('base64url');
    const tokenRefuse = Buffer.from(JSON.stringify({
      userId, email, action: 'refuse', exp: Date.now() + 7*24*60*60*1000
    })).toString('base64url');

    // Stocker les tokens dans pending_users
    await sbFetch(`/pending_users?user_id=eq.${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ validate_token: tokenData, refuse_token: tokenRefuse })
    });

    const validateUrl = `${APP_URL}/api/validate-user?token=${tokenData}`;
    const refuseUrl = `${APP_URL}/api/validate-user?token=${tokenRefuse}`;

    // 4. Envoyer email à l'admin via Resend
    if (process.env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'VitiTrace <noreply@vititrace.fr>',
          to: ADMIN_EMAIL,
          subject: `🍇 Nouveau compte VitiTrace — ${nom} (${email})`,
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
              <div style="background:#1a1410;padding:24px;border-radius:12px 12px 0 0;text-align:center">
                <div style="font-size:40px">🍇</div>
                <div style="color:#c8a84c;font-size:22px;font-weight:700;font-family:Georgia,serif">VitiTrace</div>
              </div>
              <div style="background:#fff;padding:28px;border-radius:0 0 12px 12px;border:1px solid #e0e0e0">
                <h2 style="color:#1a1410;margin-top:0">Nouvelle demande de compte</h2>
                <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
                  <tr><td style="padding:8px 0;color:#666;width:120px">Nom</td><td style="padding:8px 0;font-weight:700">${nom}</td></tr>
                  <tr><td style="padding:8px 0;color:#666">Email</td><td style="padding:8px 0">${email}</td></tr>
                  ${domaine_nom ? `<tr><td style="padding:8px 0;color:#666">Domaine</td><td style="padding:8px 0">${domaine_nom}</td></tr>` : ''}
                  <tr><td style="padding:8px 0;color:#666">Date</td><td style="padding:8px 0">${new Date().toLocaleDateString('fr-FR', {day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})}</td></tr>
                </table>
                <div style="display:flex;gap:12px;flex-direction:column">
                  <a href="${validateUrl}" style="display:block;background:#2d5a27;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;text-align:center;font-weight:700;font-size:16px">
                    ✅ Valider le compte
                  </a>
                  <a href="${refuseUrl}" style="display:block;background:#c0392b;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;text-align:center;font-weight:700;font-size:16px">
                    ❌ Refuser le compte
                  </a>
                </div>
                <p style="color:#999;font-size:12px;margin-top:20px;text-align:center">Ces liens expirent dans 7 jours.</p>
              </div>
            </div>
          `
        })
      });
    } else {
      console.log('RESEND_API_KEY manquant — tokens stockes en DB. Valider manuellement via /api/validate-user?token=' + tokenData);
    }

    return res.status(200).json({ success: true, message: "Compte créé. En attente de validation par l'administrateur." });

  } catch(e) {
    console.error('Register error:', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
