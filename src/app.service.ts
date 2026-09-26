import { Injectable } from '@nestjs/common';
// Deliberate breach, throwaway branch only: an unused import must fail the lint gate.
import { hostname } from 'node:os';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }
}
