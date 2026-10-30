# PAC 2027 / Cave — contrat fonctionnel et état réel (30 octobre 2026)

## Déjà développé dans cette branche
- `modules/pac-preparation.js` : analyse des données d'exploitation, parcelles et surfaces, checklist d'anomalies, statut « incomplet / à vérifier / prêt pour revue ».
- Structure d'une proposition de correction (ancienne valeur, nouvelle valeur, auteur, destinataire, pièce justificative, attente de confirmation).

Le module est autonome et non connecté aux écrans ; il ne remplace pas le fonctionnement existant.

## Travail restant avant tout essai en cave
1. Ajouter un champ de culture PAC par parcelle et une table d'infrastructures agroécologiques géolocalisées (haies, arbres, mares, fossés, cours d'eau, jachères, ruches…), avec origine des mesures et vérification d'éligibilité par dispositif.
2. Construire une interface secrétaire avec filtres par campagne, statut et adhérent.
3. Importer photos/PDF, XML, CSV, tableurs et ZIP en conservant les originaux ; IA propose une extraction, humain valide.
4. Implémenter une table de propositions de correction, RLS par cave et notifications à l'exploitant, suivi accepté/refusé/à revoir.
5. Constituer un référentiel daté PAC 2027 / MAEC Occitanie / écorégime / bio : règles officielles, sources, engagement, coûts, simulation **nette**. Aucun gain garanti.
6. Produire un export réglementaire du registre phytosanitaire numérique et vérifier le cahier des charges officiel ; ne pas confondre avec une simple impression PDF.
7. Tester avec trois comptes (viticulteur A, secrétaire cave A, viticulteur cave B) et revue de sécurité avant fusion.

## Règles UX incontournables
Photo, voix ou dépôt de fichier -> préremplissage -> vérification -> validation -> classement -> notification.
Jamais de resaisie forcée. Jamais de modification silencieuse des informations PAC.
Le viticulteur peut accepter, contester ou demander une explication ; sa non-réponse ne vaut jamais accord.

## Limites actuelles
- La table `parcelles` actuelle ne possède pas de champ `culture_pac` : il faudra effectuer un mapping depuis les données importées et valider.
- Le module de préparation n'est pas encore intégré à l'interface, ni testé de bout en bout.
- Les notifications ne sont **pas** encore branchées sur ce nouveau flux.
- Aucun calcul d'aide réglementaire n'est activé pour la campagne 2027.
- Aucune migration ni donnée de production modifiée.
