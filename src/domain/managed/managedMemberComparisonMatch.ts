import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import {
  managedMemberInspectionSchema,
  type ManagedMemberInspection,
} from "./managedArtifact.js";
import { parseManagedInspectionEvidence } from "./managedInspectionEvidence.js";
import type {
  ManagedMemberComparisonResult,
  ManagedMemberComparisonSide,
} from "./managedMemberComparison.js";
import type { JsonValue } from "../jsonValue.js";

export const sha256 = (value: JsonValue): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Managed comparison canonicalization failed");
  return createHash("sha256").update(serialized).digest("hex");
};

type Method = ManagedMemberInspection["methods"][number];
type Field = ManagedMemberInspection["fields"][number];
type MatchBasis =
  ManagedMemberComparisonResult["methods"][number]["match"]["basis"];
type ConcreteMatchBasis = Exclude<MatchBasis, "none">;

interface Keyed<Item> {
  readonly item: Item;
  /** Declared type and name; an unresolved type is null, the name remains. */
  readonly identity: string;
  readonly exactKey: string | null;
  readonly signatureKey: string | null;
  readonly rawSignatureKey: string;
  readonly structuralKey: string | null;
}

interface MatchedPair<Item> {
  readonly left: Keyed<Item>;
  readonly right: Keyed<Item>;
  readonly basis: ConcreteMatchBasis;
  readonly confidence: "exact" | "high";
}

interface Ambiguous<Item> {
  readonly left: readonly Keyed<Item>[];
  readonly right: readonly Keyed<Item>[];
  readonly basis: ConcreteMatchBasis;
}

const keyMethod = (item: Method): Keyed<Method> => ({
  item,
  identity: identityOf(item),
  rawSignatureKey: item.signature.raw_sha256,
  exactKey:
    item.body.status === "present" &&
    item.body.il_sha256 !== null &&
    item.body.normalized_il_sha256 !== null
      ? sha256([
          "method-exact",
          item.signature.raw_sha256,
          item.body.il_sha256,
          item.body.normalized_il_sha256,
        ])
      : null,
  // The raw blob is the exact signature; decoding only feeds shape keys.
  signatureKey: sha256([
    "method-signature",
    item.declaring_type,
    item.name,
    item.signature.raw_sha256,
  ]),
  structuralKey:
    item.signature.parse_status === "decoded" && item.body.status === "present"
      ? sha256([
          "method-structural",
          item.signature.kind,
          item.signature.calling_convention,
          item.signature.generic_parameter_count,
          item.signature.parameter_count,
          item.signature.return_type,
          item.signature.parameter_types,
          item.body.status,
          item.body.header_format,
          item.body.il_size,
          item.body.max_stack,
          item.body.init_locals,
          item.body.opcode_counts,
          item.body.anchors.map(({ opcode, operand_kind }) => [
            opcode,
            operand_kind,
          ]),
          item.body.exception_regions.map((region) => [
            region.flags,
            region.try_length,
            region.handler_length,
            region.class_token === null ? null : "type-token",
            region.filter_offset === null ? null : "filter",
          ]),
        ])
      : null,
});

const keyField = (item: Field): Keyed<Field> => ({
  item,
  identity: identityOf(item),
  rawSignatureKey: item.signature.raw_sha256,
  exactKey:
    item.signature.parse_status === "decoded"
      ? sha256(["field-exact", item.signature.raw_sha256])
      : null,
  // Only an undecoded field reaches this round: a decoded field with the
  // same raw signature already met its counterpart in the exact round.
  signatureKey: sha256([
    "field-signature",
    item.declaring_type,
    item.name,
    item.signature.raw_sha256,
  ]),
  structuralKey: sha256([
    "field-structural",
    item.signature.kind,
    item.signature.field_type,
    item.flags,
  ]),
});

const matchMethods = (
  left: readonly Keyed<Method>[],
  right: readonly Keyed<Method>[],
) =>
  matchByKeys({
    left,
    right,
    rounds: [
      {
        basis: "exact-il-signature",
        key: declaredAs(({ exactKey }) => exactKey),
      },
      {
        basis: "exact-signature",
        key: ({ signatureKey }) => signatureKey,
        competitionKey: ({ rawSignatureKey }) => rawSignatureKey,
      },
      {
        basis: "structural-method-shape",
        // An unresolved owner has no declared shape match to prove.
        key: declaredAs((keyed) =>
          keyed.item.declaring_type === null ? null : keyed.structuralKey,
        ),
        competitionKey: ({ structuralKey }) => structuralKey,
      },
      {
        basis: "exact-il-signature",
        key: ({ exactKey }) => exactKey,
        remap: true,
      },
      {
        basis: "structural-method-shape",
        key: ({ structuralKey }) => structuralKey,
        competitionKey: ({ structuralKey }) => structuralKey,
        remap: true,
      },
    ],
  });

const matchFields = (
  left: readonly Keyed<Field>[],
  right: readonly Keyed<Field>[],
) =>
  matchByKeys({
    left,
    right,
    rounds: [
      {
        basis: "field-signature",
        key: declaredAs(({ exactKey }) => exactKey),
      },
      {
        basis: "exact-signature",
        key: ({ signatureKey }) => signatureKey,
        competitionKey: ({ rawSignatureKey }) => rawSignatureKey,
      },
      {
        basis: "field-signature",
        key: ({ exactKey }) => exactKey,
        remap: true,
      },
    ],
  });

export type ManagedMethodMatches = ReturnType<typeof matchMethods>;
export type ManagedFieldMatches = ReturnType<typeof matchFields>;

interface MatchRound<Item> {
  readonly basis: ConcreteMatchBasis;
  readonly key: (item: Keyed<Item>) => string | null;
  /** Name-free evidence paired with the retained member name for contesting. */
  readonly competitionKey?: (item: Keyed<Item>) => string | null;
  /**
   * The key omits the declared type, so a pair may join different declared
   * identities; same-identity pairs were taken by earlier rounds. Contention
   * still retains the member name, which unresolved owners keep as evidence.
   * A member whose own identity is still unpaired on the other side does not
   * take part, and a group with a member of an unresolved type stays ambiguous.
   */
  readonly remap?: true;
}

interface MatchByKeysInput<Item> {
  readonly left: readonly Keyed<Item>[];
  readonly right: readonly Keyed<Item>[];
  readonly rounds: readonly MatchRound<Item>[];
}

export const identityOf = ({
  declaring_type,
  name,
}: {
  readonly declaring_type: string | null;
  readonly name: string;
}): string => sha256([declaring_type, name]);

/** Narrow a key to members of one declared type and name. */
const declaredAs =
  <Item>(key: (item: Keyed<Item>) => string | null) =>
  (item: Keyed<Item>): string | null => {
    const value = key(item);
    return value === null ? null : sha256([item.identity, value]);
  };

const matchByKeys = <Item extends Declared>({
  left,
  right,
  rounds,
}: MatchByKeysInput<Item>): {
  readonly pairs: readonly MatchedPair<Item>[];
  readonly ambiguous: readonly Ambiguous<Item>[];
  readonly leftOnly: readonly Keyed<Item>[];
  readonly rightOnly: readonly Keyed<Item>[];
} => {
  const usedLeft = new Set<Keyed<Item>>();
  const usedRight = new Set<Keyed<Item>>();
  const pairedLeft = new Set<Keyed<Item>>();
  const pairedRight = new Set<Keyed<Item>>();
  const pairs: MatchedPair<Item>[] = [];
  const ambiguous: Ambiguous<Item>[] = [];
  for (const round of rounds) {
    const competitionKey = round.competitionKey ?? ((item) => item.exactKey);
    const unpairedLeft = unpairedOf(left, pairedLeft);
    const unpairedRight = unpairedOf(right, pairedRight);
    const declarable = ownerlessDeclarable(
      unpairedLeft,
      unpairedRight,
      competitionKey,
    );
    const openLeft = left.filter((item) => !usedLeft.has(item));
    const openRight = right.filter((item) => !usedRight.has(item));
    // Only open candidates can justify overriding a held declared identity:
    // consumed ambiguous rows remain identity barriers, but cannot join a
    // later remap group to establish its ambiguity.
    const remapContested =
      round.remap === true
        ? ownerlessContested([openLeft, openRight], competitionKey)
        : new Set<string>();
    const leftGroups = groupBy(
      round.remap === true
        ? remappable(openLeft, unpairedRight, competitionKey, remapContested)
        : openLeft.filter(declarable),
      round.key,
    );
    const rightGroups = groupBy(
      round.remap === true
        ? remappable(openRight, unpairedLeft, competitionKey, remapContested)
        : openRight.filter(declarable),
      round.key,
    );
    for (const [key, leftItems] of leftGroups) {
      const rightItems = rightGroups.get(key);
      if (rightItems === undefined) continue;
      // An unresolved owner may be either member's own counterpart, so a
      // remap group it joins stays ambiguous.
      const refused =
        round.remap === true &&
        [...leftItems, ...rightItems].some(
          ({ item }) => item.declaring_type === null,
        );
      if (!refused && leftItems.length === 1 && rightItems.length === 1) {
        const [leftItem] = leftItems;
        const [rightItem] = rightItems;
        if (leftItem === undefined || rightItem === undefined) continue;
        usedLeft.add(leftItem);
        usedRight.add(rightItem);
        pairedLeft.add(leftItem);
        pairedRight.add(rightItem);
        pairs.push({
          left: leftItem,
          right: rightItem,
          basis: round.basis,
          confidence:
            round.basis === "exact-il-signature" ||
            round.basis === "exact-signature" ||
            round.basis === "field-signature"
              ? "exact"
              : "high",
        });
      } else {
        for (const item of leftItems) usedLeft.add(item);
        for (const item of rightItems) usedRight.add(item);
        ambiguous.push({
          left: leftItems,
          right: rightItems,
          basis: round.basis,
        });
      }
    }
  }
  // Contention can prevent a declared signature pair even when CIL/shape
  // evidence cannot form a later remap. Held ambiguities still contest
  // ownership; only proven pairs leave that evidence pool. Group only open
  // candidates so held members retain their original ambiguity and provenance.
  for (const group of unresolvedSignatureAmbiguities(
    left.filter((item) => !usedLeft.has(item)),
    right.filter((item) => !usedRight.has(item)),
    ownerlessContested(
      [unpairedOf(left, pairedLeft), unpairedOf(right, pairedRight)],
      (member) => member.rawSignatureKey,
    ),
  )) {
    for (const item of group.left) usedLeft.add(item);
    for (const item of group.right) usedRight.add(item);
    ambiguous.push(group);
  }
  return {
    pairs,
    ambiguous,
    leftOnly: left.filter((item) => !usedLeft.has(item)),
    rightOnly: right.filter((item) => !usedRight.has(item)),
  };
};

/** Open signature choices contested by unresolved owners, including held rows. */
const unresolvedSignatureAmbiguities = <Item extends Declared>(
  left: readonly Keyed<Item>[],
  right: readonly Keyed<Item>[],
  contested: ReadonlySet<string>,
): Ambiguous<Item>[] => {
  const key = (member: Keyed<Item>): string =>
    competitionIdentityKey(member, member.rawSignatureKey) ?? "";
  const leftGroups = groupBy(left, key);
  const rightGroups = groupBy(right, key);
  const groups: Ambiguous<Item>[] = [];
  for (const [signature, leftItems] of leftGroups) {
    const rightItems = rightGroups.get(signature);
    if (!contested.has(signature) || rightItems === undefined) continue;
    groups.push({
      left: leftItems,
      right: rightItems,
      basis: "exact-signature",
    });
  }
  return groups;
};

interface Declared {
  readonly declaring_type: string | null;
  readonly name: string;
}

const unpairedOf = <Item>(
  items: readonly Keyed<Item>[],
  paired: ReadonlySet<Keyed<Item>>,
): Keyed<Item>[] => items.filter((item) => !paired.has(item));

/**
 * Round-specific evidence keys an unresolved owner competes for, paired with
 * its retained member name. Another same-name member on the same side can be
 * the unresolved row's owner; a different name cannot. Contested candidates
 * stay in remap rounds rather than pairing by declared identity.
 */
const competitionIdentityKey = <Item extends Declared>(
  member: Keyed<Item>,
  evidenceKey: string | null,
): string | null =>
  evidenceKey === null ? null : JSON.stringify([member.item.name, evidenceKey]);

const ownerlessContested = <Item extends Declared>(
  sides: readonly (readonly Keyed<Item>[])[],
  keyOf: (item: Keyed<Item>) => string | null,
): ReadonlySet<string> => {
  const contested = new Set<string>();
  for (const side of sides) {
    const seen = new Map<string, number>();
    const ownerless = new Set<string>();
    for (const member of side) {
      const key = competitionIdentityKey(member, keyOf(member));
      if (key === null) continue;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (member.item.declaring_type === null) ownerless.add(key);
    }
    for (const key of ownerless)
      if ((seen.get(key) ?? 0) > 1) contested.add(key);
  }
  return contested;
};

/**
 * Members a remap round may group: an unresolved owner, which keeps its group
 * ambiguous; a member whose selected key an unresolved owner competes for, so the
 * group that preserved the base matcher's ambiguity can form; or no member of
 * the same declared identity left unpaired on the other side, whether
 * one-sided or in an ambiguous group. The sets are taken before grouping, so
 * no group order decides a remap.
 */
const remappable = <Item extends Declared>(
  items: readonly Keyed<Item>[],
  others: readonly Keyed<Item>[],
  keyOf: (item: Keyed<Item>) => string | null,
  contested: ReadonlySet<string>,
): Keyed<Item>[] => {
  const kept = new Set(others.map(({ identity }) => identity));
  return items.filter((member) => {
    const key = keyOf(member);
    return (
      (key !== null &&
        contested.has(competitionIdentityKey(member, key) ?? "")) ||
      member.item.declaring_type === null ||
      !kept.has(member.identity)
    );
  });
};

/**
 * Whether a member may pair in a declared-identity round. A member with an
 * unresolved owner may, only when no other member on either side shares its
 * selected evidence key: its owner might be any of them, so a shared key
 * leaves it to the remap rounds, which keep such a group ambiguous. The
 * resolved members that share such a key stay out too, so they cannot pair and
 * consume the candidate the ownerless member might own.
 */
const ownerlessDeclarable = <Item extends Declared>(
  left: readonly Keyed<Item>[],
  right: readonly Keyed<Item>[],
  keyOf: (item: Keyed<Item>) => string | null,
): ((member: Keyed<Item>) => boolean) => {
  const count = (side: readonly Keyed<Item>[]) => {
    const seen = new Map<string, number>();
    for (const member of side) {
      const key = keyOf(member);
      if (key !== null) seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return seen;
  };
  const leftSeen = count(left);
  const rightSeen = count(right);
  const contested = ownerlessContested([left, right], keyOf);
  return (member) => {
    const key = keyOf(member);
    return key !== null &&
      contested.has(competitionIdentityKey(member, key) ?? "")
      ? false
      : member.item.declaring_type !== null ||
          key === null ||
          ((leftSeen.get(key) ?? 0) <= 1 && (rightSeen.get(key) ?? 0) <= 1);
  };
};

const groupBy = <Item>(
  items: readonly Item[],
  keyOf: (item: Item) => string | null,
): Map<string, readonly Item[]> => {
  const grouped = new Map<string, Item[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    const bucket = grouped.get(key) ?? [];
    bucket.push(item);
    grouped.set(key, bucket);
  }
  return grouped;
};

/** Whether a side's inventory observed members of this declaring type. */
const observedBy =
  (side: ManagedMemberComparisonSide) =>
  ({ declaring_type }: { readonly declaring_type: string | null }): boolean =>
    side.result.selection === null ||
    (declaring_type !== null &&
      side.result.selection.type_names.includes(declaring_type));

/**
 * Pair only members whose declaring type both sides observed. A member outside
 * the other side's selection stays one-sided, so a type selection never yields
 * a remap to a member of a type the other side did not inspect.
 */
const matchObserved = <Item extends Declared>(
  left: readonly Item[],
  right: readonly Item[],
  sides: {
    readonly inLeft: (item: Item) => boolean;
    readonly inRight: (item: Item) => boolean;
  },
  match: (
    left: readonly Keyed<Item>[],
    right: readonly Keyed<Item>[],
  ) => ReturnType<typeof matchByKeys<Item>>,
  key: (item: Item) => Keyed<Item>,
): ReturnType<typeof matchByKeys<Item>> => {
  const matched = match(
    left.filter(sides.inRight).map(key),
    right.filter(sides.inLeft).map(key),
  );
  return {
    ...matched,
    leftOnly: [
      ...matched.leftOnly,
      ...left.filter((item) => !sides.inRight(item)).map(key),
    ],
    rightOnly: [
      ...matched.rightOnly,
      ...right.filter((item) => !sides.inLeft(item)).map(key),
    ],
  };
};

export const keyMembers = (
  left: ManagedMemberComparisonSide,
  right: ManagedMemberComparisonSide,
): {
  readonly methodMatches: ReturnType<typeof matchMethods>;
  readonly fieldMatches: ReturnType<typeof matchFields>;
} => {
  const sides = { inLeft: observedBy(left), inRight: observedBy(right) };
  return {
    methodMatches: matchObserved(
      left.result.methods,
      right.result.methods,
      sides,
      matchMethods,
      keyMethod,
    ),
    fieldMatches: matchObserved(
      left.result.fields,
      right.result.fields,
      sides,
      matchFields,
      keyField,
    ),
  };
};

export const parseManagedMemberEvidence = (
  evidence: unknown,
): {
  readonly evidenceId: string;
  readonly result: ManagedMemberInspection;
} => {
  const parsed = parseManagedInspectionEvidence(
    evidence,
    "inspect_managed_members",
    managedMemberInspectionSchema,
  );
  return {
    evidenceId: parsed.evidence.evidence_id,
    result: parsed.result,
  };
};
