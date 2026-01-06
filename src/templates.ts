export interface StateTemplate {
  id: string;
  name: string;
  documents: string[];
}

const COMMON_DOCS = [
  "Cover Letter",
  "Notice of Intent",
  "Construction Site Notice",
  "SWPPP",
];

export const STATE_TEMPLATES: StateTemplate[] = [
  {
    id: "68e7f665af102d93f751e93f",
    name: "Pennsylvania",
    documents: COMMON_DOCS,
  },
  {
    id: "67b7115f07a4de27d6560d7c",
    name: "South Dakota",
    documents: COMMON_DOCS,
  },
  {
    id: "6751c1aa26054e07f6fb32c2",
    name: "Kentucky",
    documents: COMMON_DOCS,
  },
  {
    id: "6717db7dad39071ce06debfa",
    name: "Idaho",
    documents: COMMON_DOCS,
  },
  {
    id: "6717bc827a507b3bc114a869",
    name: "Nebraska",
    documents: COMMON_DOCS,
  },
  {
    id: "67111b5c8ae11012df549b42",
    name: "Texas Large",
    documents: COMMON_DOCS,
  },
  {
    id: "66e30eb53756a712d2496ea8",
    name: "Nevada",
    documents: COMMON_DOCS,
  },
  {
    id: "66e1b1acab871ae3b9d60003",
    name: "Indiana",
    documents: COMMON_DOCS,
  },
  {
    id: "66685b9296be15f4f0636667",
    name: "Wyoming",
    documents: COMMON_DOCS,
  },
  {
    id: "6660a16934a239ee65530a59",
    name: "North Dakota",
    documents: COMMON_DOCS,
  },
  {
    id: "6659273cc25b77f93f4a1a7f",
    name: "Ohio",
    documents: COMMON_DOCS,
  },
  {
    id: "65d4ca3a02598b72ab2fd9c6",
    name: "Mississippi Large",
    documents: COMMON_DOCS,
  },
  {
    id: "6541b076598234cb67205a81",
    name: "Virginia",
    documents: COMMON_DOCS,
  },
  {
    id: "6541af58e95df0a6f77802e8",
    name: "North Carolina",
    documents: COMMON_DOCS,
  },
  {
    id: "6541acb5a7b779c0ddb59920",
    name: "Illinois",
    documents: COMMON_DOCS,
  },
  {
    id: "65284bbb802560e6c4c0e693",
    name: "Tennessee",
    documents: COMMON_DOCS,
  },
  {
    id: "6512a695b32b8ea85e86fe1d",
    name: "Missouri",
    documents: COMMON_DOCS,
  },
  {
    id: "6512a4761c0734188c7680ff",
    name: "New Mexico",
    documents: COMMON_DOCS,
  },
  {
    id: "6512a437b871e632560e1545",
    name: "New York",
    documents: COMMON_DOCS,
  },
  {
    id: "6512a0af73c2ec06946e3f1a",
    name: "Utah",
    documents: COMMON_DOCS,
  },
  {
    id: "6512936e68837bf90d658eba",
    name: "Georgia",
    documents: COMMON_DOCS,
  },
  {
    id: "64cd2733aeed6b8d990806ea",
    name: "Alabama",
    documents: COMMON_DOCS,
  },
  {
    id: "64ca92fc0f053b9e3f04c368",
    name: "Arkansas Small",
    documents: COMMON_DOCS,
  },
  {
    id: "64c031eb140e1cf59455153e",
    name: "Louisiana Large",
    documents: COMMON_DOCS,
  },
  {
    id: "64becfb6fca4026911948fdf",
    name: "Louisiana Small",
    documents: COMMON_DOCS,
  },
  {
    id: "64b6b858e75c608e42fa1a83",
    name: "South Carolina",
    documents: COMMON_DOCS,
  },
  {
    id: "64a852a934449c11316e36d4",
    name: "Colorado",
    documents: COMMON_DOCS,
  },
  {
    id: "64a852634ca26165d8e0fd7c",
    name: "Arizona",
    documents: COMMON_DOCS,
  },
  {
    id: "64a85225f20295c08c40ceb5",
    name: "Arkansas Large",
    documents: COMMON_DOCS,
  },
  {
    id: "64a85159def12cfae605dfc7",
    name: "Florida",
    documents: COMMON_DOCS,
  },
  {
    id: "64a848de70888d805f4d5097",
    name: "Oklahoma",
    documents: COMMON_DOCS,
  },
  {
    id: "64a5d4a9b39dd4b060d9cb07",
    name: "Texas Small",
    documents: COMMON_DOCS,
  },
];

export const DEFAULT_DOCUMENTS = COMMON_DOCS;

export function getDocumentsForTemplate(templateIdOrName?: string): string[] {
  if (!templateIdOrName) return DEFAULT_DOCUMENTS;

  const template = STATE_TEMPLATES.find(
    (t) => t.id === templateIdOrName || t.name === templateIdOrName
  );

  return template ? template.documents : DEFAULT_DOCUMENTS;
}

export function getTemplateName(templateIdOrName?: string): string | undefined {
  if (!templateIdOrName) return undefined;
  const template = STATE_TEMPLATES.find(
    (t) => t.id === templateIdOrName || t.name === templateIdOrName
  );
  return template ? template.name : templateIdOrName;
}
