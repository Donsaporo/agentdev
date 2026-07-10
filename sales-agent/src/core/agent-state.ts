let systemPaused = false;

export function isSystemPaused(): boolean {
  return systemPaused;
}

export function setSystemPaused(value: boolean): void {
  systemPaused = value;
}
