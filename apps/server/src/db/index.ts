import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";
import * as knowledgeSchema from "./knowledge-schema.js";

const pool = new Pool({ connectionString: config.databaseUrl });

export const db = drizzle(pool, { schema: { ...schema, ...knowledgeSchema } });
export { pool };
