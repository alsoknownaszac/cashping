import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { GLOBAL_PREFIX } from './../src/common/http/prefix.js';
import { configureSecurityHeaders } from './../src/common/http/security-headers.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // The prefix is applied in `main.ts`, not in `AppModule`, so it has to be
    // applied here too - otherwise this asserts a route the app does not serve.
    app.setGlobalPrefix(GLOBAL_PREFIX);
    // Same reason: the security headers are wired in `main.ts`, so the real
    // `AppModule` only carries them once they are applied here as well.
    configureSecurityHeaders(app);
    await app.init();
  });

  it(`/${GLOBAL_PREFIX} (GET)`, () => {
    return request(app.getHttpServer()).get(`/${GLOBAL_PREFIX}`).expect(200).expect('Hello World!');
  });

  it(`/${GLOBAL_PREFIX} (GET) carries the security headers`, () => {
    return request(app.getHttpServer())
      .get(`/${GLOBAL_PREFIX}`)
      .expect(200)
      .expect('x-content-type-options', 'nosniff')
      .expect('x-frame-options', 'DENY')
      .expect('referrer-policy', 'no-referrer')
      .expect('strict-transport-security', 'max-age=15552000; includeSubDomains');
  });

  afterEach(async () => {
    await app.close();
  });
});
