export interface StateTemplate {
  id: string;
  name: string;
  documents: string[];
}

export const STATE_TEMPLATES: StateTemplate[] = [
  {
    id: "68e7f665af102d93f751e93f",
    name: "Pennsylvania",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "67b7115f07a4de27d6560d7c",
    name: "SD",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "6751c1aa26054e07f6fb32c2",
    name: "KY",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "6717db7dad39071ce06debfa",
    name: "ID",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "6717bc827a507b3bc114a869",
    name: "NE",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "67111b5c8ae11012df549b42",
    name: "TX Large ",
    documents: ["Cover Letter", "CSN", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "66e30eb53756a712d2496ea8",
    name: "NV",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "66e1b1acab871ae3b9d60003",
    name: "IN",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "66685b9296be15f4f0636667",
    name: "WY",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "6660a16934a239ee65530a59",
    name: "ND",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "6659273cc25b77f93f4a1a7f",
    name: "OH",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "65d4ca3a02598b72ab2fd9c6",
    name: "MS LG",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "6541b076598234cb67205a81",
    name: "VA",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "6541af58e95df0a6f77802e8",
    name: "NC",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "6541acb5a7b779c0ddb59920",
    name: "IL",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "65284bbb802560e6c4c0e693",
    name: "TN",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "6512a695b32b8ea85e86fe1d",
    name: "MO",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "6512a4761c0734188c7680ff",
    name: "NM",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "6512a437b871e632560e1545",
    name: "NY",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "6512a0af73c2ec06946e3f1a",
    name: "UT",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "6512936e68837bf90d658eba",
    name: "GA",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "64cd2733aeed6b8d990806ea",
    name: "AL",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "64ca92fc0f053b9e3f04c368",
    name: "AR SM",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "64c031eb140e1cf59455153e",
    name: "LA (Large)",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "64becfb6fca4026911948fdf",
    name: "LA (Small)",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "64b6b858e75c608e42fa1a83",
    name: "SC",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "64a852a934449c11316e36d4",
    name: "CO",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "64a852634ca26165d8e0fd7c",
    name: "AZ",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "64a85225f20295c08c40ceb5",
    name: "AR LG",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "64a85159def12cfae605dfc7",
    name: "FL",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "64a848de70888d805f4d5097",
    name: "OK",
    documents: ["Cover Letter", "NOI", "NOT", "SWPPP DOC"],
  },
  {
    id: "64a5d4a9b39dd4b060d9cb07",
    name: "TX SM",
    documents: [
      "Cover Letter",
      "Construction Site Notice",
      "Notice of Intent",
      "SWPPP",
    ],
  },
];

export const DEFAULT_DOCUMENTS = [
  "Cover Letter",
  "CSN",
  "NOI",
  "NOT",
  "SWPPP DOC",
];

export function getDocumentsForTemplate(templateIdOrName?: string): string[] {
  if (!templateIdOrName) return DEFAULT_DOCUMENTS;

  const template = STATE_TEMPLATES.find(
    (t) => t.id === templateIdOrName || t.name === templateIdOrName
  );

  return template ? template.documents : DEFAULT_DOCUMENTS;
}
