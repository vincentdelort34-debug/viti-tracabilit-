/*
 * VitiPilot — moteur de préparation PAC / cave (version de développement)
 * Lecture seule : aucune modification Supabase, aucune déclaration PAC.
 * Les critères d'aides sont volontairement absents jusqu'à validation réglementaire.
 */
export const CULTURES = Object.freeze({
  vigne: 'Vigne', clementinier: 'Clémentinier', olivier: 'Olivier',
  pistachier: 'Pistachier', grandes_cultures: 'Grandes cultures',
  autre: 'Autre culture'
});
export const INFRASTRUCTURES = Object.freeze([
  'haie', 'arbre_isole', 'bosquet', 'mare', 'fossé',
  'cours_eau', 'jachere', 'bande_fleurie', 'lande', 'ruche'
]);
const text = value => String(value ?? '').trim();
const validArea = value => Number.isFinite(Number(value)) && Number(value) > 0;
export function analyseDossierPAC({ domaine = {}, parcelles = [], campagne = '2027', documents = [], modifications = [] } = {}) {
  const alerts = [];
  const actifs = parcelles.filter(p => !p.archived_at);
  const seen = new Set();
  if (!text(domaine.nom) && !text(domaine.raison_sociale)) alerts.push({code:'EXPLOITATION_NOM',niveau:'manquant',message:'Nom de l’exploitation à renseigner'});
  if (!text(domaine.siret)) alerts.push({code:'EXPLOITATION_SIRET',niveau:'a_verifier',message:'SIRET à vérifier'});
  if (!actifs.length) alerts.push({code:'PARCELLES_ABSENTES',niveau:'manquant',message:'Aucune parcelle active'});
  for (const p of actifs) {
    const label = text(p.nom) || text(p.code) || 'Parcelle sans nom';
    if (!text(p.code)) alerts.push({code:'PARCELLE_CODE',niveau:'manquant',parcelle:p.id,message:`${label} : identifiant manquant`});
    if (!validArea(p.surface_ha)) alerts.push({code:'PARCELLE_SURFACE',niveau:'manquant',parcelle:p.id,message:`${label} : surface à confirmer`});
    if (!text(p.commune)) alerts.push({code:'PARCELLE_COMMUNE',niveau:'a_verifier',parcelle:p.id,message:`${label} : commune à confirmer`});
    if (!text(p.culture) && !text(p.culture_pac)) alerts.push({code:'PARCELLE_CULTURE',niveau:'manquant',parcelle:p.id,message:`${label} : culture PAC à confirmer`});
    if (p.code && seen.has(p.code)) alerts.push({code:'PARCELLE_DOUBLON',niveau:'a_verifier',parcelle:p.id,message:`${label} : code parcelle dupliqué`});
    seen.add(p.code);
  }
  const awaiting = modifications.filter(m=>m.statut==='en_attente_viticulteur').length;
  if (awaiting) alerts.push({code:'VALIDATIONS_ATTENTE',niveau:'a_verifier',message:`${awaiting} modification(s) à confirmer par le viticulteur`});
  const surfaces = actifs.reduce((s,p)=>s+(validArea(p.surface_ha)?Number(p.surface_ha):0),0);
  return {
    campagne, domaine_id:domaine.id||null, nb_parcelles:actifs.length,
    surface_saisie_ha:Math.round(surfaces*10000)/10000,
    documents_recus:documents.length,
    corrections_en_attente:awaiting,
    alertes:alerts,
    statut:alerts.some(x=>x.niveau==='manquant')?'incomplet':alerts.length?'a_verifier':'pret_pour_revue',
    // IMPORTANT : « prêt pour revue » n'est ni une conformité ni un dépôt Télépac.
    verification_humaine_requise:true,
    aides_simulees:[], // jamais de promesse d'aide sans règles 2027 et pièces justificatives
  };
}
export function enregistrerPropositionCorrection({champ,ancienne_valeur,nouvelle_valeur,auteur_id,viticulteur_id,justificatif_id=null}) {
  if (!text(champ)||!text(auteur_id)||!text(viticulteur_id)) throw new Error('Correction incomplète');
  if (JSON.stringify(ancienne_valeur)===JSON.stringify(nouvelle_valeur)) throw new Error('Valeur inchangée');
  return {champ,ancienne_valeur,nouvelle_valeur,auteur_id,viticulteur_id,justificatif_id,
    statut:'en_attente_viticulteur',notification_a_envoyer:true};
}
