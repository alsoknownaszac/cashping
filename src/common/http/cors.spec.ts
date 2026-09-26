import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppController } from '../../app.controller.js';
import { AppService } from '../../app.service.js';
import { configureCors } from './cors.js';

/**
 * The CORS contract the frontend depends on, asserted against real responses.
 *
 * An explicit allow-list is passed in, so this stays a unit test: it needs no
 * environment and no `.env`, and it cannot be influenced by whatever
 * `CORS_ALLOWED_ORIGINS` happens to be exported in the shell.
 */
const ALLOWED_ORIGINS = ['http://localhost:3000', 'http://localhost:5173'];

describe('configureCors', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    app = moduleRef.createNestApplication();
    configureCors(app, ALLOWED_ORIGINS);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('echoes the origin back when the request comes from an allowed origin', async () => {
    const response = await request(app.getHttpServer())
      .get('/')
      .set('Origin', 'http://localhost:5173');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    // The header varies per origin, so caches must not reuse one origin's response
    // for another.
    expect(response.headers['vary']).toContain('Origin');
  });

  it('omits the header for a disallowed origin - which is what blocks the browser', async () => {
    const response = await request(app.getHttpServer())
      .get('/')
      .set('Origin', 'http://not-allowed.example');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight from an allowed origin with the methods and headers asked about', async () => {
    const response = await request(app.getHttpServer())
      .options('/')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(response.headers['access-control-allow-methods']).toContain('GET');
    // Reflected rather than hard-coded, so `Authorization` (once auth lands) and
    // any future header work without touching the CORS setup.
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
  });

  it('answers a preflight from a disallowed origin without the header', async () => {
    const response = await request(app.getHttpServer())
      .options('/')
      .set('Origin', 'http://not-allowed.example')
      .set('Access-Control-Request-Method', 'GET');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('leaves a request with no Origin header untouched (curl, healthchecks)', async () => {
    const response = await request(app.getHttpServer()).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toBe('Hello World!');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
