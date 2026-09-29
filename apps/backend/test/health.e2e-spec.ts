import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './utils/create-test-app';

describe('Health check (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // Knative's readiness probe and the deploy smoke test call it with no cookies.
  it('GET /api/health answers without authentication, through the real guard chain', async () => {
    await request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('keeps authenticated routes behind the guard chain under the /api prefix', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
  });
});
