import { defineConfig } from 'drizzle-kit'

// Application-owned schema only. Better Auth manages its own tables first;
// auth-reference.ts supplies an FK target without exporting its schema here.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
})
