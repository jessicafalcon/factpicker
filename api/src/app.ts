import { readFileSync } from "node:fs";
import { buildSchema, type GraphQLSchema } from "graphql";
import { createContext } from "./context.ts";
import { makeExecutor } from "./execute.ts";
import { createEmbeddingClient } from "./sources.ts";

export const schema: GraphQLSchema = buildSchema(
  readFileSync(new URL("../schema.graphql", import.meta.url), "utf8"),
);

export { createContext };
export const execute = makeExecutor(schema);
export type { ExecuteOptions } from "./execute.ts";
