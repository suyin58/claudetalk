import { randomUUID as nodeRandomUUID } from 'crypto';

/**
 * 生成 UUID v4
 */
export function randomUUID(): string {
  return nodeRandomUUID();
}
