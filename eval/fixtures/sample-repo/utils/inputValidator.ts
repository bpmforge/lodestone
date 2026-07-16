// Input validation / sanitization (concept: input_validation).
export function sanitizeInput(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "");
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
