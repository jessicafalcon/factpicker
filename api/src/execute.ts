/** Shared GraphQL executor: the same resolver dispatch for Node and Deno. */
import { defaultFieldResolver, graphql, type GraphQLSchema } from "graphql";
import { resolvers } from "./resolvers.ts";
import type { Context } from "./resolvers.ts";

const resolverFor = (typeName: string, fieldName: string) =>
  (resolvers as Record<string, Record<string, unknown>>)[typeName]?.[fieldName] as
    | ((source: any, args: any, context: any, info: any) => unknown)
    | undefined;

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

export function makeExecutor(schema: GraphQLSchema) {
  return (options: ExecuteOptions) =>
    graphql({
      schema,
      source: options.source,
      rootValue: {},
      contextValue: options.context,
      variableValues: options.variableValues ?? undefined,
      operationName: options.operationName ?? undefined,
      fieldResolver,
    });
}
