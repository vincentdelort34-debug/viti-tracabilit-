# VitiPilot — Espace cave coopérative (chantier isolé)

État : spécification technique, AUCUNE mise en production.

## Besoin terrain
Une secrétaire de cave doit suivre la campagne de tous les adhérents rattachés : dossiers incomplets, registres de traitements, bilans IFT, pièces HVE, suivi des vérifications, sans visiter chaque compte individuellement.

## Existant vérifié
- Domaines : id, cave_id, user_id, role, nom, email, surface_ha, campagne_en_cours.
- Parcelles : domaine_id, surface_ha, archived_at.
- Traitements : domaine_id, campagne, date_application, produit_nom, amm, dose_appliquee, dose_reference, ift, ift_valide_le.
- ift_validations : historique de validations.
- Fonction secrétaire et changement de domaine déjà présents dans app.js.
- Politiques RLS existantes pour consultation secrétaire, à tester avec deux caves indépendantes avant exploitation.

## Première version cible : lecture seule
1. Un tableau par adhérent, avec surface, nombre de parcelles, nombre de traitements, date du dernier traitement, statut de validation IFT, statut du dossier.
2. Filtres : campagne, nom, complet/incomplet, validé/à contrôler.
3. Cliquer sur un adhérent ouvre un résumé détaillé (lecture seule).
4. Les indicateurs de complétude restent « informations à contrôler », jamais « conformité HVE acquise » sans référentiel réglementaire et validation métier.
5. Aucune donnée d'une autre cave, même en manipulant les requêtes.

## Source de vérité
- Construire une requête/une RPC sécurisée prenant la campagne en argument et déduisant la cave de auth.uid(), jamais d'un cave_id accepté du navigateur.
- Ne pas exposer de clé service_role au client.
- Centraliser les agrégats côté base et protéger par tests RLS.
- Ne pas réutiliser loadAll() pour charger tous les traitements de tous les adhérents.

## Points de vigilance confirmés dans le code
- loadValidationList() calcule un « IFT moyen » par moyenne simple des lignes de traitement : ce n'est pas l'IFT moyen pondéré par la surface des parcelles ; ne pas le traiter comme valeur réglementaire.
- L'affichage HVE contient des scores/références codés en dur et ne doit pas servir de certificat.
- Le flux de création de comptes transmet un mot de passe temporaire affiché en clair : migrer vers des invitations et mot de passe choisi par l'utilisateur.
- Vérifier la politique UPDATE sur caves : elle permet selon son prédicat aux domaines rattachés de mettre à jour le nom ; réserver aux rôles autorisés.

## Tests d'acceptation obligatoires
- Un viticulteur de la cave A ne peut pas lire les autres dossiers.
- La secrétaire A voit les adhérents A, mais aucun adhérent B.
- Un adhérent sans traitement apparaît « saisie manquante », jamais IFT=0 certifié.
- Les changements de campagne n'altèrent pas les historiques.
- Les erreurs réseaux et données incomplètes sont visibles, pas maquillées en zéro.

## Déploiement
Créer et tester en branche, faire une revue de code avec Sébastien, déployer sur un environnement de prévisualisation, tester avec comptes dédiés, puis seulement proposer la fusion vers main.
