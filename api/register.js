// Vercel Serverless Function — Inscription + notification admin
// Quand un nouvel utilisateur s'inscrit :
//   1. Crée le compte Supabase Auth
//   2. Insère dans pending_users (statut: 'pending')
//   3. Envoie un email à l'admin avec lien Valider/Refuser

import { createClient } from '@supabase/supabase-js';

const ADMIN_EMAIL = 'vincent.delort34@gmail.com';
const APP_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://viti-tracabilit.vercel.app';

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

  // Client service role pour créer les entrées admin
  const sbAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    // 1. Créer le compte Auth Supabase
    const { data: authData, error: authError } = await sbAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // pas besoin de confirmer l'email — c'est l'admin qui valide
      user_metadata: { nom, domaine_nom: domaine_nom || '' }
    });
    if (authError) {
      if (authError.message.includes('already registered')) {
        return res.status(400).json({ error: 'Cette adresse email est déjà utilisée.' });
      }
      throw authError;
    }

    const userId = authData.user.id;

    // 2. Insérer dans pending_users
    await sbAdmin.from('pending_users').insert({
      user_id: userId,
      email,
      nom,
      domaine_nom: domaine_nom || '',
      status: 'pending',
      created_at: new Date().toISOString()
    });

    // 3. Générer tokens de validation (simples JWT-like via base64)
    const tokenData = Buffer.from(JSON.stringify({ userId, email, action: 'validate', exp: Date.now() + 7*24*60*60*1000 })).toString('base64url');
    const tokenRefuse = Buffer.from(JSON.stringify({ userId, email, action: 'refuse', exp: Date.now() + 7*24*60*60*1000 })).toString('base64url');

    const validateUrl = `${APP_URL}/api/validate-user?token=${tokenData}`;
    const refuseUrl = `${APP_URL}/api/validate-user?token=${tokenRefuse}`;

    // 4. Envoyer email à l'admin via Resend
    const emailBody = {
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
    };

    // Essayer Resend si dispo, sinon log et continuer
    if (process.env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(emailBody)
      });
    } else {
      // Fallback : stocker le token dans la DB pour validation manuelle
      await sbAdmin.from('pending_users').update({ validate_token: tokenData, refuse_token: tokenRefuse }).eq('user_id', userId);
      console.log('RESEND_API_KEY manquant — tokens stockés en DB. Valider manuellement.');
    }

    return res.status(200).json({ success: true, message: 'Compte créé. En attente de validation par l\'administrateur.' });

  } catch(e) {
    console.error('Register error:', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
