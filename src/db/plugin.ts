import mongoose, { type Schema } from 'mongoose';

/**
 * Every document leaves the API as `{ id, ...fields }` — no `_id`, no `__v`. Secrets (password
 * hashes) are `select: false` on the schema so they are never loaded unless asked for.
 */
function toClient(schema: Schema) {
  const transform = (_doc: unknown, ret: Record<string, unknown>) => {
    if (ret._id !== undefined) {
      ret.id = String(ret._id);
      delete ret._id;
    }
    delete ret.__v;
    return ret;
  };
  schema.set('toJSON', { virtuals: false, versionKey: false, transform });
}

let installed = false;
export function installPlugins() {
  if (installed) return;
  installed = true;
  // Query filters only ever take values that went through a Zod schema (strings, numbers), so
  // request bodies can't smuggle `$` operators into a filter.
  mongoose.set('strictQuery', true);
  mongoose.plugin(toClient);
}

installPlugins();
