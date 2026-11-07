/** Display names for the fact catalogue. One place, used by every section. */
export const FACT_LABEL: Record<string, string> = {
  pension_2023_64: "Pension reform (2023)",
  education_budget_2027: "Education budget",
  immigration_law_2024: "Immigration law",
  cost_of_living: "Cost of living",
  lepen_conviction: "Court ruling",
  protest_17_october_2026: "17 October",
};

export const factLabel = (fact: { id: string; category: string }) => FACT_LABEL[fact.id] ?? fact.category;
