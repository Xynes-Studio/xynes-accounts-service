import { describe, it, expect } from 'bun:test';
import { checkPostgresReadiness } from '../src/infra/readiness';

describe('Readiness check (unit)', () => {
  it('passes when schema exists', async () => {
    const fakeFactory: any = () => {
      const sql: any = async (strings: TemplateStringsArray, arg: any) => {
        void arg;
        const text = strings.join('');
        if (text.includes('FROM pg_namespace')) {
          return [{ 1: 1 }];
        }
        return [{ 1: 1 }];
      };
      sql.end = async () => undefined;
      return sql;
    };

    await expect(
      checkPostgresReadiness({
        databaseUrl: 'postgres://example',
        schemaName: 'identity',
        clientFactory: fakeFactory,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails when schema does not exist', async () => {
    const fakeFactory: any = () => {
      const sql: any = async (strings: TemplateStringsArray) => {
        const text = strings.join('');
        if (text.includes('FROM pg_namespace')) {
          return [];
        }
        return [{ 1: 1 }];
      };
      sql.end = async () => undefined;
      return sql;
    };

    await expect(
      checkPostgresReadiness({
        databaseUrl: 'postgres://example',
        schemaName: 'identity',
        clientFactory: fakeFactory,
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
