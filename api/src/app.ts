import { readFileSync } from "node:fs";
import { buildSchema, defaultFieldResolver, graphql, type GraphQLSchema } from "graphql";
import { resolvers, type Context } from "./resolvers.ts";
import { buildIndex, factVideos } from "./derive.ts";
import { createEmbeddingClient, type Dataset, type FactDef } from "./sources.ts";

export const schema: GraphQLSchema = buildSchema(
  readFileSync(new URL("../schema.graphql", import.meta.url), "utf8"),
);

/** Build the per-process context: one index, one fact→video map, one embedder. */
export function createContext(dataset: Dataset, embeddings = createEmbeddingClient()): Context {
  const index = buildIndex(dataset);
  const factsByVideo = new Map<string, FactDef[]>();
  for (const fact of dataset.facts) {
    for (const video of factVideos(index, fact)) {
      const list = factsByVideo.get(video.id) ?? [];
      list.push(fact);
      factsByVideo.set(video.id, list);
    }
  }
  return { dataset, index, embeddings, factsByVideo };
}

const resolverFor = (typeName: string, fieldName: string) =>
  (resolvers as Record<string, Record<string, unknown>>)[typeName]?.[fieldName] as
    | ((source: any, args: any, context: any, info: any) => unknown)
    | undefined;

/** Dispatch to the type resolvers, fall back to plain property access. */
const fieldResolver = (source: any, args: any, context: any, info: any) => {
  const custom = resolverFor(info.parentType.name, info.fieldName);
  if (custom) return custom(source, args, context, info);
  return defaultFieldResolver(source, args, context, info);
};

export interface ExecuteOptions {
  source: string;
  variableValues?: Record<string, unknown> | null;
  operationName?: string | null;
  context: Context;
}

export async function execute({ source, variableValues, operationName, context }: ExecuteOptions) {
  return graphql({ schema, source, rootValue: {}, contextValue: context, variableValues: variableValues ?? undefined, operationName: operationName ?? undefined, fieldResolver });
}
