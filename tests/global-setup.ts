import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

let rs: MongoMemoryReplSet | undefined;

/** One in-memory replica set for the whole run (transactions need a replica set). */
export async function setup(project: TestProject) {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  project.provide('mongoUri', rs.getUri());
}

export async function teardown() {
  await rs?.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
