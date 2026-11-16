// Storage takes JsonValue. Our records are plain data, but optional fields (`port?: number`) keep
// TypeScript from proving it, so they go through a real JSON round trip instead of a cast.
import type { JsonValue } from 'orca/worker'

export function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
