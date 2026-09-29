import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { configureApp } from './app.setup';
import { HealthController } from './health/health.controller';

async function createApp(spaDir?: string): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    // A tiny throttle budget makes "health is never throttled" observable.
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 2 }])],
    controllers: [HealthController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app, { spaDir });
  await app.init();
  return app;
}

describe('configureApp', () => {
  let spaDir: string;
  let app: NestExpressApplication;

  beforeAll(() => {
    spaDir = mkdtempSync(join(tmpdir(), 'spa-'));
    writeFileSync(
      join(spaDir, 'index.html'),
      '<!doctype html><title>spa shell</title>',
    );
    mkdirSync(join(spaDir, 'assets'));
    writeFileSync(join(spaDir, 'assets', 'app.js'), 'console.log("bundle");');
  });

  afterAll(() => {
    rmSync(spaDir, { recursive: true, force: true });
  });

  describe('with the built SPA', () => {
    beforeEach(async () => {
      app = await createApp(spaDir);
    });

    afterEach(async () => {
      await app.close();
    });

    it('serves the health check under the /api prefix', async () => {
      await request(app.getHttpServer() as App)
        .get('/api/health')
        .expect(200)
        .expect({ status: 'ok' });
    });

    it('never throttles the health check', async () => {
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer() as App)
          .get('/api/health')
          .expect(200);
      }
    });

    it('answers client-side routes with the SPA shell', async () => {
      const res = await request(app.getHttpServer() as App)
        .get('/admin/users')
        .expect(200);
      expect(res.text).toContain('spa shell');
    });

    it('serves built assets as files', async () => {
      const res = await request(app.getHttpServer() as App)
        .get('/assets/app.js')
        .expect(200);
      expect(res.text).toContain('bundle');
    });

    it('keeps unknown API routes as 404s instead of the SPA shell', async () => {
      const res = await request(app.getHttpServer() as App)
        .get('/api/does-not-exist')
        .expect(404);
      expect(res.text).not.toContain('spa shell');
    });

    it('keeps missing uploads as 404s instead of the SPA shell', async () => {
      const res = await request(app.getHttpServer() as App)
        .get('/uploads/photos/missing.png')
        .expect(404);
      expect(res.text).not.toContain('spa shell');
    });

    it('keeps the bare /uploads path out of the SPA fallback', async () => {
      // Static serving answers first: a redirect to /uploads/ when the directory
      // exists (cwd/uploads), a 404 when it does not — never the SPA shell.
      const res = await request(app.getHttpServer()).get('/uploads');
      expect([301, 404]).toContain(res.status);
      expect(res.text).not.toContain('spa shell');
    });

    it('does not answer non-GET requests with the SPA shell', async () => {
      const res = await request(app.getHttpServer() as App)
        .post('/admin/users')
        .expect(404);
      expect(res.text).not.toContain('spa shell');
    });
  });

  describe('without SPA_DIR (native / Docker dev)', () => {
    beforeEach(async () => {
      app = await createApp();
    });

    afterEach(async () => {
      await app.close();
    });

    it('serves only the API', async () => {
      await request(app.getHttpServer() as App)
        .get('/api/health')
        .expect(200);
      await request(app.getHttpServer() as App)
        .get('/admin/users')
        .expect(404);
    });
  });

  it('refuses to start when SPA_DIR has no index.html', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'spa-empty-'));
    try {
      await expect(createApp(empty)).rejects.toThrow('does not exist');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
