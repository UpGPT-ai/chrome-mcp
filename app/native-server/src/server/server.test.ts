import { describe, expect, test, afterAll, beforeAll } from '@jest/globals';
import supertest from 'supertest';
import Server from './index';

describe('Server tests', () => {
  // Start a server instance for testing
  beforeAll(async () => {
    await Server.getInstance().ready();
  });

  // Shut down the server
  afterAll(async () => {
    await Server.stop();
  });

  test('GET /ping should return the correct response', async () => {
    const response = await supertest(Server.getInstance().server)
      .get('/ping')
      .expect(200)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      status: 'ok',
      message: 'pong',
    });
  });
});
