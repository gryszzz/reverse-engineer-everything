export const EDITION = {
  schema_version: "ree.edition.v1",
  license: "MIT",
  copyright: "Copyright (c) 2026 morluto",
  sale_permitted_by_license: true,
  conditions: [
    "Include the copyright notice and the MIT permission notice in every copy or substantial portion.",
  ],
  payment_implemented: false,
  editions: [
    {
      id: "local",
      price: "no charge in this checkout",
      commands: [
        "inspect",
        "analyze",
        "studio",
        "demo",
        "doctor",
        "app",
        "outside-in",
        "bench",
      ],
    },
    {
      id: "pipeline",
      price: "not sold separately yet",
      commands: ["opportunities", "rebuild", "verify", "handoff"],
      not_a_command: ["ree serve"],
      note: "These commands ship in this MIT checkout. Nothing is locked.",
    },
  ],
};

export function formatEdition(json) {
  if (json) return JSON.stringify(EDITION, null, 2);
  return [
    "REE edition boundary",
    EDITION.copyright,
    "License: MIT. Selling copies is permitted when the copyright and permission notices travel with the copy.",
    "Payment code: none.",
    "Local core, no charge in this checkout: " +
      EDITION.editions[0].commands.join(", "),
    "Pipeline, not sold separately yet: " +
      EDITION.editions[1].commands.join(", "),
    "ree serve is not a command.",
    "Both editions are in this checkout. There is no license key.",
  ].join("\n");
}
