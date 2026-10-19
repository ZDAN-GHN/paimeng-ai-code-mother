
export function appOrigin(): string {
  return process.env.APP_ORIGIN ?? 'http://localhost:3000';
}

export function previewOrigin(): string {
  return process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:3001';
}
