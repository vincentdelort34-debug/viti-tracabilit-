// Vercel Serverless Function — Valider ou refuser un compte en attente
// Appelé via le lien dans l'email admin
// ?token=<base64url encoded {userId, email, action, exp}>

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const { token } = req.query;
  if (!token) return res.status(400).send(page('❌ Token manquant', 'Lien invalide.', '#c0392b'));

  let payload;
  try {
    payload = JSON.parse(Buffer.from(token, 'base64url').toString());
  } catch(e) {
    return res.status(400).send(page('❌ Token invalide', 'Ce lien est corrompu.', '#c0392b'));
  }

  if (Date.now() > payload.exp) {
    return res.status(400).send(page('⏱ Lien expiré', 'Ce lien a expiré (7 jours). Demandez un nouvel envoi.', '#e67e22'));
  }

  const sbAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Vérifier que l'utilisateur est bien en attente
  const { data: pending } = await sbAdmin.from('pending_users').select('*').eq('user_id', payload.userId).single();
  if (!pending) {
    return res.status(404).send(page('🤔 Introuvable', 'Ce compte n\'existe pas ou a déjà été traité.', '#e67e22'));
  }
  if (pending.status !== 'pending') {
    const already = pending.status === 'validated' ? 'déjà validé' : 'déjà refusé';
    return res.status(200).send(page('ℹ️ Déjà traité', `Ce compte a été ${already}.`, '#3498db'));
  }

  if (payload.action === 'validate') {
    // Créer le rôle dans user_roles
    // Chercher un domaine existant pour ce nom (ou laisser null — Lisa sera secrétaire de tout)
    let domaineId = null;
    if (pending.domaine_nom) {
      const { data: dom } = await sbAdmin.from('domaines').select('id').ilike('nom', `%${pending.domaine_nom}%`).limit(1).single();
      if (dom) domaineId = dom.id;
    }

    // Insérer dans user_roles avec rôle 'secretaire' par défaut
    const { error: roleError } = await sbAdmin.from('user_roles').insert({
      user_id: payload.userId,
      role: 'secretaire',
      domaine_id: domaineId
    });
    if (roleError && !roleError.message.includes('duplicate')) {
      return res.status(500).send(page('❌ Erreur', 'Impossible d\'assigner le rôle : ' + roleError.message, '#c0392b'));
    }

    // Marquer comme validé
    await sbAdmin.from('pending_users').update({ status: 'validated', validated_at: new Date().toISOString() }).eq('user_id', payload.userId);

    // Notifier l'utilisateur
    if (process.env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'VitiTrace <noreply@vititrace.fr>',
          to: payload.email,
          subject: '✅ Votre compte VitiTrace est activé',
          html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <h2>✅ Votre compte est activé !</h2>
            <p>Bonjour ${pending.nom},</p>
            <p>Votre accès à VitiTrace a été validé. Vous pouvez maintenant vous connecter.</p>
            <a href="https://viti-tracabilit.vercel.app" style="display:inline-block;background:#2d5a27;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">
              🍇 Ouvrir VitiTrace
            </a>
          </div>`
        })
      });
    }

    return res.status(200).send(page('✅ Compte validé !', `${pending.nom} (${payload.email}) peut maintenant se connecter à VitiTrace.`, '#2d5a27'));

  } else if (payload.action === 'refuse') {
    // Désactiver le compte Auth
    await sbAdmin.auth.admin.deleteUser(payload.userId);
    await sbAdmin.from('pending_users').update({ status: 'refused', refused_at: new Date().toISOString() }).eq('user_id', payload.userId);

    // Notifier l'utilisateur du refus
    if (process.env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'VitiTrace <noreply@vititrace.fr>',
          to: payload.email,
          subject: 'Votre demande VitiTrace',
          html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <p>Bonjour ${pending.nom},</p>
            <p>Votre demande de compte VitiTrace n'a pas pu être acceptée. Contactez l'administrateur pour plus d'informations.</p>
          </div>`
        })
      });
    }

    return res.status(200).send(page('❌ Compte refusé', `La demande de ${pending.nom} (${payload.email}) a été refusée et le compte supprimé.`, '#c0392b'));
  }

  return res.status(400).send(page('❌ Action inconnue', 'Action non reconnue dans le token.', '#c0392b'));
}

function page(title, msg, color) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VitiTrace · Validation</title>
<style>body{font-family:sans-serif;background:#1a1410;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
.box{background:#fff;border-radius:16px;padding:36px 32px;max-width:400px;width:100%;text-align:center}
.icon{font-size:52px;margin-bottom:12px}
h1{color:${color};font-size:22px;margin:0 0 12px}
p{color:#555;font-size:15px;line-height:1.5;margin:0 0 24px}
a{display:inline-block;background:#c8a84c;color:#1a1410;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700}
</style>
</head>
<body>
<div class="box">
  <div class="icon">🍇</div>
  <h1>${title}</h1>
  <p>${msg}</p>
  <a href="https://viti-tracabilit.vercel.app">Ouvrir VitiTrace</a>
</div>
</body>
</html>`;
}
