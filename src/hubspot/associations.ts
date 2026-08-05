import type { Client } from "@hubspot/api-client";

// HubSpot-defined association type IDs are portal-independent, but resolving
// them dynamically (rather than hardcoding e.g. 64/67/286) avoids silent
// breakage if HubSpot changes them or this ever runs against a portal with a
// custom association setup.
const associationTypeIdCache = new Map<string, number>();

export async function resolveAssociationTypeId(
  client: Client,
  fromObjectType: string,
  toObjectType: string,
): Promise<number> {
  const cacheKey = `${fromObjectType}->${toObjectType}`;
  const cached = associationTypeIdCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const definitions = await client.crm.associations.v4.schema.definitionsApi.getAll(fromObjectType, toObjectType);
  const preferred =
    definitions.results.find((result) => result.category === "HUBSPOT_DEFINED") ?? definitions.results[0];

  if (!preferred) {
    throw new Error(`No association type defined from "${fromObjectType}" to "${toObjectType}"`);
  }

  associationTypeIdCache.set(cacheKey, preferred.typeId);
  return preferred.typeId;
}

export function buildAssociation(toId: string, category: string, typeId: number) {
  return {
    to: { id: toId },
    types: [{ associationCategory: category as never, associationTypeId: typeId }],
  };
}
