import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppController } from '../../app.controller.js';
import { AppService } from '../../app.service.js';
import { configureSecurityHeaders } from './security-headers.js';

/**
 * The security-header contract, asserted against real responses.
 *
 * Booted exactly the way `cors.spec.ts` boots the CORS spec: a bare controller so the test
 * needs no environment, no `.env` and no database, and cannot be influenced by whatever is
 * exported in the shell. It is the two-sided check the audit asks for - the four headers are
 * present, and the fingerprinting header Express sets by default is gone.
 */
describe('configureSecurityHeaders', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    app = moduleRef.createNestApplication();
    configureSecurityHeaders(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('sets the four baseline headers on an ordinary response', async () => {
    const response = await request(app.getHttpServer()).get('/');

    expect(response.status).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('sets HSTS with a max-age and includeSubDomains', async () => {
    const response = await request(app.getHttpServer()).get('/');

    expect(response.headers['strict-transport-security']).toBe(
      'max-age=15552000; includeSubDomains',
    );
  });

  it('removes the X-Powered-By header Express sets by default', async () => {
    const response = await request(app.getHttpServer()).get('/');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('sets the headers on an error response too, not only on 2xx', async () => {
    // A 404 still travels through the middleware, which is the case that matters: the
    // headers must not depend on a route having matched.
    const response = await request(app.getHttpServer()).get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });
});
