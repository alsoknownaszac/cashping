import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { type OpenAPIObject } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { type App } from 'supertest/types';
import { AppController } from '../../app.controller.js';
import { AppService } from '../../app.service.js';
import { HealthController } from '../../health/health.controller.js';
import { GLOBAL_PREFIX } from './prefix.js';
import { SWAGGER_PATH, createOpenApiDocument, setupSwagger } from './swagger.js';

/** The path the service root ends up on once the global prefix is applied. */
const ROOT_PATH = `/${GLOBAL_PREFIX}`;
/** Ditto for health - the ALB health-check path in the deployment sequence. */
const HEALTH_PATH = `/${GLOBAL_PREFIX}/health`;

/** The parts of an OpenAPI operation these assertions inspect. */
interface OperationLike {
  tags?: string[];
  summary?: string;
  responses: Record<string, unknown>;
}

/** The parts of a generated response these assertions inspect. */
interface ResponseLike {
  content?: Record<string, { schema?: unknown }>;
}

/** The parts of a generated DTO schema these assertions inspect. */
interface SchemaLike {
  properties?: Record<string, Record<string, unknown>>;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

function operationFor(document: OpenAPIObject, path: string, method: string): OperationLike {
  const operations = document.paths[path] as unknown as Record<string, OperationLike | undefined>;
  const operation = operations?.[method];

  if (!operation) {
    throw new Error(`no ${method.toUpperCase()} operation is documented for ${path}`);
  }

  return operation;
}

function responseSchema(
  document: OpenAPIObject,
  path: string,
  status: string,
  mediaType: string,
): unknown {
  const response = operationFor(document, path, 'get').responses[status] as ResponseLike | undefined;

  return response?.content?.[mediaType]?.schema;
}

function dtoProperties(
  document: OpenAPIObject,
  name: string,
): Record<string, Record<string, unknown>> {
  const schema = document.components?.schemas?.[name] as SchemaLike | undefined;

  if (!schema?.properties) {
    throw new Error(`${name} is missing from components.schemas (or has no properties)`);
  }

  return schema.properties;
}

/**
 * The generated document is the contract the frontend codes against, so its shapes
 * are asserted here rather than eyeballed in the browser: field by field, with a
 * bare endpoint or an empty schema failing the suite.
 *
 * The real controllers are wired into a `TestingModule` by hand, which keeps this
 * hermetic (no `.env`, no database, so it runs with the rest of the unit suite in
 * CI) while still exploring them exactly as `AppModule` registers them - plus the
 * `/v1` route prefix, so the asserted paths are the ones a client calls.
 */
describe('createOpenApiDocument', () => {
  let app: INestApplication;
  let document: OpenAPIObject;
  let operations: { path: string; method: string; operation: OperationLike }[];

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AppController, HealthController],
      providers: [AppService],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirrors `main.ts`: the prefix is set before the document is built, so what
    // is asserted below is the URL a client actually calls.
    app.setGlobalPrefix(GLOBAL_PREFIX);
    await app.init();
    document = createOpenApiDocument(app);

    operations = Object.entries(document.paths).flatMap(([path, item]) =>
      HTTP_METHODS.flatMap((method) => {
        const operation = (item as unknown as Record<string, OperationLike | undefined>)[method];
        return operation ? [{ path, method, operation }] : [];
      }),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('documents every controller it is given, and nothing else', () => {
    expect(Object.keys(document.paths).sort()).toEqual([ROOT_PATH, HEALTH_PATH]);
  });

  it('gives every operation a tag and a summary', () => {
    expect(operations.length).toBeGreaterThan(0);

    for (const { path, method, operation } of operations) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(operation.tags?.length, `${where} is untagged`).toBeGreaterThan(0);
      expect(operation.summary, `${where} has no summary`).toBeTruthy();
    }
  });

  // "Not just bare endpoint names": every documented status has to say what comes
  // back, so the frontend never has to discover a shape at runtime.
  it('describes a schema for every documented response', () => {
    for (const { path, method, operation } of operations) {
      const where = `${method.toUpperCase()} ${path}`;
      const statuses = Object.keys(operation.responses);

      expect(statuses.length, `${where} documents no responses`).toBeGreaterThan(0);

      for (const status of statuses) {
        const response = operation.responses[status] as ResponseLike | undefined;
        const mediaTypes = Object.keys(response?.content ?? {});

        expect(mediaTypes.length, `${where} -> ${status} documents no content`).toBeGreaterThan(0);

        for (const mediaType of mediaTypes) {
          expect(
            response?.content?.[mediaType]?.schema,
            `${where} -> ${status} (${mediaType}) has no schema`,
          ).toBeTruthy();
        }
      }
    }
  });

  // A DTO whose fields are not decorated generates a valid-looking but empty schema
  // - worse than no docs, because the frontend codes against a shape that says
  // nothing. `@ApiProperty()` on every field is what makes the shape real (this
  // project has no Swagger CLI plugin, and vitest would not run one anyway), so an
  // empty object is a failure here rather than a footnote.
  it('never documents a DTO as an empty object', () => {
    const schemas = (document.components?.schemas ?? {}) as Record<string, SchemaLike>;

    expect(Object.keys(schemas).length).toBeGreaterThan(0);

    for (const [name, schema] of Object.entries(schemas)) {
      if (!schema.properties) {
        continue;
      }

      expect(
        Object.keys(schema.properties).length,
        `${name} is documented with no fields at all`,
      ).toBeGreaterThan(0);
    }
  });

  describe(`GET ${ROOT_PATH}`, () => {
    it('documents the greeting as the string it actually returns', () => {
      expect(responseSchema(document, ROOT_PATH, '200', 'text/html')).toEqual({
        type: 'string',
        example: 'Hello World!',
      });
    });

    it('points 500 at the shared error shape', () => {
      expect(responseSchema(document, ROOT_PATH, '500', 'application/json')).toEqual({
        $ref: '#/components/schemas/ErrorResponseDto',
      });
    });
  });

  describe(`GET ${HEALTH_PATH}`, () => {
    it('points 200 at the health DTO', () => {
      expect(responseSchema(document, HEALTH_PATH, '200', 'application/json')).toEqual({
        $ref: '#/components/schemas/HealthResponseDto',
      });
    });

    it('describes every field of that DTO with a type, a description and an example', () => {
      const properties = dtoProperties(document, 'HealthResponseDto');

      expect(Object.keys(properties).sort()).toEqual(['status', 'timestamp', 'uptimeSeconds']);

      for (const [name, property] of Object.entries(properties)) {
        expect(property['type'], `${name} has no type`).toBeTruthy();
        expect(property['description'], `${name} has no description`).toBeTruthy();
        expect(property['example'], `${name} has no example`).toBeDefined();
      }

      expect(properties['status']?.['type']).toBe('string');
      expect(properties['status']?.['enum']).toEqual(['ok']);
      expect(properties['uptimeSeconds']?.['type']).toBe('number');
    });
  });

  describe('ErrorResponseDto', () => {
    it('documents every field the global exception filter sends', () => {
      const properties = dtoProperties(document, 'ErrorResponseDto');

      expect(Object.keys(properties).sort()).toEqual([
        'error',
        'message',
        'path',
        'statusCode',
        'timestamp',
      ]);

      for (const [name, property] of Object.entries(properties)) {
        expect(property['description'], `${name} has no description`).toBeTruthy();
        expect(property['example'], `${name} has no example`).toBeDefined();
        expect(property['type'] ?? property['oneOf'], `${name} has no shape`).toBeTruthy();
      }
    });

    it('allows `message` to be the array a failed validation produces', () => {
      expect(dtoProperties(document, 'ErrorResponseDto')['message']?.['oneOf']).toEqual([
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
      ]);
    });
  });
});

/**
 * The mount itself, asserted over HTTP against apps wired exactly as `main.ts`
 * wires them.
 *
 * Two things the document-level assertions above cannot see: the docs URL stays
 * *outside* the route prefix (a bookmark has to survive a version bump), and
 * switching the docs off removes both routes rather than leaving the UI mounted
 * on a document with nothing behind it.
 */
describe('setupSwagger', () => {
  let app: INestApplication<App>;
  let mounted: boolean;

  async function boot(enabled: boolean): Promise<INestApplication<App>> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AppController, HealthController],
      providers: [AppService],
    }).compile();

    const instance = moduleRef.createNestApplication();
    instance.setGlobalPrefix(GLOBAL_PREFIX);
    mounted = setupSwagger(instance, enabled);
    await instance.init();

    return instance;
  }

  describe('when enabled', () => {
    beforeAll(async () => {
      app = await boot(true);
    });

    afterAll(async () => {
      await app.close();
    });

    it('reports that the docs were mounted', () => {
      expect(mounted).toBe(true);
    });

    it(`serves the Swagger UI at /${SWAGGER_PATH}`, async () => {
      const response = await request(app.getHttpServer()).get(`/${SWAGGER_PATH}`).expect(200);

      expect(response.text).toContain('Swagger UI');
    });

    it(`does not serve them under the route prefix either`, async () => {
      // `SwaggerModule.setup(..., { useGlobalPrefix: true })` would mount the UI
      // at /v1/api/docs and break the URL the frontend was handed, so the option
      // is deliberately left off. This pins that decision.
      await request(app.getHttpServer())
        .get(`/${GLOBAL_PREFIX}/${SWAGGER_PATH}`)
        .expect(404);
    });

    it(`serves the document at /${SWAGGER_PATH}-json, with the prefix inside every path`, async () => {
      const response = await request(app.getHttpServer())
        .get(`/${SWAGGER_PATH}-json`)
        .expect(200);

      expect(Object.keys(response.body.paths as Record<string, unknown>).sort()).toEqual([
        ROOT_PATH,
        HEALTH_PATH,
      ]);
    });
  });

  describe('when disabled', () => {
    beforeAll(async () => {
      app = await boot(false);
    });

    afterAll(async () => {
      await app.close();
    });

    it('reports that nothing was mounted', () => {
      expect(mounted).toBe(false);
    });

    it('serves neither the UI nor the document', async () => {
      await request(app.getHttpServer()).get(`/${SWAGGER_PATH}`).expect(404);
      await request(app.getHttpServer()).get(`/${SWAGGER_PATH}-json`).expect(404);
    });

    it('leaves the API itself untouched', async () => {
      const response = await request(app.getHttpServer()).get(HEALTH_PATH).expect(200);

      expect(response.body).toMatchObject({ status: 'ok' });
    });
  });
});
