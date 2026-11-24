// Vercel Serverless Function — Gestion des inscriptions en attente (admin uniquement)
// GET  : liste des demandes en attente + domaines existants
// POST : { action: 'validate'|'refuse', user_id, domaine_id?, new_domaine_nom?, role? }
// Auth : header Authorization: Bearer <access_token Supabase de l'admin connecté>
// Pas de dépendance npm : API REST Supabase via fetch natif.

const SB_URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_KEY;

async function sb(path, options = {}) {
  const res = await fetch(`${SB_URL}${path}`, {
    ...options,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Vérifie le jeton de l'utilisateur et qu'il est admin
async function requireAdmin(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY || SERVICE, Authorization: `Bearer ${token}` }
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user?.id) return null;
  const roles = await sb(`/rest/v1/user_roles?user_id=eq.${user.id}&select=role`);
  const isAdmin = roles.ok && Array.isArray(roles.data) && roles.data.some(r => r.role === 'admin');
  return isAdmin ? user : null;
}

export default async function handler(req, res) {
  if (!SB_URL || !SERVICE) return res.status(500).json({ error: 'Configuration serveur incomplète' });

  const admin = await requireAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Accès réservé à l\'administrateur' });

  try {
    if (req.method === 'GET') {
      const [pending, doms] = await Promise.all([
        sb('/rest/v1/pending_users?status=eq.pending&select=user_id,email,nom,domaine_nom,created_at&order=created_at.asc'),
        sb('/rest/v1/domaines?select=id,nom&order=nom.asc')
      ]);
      if (!pending.ok) throw new Error('Lecture des demandes : ' + JSON.stringify(pending.data));
      return res.status(200).json({ pending: pending.data || [], domaines: doms.ok ? doms.data : [] });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { action, user_id, domaine_id, new_domaine_nom, role } = req.body || {};
    if (!user_id || !['validate', 'refuse'].includes(action)) {
      return res.status(400).json({ error: 'Paramètres invalides' });
    }

    const pRes = await sb(`/rest/v1/pending_users?user_id=eq.${encodeURIComponent(user_id)}&status=eq.pending&select=*`);
    const pending = Array.isArray(pRes.data) ? pRes.data[0] : null;
    if (!pending) return res.status(404).json({ error: 'Demande introuvable ou déjà traitée' });

    if (action === 'refuse') {
      await sb(`/auth/v1/admin/users/${user_id}`, { method: 'DELETE' });
      await sb(`/rest/v1/pending_users?user_id=eq.${user_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'refused', refused_at: new Date().toISOString() })
      });
      return res.status(200).json({ success: true, message: `Demande de ${pending.nom} refusée` });
    }

    // Validation : domaine existant ou nouveau domaine
    let domId = domaine_id || null;
    if (!domId) {
      const nomDom = (new_domaine_nom || pending.domaine_nom || pending.nom || 'Nouveau domaine').trim();
      const dRes = await sb('/rest/v1/domaines', {
        method: 'POST',
        body: JSON.stringify({ nom: nomDom, campagne_en_cours: new Date().getFullYear() })
      });
      if (!dRes.ok || !Array.isArray(dRes.data) || !dRes.data[0]) {
        throw new Error('Création du domaine impossible : ' + JSON.stringify(dRes.data));
      }
      domId = dRes.data[0].id;
    }

    const finalRole = ['viticulteur', 'secretaire'].includes(role) ? role : 'viticulteur';
    const existing = await sb(`/rest/v1/user_roles?user_id=eq.${user_id}&select=id`);
    if (existing.ok && Array.isArray(existing.data) && existing.data.length) {
      await sb(`/rest/v1/user_roles?user_id=eq.${user_id}`, {
        method: 'PATCH', body: JSON.stringify({ role: finalRole, domaine_id: domId })
      });
    } else {
      const rRes = await sb('/rest/v1/user_roles', {
        method: 'POST', body: JSON.stringify({ user_id, role: finalRole, domaine_id: domId })
      });
      if (!rRes.ok) throw new Error('Attribution du rôle impossible : ' + JSON.stringify(rRes.data));
    }

    await sb(`/rest/v1/pending_users?user_id=eq.${user_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'validated', validated_at: new Date().toISOString() })
    });

    return res.status(200).json({ success: true, message: `${pending.nom} peut maintenant se connecter` });
  } catch (e) {
    console.error('admin-pending error:', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
