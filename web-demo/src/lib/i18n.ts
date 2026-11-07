/**
 * Bilingual copy. Values are plain strings with {placeholders} so the whole
 * dictionary can cross the server/client boundary.
 */
export type Locale = "en" | "fr";
export const LOCALES: Locale[] = ["en", "fr"];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "locale";

export const fmt = (template: string, vars: Record<string, string | number> = {}) =>
  template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] === undefined ? `{${key}}` : String(vars[key])));

const FACT_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    pension_2023_64: "Pension reform (2023)",
    education_budget_2027: "Education budget",
    immigration_law_2024: "Immigration law",
    cost_of_living: "Cost of living",
    lepen_conviction: "Court ruling",
    protest_17_october_2026: "17 October",
  },
  fr: {
    pension_2023_64: "Réforme des retraites (2023)",
    education_budget_2027: "Budget de l’éducation",
    immigration_law_2024: "Loi immigration",
    cost_of_living: "Coût de la vie",
    lepen_conviction: "Décision de justice",
    protest_17_october_2026: "17 octobre",
  },
};

/** Reading-family ids emitted by the Sankey (`reading:<id>`). */
const READING_LABELS_FR: Record<string, string> = {
  protests: "A déclenché des manifestations",
  workers: "Injuste pour les travailleurs",
  funding: "Une question de financement",
  forced: "Passé en force au Parlement",
  repeal: "À abroger",
  public_services: "Les services publics abandonnés",
  ruling: "La décision les disqualifie",
  prices: "Les prix écrasent les salaires",
  immigration: "La loi va trop loin, ou pas assez",
  security: "Une question de sécurité",
  other: "Autres lectures",
};

const EVENT_TITLES_FR: Record<string, string> = {
  lepen_conviction_ineligibility: "La condamnation de Marine Le Pen, son inéligibilité et le bracelet électronique",
  hospital_health: "Hôpital, médecins et accès aux soins",
  candidate_declarations: "Candidatures, meetings et sondages",
  socialist_primary_glucksmann: "Primaire socialiste et investiture de Glucksmann",
  purchasing_power_smic: "Pouvoir d’achat, SMIC et prix",
  heatwaves_fires: "Canicules, incendies et colère des pompiers",
  pensions_reform: "Retraites et réforme à 64 ans",
  medef_ref_debate: "Débat à sept candidats au REF du MEDEF",
  budget_deficit_493: "Budget, déficit et article 49.3",
  housing_rents: "Logement, loyers et HLM",
  immigration_oqtf: "Immigration, OQTF et régularisation",
  ukraine_russia: "Ukraine, Russie et défense",
  strikes_demonstrations: "Grèves, syndicats et manifestations",
  palestine_gaza: "Palestine, Gaza et la gauche française",
  rn_antisemitism_row: "Accusations d’antisémitisme au RN et référence à Alain Soral",
  police_custody_igpn: "Garde à vue, IGPN et accusations de violences policières",
  adele_haenel_censorship: "Adèle Haenel, France 5 et la Grande Librairie déprogrammée",
  lycee_blockades_uni: "Blocages de lycées et affaire UNI / Louise Montangon",
  protest_17_october: "La mobilisation du 17 octobre et ses suites",
  paris_massacre_1961: "17 octobre 1961 et la mémoire du massacre de Paris",
};

const EVENT_LABELS_FR: Record<string, string> = {
  "Court ruling": "Décision de justice",
  Announcement: "Annonce",
  Debate: "Débat",
  Protest: "Manifestation",
  Primary: "Primaire",
  "Antisemitism row": "Polémique",
  "Police custody": "Garde à vue",
  Censorship: "Censure",
  "Lycée blockades": "Blocages",
  "1961 memory": "Mémoire 1961",
  Pensions: "Retraites",
  Immigration: "Immigration",
  Budget: "Budget",
  "Purchasing power": "Pouvoir d’achat",
  Health: "Santé",
  Heatwaves: "Canicules",
  Housing: "Logement",
  Strikes: "Grèves",
  Ukraine: "Ukraine",
  "Middle East": "Proche-Orient",
  Scandal: "Scandale",
  Policy: "Politique",
  Campaign: "Campagne",
  Society: "Société",
  World: "Monde",
  Event: "Événement",
};

export const factLabel = (fact: { id: string; category: string }, locale: Locale) =>
  FACT_LABELS[locale][fact.id] ?? fact.category;

export const readingLabel = (id: string, fallback: string, locale: Locale) => {
  if (locale === "en") return fallback;
  const key = id.replace(/^reading:/, "");
  if (key === "fact") return fallback;
  return READING_LABELS_FR[key] ?? fallback;
};

export const eventTitle = (id: string, fallback: string, locale: Locale) =>
  locale === "fr" ? EVENT_TITLES_FR[id] ?? fallback : fallback;

const ANATOMY_TOPIC: Record<Locale, Record<string, string>> = {
  en: {
    pension_2023_64: "the 2023 pension reform",
    education_budget_2027: "the 2027 education budget",
    immigration_law_2024: "the 2024 immigration law",
    cost_of_living: "the cost of living",
    lepen_conviction: "the Le Pen ruling",
  },
  fr: {
    pension_2023_64: "la réforme des retraites de 2023",
    education_budget_2027: "le budget de l’éducation 2027",
    immigration_law_2024: "la loi immigration de 2024",
    cost_of_living: "le coût de la vie",
    lepen_conviction: "la décision de justice sur Marine Le Pen",
  },
};

export const anatomyTopic = (id: string, locale: Locale) => ANATOMY_TOPIC[locale][id];

export const eventLabel = (label: string, locale: Locale) =>
  locale === "fr" ? EVENT_LABELS_FR[label] ?? label : label;

export const dict = {
  en: {
    nav: { story: "Story" },
    lang: { label: "Language", en: "EN", fr: "FR" },
    hero: {
      kicker: "PRÉSIDENTIELLE 2027 · {range}",
      titleLead: "Same facts, opposite",
      titleTail: "opinions",
      intro:
        "Creators rarely invent facts. They pick one, say what it means, and turn it into a verdict on a candidate. We traced how that happens in {n} TikTok and Instagram videos between {first} and {last}.",
    },
    anatomy: {
      title: "Anatomy of an opinion",
      intro:
        "Most political videos follow the same three steps. {line}",
      introAbout: "Here is one about {topic}, posted {date}.",
      introThread: "Here is one from the 17 October thread, posted {n} days later.",
      introDayAfter: "Here is one from the day after the 17 October protest.",
      introRunup: "Here is one from the run-up to the 17 October protest.",
      srVerdict: "Verdict: {leaning} toward {candidate}.",
      introPosted: "Here is one, posted {date}.",
      rotate: "Auto-rotate",
      pause: "Pause rotation",
      openOn: "Open on {platform}",
      views: "{n} views",
      legend: {
        FACT: { label: "1 · THE FACT", description: "Matched to our fact list and checked against the source." },
        MEANING: { label: "2 · WHAT THEY SAY IT MEANS", description: "The creator’s interpretation. We record it; we don’t judge it." },
        VERDICT: { label: "3 · THE VERDICT", description: "Who it is aimed at, and whether it is for or against them." },
      },
    },
    leaning: { favorable: "favorable", critical: "critical", neutral: "neutral", unclear: "unclear" },
    sankey: {
      title: "One fact, many readings",
      intro:
        "Now repeat that for every video citing the same fact. Each band is a group of videos, flowing from the fact to what creators said it meant, and on to their verdict.",
      pick: "Pick a fact",
      factEyebrow: "The fact",
      videos: "{n} videos",
      viewsLine: "{v} · {views} views",
      colReadings: "What creators said it meant",
      colVerdicts: "Their verdict",
      verdictAgainst: "Against a candidate",
      verdictFor: "For a candidate",
      verdictNone: "No side",
      empty:
        "Only {n} videos cite this fact in the sample — not enough to read a breakdown from. Pick another fact.",
      caption:
        "Of {n} videos citing this fact, {against}% used it against a candidate, {for}% in support of one, and {none}% took no side.{top}",
      captionTop: " The most common reading: “{label}”.",
    },
    timeline: {
      title: "When each fact came up",
      intro: "The fact you picked above, moment by moment — where it appeared, and how the verdict moved.",
      moments: "{n} moments",
      citingIt: "{n} videos citing it",
      citingOne: "{n} video citing this fact",
      citingMany: "{n} videos citing this fact",
      posted: "{n} posted in {days} days",
      alsoCited: "Also cited",
      footer:
        "Each moment counts the videos citing this fact in the {days} days around it; the second figure is everything posted in that window. The split uses only labels whose evidence was found word for word in the video.",
      empty: "No moment in this sample cites this fact yet.",
      for: "{n} for",
      against: "{n} against",
      none: "{n} no side",
    },
    behind: {
      title: "The videos behind the numbers",
      intro:
        "Every band in the chart links to its videos, with the fact, the meaning and the verdict highlighted in the creator’s own words.",
      views: "{n} views",
    },
    how: {
      title: "How we did this",
      bullets: [
        "We collected TikTok and Instagram videos mentioning the candidates from Oriane’s index, posted between 8 August and 2 November 2026. The index does not cover every video, so counts describe our sample of {n} videos.",
        "For each video, a language model extracted three parts: the fact, matched to a list of facts we wrote and checked against the source; what the creator said it meant, grouped into a short label; and the verdict, the candidate it was aimed at and whether it was for or against them. Each part is kept only when its quote appears word for word in the video.",
        "We record how creators interpret facts. We do not judge whether those interpretations are right.",
        "This is not a poll. It describes what creators publish, which is different from what voters think.",
      ],
    },
    errors: {
      title: "The API is not answering",
      body: "The page could not reach {endpoint}. Start it in another terminal, then reload — this page reads the live dataset on every request.",
      hint: "npm run api:dev",
    },
  },
  fr: {
    nav: { story: "Récit" },
    lang: { label: "Langue", en: "EN", fr: "FR" },
    hero: {
      kicker: "PRÉSIDENTIELLE 2027 · {range}",
      titleLead: "Les faits, et ce qu’on",
      titleTail: "en fait",
      intro:
        "Les créateurs inventent rarement des faits. Ils en prennent un, disent ce qu’il signifie et en font une opinion sur un candidat. Nous avons suivi comment cela se passe dans {n} vidéos TikTok et Instagram entre {first} et {last}.",
    },
    anatomy: {
      title: "Anatomie d’une opinion",
      intro:
        "La plupart des vidéos politiques suivent les mêmes trois étapes. {line}",
      introAbout: "En voici une sur {topic}, publiée le {date}.",
      introThread: "En voici une du fil du 17 octobre, publiée {n} jours plus tard.",
      introDayAfter: "En voici une du lendemain de la mobilisation du 17 octobre.",
      introRunup: "En voici une de la période qui précède le 17 octobre.",
      srVerdict: "Verdict : {leaning} envers {candidate}.",
      introPosted: "En voici une, publiée le {date}.",
      rotate: "Défilement auto",
      pause: "Mettre en pause",
      openOn: "Ouvrir sur {platform}",
      views: "{n} vues",
      legend: {
        FACT: { label: "1 · LE FAIT", description: "Recoupé avec notre liste de faits et vérifié à la source." },
        MEANING: { label: "2 · CE QU’ILS EN DISENT", description: "L’interprétation du créateur. Nous la consignons, sans la juger." },
        VERDICT: { label: "3 · LE VERDICT", description: "À qui cela s’adresse, et si c’est pour ou contre." },
      },
    },
    leaning: { favorable: "favorable", critical: "critique", neutral: "neutre", unclear: "indécis" },
    sankey: {
      title: "Un fait, plusieurs lectures",
      intro:
        "Répétez l’opération pour chaque vidéo citant le même fait. Chaque bande est un groupe de vidéos, du fait à ce que les créateurs en ont dit, puis à leur verdict.",
      pick: "Choisir un fait",
      factEyebrow: "Le fait",
      videos: "{n} vidéos",
      viewsLine: "{v} · {views} vues",
      colReadings: "Ce que les créateurs en ont dit",
      colVerdicts: "Leur verdict",
      verdictAgainst: "Contre un candidat",
      verdictFor: "Pour un candidat",
      verdictNone: "Aucun camp",
      empty:
        "Seules {n} vidéos citent ce fait dans l’échantillon — pas assez pour en tirer une lecture. Choisissez un autre fait.",
      caption:
        "Sur {n} vidéos citant ce fait, {against} % l’ont utilisé contre un candidat, {for} % en soutien, et {none} % n’ont pris aucun camp.{top}",
      captionTop: " La lecture la plus fréquente : « {label} ».",
    },
    timeline: {
      title: "Quand chaque fait est apparu",
      intro: "Le fait que vous avez choisi, moment par moment — où il est apparu et comment le verdict a évolué.",
      moments: "{n} moments",
      citingIt: "{n} vidéos le citant",
      citingOne: "{n} vidéo citant ce fait",
      citingMany: "{n} vidéos citant ce fait",
      posted: "{n} publiées en {days} jours",
      alsoCited: "Aussi cité",
      footer:
        "Chaque moment compte les vidéos qui citent ce fait dans les {days} jours autour ; le second chiffre est tout ce qui a été publié dans cette fenêtre. La répartition n’utilise que les libellés dont la citation figure mot pour mot dans la vidéo.",
      empty: "Aucun moment de cet échantillon ne cite encore ce fait.",
      for: "{n} pour",
      against: "{n} contre",
      none: "{n} sans position",
    },
    behind: {
      title: "Les vidéos derrière les chiffres",
      intro:
        "Chaque bande du graphique renvoie à ses vidéos, avec le fait, le sens et le verdict soulignés dans les mots du créateur.",
      views: "{n} vues",
    },
    how: {
      title: "Comment nous avons procédé",
      bullets: [
        "Nous avons collecté les vidéos TikTok et Instagram mentionnant les candidats dans l’index Oriane, publiées entre le 8 août et le 2 novembre 2026. L’index ne couvre pas toutes les vidéos : les chiffres décrivent notre échantillon de {n} vidéos.",
        "Pour chaque vidéo, un modèle de langage a extrait trois éléments : le fait, rapproché d’une liste de faits que nous avons écrits et vérifiés à la source ; ce que le créateur dit qu’il signifie, regroupé en un libellé court ; et le verdict, le candidat visé et s’il est pour ou contre. Chaque élément n’est conservé que si sa citation figure mot pour mot dans la vidéo.",
        "Nous consignons la façon dont les créateurs interprètent les faits. Nous ne jugeons pas ces interprétations.",
        "Ce n’est pas un sondage. Cela décrit ce que les créateurs publient, ce qui diffère de ce que pensent les électeurs.",
      ],
    },
    errors: {
      title: "L’API ne répond pas",
      body: "La page n’a pas pu joindre {endpoint}. Lancez-la dans un autre terminal, puis rechargez — cette page lit le jeu de données à chaque requête.",
      hint: "npm run api:dev",
    },
  },
} as const;

export const copyFor = (locale: Locale) => dict[locale];
export type Copy = (typeof dict)[Locale];
