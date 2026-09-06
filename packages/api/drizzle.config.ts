import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  dialect: 'sqlite',
  schema: ['./src/db/schema.ts', './src/db/schema-marketplace.ts', './src/db/schema-extras.ts'],
  out: './drizzle',
})
