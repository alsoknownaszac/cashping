import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { GLOBAL_PREFIX } from './../src/common/http/prefix.js';

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
    await app.init();
  });

  it(`/${GLOBAL_PREFIX} (GET)`, () => {
    return request(app.getHttpServer()).get(`/${GLOBAL_PREFIX}`).expect(200).expect('Hello World!');
  });

  afterEach(async () => {
    await app.close();
  });
});
