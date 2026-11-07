/**
 * Communities that shape how a candidate is framed on social video.
 *
 * These are the accounts that produce or amplify content: party structures,
 * youth wings, unions, student organisations, NGOs, think tanks and outlets.
 * They are queried as an independent signal — "CGT" is not a candidate mention,
 * it is a community mention — which lets the UI answer "who is pushing this
 * frame?" without guessing from the creator handle.
 */
export type CommunityType =
  | "party"
  | "party_youth"
  | "union"
  | "student_union"
  | "ngo"
  | "think_tank"
  | "media"
  | "militant_collective";

export type Alignment =
  | "far_left"
  | "left"
  | "centre_left"
  | "centre"
  | "centre_right"
  | "right"
  | "far_right"
  | "sovereigntist"
  | "employer"
  | "non_aligned";

export interface CommunityDef {
  id: string;
  name: string;
  type: CommunityType;
  alignment: Alignment;
  aliases: string[];
  /** Candidates this community is aligned with or openly backs. */
  backs: string[];
  notes?: string;
}

export const COMMUNITIES: CommunityDef[] = [
  // ── Party structures and youth wings ──────────────────────────────────
  { id: "rn_jeunes", name: "Rassemblement national / Jeunes RN", type: "party_youth", alignment: "far_right", aliases: ["Jeunes RN", "Rassemblement national", "Front national", "RN"], backs: ["lepen", "bardella"] },
  { id: "jeunes_insoumis", name: "Les Jeunes Insoumis·es", type: "party_youth", alignment: "far_left", aliases: ["Jeunes Insoumis", "Jeunes Insoumises", "Jeunes insoumis·es", "LFI"], backs: ["melenchon", "ruffin"] },
  { id: "lr_jeunes", name: "Les Jeunes Républicains", type: "party_youth", alignment: "right", aliases: ["Jeunes Républicains", "Jeunes LR", "Les Républicains", "LR"], backs: ["retailleau", "bertrand"] },
  { id: "jem", name: "Jeunes avec Macron", type: "party_youth", alignment: "centre", aliases: ["Jeunes avec Macron", "JAM", "Jeunes avec Manu"], backs: ["attal"] },
  { id: "eelv_jeunes", name: "Jeunes Écologistes", type: "party_youth", alignment: "left", aliases: ["Jeunes Écologistes", "Jeunes Ecologistes", "Jeunes Verts"], backs: ["tondelier"] },
  { id: "jeunes_communistes", name: "Jeunes Communistes", type: "party_youth", alignment: "far_left", aliases: ["Jeunes Communistes", "JC", "Mouvement Jeunes Communistes"], backs: ["roussel"] },
  { id: "renaissance", name: "Renaissance", type: "party", alignment: "centre", aliases: ["Renaissance", "LREM", "En Marche"], backs: ["attal", "becht"] },
  { id: "horizons", name: "Horizons", type: "party", alignment: "centre_right", aliases: ["Horizons"], backs: ["philippe"] },
  { id: "ps", name: "Parti socialiste", type: "party", alignment: "centre_left", aliases: ["Parti socialiste", "PS"], backs: ["glucksmann", "bouamrane", "cazeneuve"] },
  { id: "place_publique", name: "Place publique", type: "party", alignment: "centre_left", aliases: ["Place publique", "Place Publique"], backs: ["glucksmann"] },
  { id: "les_ecologistes", name: "Les Écologistes", type: "party", alignment: "left", aliases: ["Les Écologistes", "Europe Écologie Les Verts", "EELV"], backs: ["tondelier"] },
  { id: "pcf", name: "Parti communiste français", type: "party", alignment: "far_left", aliases: ["Parti communiste", "PCF"], backs: ["roussel"] },
  { id: "reconquete", name: "Reconquête", type: "party", alignment: "far_right", aliases: ["Reconquête", "Reconquete"], backs: ["zemmour"] },
  { id: "nouvelle_energie", name: "Nouvelle Énergie", type: "party", alignment: "right", aliases: ["Nouvelle Énergie", "Nouvelle Energie"], backs: ["lisnard"] },
  { id: "debout_la_france", name: "Debout la France", type: "party", alignment: "sovereigntist", aliases: ["Debout la France", "DLF"], backs: ["duponaignan"] },
  { id: "les_patriotes", name: "Les Patriotes", type: "party", alignment: "sovereigntist", aliases: ["Les Patriotes"], backs: ["philippot"] },
  { id: "la_convention", name: "La Convention", type: "party", alignment: "centre_left", aliases: ["La Convention"], backs: ["cazeneuve"] },
  { id: "generation_ecologie", name: "Génération écologie", type: "party", alignment: "left", aliases: ["Génération écologie", "Generation ecologie"], backs: ["batho"] },
  { id: "nous_france", name: "Nous France", type: "party", alignment: "right", aliases: ["Nous France"], backs: ["bertrand"] },
  { id: "upr", name: "Union populaire républicaine", type: "party", alignment: "sovereigntist", aliases: ["Union populaire républicaine", "UPR"], backs: ["asselineau"] },
  { id: "lutte_ouvriere", name: "Lutte ouvrière", type: "party", alignment: "far_left", aliases: ["Lutte ouvrière", "Lutte ouvriere", "LO"], backs: ["arthaud"] },
  { id: "npa", name: "NPA – Révolutionnaires", type: "party", alignment: "far_left", aliases: ["NPA", "Nouveau Parti anticapitaliste", "NPA Révolutionnaires"], backs: ["labib"] },
  { id: "revolution_permanente", name: "Révolution permanente", type: "party", alignment: "far_left", aliases: ["Révolution permanente", "Revolution permanente"], backs: ["kazib"] },
  { id: "parti_animaliste", name: "Parti animaliste", type: "party", alignment: "non_aligned", aliases: ["Parti animaliste"], backs: ["markovic"] },
  { id: "equinoxe", name: "Équinoxe", type: "party", alignment: "non_aligned", aliases: ["Équinoxe", "Equinoxe"], backs: ["mikolajczak"] },
  { id: "trajectoire", name: "Trajectoire", type: "party", alignment: "non_aligned", aliases: ["Trajectoire"], backs: ["mlekuz"] },

  // ── Unions ────────────────────────────────────────────────────────────
  { id: "cgt", name: "CGT", type: "union", alignment: "far_left", aliases: ["CGT", "Confédération générale du travail"], backs: ["melenchon", "roussel", "arthaud", "kazib"], notes: "Historically close to the PCF and LFI; opposes the RN." },
  { id: "cfdt", name: "CFDT", type: "union", alignment: "centre_left", aliases: ["CFDT"], backs: ["glucksmann"], notes: "Reformist union; Laurent Berger is a public voice." },
  { id: "fo", name: "Force ouvrière", type: "union", alignment: "left", aliases: ["Force ouvrière", "Force ouvriere", "FO"], backs: [] },
  { id: "solidaires", name: "Solidaires / SUD", type: "union", alignment: "far_left", aliases: ["Solidaires", "SUD", "Union syndicale Solidaires"], backs: ["melenchon", "arthaud", "kazib"] },
  { id: "cgt_opposed", name: "Syndicats face au RN", type: "union", alignment: "far_left", aliases: ["intersyndicale", "syndicats"], backs: [], notes: "Used to detect labour-vs-RN confrontation framing." },
  { id: "medef", name: "MEDEF", type: "employer", alignment: "employer", aliases: ["MEDEF", "Medef", "Rencontre des Entrepreneurs de France", "REF"], backs: [], notes: "Hosted the 2026-08-27 seven-candidate debate." },

  // ── Student organisations ─────────────────────────────────────────────
  { id: "unef", name: "UNEF", type: "student_union", alignment: "left", aliases: ["UNEF", "Unef"], backs: ["melenchon", "ruffin"] },
  { id: "la_cocarde", name: "La Cocarde étudiante", type: "student_union", alignment: "right", aliases: ["La Cocarde", "Cocarde étudiante", "Cocarde etudiante"], backs: ["retailleau"] },
  { id: "fage", name: "FAGE", type: "student_union", alignment: "non_aligned", aliases: ["FAGE"], backs: [] },

  // ── NGOs and advocacy ─────────────────────────────────────────────────
  { id: "sos_racisme", name: "SOS Racisme", type: "ngo", alignment: "left", aliases: ["SOS Racisme", "SOS racisme"], backs: [] },
  { id: "licra", name: "LICRA", type: "ngo", alignment: "non_aligned", aliases: ["LICRA", "Licra"], backs: [] },
  { id: "attac", name: "Attac", type: "ngo", alignment: "far_left", aliases: ["Attac"], backs: ["melenchon", "tondelier"] },
  { id: "greenpeace", name: "Greenpeace France", type: "ngo", alignment: "non_aligned", aliases: ["Greenpeace"], backs: [] },
  { id: "fondation_jean_jaures", name: "Fondation Jean-Jaurès", type: "think_tank", alignment: "centre_left", aliases: ["Fondation Jean-Jaurès", "Fondation Jean Jaures"], backs: [] },
  { id: "institut_montaigne", name: "Institut Montaigne", type: "think_tank", alignment: "centre_right", aliases: ["Institut Montaigne"], backs: [] },

  // ── Outlets and creator collectives ───────────────────────────────────
  { id: "brut", name: "Brut", type: "media", alignment: "non_aligned", aliases: ["Brut", "Brut."], backs: [] },
  { id: "hugodecrypte", name: "HugoDécrypte", type: "media", alignment: "non_aligned", aliases: ["HugoDécrypte", "Hugo Decrypte", "HugoDécrypte"], backs: [] },
  { id: "konbini", name: "Konbini", type: "media", alignment: "non_aligned", aliases: ["Konbini"], backs: [] },
  { id: "mediapart", name: "Mediapart", type: "media", alignment: "left", aliases: ["Mediapart"], backs: [] },
  { id: "le_media", name: "Le Média", type: "media", alignment: "far_left", aliases: ["Le Média", "Le Media"], backs: ["melenchon"] },
  { id: "frontieres", name: "Frontières", type: "media", alignment: "far_right", aliases: ["Frontières", "Frontieres"], backs: ["lepen", "bardella"] },
  { id: "boulevard_voltaire", name: "Boulevard Voltaire", type: "media", alignment: "far_right", aliases: ["Boulevard Voltaire"], backs: ["lepen", "zemmour"] },
  { id: "livre_noir", name: "Livre noir", type: "media", alignment: "far_right", aliases: ["Livre noir", "Livre Noir"], backs: ["zemmour"] },
  { id: "valeurs_actuelles", name: "Valeurs actuelles", type: "media", alignment: "far_right", aliases: ["Valeurs actuelles", "Valeurs Actuelles"], backs: ["retailleau", "zemmour"] },
  { id: "marianne", name: "Marianne", type: "media", alignment: "sovereigntist", aliases: ["Marianne"], backs: ["polony"], notes: "Natacha Polony's outlet before her candidacy." },
  { id: "cnews", name: "CNews", type: "media", alignment: "right", aliases: ["CNews", "CNews Matin"], backs: [] },
  { id: "bfmtv", name: "BFMTV", type: "media", alignment: "non_aligned", aliases: ["BFMTV", "BFM TV", "BFM"], backs: [] },
  { id: "lci", name: "LCI", type: "media", alignment: "non_aligned", aliases: ["LCI"], backs: [] },
  { id: "france_inter", name: "France Inter", type: "media", alignment: "non_aligned", aliases: ["France Inter"], backs: [] },
  { id: "le_monde", name: "Le Monde", type: "media", alignment: "non_aligned", aliases: ["Le Monde"], backs: [] },
  { id: "le_figaro", name: "Le Figaro", type: "media", alignment: "right", aliases: ["Le Figaro", "Figaro"], backs: [] },
  { id: "souverainistes", name: "Souverainistes", type: "militant_collective", alignment: "sovereigntist", aliases: ["souverainiste", "souverainistes", "Frexit"], backs: ["duponaignan", "asselineau", "philippot", "polony"] },
];

export const COMMUNITIES_BY_ID: Record<string, CommunityDef> = Object.fromEntries(
  COMMUNITIES.map((c) => [c.id, c]),
);

export const COMMUNITIES_BY_ALIGNMENT = COMMUNITIES.reduce<Record<string, CommunityDef[]>>(
  (acc, community) => {
    (acc[community.alignment] ??= []).push(community);
    return acc;
  },
  {},
);

/** Media handles that dominate French political video, for creator-tier queries. */
export const MEDIA_HANDLES = [
  "brutofficiel", "hugodecrypte", "konbini", "mediapart", "lemedia", "cnews", "bfmtv",
  "lci", "franceinter", "lemondefr", "lefigaro", "marianne", "frontieresmedia",
  "boulevardvoltaire_", "valeursactuelles", "livre_noir", "sudradio", "radiofrance",
];

/** Party account handles, when the data has them. */
export const PARTY_HANDLES = [
  "rassemblementnational", "lafranceinsoumise", "renaissance", "lesrepublicains",
  "eelv", "particommunistefrancais", "reconquete", "horizons", "nouvelleenergie",
];
