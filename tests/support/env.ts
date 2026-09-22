/** Admin URL used to create/drop throwaway databases. Local Docker default. */
export function testAdminDatabaseUrl(): string {
  return process.env.R4_TEST_DATABASE_URL ?? 'postgres://r4:r4_local_only@127.0.0.1:55432/postgres';
}

export function databaseUrlFor(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}
